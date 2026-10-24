import type { ChatlogJson, ChatlogMessage, FileItem, Segment } from "@/types";

/** A voice message lifted out of a chatlog export. */
export interface ChatVoiceRef {
  index: number;
  time: string;
  sender: string;
  url: string;
  key: string;
}

export function isChatlogExport(value: unknown): value is ChatlogJson {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { messages?: unknown; chat?: unknown };
  if (!Array.isArray(candidate.messages)) return false;
  return candidate.messages.some(
    (item) => item && typeof item === "object" && typeof (item as ChatlogMessage).type === "string"
  );
}

function resolveVoiceUrl(message: ChatlogMessage): string | null {
  const direct = message.media_url;
  if (typeof direct === "string" && direct.startsWith("http")) return direct;

  const contents = message.contents ?? {};
  const host = typeof contents.host === "string" ? contents.host : null;
  const key = typeof contents.voice === "string" ? contents.voice : null;
  const proxy = typeof contents.proxyUrl === "string" ? contents.proxyUrl : null;
  if (host && key) return `http://${host}/voice/${key}`;
  if (host && proxy) return `http://${host}${proxy.startsWith("/") ? "" : "/"}${proxy}`;

  const match = typeof message.content === "string" ? message.content.match(/\((https?:\/\/[^)]+)\)/) : null;
  return match ? match[1] : null;
}

function voiceKey(message: ChatlogMessage): string {
  const fromContents = message.contents?.voice;
  if (typeof fromContents === "string" && fromContents) return fromContents;
  if (typeof message.media_path === "string") return message.media_path.split("/").pop() || message.media_path;
  return String(message.local_id ?? message.message_id ?? message.time ?? "voice");
}

/** Collect every voice message (in order) from a chatlog export. */
export function extractVoices(chatlog: ChatlogJson): ChatVoiceRef[] {
  const voices: ChatVoiceRef[] = [];
  chatlog.messages.forEach((message, index) => {
    if (message?.type !== "voice") return;
    const url = resolveVoiceUrl(message);
    if (!url) return;
    voices.push({
      index,
      time: typeof message.time === "string" ? message.time : "",
      sender: typeof message.sender === "string" ? message.sender : "未知",
      url,
      key: voiceKey(message),
    });
  });
  return voices;
}

export function chatItemLabel(voice: ChatVoiceRef): string {
  const clock = voice.time.includes(" ") ? voice.time.split(" ").pop() ?? voice.time : voice.time;
  return `${clock} · ${voice.sender}`;
}

export function joinTranscript(segments: Segment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Return a copy of the export with each voice message's `content` replaced by
 * its transcript. Messages without a finished transcript keep their original
 * content, so a partial run never destroys data.
 */
export function applyTranscripts(
  chatlog: ChatlogJson,
  items: { index: number; file: FileItem | undefined }[]
): { output: ChatlogJson; filled: number; missing: number } {
  const output = structuredClone(chatlog);
  let filled = 0;
  let missing = 0;

  for (const { index, file } of items) {
    const message = output.messages[index];
    if (!message) continue;
    const text = file && file.phase === "done" ? joinTranscript(file.segments) : "";
    if (text) {
      message.content = text;
      filled += 1;
    } else {
      missing += 1;
    }
  }

  return { output, filled, missing };
}

export function chatExportName(title: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "chatlog";
  return `${safe}-转写-${stamp}.json`;
}
