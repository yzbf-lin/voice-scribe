import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
  Loader2,
  MessagesSquare,
  Rows3,
  ScrollText,
  Subtitles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EXPORT_META, plainText, type ExportFormat } from "@/lib/export";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";
import type { FileItem } from "@/types";

const FORMAT_ICONS: Record<ExportFormat, typeof FileText> = {
  txt: FileText,
  srt: Subtitles,
  md: ScrollText,
  json: FileJson,
};

function clockOf(time: string): string {
  return time.includes(" ") ? time.split(" ").pop() ?? time : time;
}

function Block({
  file,
  clock,
  sender,
  showSender,
}: {
  file: FileItem;
  clock: string;
  sender: string;
  showSender: boolean;
}) {
  const activeId = useScribeStore((s) => s.activeId);
  const openSingle = useScribeStore((s) => s.openSingle);
  const toast = useScribeStore((s) => s.pushToast);
  const isActive = activeId === file.id;
  const text = useMemo(() => plainText(file), [file]);
  const transcribing = file.phase === "transcribing";

  return (
    <div
      data-voice-id={file.id}
      className={cn(
        "group relative rounded-lg border px-3 py-2.5 transition-colors",
        isActive ? "border-foreground/15 bg-card shadow-sm" : "border-border/60 bg-card/40 hover:bg-card/80"
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px]">
        <span className="tabular font-mono text-muted-foreground">{clock}</span>
        {showSender && <span className="min-w-0 truncate text-muted-foreground">{sender}</span>}
        {file.phase === "done" && (
          <span className="tabular shrink-0 text-muted-foreground/60">{file.segments.length} 句</span>
        )}
        {transcribing && (
          <span className="tabular inline-flex shrink-0 items-center gap-1 text-brand">
            <Loader2 className="size-2.5 animate-spin" />
            {Math.round(file.progress * 100)}%
          </span>
        )}
        {file.phase === "error" && <span className="shrink-0 text-destructive">失败</span>}
        {file.phase === "pending" && <span className="shrink-0 text-muted-foreground/50">待转录</span>}

        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {text && (
            <button
              type="button"
              onClick={() => {
                void window.voiceScribe.copy(text);
                toast({ title: "已复制本条", variant: "success" });
              }}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              复制
            </button>
          )}
          <button
            type="button"
            onClick={() => openSingle(file.id)}
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            单条
          </button>
        </div>
      </div>

      {transcribing && file.segments.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground/70">正在识别…</p>
      ) : text ? (
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.75] text-foreground/90 selection:bg-brand/15">
          {text}
        </p>
      ) : file.phase === "error" ? (
        <p className="text-[12px] text-destructive/80">{file.error ?? "转录失败"}</p>
      ) : file.phase === "done" ? (
        <p className="text-[12.5px] italic text-muted-foreground/50">（静音或没有识别到语音）</p>
      ) : null}

      {transcribing && file.segments.length > 0 && (
        <Progress value={file.progress * 100} className="mt-1.5 h-0.5" />
      )}
    </div>
  );
}

/**
 * Chat mode's "read it all" view: every voice note of one conversation in
 * order, so a conversation split across dozens of clips still reads (and
 * copies / exports) as a single document.
 */
