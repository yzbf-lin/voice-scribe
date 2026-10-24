import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Group, Panel } from "react-resizable-panels";
import { Layers, ListFilter, ShieldCheck, Trash2, WifiOff, Languages } from "lucide-react";

import { DropZone } from "@/components/DropZone";
import { ChatBar } from "@/components/ChatBar";
import { FileQueue } from "@/components/FileQueue";
import { MergedTranscript } from "@/components/MergedTranscript";
import { ResizeHandle } from "@/components/ResizeHandle";
import { SelectionBar } from "@/components/SelectionBar";
import { Toaster } from "@/components/Toaster";
import { TopBar } from "@/components/TopBar";
import { Transcript } from "@/components/Transcript";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useScribeStore } from "@/store/useScribeStore";

function EmptyState() {
  return (
    <motion.div
      key="empty"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22 }}
      className="flex h-full flex-col items-center justify-center gap-8 px-8"
    >
      <div className="max-w-xl space-y-3 text-center">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3 text-[var(--success)]" />
          本地推理 · 文件不出本机
        </div>
        <h1 className="text-balance text-[26px] font-semibold leading-tight tracking-tight">
          把视频里的声音，<span className="text-muted-foreground">变成可编辑的文字</span>
        </h1>
        <p className="text-[0.82rem] leading-relaxed text-muted-foreground">
          基于 Whisper 模型在本机完成识别，支持 99 种语言，导出 TXT / SRT / Markdown / JSON。
        </p>
      </div>

      <DropZone />

      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <WifiOff className="size-3.5" /> 无需联网
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Languages className="size-3.5" /> 自动识别语种
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Layers className="size-3.5" /> 批量队列
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ListFilter className="size-3.5" /> 时间轴字幕
        </span>
      </div>
    </motion.div>
  );
}

function Workspace() {
  const files = useScribeStore((s) => s.files);
  const clearAll = useScribeStore((s) => s.clearAll);
  const worker = useScribeStore((s) => s.worker);
  const prompt = useScribeStore((s) => s.prompt);
  const setPrompt = useScribeStore((s) => s.setPrompt);
  const chat = useScribeStore((s) => s.chat);
  const chatView = useScribeStore((s) => s.chatView);
  const merged = Boolean(chat) && chatView === "merged";

  return (
    <motion.div
      key="workspace"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="h-full"
    >
      <Group orientation="horizontal" className="h-full">
        {/* Pixel min sizes (not %): the queue's buttons need ~250px, the
            transcript header ~430px. With percentage minimums a narrow window
            squeezes a panel below its content width and the overflow spills
            over the divider until you drag it again. */}
        <Panel defaultSize="30%" minSize={252} maxSize="46%" className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 pb-2 pt-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[0.8rem] font-medium">文件队列</span>
              <Badge variant="outline" className="tabular">
                {files.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={clearAll} aria-label="清空队列">
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>清空队列</TooltipContent>
            </Tooltip>
          </div>

          <div className="px-3 pb-2">
            <DropZone variant="compact" />
          </div>

          <ChatBar />

          <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <FileQueue />
          </div>

          <SelectionBar />

          <div className="border-t border-border px-3 py-2">
            <label
              htmlFor="prompt"
              className="mb-1 flex items-center gap-1 text-[10.5px] text-muted-foreground"
            >
              术语提示
              <span className="text-muted-foreground/60">可选 · 提升专业词汇准确率</span>
            </label>
            <Input
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="如：硬装、水电改造、泥瓦油工…"
              maxLength={200}
            />
          </div>

          {worker && !worker.available && (
            <div className="mx-3 mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-2.5">
              <p className="text-[11px] font-medium text-destructive">未检测到 Python 环境</p>
              <p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
                在项目根目录执行 <code className="font-mono">npm run setup:python</code> 后重启应用。
              </p>
            </div>
          )}
        </Panel>

        <ResizeHandle />

        <Panel minSize={420} className="min-w-0 overflow-hidden bg-card">
          {merged ? <MergedTranscript /> : <Transcript />}
        </Panel>
      </Group>
    </motion.div>
  );
}

export default function App() {
  const files = useScribeStore((s) => s.files);
  const setWorker = useScribeStore((s) => s.setWorker);
  const handleEvent = useScribeStore((s) => s.handleEvent);
  const handleModelEvent = useScribeStore((s) => s.handleModelEvent);
  const addPaths = useScribeStore((s) => s.addPaths);

  useEffect(() => {
    const offEvent = window.voiceScribe.onTranscribeEvent(handleEvent);
    const offStatus = window.voiceScribe.onWorkerStatus(setWorker);
    const offModel = window.voiceScribe.onModelEvent(handleModelEvent);

    window.voiceScribe.workerStatus().then(setWorker);
    window.voiceScribe.listModels().then((result) => {
      if (result.snapshot) handleModelEvent(result.snapshot);
    });

    // Dev helper: pick the model via VS_MODEL (screenshots / smoke tests).
    if (window.voiceScribe.initialModel) {
      useScribeStore.getState().setModel(window.voiceScribe.initialModel);
    }

    // Dev helper: preload a file via VS_OPEN_FILE for screenshots/smoke tests.
    if (window.voiceScribe.initialFile) {
      addPaths([window.voiceScribe.initialFile]).then(() => {
        if (!window.voiceScribe.autoStart) return;
        const state = useScribeStore.getState();
        const target = state.files.find((f) => f.path === window.voiceScribe.initialFile);
        if (target) state.startTranscription(target.id);
      });
    }
    if (process.env.NODE_ENV === "development") {
      window.voiceScribe.devReplay?.().then((payload) => {
        if (!payload) return;
        const state = useScribeStore.getState();
        const target = state.files.find((f) => f.path === payload.file) ?? state.files[0];
        if (target) state.hydrate(target.id, payload);
      });
    }

    const onKeyDown = async (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        const path = await window.voiceScribe.openMedia();
        if (path) await addPaths([path]);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      offEvent();
      offStatus();
      offModel();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleEvent, setWorker, handleModelEvent, addPaths]);

  return (
    <div className="flex h-full flex-col bg-background">
      <TopBar />
      <main className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {files.length === 0 ? <EmptyState /> : <Workspace />}
        </AnimatePresence>
      </main>
      <Toaster />
    </div>
  );
}
