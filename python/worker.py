#!/usr/bin/env python3
"""
VoiceScribe transcription worker.

Two modes:
  1. stdio worker (default)  -> JSON-lines protocol, driven by the Electron main process.
  2. CLI                     -> python worker.py --file video.mp4 --model small --out out.txt

Why no ffmpeg? faster-whisper decodes media through PyAV, whose wheels bundle the
FFmpeg libraries, so mp4/mov/mkv/mp3/wav all decode without a system install.
"""

import argparse
import fnmatch
import json
import os
import re
import sys
import threading
import time
import traceback

# Keep stdout clean: it is the protocol channel. Everything else goes to stderr.
_PROTO_OUT = sys.stdout
_emit_lock = threading.Lock()

# Disable the Xet transfer backend. Xet writes each attempt into its own
# randomly-suffixed *.incomplete temp file and never reuses it, so a 3 GB model
# that gets interrupted restarts from byte 0 and orphans the previous partial
# (we measured 3 stale files / 3.4 GB from three interrupted attempts).
# Plain HTTP uses Range requests against a single "<blob>.<etag>.incomplete",
# which is what makes 断点续传 actually work. Must be set before
# huggingface_hub.constants is imported, hence module level.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def log(*args):
    print("[worker]", *args, file=sys.stderr, flush=True)


def emit(payload):
    # Multiple threads (downloads, transcription) write to the same pipe.
    with _emit_lock:
        _PROTO_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
        _PROTO_OUT.flush()


THREADS = max(4, (os.cpu_count() or 4) - 2)
MODEL_CACHE = {}
CANCEL_FLAGS = set()
_lock = threading.Lock()

BEAM_SIZE = 5

MODEL_ALIASES = {
    "tiny": "tiny",
    "base": "base",
    "small": "small",
    "medium": "medium",
    "large": "large-v3",
    "large-v3": "large-v3",
}

# Hugging Face repo + fallback size (bytes) used before the hub has been asked
# for the real metadata. The real size is cached after the first successful
# download, so the UI can show accurate numbers while offline.
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}

MODEL_FALLBACK_BYTES = {
    "tiny": 75 * 1024**2,
    "base": 145 * 1024**2,
    "small": 484 * 1024**2,
    "medium": 1530 * 1024**2,
    "large-v3": 3090 * 1024**2,
}

# Same filter faster-whisper itself uses, so we never pull the .pt originals.
MODEL_FILE_PATTERNS = [
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
]

DOWNLOADS: dict = {}  # model key -> _Progress, while a download is running
_DOWNLOAD_LOCKS: dict = {}
_SIZE_CACHE: dict = {}


def _hub_cache_dir() -> str:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        return HF_HUB_CACHE
    except Exception:  # noqa: BLE001 - older/newer hub layouts
        home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
        return os.path.join(home, "hub")


def _repo_dir(key: str) -> str:
    repo = MODEL_REPOS[key]
    return os.path.join(_hub_cache_dir(), "models--" + repo.replace("/", "--"))


def _snapshot_dir(key: str) -> str | None:
    """Return the cached snapshot dir for a model, or None when incomplete."""
    snapshots = os.path.join(_repo_dir(key), "snapshots")
    if not os.path.isdir(snapshots):
        return None
    for revision in os.listdir(snapshots):
        candidate = os.path.join(snapshots, revision)
        if os.path.exists(os.path.join(candidate, "model.bin")):
            return candidate
    return None


def model_size_bytes(key: str) -> int:
    """On-disk size of a fully downloaded model (0 when not downloaded)."""
    snap = _snapshot_dir(key)
    if not snap:
        return 0
    total = 0
    for entry in os.scandir(snap):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            pass
    return total


def _size_cache_path() -> str:
    return os.path.join(_hub_cache_dir(), ".voicescribe-model-sizes.json")


