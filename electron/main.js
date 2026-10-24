const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const readline = require("node:readline");

const isDev = process.env.NODE_ENV === "development";
const ROOT = path.join(__dirname, "..");

let mainWindow = null;
let worker = null;
let workerReady = false;
let nextRequestId = 1;
const pending = new Map(); // requestId -> { resolve, reject, onEvent }
let modelSnapshot = null; // last "models" payload from the worker

/* ------------------------------------------------------------------ */
/* Python worker lifecycle                                             */
/* ------------------------------------------------------------------ */

function resolvePython() {
  const candidates = [
    process.env.VOICESCRIBE_PYTHON,
    path.join(ROOT, "python", ".venv", "bin", "python"),
    path.join(ROOT, "python", ".venv", "bin", "python3"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function pythonStatus() {
  const bin = resolvePython();
  return {
    available: Boolean(bin),
    path: bin,
    workerReady,
    hint: bin
      ? null
      : "未找到 Python 运行环境，请在项目根目录执行 npm run setup:python",
  };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startWorker() {
  const bin = resolvePython();
  if (!bin) {
    sendToRenderer("worker:status", pythonStatus());
    return;
  }

  const script = path.join(ROOT, "python", "worker.py");
  worker = spawn(bin, ["-u", script], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });

  const rl = readline.createInterface({ input: worker.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      workerReady = true;
      sendToRenderer("worker:status", pythonStatus());
      // Push a fresh model inventory as soon as the engine is up.
      worker.stdin.write(JSON.stringify({ cmd: "models" }) + "\n");
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

  worker.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (isDev) process.stderr.write(text);
    sendToRenderer("worker:log", text);
  });

  worker.on("exit", (code) => {
    workerReady = false;
    worker = null;
    modelSnapshot = null;
    for (const [, entry] of pending) {
      entry.onEvent({ type: "error", message: `转录进程已退出 (code ${code})` });
    }
    pending.clear();
    sendToRenderer("worker:status", pythonStatus());
  });

  sendToRenderer("worker:status", pythonStatus());
}

function stopWorker() {
  if (worker) {
    try {
      worker.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      /* ignore */
    }
    setTimeout(() => worker && worker.kill(), 800);
  }
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
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(ROOT, "dist", "index.html"));
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
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
// so the Python worker can decode them like any other audio file.
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

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle("worker:status", () => pythonStatus());

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
    worker.stdin.write(JSON.stringify({ cmd: "probe", id, file: filePath }) + "\n");
  });
});

ipcMain.handle("models:list", async () => {
  if (!worker || !workerReady) {
    return { ok: false, error: "转录引擎未就绪", snapshot: modelSnapshot };
  }
  worker.stdin.write(JSON.stringify({ cmd: "models" }) + "\n");
  return { ok: true, snapshot: modelSnapshot };
});

ipcMain.handle("models:download", async (_event, model) => {
  if (!worker || !workerReady) return { ok: false, error: "转录引擎未就绪" };
  worker.stdin.write(JSON.stringify({ cmd: "downloadModel", model }) + "\n");
  return { ok: true };
});

ipcMain.handle("transcribe:start", async (_event, options) => {
  if (!worker || !workerReady) {
    return { ok: false, error: "转录引擎未就绪，请确认 Python 环境已安装" };
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

  // Announce the request BEFORE writing to the worker: IPC messages are ordered,
  // so the renderer always binds requestId -> file before any segment arrives.
  sendToRenderer("transcribe:event", {
    type: "started",
    requestId: id,
    file,
    model,
    language,
  });

  worker.stdin.write(
    JSON.stringify({ cmd: "transcribe", id, file, model, language, prompt }) + "\n"
  );
  return { ok: true, requestId: id };
});

ipcMain.handle("transcribe:cancel", async (_event, requestId) => {
  if (!worker || !workerReady) return { ok: false };
  const id = nextRequestId++;
  worker.stdin.write(
    JSON.stringify({ cmd: "cancel", id, target: requestId }) + "\n"
  );
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
