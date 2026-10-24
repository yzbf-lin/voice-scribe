import type { FileItem, Segment } from "@/types";
import { formatClock, formatSrtTime, languageLabel, stripExtension } from "./format";

export type ExportFormat = "txt" | "srt" | "md" | "json";

export const EXPORT_META: Record<
  ExportFormat,
  { label: string; extension: string; filterName: string; hint: string }
> = {
  txt: { label: "纯文本 (.txt)", extension: "txt", filterName: "文本文件", hint: "只保留文字内容" },
  srt: { label: "字幕 (.srt)", extension: "srt", filterName: "SubRip 字幕", hint: "带时间轴，可导入剪辑软件" },
  md: { label: "Markdown (.md)", extension: "md", filterName: "Markdown", hint: "带时间戳的笔记格式" },
  json: { label: "JSON (.json)", extension: "json", filterName: "JSON 数据", hint: "完整结构化数据" },
};

function joinParagraphs(segments: Segment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function buildExport(file: FileItem, format: ExportFormat): { content: string; defaultName: string } {
  const base = stripExtension(file.name);
  const segments = file.segments;

  switch (format) {
    case "srt": {
      const content = segments
        .map((s, i) => `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text.trim()}\n`)
        .join("\n");
      return { content, defaultName: `${base}.srt` };
    }
    case "md": {
      const lines = segments.map((s) => `**\`${formatClock(s.start)}\`** ${s.text.trim()}`);
      const content = [
        `# ${base}`,
        "",
        `> ${languageLabel(file.language)} · ${formatClock(file.meta?.duration ?? 0)} · ${segments.length} 段`,
        "",
        lines.join("\n\n"),
        "",
      ].join("\n");
      return { content, defaultName: `${base}.md` };
    }
    case "json": {
      const content = JSON.stringify(
        {
          file: file.path,
          name: file.name,
          language: file.language,
          duration: file.meta?.duration ?? null,
          model: null,
          exportedAt: new Date().toISOString(),
          segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          text: joinParagraphs(segments),
        },
        null,
        2
      );
      return { content, defaultName: `${base}.json` };
    }
    case "txt":
    default:
      return { content: joinParagraphs(segments) + "\n", defaultName: `${base}.txt` };
  }
}

export function plainText(file: FileItem): string {
  return joinParagraphs(file.segments);
}

/* ------------------------------------------------------------------ */
/* Merged export (several files → one document)                        */
/* ------------------------------------------------------------------ */

/**
 * One block of a merged document. `label` is the full heading; `clock` /
 * `speaker` are optional parts so chat transcripts can collapse the speaker
 * name when the same person keeps talking.
 */
export interface MergeEntry {
  label: string;
  clock?: string;
  speaker?: string;
  file: FileItem;
}

function sanitizeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "merged";
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Heading for a block, dropping the repeated speaker name. */
function headingOf(entry: MergeEntry, previous?: MergeEntry): string {
  if (!entry.clock) return entry.label;
  if (entry.speaker && previous?.speaker !== entry.speaker) return `[${entry.clock}] ${entry.speaker}`;
  return `[${entry.clock}]`;
}

interface MergeBlock {
  heading: string;
  body: string;
  file: FileItem;
}

function toBlocks(entries: MergeEntry[]): MergeBlock[] {
  const blocks: MergeBlock[] = [];
  let previous: MergeEntry | undefined;
  for (const entry of entries) {
    const body = joinParagraphs(entry.file.segments);
    if (!body) {
      previous = entry;
      continue;
    }
    blocks.push({ heading: headingOf(entry, previous), body, file: entry.file });
    previous = entry;
  }
  return blocks;
}

function blockDuration(file: FileItem): number {
  if (file.meta?.duration) return file.meta.duration;
  const last = file.segments[file.segments.length - 1];
  return last ? last.end : 0;
}

/** Plain text for "merge & copy" — one heading per block, blank line between. */
export function mergePlainText(entries: MergeEntry[], withHeadings = true): string {
  return toBlocks(entries)
    .map((block) => (withHeadings ? `${block.heading}\n${block.body}` : block.body))
    .join("\n\n");
}

export function buildMergedExport(
  entries: MergeEntry[],
  format: ExportFormat,
  title: string
): { content: string; defaultName: string } {
  const blocks = toBlocks(entries);
  const base = sanitizeName(title);
  const segments = blocks.reduce((sum, block) => sum + block.file.segments.length, 0);
  const duration = blocks.reduce((sum, block) => sum + blockDuration(block.file), 0);

  switch (format) {
    case "srt": {
      // Voice notes have no shared timeline, so cues are laid end to end in
      // queue order — good enough to load as a single subtitle track.
      let offset = 0;
      let index = 0;
      const cues: string[] = [];
      for (const block of blocks) {
        for (const segment of block.file.segments) {
          const text = segment.text.trim();
          if (!text) continue;
          index += 1;
          cues.push(
            `${index}\n${formatSrtTime(offset + segment.start)} --> ${formatSrtTime(offset + segment.end)}\n${text}\n`
          );
        }
        offset += blockDuration(block.file);
      }
      return { content: cues.join("\n"), defaultName: `${base}-合并-${stamp()}.srt` };
    }
    case "md": {
      const content = [
        `# ${title}`,
        "",
        `> ${blocks.length} 段 · ${formatClock(duration)} · ${segments} 句`,
        "",
        ...blocks.map((block) => `## ${block.heading}\n\n${block.body}\n`),
      ].join("\n");
      return { content, defaultName: `${base}-合并-${stamp()}.md` };
    }
    case "json": {
      const content = JSON.stringify(
        {
          title,
          exportedAt: new Date().toISOString(),
          count: blocks.length,
          duration,
          files: blocks.map((block) => ({
            label: block.heading,
            path: block.file.path,
            name: block.file.name,
            language: block.file.language,
            duration: block.file.meta?.duration ?? null,
            segments: block.file.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
            text: block.body,
          })),
          text: blocks.map((block) => `${block.heading}\n${block.body}`).join("\n\n"),
        },
        null,
        2
      );
      return { content, defaultName: `${base}-合并-${stamp()}.json` };
    }
    case "txt":
    default: {
      const content = blocks.map((block) => `${block.heading}\n${block.body}`).join("\n\n");
      return { content: `${content}\n`, defaultName: `${base}-合并-${stamp()}.txt` };
    }
  }
}