def _load_size_cache() -> None:
    try:
        with open(_size_cache_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            _SIZE_CACHE.update({k: int(v) for k, v in data.items() if isinstance(v, (int, float))})
    except Exception:  # noqa: BLE001 - cache is optional
        pass


def _save_size_cache() -> None:
    try:
        os.makedirs(os.path.dirname(_size_cache_path()), exist_ok=True)
        with open(_size_cache_path(), "w", encoding="utf-8") as fh:
            json.dump(_SIZE_CACHE, fh)
    except Exception:  # noqa: BLE001
        pass


def _wanted_file(filename: str) -> bool:
    return any(fnmatch.fnmatch(filename, pattern) for pattern in MODEL_FILE_PATTERNS)


def _expected_bytes(key: str) -> int:
    """Total download size: cached value, hub metadata, or a static fallback."""
    if _SIZE_CACHE.get(key):
        return _SIZE_CACHE[key]
    total = 0
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(MODEL_REPOS[key], files_metadata=True)
        total = sum((s.size or 0) for s in (info.siblings or []) if _wanted_file(s.rfilename))
    except Exception as exc:  # noqa: BLE001 - offline / rate limited
        log(f"model metadata unavailable for {key}: {exc}")
    if total:
        _SIZE_CACHE[key] = total
        _save_size_cache()
        return total
    return MODEL_FALLBACK_BYTES.get(key, 0)


class _Progress:
    """Byte counter fed by a custom tqdm class, throttled into protocol events."""

    def __init__(self, key: str, total: int):
        self.key = key
        self.total = total
        self.bytes = 0
        self.speed = 0.0
        self.started = time.time()
        self._last_bytes = 0
        self._last_emit = 0.0
        self._last_tick = self.started
        self._lock = threading.Lock()

    def add(self, n: float) -> None:
        if not n:
            return
        with self._lock:
            self.bytes += int(n)
            now = time.time()
            if now - self._last_emit < 0.3:
                return
            elapsed = now - self._last_tick
            if elapsed > 0:
                instant = (self.bytes - self._last_bytes) / elapsed
                self.speed = instant if not self.speed else self.speed * 0.65 + instant * 0.35
            self._last_emit, self._last_bytes, self._last_tick = now, self.bytes, now
            self.flush()

    def snapshot(self) -> dict:
        total = self.total or 0
        percent = min(self.bytes / total, 0.999) if total else 0.0
        return {
            "downloaded": self.bytes,
            "total": total,
            "percent": round(percent, 4),
            "speed": round(self.speed),
            "startedAt": round(self.started * 1000),
        }

    def flush(self) -> None:
        emit({"type": "model:progress", "model": self.key, **self.snapshot()})


def _download_lock(key: str) -> threading.Lock:
    with _lock:
        return _DOWNLOAD_LOCKS.setdefault(key, threading.Lock())


def _clean_stale_partials(key: str) -> int:
    """
    Drop leftovers from hf_hub's own downloader.

    hf_hub >= 2.x writes each attempt into a process-unique
    "<etag>.<uuid8>.incomplete" file opened with mode "wb", so an interrupted
    download restarts from byte 0 *and* leaves the old partial behind. Those
    files can never be resumed by anyone, so reclaim the space.
    """
    blobs = os.path.join(_repo_dir(key), "blobs")
    if not os.path.isdir(blobs):
        return 0
    freed = 0
    for entry in os.listdir(blobs):
        if not entry.endswith(".incomplete"):
            continue
        # Our own resumable partial is "<etag>.incomplete"; anything with an
        # extra dot in the stem is an orphaned legacy temp file.
        if "." not in entry[: -len(".incomplete")]:
            continue
        path = os.path.join(blobs, entry)
        try:
            freed += os.path.getsize(path)
            os.remove(path)
        except OSError:
            pass
    if freed:
        log(f"cleaned {freed / 1024**2:.0f} MB of stale partial downloads for {key}")
    return freed


def _stream_once(url: str, incomplete: str, expected: int, progress: "_Progress") -> None:
    """One HTTP attempt. Resumes from whatever is already in `incomplete`."""
    import urllib.error
    import urllib.request

    pos = os.path.getsize(incomplete) if os.path.exists(incomplete) else 0
    if expected and pos > expected:
        # Truncated/oversized leftover: start over.
        os.remove(incomplete)
        pos = 0
    if expected and pos == expected:
        return

    request = urllib.request.Request(url, headers={"User-Agent": "voicescribe/1.0"})
    if pos:
        request.add_header("Range", f"bytes={pos}-")

    try:
        response = urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as error:
        if error.code == 416 and pos:
            # Already complete on the server side.
            return
        raise

    with response:
        status = getattr(response, "status", 200)
        if pos and status != 206:
            # Server ignored Range -> restart from zero rather than corrupt.
            log(f"range ignored for {os.path.basename(incomplete)}, restarting")
            pos = 0
        with open(incomplete, "ab" if pos else "wb") as handle:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                handle.write(chunk)
                progress.add(len(chunk))

    if expected:
        size = os.path.getsize(incomplete)
        if size != expected:
            raise IOError(f"got {size} bytes, expected {expected}")


def _download_one(
    url: str, blob_path: str, expected: int, progress: "_Progress", attempts: int = 6
) -> None:
    """
    Download one file, resuming across retries.

    Long transfers over a flaky link die on socket timeouts; because the partial
    file survives, each retry picks up where the last one stopped instead of
    starting over.
    """
    incomplete = blob_path + ".incomplete"
    for attempt in range(1, attempts + 1):
        try:
            _stream_once(url, incomplete, expected, progress)
            os.replace(incomplete, blob_path)
            return
        except Exception as exc:  # noqa: BLE001 - network errors vary by platform
            if attempt >= attempts:
                raise
            wait = min(2 ** attempt, 20)
            log(f"retry {attempt}/{attempts} {os.path.basename(blob_path)}: {type(exc).__name__}: {exc}")
            time.sleep(wait)


def _resumable_download(key: str, repo: str, progress: "_Progress") -> None:
    """
    Download the model files ourselves so an interrupted transfer continues
    where it stopped (hf_hub 2.x cannot do that, see _clean_stale_partials).
    """
    from huggingface_hub import HfApi
    from huggingface_hub.constants import ENDPOINT

    endpoint = (ENDPOINT or "https://huggingface.co").rstrip("/")
    blobs_dir = os.path.join(_repo_dir(key), "blobs")
    os.makedirs(blobs_dir, exist_ok=True)

    info = HfApi().model_info(repo, files_metadata=True)
    files = []
    for sibling in info.siblings:
        name = sibling.rfilename
        if not _wanted_file(name):
            continue
        size = getattr(sibling, "size", None) or 0
        lfs = getattr(sibling, "lfs", None)
        etag = getattr(lfs, "sha256", None) if lfs else None
        etag = etag or getattr(sibling, "blob_id", None)
        if not etag:
            continue
        files.append((name, size, etag))

    total = sum(size for _, size, _ in files)
    if total:
        progress.total = total

    for name, size, etag in files:
        blob_path = os.path.join(blobs_dir, etag)
        if os.path.exists(blob_path):
            on_disk = os.path.getsize(blob_path)
            if not size or on_disk == size:
                progress.add(on_disk)
                continue
        # Count bytes we already have so a resumed transfer reports a sane %.
        incomplete = blob_path + ".incomplete"
        if os.path.exists(incomplete):
            have = os.path.getsize(incomplete)
            if not size or have <= size:
                progress.add(have)
        url = f"{endpoint}/{repo}/resolve/main/{name}"
        log(f"fetch {name} ({size / 1024**2:.1f} MB)")
        _download_one(url, blob_path, size, progress)

    # Blobs are now complete; let hf_hub wire up snapshots/refs (no re-download).
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=repo, allow_patterns=MODEL_FILE_PATTERNS)


