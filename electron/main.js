const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const isDev = process.env.NODE_ENV === "development";
const ROOT = path.join(__dirname, "..");

let mainWindow = null;
let worker = null;
let workerReady = false;
let nextRequestId = 1;
const pending = new Map(); // requestId -> { resolve, reject, onEvent }
let modelSnapshot = null; // last "models" payload from the engine
let engineCrashed = false; // engine died without being asked to stop
let quitting = false;
let engineRestarts = 0; // consecutive automatic restarts after a crash
let engineStartedAt = 0;

/* ------------------------------------------------------------------ */
/* Engine lifecycle (whisper.cpp in a utility process)                 */
/* ------------------------------------------------------------------ */

/**
 * Path to the engine entry point, plus the NODE_PATH it needs.
 *
 * utilityProcess.fork needs a real file on disk: a path inside app.asar is not
 * spawnable (ENOTDIR), which leaves the packaged app stuck on "引擎启动中"
 * forever. electron-builder unpacks electron/engine next to the archive, but
 * Node then resolves modules from that directory upwards and never looks inside
 * app.asar — so `require("@fugood/whisper.node")` fails. Pointing NODE_PATH at
 * the archive's node_modules bridges the two.
 */
function engineEntry() {
  const inAsar = path.join(__dirname, "engine", "worker.js");
  const unpacked = inAsar.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : inAsar;
}

function engineNodePath() {
  const entry = engineEntry();
  const marker = `app.asar.unpacked${path.sep}`;
  if (!entry.includes(marker)) return null;
  const resources = entry.slice(0, entry.indexOf(marker));
  return path.join(resources, "app.asar", "node_modules");
}

function engineStatus() {
  return {
    available: !engineCrashed,
    path: worker ? engineEntry() : null,
    workerReady,
    hint: engineCrashed
      ? "本地转录引擎意外退出，正在尝试自动恢复；仍不行请重启应用"
      : workerReady
        ? null
        : "本地引擎启动中，请稍候",
  };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function engineMessage(payload) {
  try {
    worker?.postMessage(payload);
  } catch {
    /* engine already gone; the exit handler reports it */
  }
}

function startWorker() {
  engineCrashed = false;
  // window-all-closed sets this; a fresh start has to clear it or every later
  // crash would be silently ignored.
  quitting = false;
  engineStartedAt = Date.now();
  // Inference runs off the main process: loading a model blocks its JS thread
  // for seconds and a native crash would otherwise take the window with it.
  const nodePath = engineNodePath();
  worker = utilityProcess.fork(engineEntry(), [], {
    stdio: "pipe",
    serviceName: "VoiceScribe 引擎",
    env: {
      ...process.env,
      // The engine prepends this to its module search path. NODE_PATH alone is
      // not enough: Electron's utility process ignores it.
      ...(nodePath ? { VS_ENGINE_MODULES: nodePath } : {}),
    },
  });

  worker.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      workerReady = true;
      sendToRenderer("worker:status", engineStatus());
      engineMessage({ cmd: "models" });
      return;
    }
    // Model inventory / download progress is broadcast, not tied to a request.
    if (msg.type === "models" || String(msg.type).startsWith("model:")) {
      if (msg.type === "models") modelSnapshot = msg;
      sendToRenderer("model:event", msg);
      return;
    }
    // Route to the pending request that owns this id (or broadcast).
    const entry = msg.id != null ? pending.get(msg.id) : null;
    if (entry) entry.onEvent(msg);
    else sendToRenderer("worker:event", msg);
  });

  worker.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    // Packaged builds have no terminal, so a silent engine failure is
    // undebuggable; VS_ENGINE_DEBUG=1 surfaces it on stderr.
    if (isDev || process.env.VS_ENGINE_DEBUG === "1") process.stderr.write(text);
    sendToRenderer("worker:log", text);
  });
  worker.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    // Packaged builds have no terminal, so a silent engine failure is
    // undebuggable; VS_ENGINE_DEBUG=1 surfaces it on stderr.
    if (isDev || process.env.VS_ENGINE_DEBUG === "1") process.stderr.write(text);
    sendToRenderer("worker:log", text);
  });

  worker.on("exit", (code) => {
    workerReady = false;
    worker = null;
    modelSnapshot = null;
    const lived = Date.now() - engineStartedAt;
    // A non-zero exit nobody asked for means the native side died. Without a
    // restart the badge would stay on "引擎缺失" until the app is relaunched,
    // even though everything the engine needs (models, ffmpeg) is still fine.
    if (!quitting && code !== 0) {
      engineCrashed = true;
      console.error(`[engine] exited with code ${code} after ${(lived / 1000).toFixed(1)}s`);
    }
    for (const [, entry] of pending) {
      entry.onEvent({ type: "error", message: `转录进程已退出 (code ${code})` });
    }
    pending.clear();
    sendToRenderer("worker:status", engineStatus());

    if (quitting) return;
    // Reset the budget when the engine had been healthy for a while, so a rare
    // crash never exhausts the retries for the whole session.
    if (lived > 30000) engineRestarts = 0;
    if (engineRestarts >= 3) {
      console.error("[engine] giving up after 3 restarts");
      return;
    }
    engineRestarts += 1;
    setTimeout(() => {
      if (!quitting && !worker) {
        console.error(`[engine] restarting (attempt ${engineRestarts})`);
        startWorker();
      }
    }, 600 * engineRestarts);
  });

  engineMessage({ cmd: "init", userDataPath: app.getPath("userData") });
  sendToRenderer("worker:status", engineStatus());
}

