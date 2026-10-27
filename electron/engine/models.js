/**
 * Whisper model catalog + resumable downloader for the ggml weights.
 *
 * Everything here is plain Node (no Python): the weights come straight from
 * Hugging Face over HTTPS, written to "<file>.incomplete" and renamed into place
 * when the byte count matches. A dead socket therefore costs only the last few
 * seconds instead of restarting a 1.5 GB transfer.
 */

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPO = "ggerganov/whisper.cpp";
const ENDPOINT = (process.env.VOICESCRIBE_HF_ENDPOINT || "https://huggingface.co").replace(/\/$/, "");

/** Model key -> ggml file name. Keys match the UI catalog in src/lib/models.ts. */
const MODEL_FILES = {
  tiny: "ggml-tiny.bin",
  base: "ggml-base.bin",
  small: "ggml-small.bin",
  medium: "ggml-medium.bin",
  "large-v3": "ggml-large-v3.bin",
};

/**
 * Sizes are only a fallback for the first paint / offline start; the real
 * Content-Length from the redirect target wins whenever it is available.
 */
const FALLBACK_BYTES = {
  tiny: 77691713,
  base: 147951465,
  small: 487601967,
  medium: 1533763059,
  "large-v3": 3095033483,
};

const ALIASES = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  large: "large-v3",
  "large-v3": "large-v3",
  "large-v3-turbo": "large-v3",
};

function resolveModel(name) {
  return ALIASES[name] || "small";
}

function modelFileName(key) {
  return MODEL_FILES[key] || MODEL_FILES.small;
}

function modelUrl(key) {
  return `${ENDPOINT}/${REPO}/resolve/main/${modelFileName(key)}`;
}

function fallbackBytes(key) {
  return FALLBACK_BYTES[key] || 0;
}

/** Where weights live: the app's userData dir, so they survive updates. */
function cacheDir(userDataPath) {
  return path.join(userDataPath, "models");
}

function modelPath(userDataPath, key) {
  return path.join(cacheDir(userDataPath), modelFileName(key));
}