def ensure_downloaded(key: str) -> bool:
    """
    Make sure the weights are on disk, downloading them if needed.

    Single-flight per model: a manual "download" click and a transcription that
    starts meanwhile wait on the same lock instead of racing.
    """
    with _download_lock(key):
        if _snapshot_dir(key):
            return True

        repo = MODEL_REPOS[key]
        total = _expected_bytes(key)
        progress = _Progress(key, total)
        with _lock:
            DOWNLOADS[key] = progress

        emit({"type": "model:start", "model": key, "total": total})
        log(f"downloading {key} from {repo} ({total / 1024**2:.0f} MB)")
        try:
            _clean_stale_partials(key)
            _resumable_download(key, repo, progress)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            emit({"type": "model:error", "model": key, "message": str(exc)})
            return False
        finally:
            with _lock:
                DOWNLOADS.pop(key, None)
            emit({"type": "models", **models_payload()})

        size = model_size_bytes(key)
        if size:
            _SIZE_CACHE[key] = size
            _save_size_cache()
        emit({"type": "model:done", "model": key, "sizeBytes": size})
        log(f"model {key} downloaded ({size / 1024**2:.0f} MB)")
        return True


def start_download(name: str) -> None:
    key = MODEL_ALIASES.get(name, "small")
    if _snapshot_dir(key):
        emit({"type": "model:done", "model": key, "sizeBytes": model_size_bytes(key), "cached": True})
        return
    with _lock:
        running = key in DOWNLOADS
    if running:
        return
    threading.Thread(target=ensure_downloaded, args=(key,), daemon=True).start()


