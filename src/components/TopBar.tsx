import { AudioLines, CircleAlert, Languages, Loader2 } from "lucide-react";
import { motion } from "motion/react";

import { ModelMenu } from "@/components/ModelMenu";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";

const LANGUAGES = [
  { value: "auto", label: "自动检测" },
  { value: "zh", label: "中文" },
  { value: "yue", label: "粤语" },
  { value: "en", label: "英语" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "ru", label: "俄语" },
];

function WorkerIndicator() {
  const worker = useScribeStore((s) => s.worker);
  const isBusy = useScribeStore((s) => s.files.some((f) => f.phase === "transcribing"));

  const ready = worker?.workerReady;
  const failed = worker && !worker.available;

  const content = (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
      {isBusy ? (
        <Loader2 className="size-3 animate-spin text-brand" />
      ) : failed ? (
        <CircleAlert className="size-3 text-destructive" />
      ) : (
        <span
          className={cn(
            "relative flex size-1.5 rounded-full",
            ready ? "bg-[var(--success)]" : "bg-muted-foreground/50"
          )}
        >
          {ready && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--success)] opacity-60" />
          )}
        </span>
      )}
      <span>{isBusy ? "转录中" : failed ? "引擎缺失" : ready ? "本地引擎就绪" : "引擎启动中"}</span>
    </div>
  );

  if (!failed) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-64">{worker?.hint}</TooltipContent>
    </Tooltip>
  );
}

export function TopBar() {
  const languagePref = useScribeStore((s) => s.languagePref);
  const setLanguagePref = useScribeStore((s) => s.setLanguagePref);
  const isBusy = useScribeStore((s) => s.files.some((f) => f.phase === "transcribing"));

  return (
    <header className="drag-region flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/80 pl-[86px] pr-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-[9px] bg-primary text-primary-foreground shadow-sm">
          <AudioLines className="size-4" strokeWidth={2.2} />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight">VoiceScribe</span>
          <Badge variant="outline" className="hidden sm:inline-flex">
            本地离线
          </Badge>
        </div>
      </div>

      <div className="no-drag flex items-center gap-2">
        <WorkerIndicator />

        <ModelMenu />

        <div className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card/60 pl-2 pr-0.5">
          <Languages className="size-3.5 shrink-0 text-muted-foreground" />
          <Select value={languagePref} onValueChange={setLanguagePref} disabled={isBusy}>
            <SelectTrigger className="h-7 w-[78px] border-0 bg-transparent px-1.5 shadow-none hover:bg-muted/60">
              <SelectValue>
                {LANGUAGES.find((l) => l.value === languagePref)?.label ?? "自动检测"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                <SelectLabel>识别语言</SelectLabel>
                {LANGUAGES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </header>
  );
}
