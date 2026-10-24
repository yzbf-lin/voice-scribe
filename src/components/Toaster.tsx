import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, CircleCheck, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useScribeStore } from "@/store/useScribeStore";

export function Toaster() {
  const toasts = useScribeStore((s) => s.toasts);
  const dismiss = useScribeStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-lg shadow-black/[0.06]",
              toast.variant === "error" ? "border-destructive/25" : "border-border"
            )}
          >
            {toast.variant === "success" ? (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--success)]" />
            ) : toast.variant === "error" ? (
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            ) : (
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[0.8rem] font-medium leading-5">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 line-clamp-2 break-all text-[10.5px] leading-4 text-muted-foreground">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              className="rounded p-0.5 text-muted-foreground/50 transition hover:text-foreground"
              aria-label="关闭"
            >
              <X className="size-3" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