function fileSize(target) {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

/**
 * True when usable weights are on disk.
 *
 * A byte-count check matters: a truncated leftover (interrupted copy, failed
 * rename, a killed download from an older version) would otherwise look ready
 * and then fail deep inside whisper.cpp's model loader.
 */
/**
 * Bytes already on disk for an unfinished download. Lets the UI show a real
 * percentage for a paused model without guessing.
 */
function partialSize(userDataPath, key) {
  return fileSize(`${modelPath(userDataPath, key)}.incomplete`);
}

/**
 * Explicit "I paused this" marker.
 *
 * Without it the next launch cannot tell a deliberate pause from a download that
 * was cut off by a quit or a dropped connection — and it has to pick one, since
 * the leftover bytes look identical.
 */
function pauseMarkerPath(userDataPath, key) {
  return `${modelPath(userDataPath, key)}.paused`;
}

function hasPauseMarker(userDataPath, key) {
  return fs.existsSync(pauseMarkerPath(userDataPath, key));
}

function writePauseMarker(userDataPath, key) {
  try {
    fs.mkdirSync(cacheDir(userDataPath), { recursive: true });
    fs.writeFileSync(pauseMarkerPath(userDataPath, key), String(Date.now()));
  } catch {
    /* a marker we cannot write only costs an auto-resume */
  }
}

function clearPauseMarker(userDataPath, key) {
  try {
    fs.rmSync(pauseMarkerPath(userDataPath, key), { force: true });
  } catch {
    /* nothing to clear */
  }
}

function isDownloaded(userDataPath, key) {
  const size = fileSize(modelPath(userDataPath, key));
  if (size <= 0) return false;
  const expected = fallbackBytes(key);
  return !expected || size === expected;
}

/**
 * Ask HF for the real size via a HEAD request that follows the CDN redirect.
 * Returns 0 when offline; callers fall back to FALLBACK_BYTES.
 */
async function remoteSize(key) {
  try {
    const response = await fetch(modelUrl(key), { method: "HEAD", redirect: "follow" });
    if (!response.ok) return 0;
    const length = Number(response.headers.get("content-length") || 0);
    return Number.isFinite(length) ? length : 0;
  } catch {
    return 0;
  }
}

/**
 * Stream one URL into `target`, resuming from whatever is already there.
 * Returns the number of bytes newly written this attempt.
 */
async function downloadTo(key, target, expected, onBytes, signal) {
  const partial = `${target}.incomplete`;
  let have = fileSize(partial);
  if (expected && have > expected) {
    fs.rmSync(partial, { force: true });
    have = 0;
  }
  if (expected && have === expected) {
    fs.renameSync(partial, target);
    return 0;
  }

  const headers = { "User-Agent": "voicescribe/1.1" };
  if (have > 0) headers.Range = `bytes=${have}-`;

  const response = await fetch(modelUrl(key), { headers, redirect: "follow", signal });
  if (response.status === 416 && have > 0) {
    fs.renameSync(partial, target);
    return 0;
  }
  if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`);

  // A server that ignores Range would corrupt the file, so restart cleanly.
  let append = have > 0 && response.status === 206;
  if (have > 0 && !append) {
    fs.rmSync(partial, { force: true });
    have = 0;
  }

  let written = 0;
  const sink = fs.createWriteStream(partial, { flags: append ? "a" : "w" });
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (source) {
      for await (const chunk of source) {
        written += chunk.length;
        onBytes(chunk.length);
        yield chunk;
      }
    },
    sink
  );

  const total = fileSize(partial);
  if (expected && total !== expected) {
    throw new Error(`下载不完整 (${total}/${expected} 字节)`);
  }
  fs.renameSync(partial, target);
  return written;
}

/**
 * Download with retries. Every attempt resumes from the partial file, so a
 * flaky link only loses the bytes in flight.
 */
async function downloadModel(key, { userDataPath, onProgress, attempts = 6, signal }) {
  const target = modelPath(userDataPath, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const expected = (await remoteSize(key)) || fallbackBytes(key);
  const startedAt = Date.now();
  let downloaded = fileSize(`${target}.incomplete`);
  let lastEmit = 0;
  let speed = 0;
  let lastTick = Date.now();
  let lastBytes = downloaded;

  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 300) return;
    const elapsed = (now - lastTick) / 1000;
    if (elapsed > 0.05) {
      const instant = (downloaded - lastBytes) / elapsed;
      speed = speed ? speed * 0.65 + instant * 0.35 : instant;
      lastTick = now;
      lastBytes = downloaded;
    }
    lastEmit = now;
    const total = expected || downloaded;
    onProgress({
      downloaded,
      total,
      percent: total ? Math.min(downloaded / total, 0.999) : 0,
      speed: Math.round(speed),
      // A 2.9 GB transfer at ~700 KB/s takes over an hour; without a countdown
      // the panel looks stuck. Null until the speed estimate has settled.
      etaSeconds: speed > 1024 && total > downloaded ? Math.round((total - downloaded) / speed) : null,
      startedAt,
    });
  };

  emit(true);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadTo(key, target, expected, (n) => {
        downloaded += n;
        emit(false);
      }, signal);
      const size = fileSize(target);
      emit(true);
      return { size };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Re-sync the counter with what is actually on disk before retrying.
      downloaded = fileSize(`${target}.incomplete`);
      lastBytes = downloaded;
      lastTick = Date.now();
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 20) * 1000));
    }
  }
  throw new Error("下载失败");
}

module.exports = {
  MODEL_FILES,
  FALLBACK_BYTES,
  cacheDir,
  modelPath,
  modelFileName,
  modelUrl,
  fallbackBytes,
  resolveModel,
  isDownloaded,
  partialSize,
  hasPauseMarker,
  writePauseMarker,
  clearPauseMarker,
  fileSize,
  remoteSize,
  downloadModel,
};
