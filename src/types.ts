export type FilePhase = "pending" | "probing" | "transcribing" | "done" | "error";

export interface MediaMeta {
  size?: number;
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codec?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface FileItem {
  id: string;
  path: string;
  name: string;
  /** Display override (chat-log items show "20:16 陈兴" instead of a temp file name). */
  label?: string;
  ext: string;
  size: number;
  phase: FilePhase;
  stage?: "loading" | "downloading" | "decoding" | "transcribing";
  model?: string;
  meta?: MediaMeta;
  segments: Segment[];
  liveText: string;
  progress: number;
  language?: string;
  error?: string;
  requestId?: number;
}

export interface ModelDownload {
  downloaded: number;
  total: number;
  percent: number;
  speed: number;
  /** Seconds left, when the speed estimate is stable enough to be useful. */
  etaSeconds?: number | null;
  startedAt?: number;
  /** True when the user stopped the download; bytes stay on disk, resumable. */
  paused?: boolean;
}

export interface ModelInfo {
  name: string;
  repo: string;
  downloaded: boolean;
  sizeBytes: number;
  expectedBytes: number;
  path: string | null;
  download?: ModelDownload;
}

export interface ModelsSnapshot {
  models: ModelInfo[];
  cacheDir: string;
}

export interface WorkerStatus {
  available: boolean;
  path: string | null;
  workerReady: boolean;
  hint: string | null;
}

export type WorkerEvent =
  | { type: "started"; file: string; model: string; language: string }
  | { type: "meta"; duration: number; hasAudio: boolean; hasVideo: boolean; codec?: string | null }
  | { type: "stage"; stage: "loading" | "downloading" | "decoding" | "transcribing"; model?: string }
  | { type: "info"; language: string; languageProbability: number; duration: number }
  | { type: "segment"; segment: Segment; progress: number }
  | { type: "done"; segments: Segment[]; language: string; duration: number; text: string }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export type ModelEvent =
  | ({ type: "models" } & ModelsSnapshot)
  | { type: "model:start"; model: string; total: number; downloaded?: number; percent?: number }
  | ({ type: "model:progress"; model: string } & ModelDownload)
  | { type: "model:done"; model: string; sizeBytes: number; cached?: boolean }
  | { type: "model:paused"; model: string } & ModelDownload
  | { type: "model:error"; model: string; message: string };

export interface ExportPayload {
  defaultName: string;
  content: string;
  filterName: string;
  extension: string;
}

/* ------------------------------------------------------------------ */
/* Chat-log (chatlog export) mode                                      */
/* ------------------------------------------------------------------ */

export interface ChatlogMessage {
  type?: string;
  time?: string;
  sender?: string;
  content?: string;
  media_url?: string;
  media_path?: string;
  contents?: {
    host?: string;
    voice?: string;
    proxyUrl?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ChatlogJson {
  chat?: string;
  username?: string;
  messages: ChatlogMessage[];
  [key: string]: unknown;
}

export interface ChatItem {
  /** Index into chatlog.messages */
  index: number;
  fileId: string;
  path: string;
  time: string;
  sender: string;
}

export interface ChatSession {
  sourcePath: string;
  fileName: string;
  title: string;
  chatlog: ChatlogJson;
  items: ChatItem[];
}
