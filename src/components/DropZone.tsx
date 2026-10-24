import { useCallback, useRef, useState } from "react";
import { FileAudio, FileVideo, FolderOpen, Upload } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";

const FORMATS = ["MP4", "MOV", "MKV", "WEBM", "MP3", "WAV", "M4A", "FLAC", "JSON"];

// Deterministic pseudo-waveform so the hero card feels alive without being noisy.
const BARS = Array.from({ length: 48 }, (_, i) => {
  const wave = Math.sin(i * 0.55) * 0.5 + Math.sin(i * 0.19 + 1.2) * 0.5;
  return 18 + Math.abs(wave) * 82;
});

export function DropZone({ variant = "hero" }: { variant?: "hero" | "compact" }) {
  const addPaths = useScribeStore((s) => s.addPaths);
  const addDroppedFiles = useScribeStore((s) => s.addDroppedFiles);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const openPicker = useCallback(async () => {
    const path = await window.voiceScribe.openMedia();
    if (path) await addPaths([path]);
  }, [addPaths]);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) await addDroppedFiles(files);
    },
    [addDroppedFiles]
  );

  const handlers = {
    onDragEnter: (event: React.DragEvent) => {
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: React.DragEvent) => {
      event.preventDefault();
      depth.current -= 1;
      if (depth.current <= 0) setDragging(false);
    },
    onDrop,
  };

  if (variant === "compact") {
    return (
      <button
        onClick={openPicker}
        {...handlers}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-[0.8rem] text-muted-foreground transition-colors",
          dragging ? "border-brand bg-brand-soft text-brand" : "hover:border-foreground/25 hover:bg-muted/50"
        )}
      >
        <Upload className="size-3.5 shrink-0" />
        <span className="truncate">{dragging ? "松开以添加文件" : "拖入或点击添加文件"}</span>
      </button>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="flex w-full max-w-2xl flex-col items-center"
    >
      <motion.button
        {...handlers}
        onClick={openPicker}
        animate={dragging ? { scale: 1.012 } : { scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        className={cn(
          "paper-grid group relative flex w-full flex-col items-center justify-center gap-5 overflow-hidden rounded-2xl border border-dashed px-10 pb-16 pt-14 text-center transition-colors",
          dragging
            ? "border-brand bg-brand-soft/70"
            : "border-border bg-card/60 hover:border-foreground/20 hover:bg-card"
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-end justify-center gap-[3px] px-8 pb-1 opacity-[0.11]">
          {BARS.map((height, index) => (
            <motion.span
              key={index}
              className="w-[3px] origin-bottom rounded-full bg-brand"
              style={{ height: `${height}%` }}
              animate={{ scaleY: dragging ? [0.5, 1, 0.5] : [0.72, 1, 0.72] }}
              transition={{
                duration: dragging ? 1.1 : 3.2,
                repeat: Infinity,
                ease: "easeInOut",
                delay: index * 0.045,
              }}
            />
          ))}
        </div>

        <div className="relative flex size-14 items-center justify-center rounded-2xl border border-border bg-background shadow-[0_1px_2px_rgba(16,16,14,0.05)]">
          <FileVideo className="size-6 text-foreground/70 transition-transform duration-300 group-hover:-translate-y-0.5" />
          <div className="absolute -bottom-1.5 -right-1.5 flex size-6 items-center justify-center rounded-lg border border-border bg-background shadow-sm">
            <FileAudio className="size-3 text-muted-foreground" />
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[15px] font-medium tracking-tight">
            {dragging ? "松手即可导入" : "拖入视频、音频，或 chatlog 导出的 JSON"}
          </p>
          <p className="text-[0.8rem] text-muted-foreground">
            或者点击选择文件 · 全程本地处理，不上传任何数据
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {FORMATS.map((format) => (
            <span
              key={format}
              className="rounded-md border border-border/80 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted-foreground"
            >
              {format}
            </span>
          ))}
        </div>
      </motion.button>

      <div className="mt-4 flex items-center gap-2">
        <Button variant="brand" size="lg" onClick={openPicker} className="px-4">
          <FolderOpen className="size-4" />
          选择文件
        </Button>
        <span className="text-[0.8rem] text-muted-foreground">支持批量导入，可拖拽排序</span>
      </div>
    </motion.div>
  );
}
