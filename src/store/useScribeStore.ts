import { create } from "zustand";
import type {
  ChatSession,
  FileItem,
  MediaMeta,
  ModelDownload,
  ModelEvent,
  ModelInfo,
  Segment,
  WorkerEvent,
  WorkerStatus,
} from "@/types";
import { basename, extensionOf, stripExtension } from "@/lib/format";
import { MODEL_LABELS } from "@/lib/models";
import {
  applyTranscripts,
  chatExportName,
  chatItemLabel,
  extractVoices,
  isChatlogExport,
} from "@/lib/chatlog";
import {
  buildMergedExport,
  mergePlainText,
  type ExportFormat,
  type MergeEntry,
} from "@/lib/export";

let uid = 0;
const nextId = () => `f${++uid}-${Date.now().toString(36)}`;

export interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: "default" | "success" | "error";
}

interface ScribeState {
  files: FileItem[];
  activeId: string | null;
  model: string;
  languagePref: string;
  prompt: string;
  worker: WorkerStatus | null;
  toasts: Toast[];
  models: ModelInfo[];
  cacheDir: string | null;
  downloads: Record<string, ModelDownload>;
  modelErrors: Record<string, string>;
  chat: ChatSession | null;
  chatRunning: boolean;
  chatBusy: boolean;
  /** Chat mode: read the whole conversation at once, or a single clip. */
  chatView: "merged" | "single";
  /** Multi-select in the queue, for merge-copy / merge-export. */
  selectedIds: string[];

  setWorker: (worker: WorkerStatus) => void;
  setModel: (model: string) => void;
  setLanguagePref: (language: string) => void;
  setPrompt: (prompt: string) => void;

  refreshModels: () => Promise<void>;
  downloadModel: (model: string) => Promise<void>;
  handleModelEvent: (event: ModelEvent) => void;

  addPaths: (paths: string[], labels?: (string | undefined)[]) => Promise<void>;
  addDroppedFiles: (files: File[]) => Promise<void>;
  removeFile: (id: string) => void;
  setActive: (id: string) => void;
  /** Open one item, leaving the merged chat view. */
  openSingle: (id: string) => void;
  reorder: (fromId: string, toId: string) => void;

