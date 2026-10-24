import { ClipboardCopy, Download, FileJson, FileText, ScrollText, Subtitles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EXPORT_META, type ExportFormat } from "@/lib/export";
import { useScribeStore } from "@/store/useScribeStore";

const FORMAT_ICONS: Record<ExportFormat, typeof FileText> = {
  txt: FileText,
  srt: Subtitles,
  md: ScrollText,
  json: FileJson,
};

/**
 * Appears above the prompt field once at least one queue item is ticked:
 * merge-copy or merge-export the selection as one document.
 */
export function SelectionBar() {
  const selectedIds = useScribeStore((s) => s.selectedIds);
  const files = useScribeStore((s) => s.files);
  const copyMerged = useScribeStore((s) => s.copyMerged);
  const exportMerged = useScribeStore((s) => s.exportMerged);
  const clearSelection = useScribeStore((s) => s.clearSelection);
  const selectAll = useScribeStore((s) => s.selectAll);

  if (selectedIds.length === 0) return null;

  const chosen = files.filter((file) => selectedIds.includes(file.id));
  const done = chosen.filter((file) => file.phase === "done" && file.segments.length > 0).length;
  const allSelected = selectedIds.length === files.length;

  return (
    <div className="mx-3 mb-2 rounded-lg border border-brand/25 bg-brand-soft/60 p-2">
      <div className="flex items-center gap-1.5">
        <p className="tabular min-w-0 flex-1 truncate text-[11px] font-medium">
          已选 {selectedIds.length} 条
          <span className="ml-1 font-normal text-muted-foreground">
            · {done > 0 ? `${done} 条可合并` : "尚无转写"}
          </span>
        </p>
        <button
          type="button"
          onClick={allSelected ? clearSelection : selectAll}
          className="shrink-0 rounded px-1 py-0.5 text-[10.5px] text-muted-foreground transition hover:bg-background/60 hover:text-foreground"
        >
          {allSelected ? "取消全选" : "全选"}
        </button>
        <button
          type="button"
          onClick={clearSelection}
          aria-label="清除选择"
          className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition hover:bg-background/60 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="brand"
          className="h-7 min-w-0 flex-1 px-2 text-[11.5px]"
          onClick={() => void copyMerged()}
          disabled={done === 0}
        >
          <ClipboardCopy className="size-3.5" />
          <span className="truncate">合并复制</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 min-w-0 flex-1 px-2 text-[11.5px]" disabled={done === 0}>
              <Download className="size-3.5" />
              <span className="truncate">合并导出</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>{selectedIds.length} 条合并为一份文档</DropdownMenuLabel>
            {(Object.keys(EXPORT_META) as ExportFormat[]).map((format) => {
              const meta = EXPORT_META[format];
              const Icon = FORMAT_ICONS[format];
              return (
                <DropdownMenuItem key={format} onSelect={() => void exportMerged(format)} className="items-start py-2">
                  <Icon className="mt-0.5" />
                  <div className="flex flex-col">
                    <span className="font-medium">{meta.label}</span>
                    <span className="text-[10.5px] text-muted-foreground">{meta.hint}</span>
                  </div>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void copyMerged()}>
              <ClipboardCopy />
              复制合并文本
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