def models_payload() -> dict:
    items = []
    for key, repo in MODEL_REPOS.items():
        snap = _snapshot_dir(key)
        with _lock:
            progress = DOWNLOADS.get(key)
        item = {
            "name": key,
            "repo": repo,
            "downloaded": bool(snap),
            "sizeBytes": model_size_bytes(key),
            "expectedBytes": _SIZE_CACHE.get(key) or MODEL_FALLBACK_BYTES.get(key, 0),
            "path": snap,
        }
        if progress:
            item["download"] = progress.snapshot()
        items.append(item)
    return {"models": items, "cacheDir": _hub_cache_dir()}


_load_size_cache()



def get_model(name: str):
    key = MODEL_ALIASES.get(name, "small")
    with _lock:
        if key in MODEL_CACHE:
            return MODEL_CACHE[key], False
    log(f"loading model {key} (first run downloads weights)...")
    from faster_whisper import WhisperModel

    # float32 is measurably faster than int8 on Apple Silicon (CTranslate2's int8
    # kernels are tuned for x86), and it is the more accurate option anyway.
    try:
        model = WhisperModel(key, device="cpu", compute_type="float32", cpu_threads=THREADS)
    except Exception:
        model = WhisperModel(key, device="cpu", compute_type="int8", cpu_threads=THREADS)
    with _lock:
        MODEL_CACHE[key] = model
    log(f"model {key} ready")
    return model, True


def decode_audio(path: str, sampling_rate: int = 16000) -> "np.ndarray":
    """
    Decode any media file to mono float32 PCM at `sampling_rate`.

    We do the decoding ourselves instead of relying on faster_whisper.audio.decode_audio():
    that helper passes `metadata_errors=` to av.open(), an argument removed in recent
    PyAV releases. Decoding directly means any `av >= 11` works, and if PyAV is missing
    entirely we fall back to the ffmpeg binary.
    """
    import numpy as np

    try:
        import av  # noqa: F401
    except ImportError:
        return _decode_with_ffmpeg(path, sampling_rate)

    chunks: list = []
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("该文件不含音频轨道")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sampling_rate)
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError("未能从该文件解码出音频")
    return np.concatenate(chunks).astype(np.float32)


