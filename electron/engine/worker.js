/**
 * VoiceScribe engine — runs inside an Electron utilityProcess.
 *
 * Why a separate process: whisper.cpp loads models and runs inference on native
 * threads. Doing that on the main process would freeze the window (model load
 * alone blocks the JS thread for several seconds), and a native crash would take
 * the whole app down. The utility process keeps the UI responsive and isolates
 * failures.
 *
 * Protocol: structured messages over `process.parentPort`, shaped exactly like
 * the JSON-lines protocol the old Python worker spoke, so electron/main.js and
 * the renderer keep their contract.
 */

// When electron-builder unpacks this directory next to app.asar, Node resolves
// modules from here upwards and never looks inside the archive. The main process
// passes the archive's node_modules in VS_ENGINE_MODULES so the native binding
// and ffmpeg-static still resolve.
if (process.env.VS_ENGINE_MODULES) {
  // Must go through NODE_PATH + _initPaths(): patching this module's `paths`
  // array only affects worker.js, while the actual require happens from
  // transcriber.js, which computes its own search path.
  const sep = require("node:path").delimiter;
  process.env.NODE_PATH = [process.env.VS_ENGINE_MODULES, process.env.NODE_PATH].filter(Boolean).join(sep);
  require("node:module").Module._initPaths();
  delete process.env.VS_ENGINE_MODULES;
}

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const audio = require("./audio");
const models = require("./models");
const { Transcriber } = require("./transcriber");

const transcriber = new Transcriber();
const downloads = new Map(); // key -> AbortController
let userDataPath = "";

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

function emit(payload) {
  process.parentPort.postMessage(payload);
}

function log(...args) {
  // stderr is piped to the main process, which forwards it to the renderer log.
  process.stderr.write(`[engine] ${args.join(" ")}\n`);
}

/* ------------------------------------------------------------------ */
/* Model inventory                                                     */
/* ------------------------------------------------------------------ */

function modelSnapshot() {
  const items = Object.keys(models.MODEL_FILES).map((key) => {
    const target = models.modelPath(userDataPath, key);
    const size = models.fileSize(target);
    const item = {
      name: key,
      repo: `ggerganov/whisper.cpp/${models.modelFileName(key)}`,
      downloaded: models.isDownloaded(userDataPath, key),
      sizeBytes: size,
      expectedBytes: models.fallbackBytes(key),
      path: size > 0 ? target : null,
    };
    const download = downloads.get(key);
    if (download?.progress) item.download = download.progress;
    else if (paused.has(key) && models.partialSize(userDataPath, key) > 0) {
      item.download = { ...pausedSnapshot(key), paused: true };
    }
    return item;
  });
  return { models: items, cacheDir: models.cacheDir(userDataPath) };
}