  toggleSelect: (id: string, range?: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;
  copyMerged: (ids?: string[]) => Promise<void>;
  exportMerged: (format: ExportFormat, ids?: string[]) => Promise<void>;

  openChatlog: (path: string) => Promise<void>;
  transcribeChat: () => Promise<void>;
  exportChat: () => Promise<void>;
  setChatView: (view: "merged" | "single") => void;
  closeChat: () => void;

  startTranscription: (id?: string) => Promise<void>;
  cancelTranscription: () => Promise<void>;
  handleEvent: (event: WorkerEvent & { requestId: number }) => void;

  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  clearAll: () => void;
  hydrate: (fileId: string, payload: { segments: Segment[]; language?: string }) => void;
}

const initialFile = (path: string, label?: string): FileItem => {
  const name = basename(path);
  return {
    id: nextId(),
    path,
    name,
    label,
    ext: extensionOf(name),
    size: 0,
    phase: "pending",
    segments: [],
    liveText: "",
    progress: 0,
  };
};

/**
 * Turn the selected ids into merge blocks, keeping queue order. In chat mode
 * each block is headed by the message clock (and speaker when it changes), so
 * a merged transcript still reads like a conversation.
 */
function mergeEntriesFor(files: FileItem[], chat: ChatSession | null, ids: string[]): MergeEntry[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const items = chat ? new Map(chat.items.map((item) => [item.fileId, item])) : null;

  return ids
    .map((id) => byId.get(id))
    .filter((file): file is FileItem => Boolean(file))
    .map((file) => {
      const item = items?.get(file.id);
      if (!item) return { label: file.label ?? file.name, file };
      const clock = item.time.includes(" ") ? item.time.split(" ").pop() ?? item.time : item.time;
      return { label: `${clock} · ${item.sender}`, clock, speaker: item.sender, file };
    });
}

export const useScribeStore = create<ScribeState>((set, get) => ({
  files: [],
  activeId: null,
  model: "small",
  languagePref: "auto",
  prompt: "",
  worker: null,
  toasts: [],
  models: [],
  cacheDir: null,
  downloads: {},
  modelErrors: {},
  chat: null,
  chatRunning: false,
  chatBusy: false,
  chatView: "merged",
  selectedIds: [],

  setWorker: (worker) => set({ worker }),
  setModel: (model) => set({ model }),
  setLanguagePref: (languagePref) => set({ languagePref }),
  setPrompt: (prompt) => set({ prompt }),

  refreshModels: async () => {
    const result = await window.voiceScribe.listModels();
    if (result.snapshot) get().handleModelEvent(result.snapshot);
  },

  downloadModel: async (model) => {
    const result = await window.voiceScribe.downloadModel(model);
    if (!result.ok) {
      get().pushToast({ title: "无法开始下载", description: result.error || "引擎未就绪", variant: "error" });
      return;
    }
    set((state) => ({
      downloads: {
        ...state.downloads,
        [model]: state.downloads[model] ?? { downloaded: 0, total: 0, percent: 0, speed: 0 },
      },
      modelErrors: Object.fromEntries(Object.entries(state.modelErrors).filter(([key]) => key !== model)),
    }));
  },

  handleModelEvent: (event) => {    switch (event.type) {
      case "models": {
        const running: Record<string, ModelDownload> = {};
        for (const item of event.models) {
          if (item.download) running[item.name] = item.download;
        }
        set({ models: event.models, cacheDir: event.cacheDir, downloads: running });
        break;
      }
      case "model:start":
        set((state) => ({
          downloads: {
            ...state.downloads,
            [event.model]: { downloaded: 0, total: event.total, percent: 0, speed: 0 },
          },
        }));
        break;
      case "model:progress":
        set((state) => ({
          downloads: {
            ...state.downloads,
            [event.model]: {
              downloaded: event.downloaded,
              total: event.total,
              percent: event.percent,
              speed: event.speed,
              startedAt: event.startedAt,
            },
          },
        }));
        break;
      case "model:done": {
        set((state) => {
          const downloads = { ...state.downloads };
          delete downloads[event.model];
          return {
            downloads,
            models: state.models.map((item) =>
              item.name === event.model
                ? { ...item, downloaded: true, sizeBytes: event.sizeBytes, download: undefined }
                : item
            ),
          };
        });
        if (!event.cached) {
          const label = MODEL_LABELS[event.model] ?? event.model;
          get().pushToast({ title: `模型 ${label} 已就绪`, description: "已保存到本地，可离线使用", variant: "success" });
        }
        get().refreshModels();
        break;
      }
      case "model:error": {
        set((state) => {
          const downloads = { ...state.downloads };
          delete downloads[event.model];
          return { downloads, modelErrors: { ...state.modelErrors, [event.model]: event.message } };
        });
        get().pushToast({ title: "模型下载失败", description: event.message, variant: "error" });
        get().refreshModels();
        break;
      }
      default:
        break;
    }
  },

  addPaths: async (paths, labels) => {
    if (paths.length === 0) return;

    // A chatlog export is a container, not media: expand it into voice items.
    const chatPaths = paths.filter((path) => extensionOf(path) === "json");
    if (chatPaths.length > 0) {
      for (const chatPath of chatPaths) await get().openChatlog(chatPath);
      paths = paths.filter((path) => extensionOf(path) !== "json");
      labels = undefined;
      if (paths.length === 0) return;
    }

    const existing = new Set(get().files.map((f) => f.path));
    const fresh = paths
      .map((path, index) => ({ path, label: labels?.[index] }))
      .filter((entry) => Boolean(entry.path) && !existing.has(entry.path))
      .map((entry) => initialFile(entry.path, entry.label));
    if (fresh.length === 0) {
      get().pushToast({ title: "文件已在列表中", variant: "default" });
      return;
    }

    set((state) => ({
      files: [...state.files, ...fresh],
      activeId: state.activeId ?? fresh[0].id,
    }));

    // Probe metadata in parallel; UI stays responsive.
    await Promise.all(
      fresh.map(async (file) => {
        set((state) => ({
          files: state.files.map((f) => (f.id === file.id ? { ...f, phase: "probing" } : f)),
        }));
        const result = await window.voiceScribe.probe(file.path);
        set((state) => ({
          files: state.files.map((f) =>
            f.id === file.id
              ? result.ok && result.meta
                ? { ...f, phase: "pending", meta: result.meta as MediaMeta, size: result.meta.size ?? f.size }
                : { ...f, phase: "error", error: result.error || "无法读取媒体信息" }
              : f
          ),
        }));
      })
    );
  },

  addDroppedFiles: async (dropped) => {
    const paths = dropped
      .map((file) => window.voiceScribe.pathForFile(file) || "")
      .filter(Boolean);
    if (paths.length === 0) {
      get().pushToast({ title: "无法读取拖入的文件路径", variant: "error" });
      return;
    }
    await get().addPaths(paths);
  },

  removeFile: (id) =>
    set((state) => {
      const files = state.files.filter((f) => f.id !== id);
      const activeId = state.activeId === id ? files[0]?.id ?? null : state.activeId;
      return { files, activeId, selectedIds: state.selectedIds.filter((x) => x !== id) };
    }),

  setActive: (id) => set({ activeId: id }),

  openSingle: (id) =>
    set((state) => ({ activeId: id, chatView: state.chat ? "single" : state.chatView })),

  reorder: (fromId, toId) =>
    set((state) => {
      if (fromId === toId) return state;
      const files = [...state.files];
      const from = files.findIndex((f) => f.id === fromId);
      const to = files.findIndex((f) => f.id === toId);
      if (from < 0 || to < 0) return state;
      const [moved] = files.splice(from, 1);
      files.splice(to, 0, moved);
      return { files };
    }),

  toggleSelect: (id, range) =>
    set((state) => {
      const selected = state.selectedIds;
      // Shift-click extends from the last picked item to this one.
      if (range && selected.length > 0) {
        const order = state.files.map((f) => f.id);
        const anchor = order.indexOf(selected[selected.length - 1]);
        const target = order.indexOf(id);
        if (anchor >= 0 && target >= 0) {
          const [start, end] = anchor < target ? [anchor, target] : [target, anchor];
          const span = order.slice(start, end + 1);
          return { selectedIds: Array.from(new Set([...selected, ...span])) };
        }
      }
      return {
        selectedIds: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
      };
    }),

  selectAll: () => set((state) => ({ selectedIds: state.files.map((f) => f.id) })),

  clearSelection: () => set({ selectedIds: [] }),

  copyMerged: async (ids) => {
    const state = get();
    const target = ids ?? state.selectedIds;
    const entries = mergeEntriesFor(state.files, state.chat, target);
    const text = mergePlainText(entries);
    if (!text) {
      state.pushToast({ title: "没有可复制的文字", description: "先完成转录", variant: "error" });
      return;
    }
    await window.voiceScribe.copy(text);
    state.pushToast({
      title: `已复制 ${entries.length} 条 · 合并文本`,
      description: `${text.replace(/\s+/g, "").length} 字`,
      variant: "success",
    });
  },

  exportMerged: async (format, ids) => {
    const state = get();
    const target = ids ?? state.selectedIds;
    const entries = mergeEntriesFor(state.files, state.chat, target);
    if (entries.length === 0) return;
    const title = state.chat?.title ?? (entries.length === 1 ? entries[0].label : "合并转写");
    const { content, defaultName } = buildMergedExport(entries, format, title);
    const meta =
      format === "srt"
        ? { filterName: "SubRip 字幕", extension: "srt" }
        : format === "md"
          ? { filterName: "Markdown", extension: "md" }
          : format === "json"
            ? { filterName: "JSON 数据", extension: "json" }
            : { filterName: "文本文件", extension: "txt" };
    const result = await window.voiceScribe.saveFile({ defaultName, content, ...meta });
    if (result.ok) {
      state.pushToast({
        title: `已导出合并 ${meta.extension.toUpperCase()}`,
        description: `${entries.length} 条 · ${result.filePath ?? defaultName}`,
        variant: "success",
      });
    } else if (result.error) {
      state.pushToast({ title: "导出失败", description: result.error, variant: "error" });
    }
  },

  openChatlog: async (path) => {
    if (get().files.some((f) => f.phase === "transcribing")) {
      get().pushToast({ title: "请先等待当前转录结束", description: "聊天记录模式会重置文件队列", variant: "error" });
      return;
    }

    set({ chatBusy: true });
    try {
      const read = await window.voiceScribe.readChatlog(path);
      if (!read.ok || !isChatlogExport(read.data)) {
        get().pushToast({
          title: "无法识别聊天记录",
          description: read.error || "需要 chatlog 导出的 JSON（含 messages 数组）",
          variant: "error",
        });
        return;
      }

      const chatlog = read.data;
      const voices = extractVoices(chatlog);
      if (voices.length === 0) {
        get().pushToast({ title: "这份记录里没有语音消息", variant: "default" });
        return;
      }

      // Voice notes are pulled from the local chatlog server, a few at a time.
      const queue = [...voices];
      const downloaded: { voice: (typeof voices)[number]; path: string }[] = [];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const voice = queue.shift();
          if (!voice) break;
          const result = await window.voiceScribe.fetchVoice(voice.url, voice.key);
          if (result.ok && result.path) downloaded.push({ voice, path: result.path });
        }
      });
      await Promise.all(workers);

      if (downloaded.length === 0) {
        get().pushToast({
          title: "语音获取失败",
          description: "请确认 chatlog 服务正在运行（默认 127.0.0.1:5030）",
          variant: "error",
        });
        return;
      }
      if (downloaded.length < voices.length) {
        get().pushToast({
          title: `${voices.length - downloaded.length} 条语音未能获取`,
          description: "其余语音已就绪，可先转录",
          variant: "default",
        });
      }

      downloaded.sort((a, b) => a.voice.index - b.voice.index);

      set({ files: [], activeId: null, chat: null, selectedIds: [] });
      const paths = downloaded.map((entry) => entry.path);
      const labels = downloaded.map((entry) => chatItemLabel(entry.voice));
      await get().addPaths(paths, labels);

      const files = get().files;
      const items = downloaded
        .map((entry) => {
          const file = files.find((candidate) => candidate.path === entry.path);
          return file
            ? {
                index: entry.voice.index,
                fileId: file.id,
                path: entry.path,
                time: entry.voice.time,
                sender: entry.voice.sender,
              }
            : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      set({
        chat: {
          sourcePath: path,
          fileName: basename(path),
          title: typeof chatlog.chat === "string" && chatlog.chat ? chatlog.chat : "聊天记录",
          chatlog,
          items,
        },
        // WeChat voice notes are almost always Mandarin; "auto" would skip the
        // Simplified-Chinese hint and come back in Traditional characters.
        languagePref: get().languagePref === "auto" ? "zh" : get().languagePref,
        // One conversation split across many clips reads best as one document.
        chatView: "merged",
      });

      get().pushToast({
        title: `已载入 ${items.length} 条语音`,
        description: `${typeof chatlog.chat === "string" ? chatlog.chat : "聊天记录"} · 点「全部转录」开始`,
        variant: "success",
      });
    } finally {
      set({ chatBusy: false });
    }
  },

  transcribeChat: async () => {
    const chat = get().chat;
    if (!chat || get().chatRunning) return;

    set({ chatRunning: true });
    try {
      for (const item of chat.items) {
        const current = get().files.find((f) => f.id === item.fileId);
        if (!current || current.phase === "done") continue;

        set({ activeId: item.fileId });
        await new Promise<void>((resolve) => {
          let seen = false;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            resolve();
          };
          const unsubscribe = useScribeStore.subscribe((state) => {
            const file = state.files.find((f) => f.id === item.fileId);
            if (!file) return finish();
            if (file.phase === "transcribing") {
              seen = true;
              return;
            }
            if (file.phase === "done" || file.phase === "error") return finish();
            // Cancel puts the item back to pending.
            if (seen && file.phase === "pending") return finish();
          });

          void get().startTranscription(item.fileId);
          setTimeout(() => {
            if (!seen) finish();
          }, 2000);
        });

        const after = get().files.find((f) => f.id === item.fileId);
        if (!after || after.phase === "pending") break;
      }
    } finally {
      set({ chatRunning: false });
      const chat2 = get().chat;
      if (chat2) {
        const files = get().files;
        const done = chat2.items.filter((item) => files.find((f) => f.id === item.fileId)?.phase === "done").length;
        get().pushToast({
          title: done === chat2.items.length ? "全部语音已转写" : "已停止转录",
          description: `${done} / ${chat2.items.length} 条完成`,
          variant: done === chat2.items.length ? "success" : "default",
        });
      }
    }
  },

  exportChat: async () => {
    const chat = get().chat;
    if (!chat) return;
    const files = get().files;
    const { output, filled, missing } = applyTranscripts(
      chat.chatlog,
      chat.items.map((item) => ({ index: item.index, file: files.find((f) => f.id === item.fileId) }))
    );

    // Always exportable: the document keeps every original field, and any voice
    // we have not transcribed yet simply keeps its original content.
    const result = await window.voiceScribe.saveFile({
      defaultName: chatExportName(chat.title),
      content: JSON.stringify(output, null, 2),
      filterName: "JSON",
      extension: "json",
    });
    if (result.ok) {
      get().pushToast({
        title: filled > 0 ? `已导出 · ${filled} 条语音已替换` : "已导出原始 JSON",
        description:
          filled === 0
            ? `${chat.items.length} 条语音尚未转写，内容保持原样`
            : missing > 0
              ? `另有 ${missing} 条未转写，保留原文`
              : result.filePath,
        variant: "success",
      });
    } else if (result.error) {
      get().pushToast({ title: "导出失败", description: result.error, variant: "error" });
    }
  },

  setChatView: (chatView) => set({ chatView }),

  closeChat: () => set({ chat: null }),

  startTranscription: async (id) => {
    const state = get();
    const targetId = id ?? state.activeId;
    const file = state.files.find((f) => f.id === targetId);
    if (!file) return;

    if (state.files.some((f) => f.phase === "transcribing")) {
      state.pushToast({ title: "已有转录任务在进行中", description: "请等待当前任务完成或取消", variant: "error" });
      return;
    }
    if (!state.worker?.workerReady) {
      state.pushToast({
        title: "转录引擎未就绪",
        description: state.worker?.hint || "请稍候重试",
        variant: "error",
      });
      return;
    }

    set((s) => ({
      activeId: targetId!,
      files: s.files.map((f) =>
        f.id === targetId
          ? {
              ...f,
              phase: "transcribing",
              stage: "loading",
              model: get().model,
              progress: 0,
              segments: [],
              liveText: "",
              error: undefined,
            }
          : f
      ),
    }));

    const response = await window.voiceScribe.startTranscription({
      file: file.path,
      model: get().model,
      language: get().languagePref,
      prompt: get().prompt.trim() || undefined,
    });

    if (!response.ok) {
      set((s) => ({
        files: s.files.map((f) =>
          f.id === targetId ? { ...f, phase: "error", error: response.error || "启动失败" } : f
        ),
      }));
      return;
    }

    if (!response.requestId) {
      set((s) => ({
        files: s.files.map((f) => (f.id === targetId ? { ...f, phase: "error", error: "引擎未返回任务号" } : f)),
      }));
    }
  },

  cancelTranscription: async () => {
    const running = get().files.find((f) => f.phase === "transcribing");
    if (!running?.requestId) return;
    await window.voiceScribe.cancelTranscription(running.requestId);
  },

  handleEvent: (event) => {
    if (event.type === "started") {
      set((state) => ({
        files: state.files.map((f) =>
          f.path === event.file
            ? {
                ...f,
                requestId: event.requestId,
                phase: "transcribing",
                stage: "loading",
                model: event.model,
                progress: 0,
                segments: [],
                liveText: "",
                error: undefined,
              }
            : f
        ),
      }));
      return;
    }

    const target = get().files.find((f) => f.requestId === event.requestId);
    if (!target) return;
    const id = target.id;

    const patch = (updater: (file: FileItem) => FileItem) =>
      set((state) => ({ files: state.files.map((f) => (f.id === id ? updater(f) : f)) }));

    switch (event.type) {
      case "stage":
        patch((f) => ({ ...f, stage: event.stage }));
        break;
      case "meta":
        patch((f) => ({
          ...f,
          meta: {
            duration: event.duration,
            hasAudio: event.hasAudio,
            hasVideo: event.hasVideo,
            codec: event.codec ?? f.meta?.codec,
            sampleRate: f.meta?.sampleRate,
            channels: f.meta?.channels,
          },
        }));
        break;
      case "info":
        patch((f) => ({ ...f, language: event.language }));
        break;
      case "segment":
        patch((f) => ({
          ...f,
          segments: [...f.segments, event.segment as Segment],
          liveText: event.segment.text,
          progress: event.progress,
        }));
        break;
      case "done":
        patch((f) => ({
          ...f,
          phase: "done",
          segments: event.segments,
          progress: 1,
          language: event.language,
          liveText: "",
        }));
        // Chat mode transcribes dozens of short clips; one toast per clip would
        // bury the UI, so the batch reports once at the end instead.
        if (!get().chatRunning) {
          get().pushToast({
            title: "转录完成",
            description: `${stripExtension(target.label ?? target.name)} · ${event.segments.length} 段`,
            variant: "success",
          });
        }
        break;
      case "cancelled":
        patch((f) => ({ ...f, phase: "pending", progress: 0, liveText: "" }));
        get().pushToast({ title: "已取消转录", variant: "default" });
        break;
      case "error":
        patch((f) => ({ ...f, phase: "error", error: event.message }));
        get().pushToast({ title: "转录失败", description: event.message, variant: "error" });
        break;
      default:
        break;
    }
  },

  pushToast: (toast) => {
    const id = Date.now() + Math.random();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => get().dismissToast(id), 4200);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearAll: () => set({ files: [], activeId: null, selectedIds: [] }),

  hydrate: (fileId, payload) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === fileId
          ? { ...f, phase: "done", segments: payload.segments, language: payload.language, progress: 1 }
          : f
      ),
    })),
}));

export const selectActiveFile = (state: ScribeState): FileItem | null =>
  state.files.find((f) => f.id === state.activeId) ?? null;

export const selectIsBusy = (state: ScribeState): boolean =>
  state.files.some((f) => f.phase === "transcribing");
