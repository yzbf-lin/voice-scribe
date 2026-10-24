import { Download, FileJson, Loader2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useScribeStore } from "@/store/useScribeStore";

/**
 * Banner for chat-log mode: shows how many voice notes were found, how many are
 * transcribed, and the two actions that matter (transcribe all / export JSON).
 */
export function ChatBar() {
  const chat = useScribeStore((s) => s.chat);
  const files = useScribeStore((s) => s.files);
  const running = useScribeStore((s) => s.chatRunning);
  const busy = useScribeStore((s) => s.chatBusy);
  const transcribeChat = useScribeStore((s) => s.transcribeChat);
  const exportChat = useScribeStore((s) => s.exportChat);
  const closeChat = useScribeStore((s) => s.closeChat);

  if (!chat) return null;

  const total = chat.items.length;
  const done = chat.items.filter((item) => files.find((f) => f.id === item.fileId)?.phase === "done").length;
  const failed = chat.items.filter((item) => files.find((f) => f.id === item.fileId)?.phase === "error").length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const allDone = total > 0 && done === total;

  return (
    <div className="mx-3 mb-2 rounded-lg border border-brand/25 bg-brand-soft/50 p-2.5">
      <div className="flex items-start gap-2">
        <FileJson className="mt-0.5 size-3.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-medium leading-4" title={chat.fileName}>
            {chat.title}
          </p>
          <p className="tabular mt-0.5 text-[10.5px] text-muted-foreground">
            {total} 条语音 · 已转写 {done}
            {failed > 0 ? ` · 失败 ${failed}` : ""}
            {busy ? " · 正在准备…" : ""}
          </p>
          <Progress value={percent} className="mt-1.5 h-1" />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={closeChat}
              aria-label="退出聊天记录模式"
              className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>退出聊天记录模式（已转写内容仍保留在队列里）</TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="brand"
          className="h-7 min-w-0 flex-1 px-2 text-[11.5px]"
          onClick={() => void transcribeChat()}
          disabled={running || busy || allDone}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          <span className="truncate">
            {running ? "转录中…" : done > 0 && !allDone ? "继续转录" : "全部转录"}
          </span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 min-w-0 flex-1 px-2 text-[11.5px]"
              onClick={() => void exportChat()}
              disabled={busy}
            >
              <Download className="size-3.5" />
              <span className="truncate">原始 JSON</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-56">
            按原样导出整份聊天记录：所有字段和消息都保留，只把语音的 content 换成转写文字。未转写的语音保持原文。
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