export function MergedTranscript() {
  const chat = useScribeStore((s) => s.chat);
  const files = useScribeStore((s) => s.files);
  const activeId = useScribeStore((s) => s.activeId);
  const chatRunning = useScribeStore((s) => s.chatRunning);
  const setChatView = useScribeStore((s) => s.setChatView);
  const copyMerged = useScribeStore((s) => s.copyMerged);
  const exportMerged = useScribeStore((s) => s.exportMerged);
  const exportChat = useScribeStore((s) => s.exportChat);
  const pushToast = useScribeStore((s) => s.pushToast);
  const bodyRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    if (!chat) return [];
    const byId = new Map(files.map((file) => [file.id, file]));
    return chat.items
      .map((item) => {
        const file = byId.get(item.fileId);
        return file ? { item, file } : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [chat, files]);

  const ids = rows.map((row) => row.file.id);
  const done = rows.filter((row) => row.file.phase === "done").length;
  const words = rows.reduce(
    (sum, row) => sum + row.file.segments.reduce((n, s) => n + s.text.replace(/\s+/g, "").length, 0),
    0
  );

  // Follow the clip being transcribed.
  useEffect(() => {
    if (!activeId) return;
    const node = bodyRef.current?.querySelector<HTMLElement>(`[data-voice-id="${activeId}"]`);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  if (!chat) return null;

  const exportAs = (format: ExportFormat) => void exportMerged(format, ids);

  return (
    <div className="@container/doc flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[0.9rem] font-semibold tracking-tight" title={chat.fileName}>
              {chat.title}
            </h2>
            <Badge variant="outline" className="shrink-0 gap-1">
              <MessagesSquare className="size-2.5" />
              合并视图
            </Badge>
            {done === rows.length && rows.length > 0 && (
              <Badge variant="success" className="shrink-0">
                <Check className="size-2.5" />
                全部完成
              </Badge>
            )}
          </div>
          <p className="tabular mt-1 text-[11px] text-muted-foreground">
            {rows.length} 条语音 · 已转写 {done}
            {words > 0 ? ` · ${words} 字` : ""}
            {chatRunning ? " · 转录中" : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyMerged(ids)}
                disabled={done === 0}
                aria-label="复制全部"
              >
                <ClipboardCopy className="size-3.5" />
                <span className="@max-[600px]/doc:hidden">复制全部</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>把 {rows.length} 条语音的转写合并成一段文字复制</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default" size="sm" aria-label="导出">
                <Download className="size-3.5" />
                <span className="@max-[520px]/doc:hidden">导出</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>导出为一份文档</DropdownMenuLabel>
              {(Object.keys(EXPORT_META) as ExportFormat[]).map((format) => {
                const meta = EXPORT_META[format];
                const Icon = FORMAT_ICONS[format];
                return (
                  <DropdownMenuItem
                    key={format}
                    onSelect={() => exportAs(format)}
                    disabled={done === 0}
                    className="items-start py-2"
                  >
                    <Icon className="mt-0.5" />
                    <div className="flex flex-col">
                      <span className="font-medium">{meta.label}</span>
                      <span className="text-[10.5px] text-muted-foreground">{meta.hint}</span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportChat()} className="items-start py-2">
                <FileJson className="mt-0.5" />
                <div className="flex flex-col">
                  <span className="font-medium">原始 JSON（保留对话结构）</span>
                  <span className="text-[10.5px] text-muted-foreground">
                    字段原样保留，只把语音换成文字
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void copyMerged(ids)} disabled={done === 0}>
                <ClipboardCopy />
                复制合并文本
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={() => setChatView("single")} aria-label="单条视图">
                <Rows3 className="size-3.5" />
                <span className="@max-[600px]/doc:hidden">单条</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>回到单条逐句视图</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div ref={bodyRef} className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <AnimatePresence initial={false}>
            {rows.map(({ item, file }, index) => (
              <motion.div
                key={file.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(index * 0.012, 0.2) }}
              >
                <Block
                  file={file}
                  clock={clockOf(item.time)}
                  sender={item.sender}
                  showSender={index === 0 || rows[index - 1].item.sender !== item.sender}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {done < rows.length && (
        <div className="shrink-0 border-t border-border bg-card/60 px-4 py-2">
          <div className="flex items-center gap-3">
            <Progress value={rows.length ? (done / rows.length) * 100 : 0} className="h-1 flex-1" />
            <span className="tabular text-[11px] text-muted-foreground">
              {done} / {rows.length}
            </span>
          </div>
          <p className="mt-1 text-[10.5px] text-muted-foreground/70">
            点左侧「全部转录」补齐剩余语音；未完成的部分不会出现在导出里。
          </p>
        </div>
      )}
    </div>
  );
}