function emitModels() {
  emit({ type: "models", ...modelSnapshot() });
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

/**
 * Models the user paused. Kept for the process lifetime so a paused download
 * stays paused until the user explicitly resumes it (or the app restarts, at
 * which point resuming is again an explicit action).
 */
const paused = new Set();

/**
 * Pick up where the previous session left off.
 *
 * A model download that was cut off by a quit/crash/network drop is not a user
 * decision to stop — leaving it paused made the app look like it "forgets" the
 * model on every restart, and the user had to babysit a 2.9 GB transfer. Only an
 * explicit pause is remembered (as a marker file); everything else resumes.
 */
function adoptPartials() {
  for (const key of Object.keys(models.MODEL_FILES)) {
    if (models.isDownloaded(userDataPath, key)) continue;
    if (models.partialSize(userDataPath, key) <= 0) continue;
    if (models.hasPauseMarker(userDataPath, key)) {
      paused.add(key);
      continue;
    }
    log(`resuming unfinished download: ${key}`);
    void ensureDownloaded(key, { force: true });
  }
}

/**
 * Start (or join) the download for one model.
 *
 * `force` marks an explicit user request, which is what un-pauses a model;
 * transcription calls without it, because a job must never silently resume a
 * download the user stopped.
 */
async function ensureDownloaded(key, { force = false } = {}) {
  if (models.isDownloaded(userDataPath, key)) return true;
  if (force) {
    paused.delete(key);
    models.clearPauseMarker(userDataPath, key);
  }

  const running = downloads.get(key);
  if (running) {
    await running.done;
    return models.isDownloaded(userDataPath, key);
  }
  if (paused.has(key)) return false;

  const controller = new AbortController();
  const entry = { controller, progress: pausedSnapshot(key) };
  entry.done = (async () => {
    // Announce the bytes already on disk, not 0: a resumed 2.9 GB download that
    // reports "0%" looks like it started over.
    emit({
      type: "model:start",
      model: key,
      total: entry.progress.total,
      downloaded: entry.progress.downloaded,
      percent: entry.progress.percent,
    });
    try {
      const { size } = await models.downloadModel(key, {
        userDataPath,
        signal: controller.signal,
        onProgress: (snapshot) => {
          entry.progress = snapshot;
          emit({ type: "model:progress", model: key, ...snapshot });
        },
      });
      models.clearPauseMarker(userDataPath, key);
      emit({ type: "model:done", model: key, sizeBytes: size });
      log(`model ${key} ready (${(size / 1024 ** 2).toFixed(0)} MB)`);
    } catch (error) {
      // A pause is an abort the user asked for: keep the bytes, report the
      // paused state instead of an error, and leave the model resumable.
      if (controller.signal.reason === "pause" || paused.has(key)) {
        paused.add(key);
        emit({ type: "model:paused", model: key, ...pausedSnapshot(key) });
        log(`model ${key} paused at ${(models.partialSize(userDataPath, key) / 1024 ** 2).toFixed(1)} MB`);
      } else {
        log(`model ${key} download failed: ${error.message}`);
        emit({ type: "model:error", model: key, message: error.message });
      }
    } finally {
      downloads.delete(key);
      emitModels();
    }
  })();

  downloads.set(key, entry);
  await entry.done;
  return models.isDownloaded(userDataPath, key);
}

/** Progress-shaped payload describing a paused model, for the models snapshot. */
function pausedSnapshot(key) {
  const downloaded = models.partialSize(userDataPath, key);
  const total = models.fallbackBytes(key);
  return { downloaded, total, percent: total ? downloaded / total : 0, speed: 0 };
}

function pauseDownload(key) {
  paused.add(key);
  // Remember the decision: without this marker the next launch would treat the
  // leftover bytes as an interrupted download and silently resume.
  models.writePauseMarker(userDataPath, key);
  const running = downloads.get(key);
  if (!running) return;
  running.controller.abort("pause");
}

/* ------------------------------------------------------------------ */
/* Transcription                                                       */
/* ------------------------------------------------------------------ */

async function transcribe(request) {
  const id = request.id;
  const file = request.file;
  const modelKey = models.resolveModel(request.model || "small");
  const language = request.language && request.language !== "auto" ? request.language : "auto";
  const controller = new AbortController();
  current = { id, controller };

  /** True when the user asked us to stop; the caller then just returns. */
  const cancelled = () => controller.signal.aborted;

  if (!file || !fs.existsSync(file)) {
    emit({ id, type: "error", message: `文件不存在: ${file}` });
    return;
  }

  let meta;
  try {
    meta = await audio.probe(file);
  } catch (error) {
    emit({ id, type: "error", message: `无法读取媒体文件: ${error.message}` });
    return;
  }

  emit({ id, type: "meta", ...meta });
  if (!meta.hasAudio) {
    emit({ id, type: "error", message: "该文件不含音频轨道" });
    return;
  }
  if (cancelled()) {
    emit({ id, type: "cancelled" });
    return;
  }

  try {
    // Weights first, with real progress, so the UI never sits on a bare spinner.
    if (!models.isDownloaded(userDataPath, modelKey)) {
      emit({ id, type: "stage", stage: "downloading", model: request.model });
      const ok = await ensureDownloaded(modelKey);
      if (cancelled()) {
        emit({ id, type: "cancelled" });
        return;
      }
      if (!ok) {
        // A paused download is a user decision, not a failure — say how to
        // continue instead of blaming the network.
        emit({
          id,
          type: "error",
          message: paused.has(modelKey)
            ? `模型 ${request.model || modelKey} 的下载已暂停，请在顶栏模型面板点「继续」后再转录`
            : "模型下载失败，请检查网络后重试",
        });
        return;
      }
    }

    emit({ id, type: "stage", stage: "loading", model: request.model });
    await transcriber.load(models.modelPath(userDataPath, modelKey), log);
    if (cancelled()) {
      emit({ id, type: "cancelled" });
      return;
    }

    emit({ id, type: "stage", stage: "decoding" });
    const { pcm } = await audio.decode(file, { duration: meta.duration, signal: controller.signal });
    if (cancelled()) {
      emit({ id, type: "cancelled" });
      return;
    }

    emit({ id, type: "stage", stage: "transcribing" });
    if (language !== "auto") {
      emit({ id, type: "info", language, languageProbability: 0, duration: meta.duration });
    }

    const result = await transcriber.transcribe({
      pcm,
      duration: meta.duration,
      language,
      prompt: request.prompt,
      onSegment: (segment, progress) => emit({ id, type: "segment", segment, progress }),
      // Only announce a language when it was detected; an explicit choice was
      // already reported above.
      onLanguage: (detected) => {
        if (language === "auto" && detected) {
          emit({ id, type: "info", language: detected, languageProbability: 0, duration: meta.duration });
        }
      },
    });

    if (result.aborted || cancelled()) {
      emit({ id, type: "cancelled" });
      return;
    }

    emit({
      id,
      type: "done",
      segments: result.segments,
      language: result.language || (language === "auto" ? "" : language),
      duration: meta.duration,
      text: result.text,
    });
  } catch (error) {
    if (cancelled() || error?.name === "AbortError" || /已取消/.test(error?.message || "")) {
      emit({ id, type: "cancelled" });
      return;
    }
    log(`transcribe failed: ${error?.stack || error}`);
    emit({ id, type: "error", message: error?.message || String(error) });
  } finally {
    if (current?.id === id) current = null;
  }
}


let current = null;

/* ------------------------------------------------------------------ */
/* Command loop                                                        */
/* ------------------------------------------------------------------ */

async function handle(message) {
  switch (message.cmd) {
    case "init":
      userDataPath = message.userDataPath;
      adoptPartials();
      emit({ type: "ready", pid: process.pid });
      emitModels();
      break;
    case "models":
      emitModels();
      break;
    case "downloadModel":
      void ensureDownloaded(models.resolveModel(message.model || "small"), { force: true });
      break;
    case "pauseDownload":
      pauseDownload(models.resolveModel(message.model || "small"));
      break;
    case "probe": {
      try {
        emit({ id: message.id, type: "meta", ...(await audio.probe(message.file)) });
      } catch (error) {
        emit({ id: message.id, type: "error", message: error.message });
      }
      break;
    }
    case "transcribe":
      void transcribe(message);
      break;
    case "cancel":
      if (current && current.id === message.target) {
        // Abort covers decode/download; transcriber.cancel() stops whisper.cpp
        // between windows. Both paths converge on a single "cancelled" event.
        current.controller.abort();
        transcriber.cancel();
      }
      break;
    case "shutdown":
      for (const entry of downloads.values()) entry.controller.abort("pause");
      await transcriber.release();
      process.exit(0);
      break;
    default:
      emit({ id: message.id, type: "error", message: `unknown command: ${message.cmd}` });
  }
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  handle(message).catch((error) => {
    log(`command failed: ${error?.stack || error}`);
    if (message?.id) emit({ id: message.id, type: "error", message: error?.message || String(error) });
  });
});

// A native crash inside whisper.cpp must not leave the UI spinning forever.
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error?.stack || error}`);
  if (current) emit({ id: current.id, type: "error", message: error?.message || String(error) });
});

log(`engine booted (${os.platform()}/${os.arch()}, ${os.cpus()?.length || 0} cores)`);