def _decode_with_ffmpeg(path: str, sampling_rate: int) -> "np.ndarray":
    """Fallback decoder for machines without PyAV (requires an ffmpeg binary on PATH)."""
    import shutil
    import subprocess

    import numpy as np

    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "未安装 PyAV，且 PATH 中找不到 ffmpeg。请执行 `pip install av`（需要预编译 wheel）"
            "或 `brew install ffmpeg`。"
        )

    process = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v", "error",
            "-i", path,
            "-vn",
            "-f", "f32le",
            "-acodec", "pcm_f32le",
            "-ac", "1",
            "-ar", str(sampling_rate),
            "-",
        ],
        stdout=subprocess.PIPE,
        check=True,
    )
    return np.frombuffer(process.stdout, dtype=np.float32).copy()


def probe(path: str) -> dict:
    """Read container metadata without transcoding."""
    import av

    with av.open(path) as container:
        duration = 0.0
        if container.duration:
            duration = container.duration / 1_000_000
        audio = None
        has_video = False
        for stream in container.streams:
            if stream.type == "audio" and audio is None:
                audio = stream
            elif stream.type == "video":
                has_video = True
        info = {
            "size": os.path.getsize(path),
            "duration": round(duration, 2),
            "hasAudio": audio is not None,
            "hasVideo": has_video,
            "sampleRate": getattr(audio, "rate", None) if audio is not None else None,
            "channels": getattr(audio, "channels", None) if audio is not None else None,
            "codec": audio.codec_context.name if audio is not None else None,
        }
        return info


SIMPLIFIED_HINT = "以下是普通话对话，请用简体中文转写。"


def _normalize_text(text: str) -> str:
    """Strip punctuation/spacing so prompt echoes can be compared."""
    return re.sub(r"[\s，。、？！,.?!:：；;\"'“”‘’()（）…—\-]", "", text or "")


def _is_prompt_echo(text: str, prompt_text: str) -> bool:
    """
    Whisper likes to transcribe the initial prompt when a clip is silent or too
    quiet. Such a segment is noise, not speech.
    """
    normalized = _normalize_text(text)
    if not normalized:
        return True
    prompt = _normalize_text(prompt_text)
    return bool(prompt) and (normalized in prompt or prompt in normalized)


def _initial_prompt(prompt, language):
    """
    Whisper regularly answers in Traditional Chinese for Mandarin audio. A short
    Simplified-Chinese prompt flips the output reliably, so we append one when
    Chinese is requested and otherwise pass the user's prompt through untouched.
    """
    text = (prompt or "").strip()
    if language == "zh":
        return f"{text} {SIMPLIFIED_HINT}".strip() if text else SIMPLIFIED_HINT
    return text or None


