/**
 * Media probing + decoding through the bundled ffmpeg binary.
 *
 * whisper.cpp can only decode wav/mp3/flac through miniaudio; mp4/mov/mkv need
 * a real demuxer, so every file goes through ffmpeg first. Decoding the whole
 * track up front also lets us report honest progress (PCM bytes / expected
 * bytes) instead of guessing.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // s16le mono

function ffmpegPath() {
  if (process.env.VOICESCRIBE_FFMPEG) return process.env.VOICESCRIBE_FFMPEG;

  // ffmpeg-static resolves the binary through __dirname, which points inside
  // app.asar once packaged. The binary itself is unpacked (see asarUnpack), and
  // spawning a path that runs through the asar archive fails with ENOTDIR —
  // so rewrite the path to the unpacked copy.
  const bundled = require("ffmpeg-static");
  if (!bundled) return null;
  const unpacked = bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : bundled;
}

function parseDuration(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Read container metadata without transcoding (fast: ffmpeg exits right after
 * it has printed the input header).
 */
function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-i", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Stop as soon as the header is complete; ffmpeg would otherwise wait for
      // an output target and eventually fail with "At least one output file".
      if (/Stream #\d+:\d+/.test(stderr) && /Duration:|Stream #/.test(stderr)) {
        setTimeout(() => child.kill("SIGKILL"), 30);
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      if (!/Input #0/.test(stderr)) {
        reject(new Error("无法读取该文件（不是有效的音视频容器）"));
        return;
      }
      const duration = parseDuration(stderr);
      const audioLine = stderr.split("\n").find((line) => /Stream #\d+:\d+.*: Audio:/.test(line));
      const videoLine = stderr.split("\n").find((line) => /Stream #\d+:\d+.*: Video:/.test(line));
      const sampleRate = audioLine ? Number((audioLine.match(/(\d+) Hz/) || [])[1] || 0) : 0;
      const channels = audioLine
        ? audioLine.includes("stereo")
          ? 2
          : (audioLine.match(/,\s*(\d+) channels?/) || [])[1]
            ? Number((audioLine.match(/,\s*(\d+) channels?/) || [])[1])
            : 1
        : 0;
      const codec = audioLine ? (audioLine.match(/Audio:\s*([a-z0-9_]+)/i) || [])[1] || null : null;
      resolve({
        size: fs.statSync(file).size,
        duration: Math.round(duration * 100) / 100,
        hasAudio: Boolean(audioLine),
        hasVideo: Boolean(videoLine),
        sampleRate: sampleRate || null,
        channels: channels || null,
        codec,
      });
    });
  });
}

/**
 * Decode any container to mono 16 kHz signed 16-bit PCM.
 * Resolves with { pcm: Buffer, duration } and reports byte progress as it fills.
 */
function decode(file, { duration = 0, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"));
      return;
    }
    const args = [
      "-nostdin",
      "-v", "error",
      "-i", file,
      "-vn",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-",
    ];
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let received = 0;
    let stderr = "";
    const expected = duration > 0 ? Math.round(duration * SAMPLE_RATE * BYTES_PER_SAMPLE) : 0;

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (onProgress && expected > 0) {
        onProgress(Math.min(received / expected, 0.99));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("已取消"));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim().split("\n").pop() || `解码失败 (ffmpeg ${code})`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) {
        reject(new Error("未能从该文件解码出音频"));
        return;
      }
      onProgress?.(1);
      resolve({ pcm, duration: pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE });
    });
  });
}

module.exports = { probe, decode, ffmpegPath, SAMPLE_RATE };
