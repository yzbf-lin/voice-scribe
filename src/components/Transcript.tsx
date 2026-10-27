import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
  FolderSearch,
  Loader2,
  MessagesSquare,
  RotateCcw,
  ScrollText,
  Sparkles,
  Subtitles,
  X,
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
import { EXPORT_META, buildExport, plainText, type ExportFormat } from "@/lib/export";
import { formatBytes, formatClock, languageLabel } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";
import type { FileItem } from "@/types";

const FORMAT_ICONS: Record<ExportFormat, typeof FileText> = {
  txt: FileText,
  srt: Subtitles,
  md: ScrollText,
  json: FileJson,
};

function ExportMenu({ file }: { file: FileItem }) {
  const pushToast = useScribeStore((s) => s.pushToast);
  const [copied, setCopied] = useState(false);
  const disabled = file.segments.length === 0;

  const exportAs = async (format: ExportFormat) => {
    const meta = EXPORT_META[format];
    const { content, defaultName } = buildExport(file, format);
    const result = await window.voiceScribe.saveFile({
      defaultName,
      content,
      filterName: meta.filterName,
      extension: meta.extension,
    });
    if (result.ok) {
      pushToast({ title: `已导出 ${meta.extension.toUpperCase()}`, description: result.filePath, variant: "success" });
    } else if (result.error) {
      pushToast({ title: "导出失败", description: result.error, variant: "error" });
    }
  };

  const copyAll = async () => {
    await window.voiceScribe.copy(plainText(file));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    pushToast({ title: "已复制全文", variant: "success" });
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={copyAll} disabled={disabled} aria-label="复制纯文本">
            {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
            <span className="@max-[520px]/doc:hidden">复制</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>复制纯文本</TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="default" size="sm" disabled={disabled} aria-label="导出文本">
            <Download className="size-3.5" />
            <span className="@max-[600px]/doc:hidden">导出文本</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>选择格式</DropdownMenuLabel>
          {(Object.keys(EXPORT_META) as ExportFormat[]).map((format) => {
            const meta = EXPORT_META[format];
            const Icon = FORMAT_ICONS[format];
            return (
              <DropdownMenuItem key={format} onSelect={() => exportAs(format)} className="items-start py-2">
                <Icon className="mt-0.5" />
                <div className="flex flex-col">
                  <span className="font-medium">{meta.label}</span>
                  <span className="text-[10.5px] text-muted-foreground">{meta.hint}</span>
                </div>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={copyAll}>
            <ClipboardCopy />
            复制到剪贴板
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SegmentRow({ start, end, text, index }: { start: number; end: number; text: string; index: number }) {
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group grid grid-cols-[58px_1fr] gap-2.5 rounded-md px-2 py-[3px] transition-colors hover:bg-muted/60"
    >
      <div className="flex items-start gap-1.5 pt-0.5">
        <span className="tabular font-mono text-[10.5px] leading-5 text-muted-foreground/70">
          {formatClock(start)}
        </span>
      </div>
      <div className="relative min-w-0">
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.7] text-foreground/90 selection:bg-brand/15">
          {text}
        </p>
        <AnimatePresence>
          {hovered && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => window.voiceScribe.copy(text)}
              className="absolute -top-1 right-0 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm hover:text-foreground"
            >
              复制
            </motion.button>
          )}
        </AnimatePresence>
        <span className="sr-only">{`第 ${index + 1} 段, ${formatClock(start)} 至 ${formatClock(end)}`}</span>
      </div>
    </motion.div>
  );
}

export function Transcript() {
  const file = useScribeStore((s) => s.files.find((f) => f.id === s.activeId) ?? null);
  const startTranscription = useScribeStore((s) => s.startTranscription);
  const cancelTranscription = useScribeStore((s) => s.cancelTranscription);
  const modelDownloads = useScribeStore((s) => s.downloads);
  const chat = useScribeStore((s) => s.chat);
  const setChatView = useScribeStore((s) => s.setChatView);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const download = file?.model ? modelDownloads[file.model] : undefined;

  const chatPosition = useMemo(() => {
    if (!chat || !file) return null;
    const index = chat.items.findIndex((item) => item.fileId === file.id);
    return index >= 0 ? { index: index + 1, total: chat.items.length } : null;
  }, [chat, file]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [file?.id]);

  useEffect(() => {
    if (file?.phase !== "transcribing") return;
    const node = scrollRef.current;
    if (node && stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [file?.segments.length, file?.phase]);

  const stats = useMemo(() => {
    if (!file) return null;
    const words = file.segments.reduce((sum, s) => sum + s.text.replace(/\s+/g, "").length, 0);
    return { words, count: file.segments.length };
  }, [file]);

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card">
          <Sparkles className="size-4 text-muted-foreground" />
        </div>
        <p className="text-[0.8rem] text-muted-foreground">导入文件后，转录内容会显示在这里</p>
      </div>
    );
  }

  const isTranscribing = file.phase === "transcribing";

  return (
    <div className="@container/doc flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[0.9rem] font-semibold tracking-tight" title={file.label ?? file.name}>
              {file.label ?? file.name}
            </h2>
            {file.phase === "done" && (
              <Badge variant="success" className="shrink-0">
                <Check className="size-2.5" />
                完成
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {chatPosition && (
              <span className="tabular">
                第 {chatPosition.index} / {chatPosition.total} 条
              </span>
            )}
            {file.meta && <span className="tabular">{formatClock(file.meta.duration)}</span>}
            {file.language && <span>· {languageLabel(file.language)}</span>}
            {stats && stats.count > 0 && (
              <span className="tabular">
                · {stats.count} 段 · {stats.words} 字
              </span>
            )}
            {file.meta?.codec && <span className="font-mono uppercase">· {file.meta.codec}</span>}
            <button
              onClick={() => window.voiceScribe.reveal(file.path)}
              className="ml-1 inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted-foreground/70 transition hover:bg-muted hover:text-foreground"
            >
              <FolderSearch className="size-3" />
              在访达中显示
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {chat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={() => setChatView("merged")} aria-label="查看全部">
                  <MessagesSquare className="size-3.5" />
                  <span className="@max-[600px]/doc:hidden">查看全部</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>把 {chat.items.length} 条语音合并成一整段对话</TooltipContent>
            </Tooltip>
          )}
          {isTranscribing ? (
            <Button variant="outline" size="sm" onClick={() => cancelTranscription()}>
              <X className="size-3.5" />
              停止
            </Button>
          ) : (
            <Button
              variant={file.phase === "done" ? "outline" : "brand"}
              size="sm"
              onClick={() => startTranscription(file.id)}
              aria-label={file.phase === "done" ? "重新转录" : "开始转录"}
            >
              {file.phase === "done" ? <RotateCcw className="size-3.5" /> : <Sparkles className="size-3.5" />}
              <span className="@max-[520px]/doc:hidden">
                {file.phase === "done" ? "重新转录" : "开始转录"}
              </span>
            </Button>
          )}
          <ExportMenu file={file} />
        </div>
      </div>

      {/* body */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
        }}
        className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {file.phase === "error" && (
          <div className="mx-auto mt-6 max-w-md rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center">
            <p className="text-[0.8rem] font-medium text-destructive">转录失败</p>
            <p className="mt-1 text-[0.75rem] text-muted-foreground">{file.error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => startTranscription(file.id)}>
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </div>
        )}

        {file.phase !== "error" && file.segments.length === 0 && !isTranscribing && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40">
              <Subtitles className="size-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-[0.8rem] font-medium">还没有转录内容</p>
              <p className="text-[0.75rem] text-muted-foreground">
                点击右上角「开始转录」，首次运行会自动下载模型
              </p>
            </div>
          </div>
        )}

        {isTranscribing && file.segments.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8">
            <Loader2 className="size-5 animate-spin text-brand" />
            <p className="text-center text-[0.78rem] text-muted-foreground">
              {file.stage === "downloading"
                ? download?.paused
                  ? `已暂停下载 ${modelLabel(file.model ?? "")} 模型 · 在顶栏模型面板点「继续」恢复`
                  : `正在下载 ${modelLabel(file.model ?? "")} 模型 · 首次使用需先获取权重`
                : file.stage === "loading"
                  ? "正在加载 Whisper 模型…"
                  : file.stage === "decoding"
                    ? "正在解码音轨…"
                    : "正在识别语音，请稍候…"}
            </p>
            {file.stage === "downloading" && download && (
              <div className="w-60 space-y-1.5">
                <Progress value={(download.percent ?? 0) * 100} className="h-1" />
                <div className="tabular flex items-center justify-between text-[10.5px] text-muted-foreground">
                  <span>
                    {formatBytes(download.downloaded)}
                    {download.total ? ` / ${formatBytes(download.total)}` : ""}
                  </span>
                  <span>
                    {Math.round((download.percent ?? 0) * 100)}%
                    {download.paused
                      ? " · 已暂停"
                      : download.speed
                        ? ` · ${formatBytes(download.speed)}/s${
                            download.etaSeconds ? ` · 剩余 ${formatClock(download.etaSeconds)}` : ""
                          }`
                        : ""}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mx-auto max-w-3xl">
          {file.segments.map((segment, index) => (
            <SegmentRow key={segment.id} index={index} start={segment.start} end={segment.end} text={segment.text} />
          ))}
        </div>
      </div>

      {/* footer progress */}
      <AnimatePresence>
        {isTranscribing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="shrink-0 overflow-hidden border-t border-border bg-card/60"
          >
            <div className="flex items-center gap-3 px-4 py-2">
              <Progress value={file.progress * 100} className="h-1 flex-1" />
              <span className="tabular w-10 text-right font-mono text-[11px] text-muted-foreground">
                {Math.round(file.progress * 100)}%
              </span>
            </div>
            {file.liveText && (
              <p className={cn("truncate px-4 pb-2 text-[11px] text-muted-foreground/80")}>{file.liveText}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