function stopWorker() {
  quitting = true;
  if (!worker) return;
  const child = worker;
  worker = null;
  try {
    child.postMessage({ cmd: "shutdown" });
  } catch {
    /* ignore */
  }
  setTimeout(() => child.kill(), 800);
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    // Matches the panel minimums (252px queue + 1px divider + 420px transcript).
    minWidth: 700,
    minHeight: 640,
    show: false,
    backgroundColor: "#fafafa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  if (isDev) {
    // Keep in sync with VITE_PORT in vite.config.ts; the default avoids 5173,
    // which other local projects commonly occupy.
    mainWindow.loadURL(`http://localhost:${process.env.VITE_PORT || 5180}`);
  } else {
    mainWindow.loadFile(path.join(ROOT, "dist", "index.html"));
  }

  // Dev-only: drive the UI before the screenshot. VS_CLICK holds one or more
  // steps separated by "|", each "spec@delayMs": a CSS selector, or
  // "text=导出文本" to click the first button/menuitem containing that text.
  // Smoke tests use it to exercise cancel/export without a human at the keyboard.
  if (process.env.VS_CLICK) {
    const steps = process.env.VS_CLICK.split("|").map((raw) => {
      const [spec, delay] = raw.trim().split("@");
      return { spec, delay: Number(delay || 5000) };
    });
    mainWindow.webContents.once("did-finish-load", () => {
      for (const step of steps) {
        setTimeout(() => {
          mainWindow.webContents
            .executeJavaScript(
              `(() => {
                 const spec = ${JSON.stringify(step.spec)};
                 let el = null;
                 if (spec.startsWith("text=")) {
                   const wanted = spec.slice(5);
                   const nodes = [...document.querySelectorAll('button, [role="menuitem"], [role="tab"], a')];
                   el = nodes.find((n) => (n.textContent || "").includes(wanted)) || null;
                 } else {
                   el = document.querySelector(spec);
                 }
                 if (!el) return false;
                 // Radix menus open on pointerdown, so a bare .click() is not
                 // enough; replay the whole pointer sequence.
                 const rect = el.getBoundingClientRect();
                 const base = { bubbles: true, cancelable: true, composed: true, button: 0, isPrimary: true,
                                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
                 el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse" }));
                 el.dispatchEvent(new MouseEvent("mousedown", base));
                 el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse" }));
                 el.dispatchEvent(new MouseEvent("mouseup", base));
                 el.click();
                 return true;
               })()`
            )
            .then((ok) => console.log("[click]", step.spec, ok ? "ok" : "not found"))
            .catch((error) => console.error("[click] failed", error.message));
        }, step.delay);
      }
    });
  }

  // Dev-only: headless screenshot helper (VS_CAPTURE=/path/out.png)
  if (process.env.VS_CAPTURE) {
    mainWindow.webContents.once("did-finish-load", () => {
      const delay = Number(process.env.VS_CAPTURE_DELAY || 2500);
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.VS_CAPTURE, image.toPNG());
          console.log("[capture] wrote", process.env.VS_CAPTURE);
        } catch (error) {
          console.error("[capture] failed", error);
        }
        app.quit();
      }, delay);
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    mainWindow.webContents.on("console-message", (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
      console.error("[renderer] did-fail-load", code, description);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer] gone", details.reason);
    });
  }
}

app.whenReady().then(() => {
  startWorker();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      // macOS keeps the app alive with no windows; the engine was stopped by
      // window-all-closed, so it has to come back with the window or the badge
      // would read "引擎缺失" on a perfectly healthy app.
      if (!worker) startWorker();
    }
  });
});

