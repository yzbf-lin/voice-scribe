import { Separator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

export function ResizeHandle({ className }: { className?: string }) {
  return (
    <Separator
      className={cn(
        "group relative w-px shrink-0 bg-border transition-colors hover:bg-foreground/20 focus-visible:bg-brand focus-visible:outline-none",
        className
      )}
    >
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <div className="absolute left-1/2 top-1/2 flex h-8 w-2.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="h-4 w-0.5 rounded-full bg-foreground/25" />
      </div>
    </Separator>
  );
}
