const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("voiceScribe", {
  platform: process.platform,
  initialFile: process.env.VS_OPEN_FILE || null,
  autoStart: process.env.VS_AUTOSTART === "1",
  initialModel: process.env.VS_MODEL || null,

  workerStatus: () => ipcRenderer.invoke("worker:status"),

  listModels: () => ipcRenderer.invoke("models:list"),

  downloadModel: (model) => ipcRenderer.invoke("models:download", model),

  pauseDownload: (model) => ipcRenderer.invoke("models:pause", model),

  onModelEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("model:event", listener);
    return () => ipcRenderer.removeListener("model:event", listener);
  },

  devReplay: () => ipcRenderer.invoke("dev:replay"),

  openMedia: () => ipcRenderer.invoke("dialog:openMedia"),

  readChatlog: (filePath) => ipcRenderer.invoke("chat:read", filePath),

  fetchVoice: (url, key) => ipcRenderer.invoke("chat:fetchVoice", { url, key }),

  // Electron 32+ removed File.path; this is the supported replacement.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  probe: (filePath) => ipcRenderer.invoke("media:probe", filePath),

  startTranscription: (options) => ipcRenderer.invoke("transcribe:start", options),

  cancelTranscription: (requestId) => ipcRenderer.invoke("transcribe:cancel", requestId),

  saveFile: (payload) => ipcRenderer.invoke("file:save", payload),

  reveal: (filePath) => ipcRenderer.invoke("shell:reveal", filePath),

  copy: (text) => ipcRenderer.invoke("clipboard:write", text),

  onTranscribeEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("transcribe:event", listener);
    return () => ipcRenderer.removeListener("transcribe:event", listener);
  },

  onWorkerStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("worker:status", listener);
    return () => ipcRenderer.removeListener("worker:status", listener);
  },

  onWorkerLog: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("worker:log", listener);
    return () => ipcRenderer.removeListener("worker:log", listener);
  },
});