app.on("window-all-closed", () => {
  // Stopping here frees the model/Metal memory while no window is open; the
  // engine is started again on "activate" (macOS) or on the next launch.
  stopWorker();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopWorker);

/* ------------------------------------------------------------------ */
/* Chat-log (chatlog export) helpers                                   */
/* ------------------------------------------------------------------ */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

ipcMain.handle("chat:read", async (_event, filePath) => {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 64 * 1024 * 1024) return { ok: false, error: "JSON 文件过大（超过 64MB）" };
    const text = await fs.promises.readFile(filePath, "utf8");
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Voice notes live on the local chatlog server; we copy them into the temp dir
// so the engine can decode them like any other audio file.
ipcMain.handle("chat:fetchVoice", async (_event, { url, key }) => {
  try {
    const parsed = new URL(String(url));
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { ok: false, error: "只支持从本机 chatlog 服务（127.0.0.1）拉取语音" };
    }
    const dir = path.join(app.getPath("temp"), "voicescribe-voices");
    await fs.promises.mkdir(dir, { recursive: true });
    const digest = crypto.createHash("sha1").update(String(key || url)).digest("hex").slice(0, 16);
    const target = path.join(dir, `${digest}.mp3`);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      return { ok: true, path: target, cached: true };
    }
    const response = await fetch(parsed.toString());
    if (!response.ok) return { ok: false, error: `语音下载失败 (HTTP ${response.status})` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return { ok: false, error: "语音内容为空" };
    await fs.promises.writeFile(target, buffer);
    return { ok: true, path: target, size: buffer.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/**
 * Start the engine if it is not running. Every engine-dependent handler calls
 * this first, so a crashed (or never-started) engine recovers on the next user
 * action instead of leaving the UI stuck on "引擎缺失".
 */
function ensureEngine() {
  if (!worker) startWorker();
  return worker;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle("worker:status", () => engineStatus());

ipcMain.handle("dialog:openMedia", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择视频或音频文件",
    properties: ["openFile"],
    filters: [
      { name: "视频 / 音频 / 聊天记录", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "flv", "wmv", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "json"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("media:probe", async (_event, filePath) => {
  ensureEngine();
  if (!worker || !workerReady) return { ok: false, error: "转录引擎未就绪" };
  const id = nextRequestId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "读取媒体信息超时" });
    }, 15000);
    pending.set(id, {
      onEvent(msg) {
        if (msg.type === "meta") {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ok: true, meta: msg });
        } else if (msg.type === "error") {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ok: false, error: msg.message });
        }
      },
    });
    engineMessage({ cmd: "probe", id, file: filePath });
  });
});

ipcMain.handle("models:list", async () => {
  ensureEngine();
  if (!worker || !workerReady) {
    return { ok: false, error: "转录引擎未就绪", snapshot: modelSnapshot };
  }
  engineMessage({ cmd: "models" });
  return { ok: true, snapshot: modelSnapshot };
});

ipcMain.handle("models:download", async (_event, model) => {
  ensureEngine();
  if (!worker || !workerReady) return { ok: false, error: "转录引擎未就绪" };
  engineMessage({ cmd: "downloadModel", model });
  return { ok: true };
});

ipcMain.handle("models:pause", async (_event, model) => {
  ensureEngine();
  if (!worker || !workerReady) return { ok: false, error: "转录引擎未就绪" };
  engineMessage({ cmd: "pauseDownload", model });
  return { ok: true };
});

ipcMain.handle("transcribe:start", async (_event, options) => {
  ensureEngine();
  if (!worker || !workerReady) {
    return { ok: false, error: "转录引擎未就绪，请稍候重试" };
  }
  const id = nextRequestId++;
  const { file, model, language, prompt } = options || {};

  pending.set(id, {
    onEvent(msg) {
      if (msg.type === "done" || msg.type === "error" || msg.type === "cancelled") {
        pending.delete(id);
      }
      sendToRenderer("transcribe:event", { ...msg, requestId: id });
    },
  });

  // Announce the request BEFORE handing it to the engine: IPC messages are
  // ordered, so the renderer always binds requestId -> file before any segment
  // arrives.
  sendToRenderer("transcribe:event", {
    type: "started",
    requestId: id,
    file,
    model,
    language,
  });

  engineMessage({ cmd: "transcribe", id, file, model, language, prompt });
  return { ok: true, requestId: id };
});

ipcMain.handle("transcribe:cancel", async (_event, requestId) => {
  if (!worker || !workerReady) return { ok: false };
  const id = nextRequestId++;
  engineMessage({ cmd: "cancel", id, target: requestId });
  return { ok: true };
});

ipcMain.handle("file:save", async (_event, { defaultName, content, filterName, extension }) => {
  // Smoke tests / screenshots: write straight into VS_SAVE_DIR instead of
  // opening the native dialog (which is modal and blocks automation).
  const autoDir = process.env.VS_SAVE_DIR;
  if (autoDir) {
    try {
      await fs.promises.mkdir(autoDir, { recursive: true });
      const target = path.join(autoDir, defaultName);
      await fs.promises.writeFile(target, content, "utf8");
      return { ok: true, filePath: target };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出转录文本",
    defaultPath: path.join(app.getPath("downloads"), defaultName),
    filters: [{ name: filterName || "文本文件", extensions: [extension || "txt"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(result.filePath, content, "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("dev:replay", async () => {
  const target = process.env.VS_REPLAY;
  if (!target || !fs.existsSync(target)) return null;
  try {
    return JSON.parse(await fs.promises.readFile(target, "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("shell:reveal", async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("clipboard:write", async (_event, text) => {
  const { clipboard } = require("electron");
  clipboard.writeText(text);
  return { ok: true };
});
