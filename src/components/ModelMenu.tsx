import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  CloudDownload,
  Cpu,
  Loader2,
  Pause,
  Play,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes, formatClock } from "@/lib/format";
import { MODEL_HINTS, MODEL_ORDER, modelLabel } from "@/lib/models";
import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";
import type { ModelDownload, ModelInfo } from "@/types";

function ModelRow({
  name,
  info,
  download,
  error,
  active,
  locked,
  onSelect,
  onDownload,
  onPause,
}: {
  name: string;
  info?: ModelInfo;
  download?: ModelDownload;
  error?: string;
  active: boolean;
  locked: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onPause: () => void;
}) {
  const label = modelLabel(name);
  const downloaded = info?.downloaded ?? false;
  const percent = Math.round((download?.percent ?? 0) * 100);
  const paused = Boolean(download?.paused);
  const size = downloaded ? info?.sizeBytes : download?.total || info?.expectedBytes;

  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-label={`选择模型 ${label}`}
      onClick={() => {
        if (!locked) onSelect();
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-1.5 rounded-md px-2 py-2 outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
        active && "bg-accent/60",
        locked && "pointer-events-none opacity-60"
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[0.8rem] font-medium">{label}</span>
        {active && <Check className="size-3 text-brand" strokeWidth={2.6} />}
        <span className="ml-auto flex items-center gap-1.5">
          {download && !paused ? (
            <>
              <Badge variant="brand" className="gap-1 tabular">
                <Loader2 className="size-2.5 animate-spin" />
                {percent}%
              </Badge>
              <button
                type="button"
                aria-label={`暂停下载 ${label} 模型`}
                onClick={(event) => {
                  event.stopPropagation();
                  onPause();
                }}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-brand"
              >
                <Pause className="size-3.5" />
              </button>
            </>
          ) : paused ? (
            <>
              <Badge variant="outline" className="gap-1 tabular">
                <Pause className="size-2.5" />
                已暂停 {percent}%
              </Badge>
              <button
                type="button"
                aria-label={`继续下载 ${label} 模型`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-brand"
              >
                <Play className="size-3.5" />
              </button>
            </>
          ) : error ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="danger" className="gap-1">
                  <TriangleAlert className="size-2.5" />
                  失败
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-56">{error}</TooltipContent>
            </Tooltip>
          ) : downloaded ? (
            <Badge variant="success" className="gap-1">
              <Check className="size-2.5" />
              已下载
            </Badge>
          ) : (
            <>
              <Badge variant="outline">未下载</Badge>
              <button
                type="button"
                aria-label={`下载 ${label} 模型`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-brand"
              >
                <CloudDownload className="size-3.5" />
              </button>
            </>
          )}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
        <span className="truncate">{MODEL_HINTS[name] ?? ""}</span>
        {size ? <span className="tabular shrink-0">{formatBytes(size)}</span> : null}
      </div>

      {download && (
        <div className="flex items-center gap-2">
          <Progress value={percent} className="h-1 flex-1" />
          <span className="tabular shrink-0 text-[10px] text-muted-foreground">
            {download.total
              ? `${formatBytes(download.downloaded)} / ${formatBytes(download.total)}`
              : formatBytes(download.downloaded)}
            {paused
              ? " · 已暂停"
              : download.speed
                ? ` · ${formatBytes(download.speed)}/s${
                    download.etaSeconds ? ` · 剩余 ${formatClock(download.etaSeconds)}` : ""
                  }`
                : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export function ModelMenu() {
  const model = useScribeStore((s) => s.model);
  const setModel = useScribeStore((s) => s.setModel);
  const models = useScribeStore((s) => s.models);
  const downloads = useScribeStore((s) => s.downloads);
  const modelErrors = useScribeStore((s) => s.modelErrors);
  const cacheDir = useScribeStore((s) => s.cacheDir);
  const refreshModels = useScribeStore((s) => s.refreshModels);
  const downloadModel = useScribeStore((s) => s.downloadModel);
  const pauseDownload = useScribeStore((s) => s.pauseDownload);
  const isBusy = useScribeStore((s) => s.files.some((f) => f.phase === "transcribing"));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) void refreshModels();
  }, [open, refreshModels]);

  const byName = useMemo(() => {
    const map = new Map<string, ModelInfo>();
    for (const item of models) map.set(item.name, item);
    return map;
  }, [models]);

  const current = byName.get(model);
  const currentDownload = downloads[model];
  const currentPercent = Math.round((currentDownload?.percent ?? 0) * 100);
  // A background download for a model the user is not currently using.
  const background = useMemo(
    () => Object.entries(downloads).find(([name]) => name !== model)?.[1],
    [downloads, model]
  );
  const totalOnDisk = models.reduce((sum, item) => sum + (item.downloaded ? item.sizeBytes : 0), 0);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isBusy}
          aria-label="模型与下载状态"
          className={cn(
            "no-drag flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 text-[0.8rem] transition-colors",
            "hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60",
            open && "bg-muted/60"
          )}
        >
          {currentDownload && !currentDownload.paused ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />
          ) : currentDownload?.paused ? (
            <Pause className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium">{modelLabel(model)}</span>
          {currentDownload ? (
            <span
              className={cn(
                "tabular text-[10px]",
                currentDownload.paused ? "text-muted-foreground" : "text-brand"
              )}
            >
              {currentDownload.paused ? `已暂停 ${currentPercent}%` : `${currentPercent}%`}
            </span>
          ) : current && !current.downloaded ? (
            <CloudDownload className="size-3 text-muted-foreground/70" />
          ) : null}
          {!currentDownload && background ? (
            <span className="tabular flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <Loader2 className="size-2.5 animate-spin" />
              {Math.round((background.percent ?? 0) * 100)}%
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[19rem] p-1.5">
        <div className="flex items-baseline justify-between px-2 pb-1 pt-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Whisper 模型
          </span>
          <span className="text-[10px] text-muted-foreground/70">本地推理</span>
        </div>

        {MODEL_ORDER.map((name) => (
          <ModelRow
            key={name}
            name={name}
            info={byName.get(name)}
            download={downloads[name]}
            error={modelErrors[name]}
            active={model === name}
            locked={isBusy}
            onSelect={() => {
              setModel(name);
              setOpen(false);
              // Picking a model that is not on disk starts its download in the
              // background, so the wait overlaps with importing a file.
              const info = byName.get(name);
              if (info && !info.downloaded && !downloads[name]) void downloadModel(name);
            }}
            onDownload={() => void downloadModel(name)}
            onPause={() => void pauseDownload(name)}
          />
        ))}

        <div className="mt-1 flex items-center justify-between gap-2 border-t border-border px-2 pt-1.5 text-[10px] text-muted-foreground">
          <span className="tabular">本地占用 {formatBytes(totalOnDisk)}</span>
          {cacheDir ? (
            <button
              type="button"
              onClick={() => void window.voiceScribe.reveal(cacheDir)}
              className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
            >
              打开缓存目录
            </button>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
