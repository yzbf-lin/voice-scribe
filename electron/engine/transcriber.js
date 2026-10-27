/**
 * Whisper inference through whisper.cpp (the @fugood/whisper.node binding).
 *
 * This is the piece that used to be Python + faster-whisper. The public shape of
 * what it returns is unchanged: segments with start/end in seconds and a plain
 * text body, so the renderer and the export code keep working untouched.
 */

const os = require("node:os");
const { initWhisper } = require("@fugood/whisper.node");

const SIMPLIFIED_HINT = "以下是普通话对话，请用简体中文转写。";

/**
 * Metal on Apple Silicon is roughly 5x faster than the CPU path; elsewhere
 * whisper.cpp runs on CPU threads. VOICESCRIBE_GPU=0 disables it.
 */
function useGpu() {
  if (process.env.VOICESCRIBE_GPU === "0") return false;
  if (process.env.VOICESCRIBE_GPU === "1") return true;
  return process.platform === "darwin" && process.arch === "arm64";
}

function threadCount() {
  const cores = os.cpus()?.length || 4;
  return Math.max(4, Math.min(8, cores - 2));
}

/** Strip punctuation/spacing so a prompt echo can be compared with the prompt. */
function normalizeText(text) {
  return (text || "").replace(/[\s，。、？！,.?!:：；;"'“”‘’()（）…—\-]/g, "");
}

/**
 * Whisper happily transcribes the initial prompt when a clip is silent or very
 * quiet. Such a segment is noise, not speech.
 */
function isPromptEcho(text, promptText) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  const prompt = normalizeText(promptText);
  return Boolean(prompt) && (normalized.includes(prompt) || prompt.includes(normalized));
}

/**
 * Whisper answers in Traditional Chinese for Mandarin audio unless the prompt
 * says otherwise, so Chinese requests always carry a Simplified hint.
 */
function initialPrompt(prompt, language) {
  const text = (prompt || "").trim();
  if (language === "zh") return text ? `${text} ${SIMPLIFIED_HINT}` : SIMPLIFIED_HINT;
  return text || undefined;
}

/** How much audio the language probe listens to before committing. */
const DETECT_SECONDS = 30;
const SAMPLE_RATE = 16000; // matches audio.decode()
const BYTES_PER_SAMPLE = 2;

class Transcriber {
  constructor() {
    this.context = null;
    this.loadedPath = null;
    this.currentStop = null;
    // A cancel that lands before whisper.cpp hands us its stop handle (model
    // load, language probe) would otherwise be lost, and the job would then run
    // to completion with no way to interrupt it.
    this.cancelRequested = false;
  }

  get ready() {
    return Boolean(this.context);
  }

  /** Load (or reuse) the model. Loading blocks this process for a few seconds. */
  async load(modelPath, onLog) {
    if (this.context && this.loadedPath === modelPath) return this.context;
    await this.release();
    onLog?.(`loading model ${modelPath}`);
    const context = await initWhisper({ filePath: modelPath, useGpu: useGpu() });
    this.context = context;
    this.loadedPath = modelPath;
    onLog?.(`model ready (gpu=${useGpu()})`);
    return context;
  }

  async release() {
    const context = this.context;
    this.context = null;
    this.loadedPath = null;
    if (!context) return;
    try {
      await context.release();
    } catch {
      /* already gone */
    }
  }

  /**
   * Detect the spoken language from the first 30 s.
   *
   * whisper.cpp only reports the detected language in the final result, which is
   * far too late to influence the prompt — a Mandarin clip run with `auto` came
   * back in Traditional Chinese. A one-second probe up front lets the real run
   * start with the right hint. Only trusted when it is unambiguous enough to
   * matter; anything else stays `auto`.
   */
  async detectLanguage(pcm, fallback) {
    const context = this.context;
    if (!context) return fallback;
    const limit = DETECT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
    const slice = pcm.subarray(0, Math.min(pcm.length, limit));
    const audio = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    try {
      const result = await context.transcribeData(audio, { language: "auto", maxLen: 1, beamSize: 1 }).promise;
      return result.language || fallback;
    } catch {
      return fallback;
    }
  }

  /** Ask the in-flight job to stop. whisper.cpp checks this between windows. */
  cancel() {
    this.cancelRequested = true;
    const stop = this.currentStop;
    this.currentStop = null;
    if (stop) {
      try {
        stop();
      } catch {
        /* job already finished */
      }
    }
  }

  /**
   * Transcribe 16 kHz mono s16le PCM.
   *
   * `onSegment` fires as whisper.cpp emits text, `onProgress` with 0..1.
   * Resolves with { segments, text, language, aborted }.
   */
  async transcribe({ pcm, duration, language, prompt, onSegment, onProgress, onLanguage }) {
    const context = this.context;
    if (!context) throw new Error("模型尚未加载");

    this.cancelRequested = false;
    const requested = !language || language === "auto" ? "auto" : language;
    // A short probe first, so an auto-detected Chinese clip still gets the
    // Simplified hint before the real pass starts.
    const lang = requested === "auto" ? await this.detectLanguage(pcm, "auto") : requested;
    if (this.cancelRequested) return { segments: [], text: "", language: null, aborted: true };
    const promptText = initialPrompt(prompt, lang === "auto" ? null : lang);
    const segments = [];
    const audio = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);

    const { promise, stop } = context.transcribeData(audio, {
      language: lang,
      beamSize: 5,
      maxThreads: threadCount(),
      prompt: promptText,
      onProgress: (percent) => onProgress?.(Math.min(Math.max(percent / 100, 0), 1)),
      onNewSegments: (chunk) => {
        for (const item of chunk.segments) {
          const text = String(item.text || "").trim();
          if (isPromptEcho(text, promptText)) continue;
          const segment = {
            id: segments.length,
            start: Math.round(item.t0) / 1000,
            end: Math.round(item.t1) / 1000,
            text,
          };
          segments.push(segment);
          onSegment?.(segment, duration ? Math.min(segment.end / duration, 1) : 0);
        }
      },
    });

    this.currentStop = stop;
    // The cancel may have arrived while we were still loading/probing.
    if (this.cancelRequested) {
      try {
        stop();
      } catch {
        /* already finished */
      }
    }
    const result = await promise;
    this.currentStop = null;
    const detected = result.language || (lang === "auto" ? null : lang);
    if (detected) onLanguage?.(detected);

    if (result.isAborted) {
      return { segments, text: segments.map((s) => s.text).join("\n"), language: detected, aborted: true };
    }

    // The callback already gave us the segments; fall back to the final list if
    // a platform skipped the callback (e.g. a very short clip).
    if (segments.length === 0 && result.segments.length > 0) {
      for (const item of result.segments) {
        const text = String(item.text || "").trim();
        if (isPromptEcho(text, promptText)) continue;
        segments.push({
          id: segments.length,
          start: Math.round(item.t0) / 1000,
          end: Math.round(item.t1) / 1000,
          text,
        });
      }
    }

    return {
      segments,
      text: segments.map((s) => s.text).join("\n"),
      language: detected,
      aborted: false,
    };
  }
}

module.exports = { Transcriber, isPromptEcho, normalizeText, initialPrompt, useGpu, threadCount, SIMPLIFIED_HINT };