def transcribe(req: dict):
    req_id = req.get("id")
    path = req.get("file")
    model_name = req.get("model", "small")
    language = req.get("language") or None
    if language in ("auto", ""):
        language = None

    if not path or not os.path.exists(path):
        emit({"id": req_id, "type": "error", "message": f"文件不存在: {path}"})
        return

    try:
        meta = probe(path)
    except Exception as exc:  # noqa: BLE001
        emit({"id": req_id, "type": "error", "message": f"无法读取媒体文件: {exc}"})
        return

    emit({"id": req_id, "type": "meta", **meta})
    if not meta["hasAudio"]:
        emit({"id": req_id, "type": "error", "message": "该文件不含音频轨道"})
        return

    try:
        key = MODEL_ALIASES.get(model_name, "small")
        emit({"id": req_id, "type": "stage", "stage": "loading", "model": model_name})
        # Fetch the weights first (with progress events) so the UI can show a real
        # percentage instead of an opaque "loading" spinner on first run.
        if not _snapshot_dir(key):
            emit({"id": req_id, "type": "stage", "stage": "downloading", "model": model_name})
            if not ensure_downloaded(key):
                emit({"id": req_id, "type": "error", "message": "模型下载失败，请检查网络后重试"})
                return
            emit({"id": req_id, "type": "stage", "stage": "loading", "model": model_name})
        model, freshly_loaded = get_model(model_name)
        emit({"id": req_id, "type": "stage", "stage": "decoding"})
        audio = decode_audio(path)
        emit({"id": req_id, "type": "stage", "stage": "transcribing", "downloaded": freshly_loaded})

        prompt_text = _initial_prompt(req.get("prompt"), language)
        segments_iter, info = model.transcribe(
            audio,
            language=language,
            task="transcribe",
            beam_size=BEAM_SIZE,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            initial_prompt=prompt_text,
        )

        total = info.duration or meta["duration"] or 0.0
        emit(
            {
                "id": req_id,
                "type": "info",
                "language": info.language,
                "languageProbability": round(getattr(info, "language_probability", 0.0) or 0.0, 4),
                "duration": round(total, 2),
            }
        )

        collected = []
        for seg in segments_iter:
            if req_id in CANCEL_FLAGS:
                emit({"id": req_id, "type": "cancelled"})
                return
            if _is_prompt_echo(seg.text, prompt_text):
                continue
            item = {
                "id": len(collected),
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
            }
            collected.append(item)
            emit(
                {
                    "id": req_id,
                    "type": "segment",
                    "segment": item,
                    "progress": round(min(seg.end / total, 1.0), 4) if total else 0,
                }
            )

        emit(
            {
                "id": req_id,
                "type": "done",
                "segments": collected,
                "language": info.language,
                "duration": round(total, 2),
                "text": "\n".join(s["text"] for s in collected if s["text"]),
            }
        )
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit({"id": req_id, "type": "error", "message": str(exc)})


def serve():
    log("worker online")
    emit({"type": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        cmd = req.get("cmd")
        if cmd == "ping":
            emit({"id": req.get("id"), "type": "pong"})
        elif cmd == "probe":
            try:
                emit({"id": req.get("id"), "type": "meta", **probe(req["file"])})
            except Exception as exc:  # noqa: BLE001
                emit({"id": req.get("id"), "type": "error", "message": str(exc)})
        elif cmd == "cancel":
            CANCEL_FLAGS.add(req.get("target"))
            emit({"id": req.get("id"), "type": "cancelAck"})
        elif cmd == "models":
            emit({"type": "models", **models_payload()})
        elif cmd == "downloadModel":
            start_download(req.get("model", "small"))
            emit({"type": "models", **models_payload()})
        elif cmd == "transcribe":
            threading.Thread(target=transcribe, args=(req,), daemon=True).start()
        elif cmd == "shutdown":
            break
        else:
            emit({"id": req.get("id"), "type": "error", "message": f"unknown command: {cmd}"})


def run_cli(path: str, model_name: str, language: str, out_path: str | None):
    """Headless transcription used for testing and batch jobs."""
    meta = probe(path)
    log(f"duration={meta['duration']}s audio={meta['hasAudio']}")
    model, _ = get_model(model_name)
    audio = decode_audio(path)
    lang = None if language in ("auto", "", None) else language
    segments, info = model.transcribe(
        audio,
        language=lang,
        beam_size=BEAM_SIZE,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
    )
    total = info.duration or meta["duration"] or 1.0
    lines, plain = [], []
    for seg in segments:
        text = seg.text.strip()
        lines.append(f"[{seg.start:7.2f} -> {seg.end:7.2f}] {text}")
        plain.append(text)
        sys.stderr.write(f"\r{min(seg.end / total, 1.0) * 100:5.1f}%  {seg.end:7.2f}s")
        sys.stderr.flush()
    sys.stderr.write("\n")
    body = "\n".join(plain)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(body + "\n")
        log(f"wrote {out_path}")
    log(f"language={info.language} segments={len(plain)}")
    print(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--out")
    args = parser.parse_args()

    if args.file:
        run_cli(args.file, args.model, args.language, args.out)
    else:
        serve()


if __name__ == "__main__":
    main()
