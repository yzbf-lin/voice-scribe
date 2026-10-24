import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  GripVertical,
  Loader2,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes, formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";
import type { FileItem } from "@/types";

function StatusBadge({ file }: { file: FileItem }) {
  switch (file.phase) {
    case "probing":
      return (
        <Badge variant="outline" className="gap-1">
          <Loader2 className="size-2.5 animate-spin" />
          读取中
        </Badge>
      );
    case "transcribing":
      return (
        <Badge variant="brand" className="gap-1 tabular">
          <Loader2 className="size-2.5 animate-spin" />
          {Math.round(file.progress * 100)}%
        </Badge>
      );
    case "done":
      return (
        <Badge variant="success" className="gap-1">
          <CircleCheck className="size-2.5" />
          {file.segments.length} 段
        </Badge>
      );
    case "error":
      return (
        <Badge variant="danger" className="gap-1">
          <CircleAlert className="size-2.5" />
          失败
        </Badge>
      );
    default:
      return <Badge variant="outline">待转录</Badge>;
  }
}

function QueueItem({ file }: { file: FileItem }) {
  const activeId = useScribeStore((s) => s.activeId);
  const openSingle = useScribeStore((s) => s.openSingle);
  const removeFile = useScribeStore((s) => s.removeFile);
  const toggleSelect = useScribeStore((s) => s.toggleSelect);
  const selected = useScribeStore((s) => s.selectedIds.includes(file.id));
  const isActive = activeId === file.id;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id,
  });

  return (
    <motion.div
      ref={setNodeRef}
      layout
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => openSingle(file.id)}
      className={cn(
        "group relative cursor-pointer rounded-lg border bg-card px-2 py-2 transition-colors",
        selected
          ? "border-brand/40 bg-brand-soft/40"
          : isActive
            ? "border-foreground/20 bg-card shadow-sm"
            : "border-border/70 hover:bg-muted/40",
        isDragging && "z-10 opacity-90 shadow-lg"
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleSelect(file.id, event.shiftKey);
          }}
          aria-label={selected ? "取消选择" : "选择"}
          aria-pressed={selected}
          className={cn(
            "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors",
            selected
              ? "border-brand bg-brand text-brand-foreground"
              : "border-border bg-background text-transparent hover:border-foreground/40"
          )}
        >
          <Check className="size-2.5" strokeWidth={3} />
        </button>

        <button
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
          className="-ml-0.5 mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-muted-foreground group-hover:opacity-100 active:cursor-grabbing"
          aria-label="拖拽排序"
        >
          <GripVertical className="size-3.5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-[0.8rem] font-medium leading-5" title={file.label ?? file.name}>
              {file.label ?? file.name}
            </p>
            <StatusBadge file={file} />
          </div>

          <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden text-[10.5px] text-muted-foreground">
            <span className="shrink-0 rounded bg-muted px-1 font-mono uppercase tracking-wide">{file.ext || "file"}</span>
            {file.meta ? (
              <>
                <span className="tabular flex shrink-0 items-center gap-0.5">
                  <Clock3 className="size-2.5" />
                  {formatClock(file.meta.duration)}
                </span>
                <span className="tabular shrink-0">{formatBytes(file.size)}</span>
              </>
            ) : (
              <span className="truncate">读取中…</span>
            )}
          </div>

          {file.phase === "transcribing" && (
            <Progress value={file.progress * 100} className="mt-1.5 h-0.5" />
          )}

          {file.error && (
            <p className="mt-1 line-clamp-2 text-[10.5px] text-destructive">{file.error}</p>
          )}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(event) => {
                event.stopPropagation();
                removeFile(file.id);
              }}
              className="rounded p-0.5 text-muted-foreground/40 opacity-0 transition hover:text-destructive group-hover:opacity-100"
              aria-label="移除"
            >
              <Trash2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>从列表移除</TooltipContent>
        </Tooltip>
      </div>
    </motion.div>
  );
}

export function FileQueue() {
  const files = useScribeStore((s) => s.files);
  const reorder = useScribeStore((s) => s.reorder);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) reorder(String(active.id), String(over.id));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={files.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {files.map((file) => (
              <QueueItem key={file.id} file={file} />
            ))}
          </AnimatePresence>
        </div>
      </SortableContext>
    </DndContext>
  );
}
