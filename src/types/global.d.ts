import type {
  FileItem,
  MediaMeta,
  ModelEvent,
  ModelInfo,
  ModelsSnapshot,
  Segment,
  WorkerEvent,
  WorkerStatus,
} from "@/types";

declare global {
  interface Window {
    voiceScribe: {
      platform: string;
      initialFile?: string | null;
      autoStart?: boolean;
      initialModel?: string | null;
      workerStatus: () => Promise<WorkerStatus>;
      listModels: () => Promise<{ ok: boolean; error?: string; snapshot: ({ type: "models" } & ModelsSnapshot) | null }>;
      downloadModel: (model: string) => Promise<{ ok: boolean; error?: string }>;
      pauseDownload: (model: string) => Promise<{ ok: boolean; error?: string }>;
      onModelEvent: (handler: (event: ModelEvent) => void) => () => void;
      devReplay: () => Promise<{ file: string; language?: string; segments: Segment[] } | null>;
      openMedia: () => Promise<string | null>;
      readChatlog: (filePath: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      fetchVoice: (url: string, key: string) => Promise<{ ok: boolean; path?: string; error?: string; cached?: boolean }>;
      pathForFile: (file: File) => string | null;
      probe: (filePath: string) => Promise<{ ok: boolean; meta?: MediaMeta; error?: string }>;
      startTranscription: (options: {
        file: string;
        model: string;
        language: string;
        prompt?: string;
      }) => Promise<{ ok: boolean; requestId?: number; error?: string }>;
      cancelTranscription: (requestId: number) => Promise<{ ok: boolean }>;
      saveFile: (payload: {
        defaultName: string;
        content: string;
        filterName: string;
        extension: string;
      }) => Promise<{ ok: boolean; filePath?: string; error?: string; canceled?: boolean }>;
      reveal: (filePath: string) => Promise<void>;
      copy: (text: string) => Promise<{ ok: boolean }>;
      onTranscribeEvent: (handler: (event: WorkerEvent & { requestId: number }) => void) => () => void;
      onWorkerStatus: (handler: (status: WorkerStatus) => void) => () => void;
      onWorkerLog: (handler: (chunk: string) => void) => () => void;
    };
  }
}

export type { FileItem, MediaMeta, ModelEvent, ModelInfo, ModelsSnapshot, Segment, WorkerEvent, WorkerStatus };
