"use client";

import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export interface LogLine {
  ts: number;
  level: string;
  message: string;
}

const LEVEL_CLASS: Record<string, string> = {
  error: "text-destructive",
  warning: "text-warning",
  info: "text-muted-foreground",
  debug: "text-muted-foreground/70",
};

/**
 * Terminal-style log viewer. Auto-scrolls while "follow" is on and pauses
 * auto-scroll as soon as the user scrolls up.
 */
export function LogPanel({
  lines,
  title = "Live log",
  className,
  height = "h-64",
  follow: initialFollow = true,
  emptyLabel = "Waiting for output…",
}: {
  lines: LogLine[];
  title?: string;
  className?: string;
  height?: string;
  follow?: boolean;
  emptyLabel?: string;
}) {
  const [follow, setFollow] = useState(initialFollow);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<"all" | "warning" | "error">("all");

  const visible = useMemo(
    () => (filter === "all" ? lines : lines.filter((line) => line.level === filter)),
    [lines, filter],
  );

  useEffect(() => {
    if (!follow || !container) return;
    container.scrollTop = container.scrollHeight;
  }, [visible.length, follow, container]);

  return (
    <div className={cn("panel overflow-hidden", className)}>
      <div className="panel-header py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-border text-[10px]">
            {(["all", "warning", "error"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  "px-2 py-0.5 uppercase tracking-wide transition-colors",
                  filter === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setFollow((value) => !value)}
            className={cn(
              "rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors",
              follow ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {follow ? "following" : "paused"}
          </button>
        </div>
      </div>
      <div
        ref={setContainer}
        className={cn("overflow-y-auto bg-background/60 p-3 font-mono text-[11px] leading-relaxed", height)}
        onWheel={() => setFollow(false)}
      >
        {visible.length === 0 ? (
          <p className="text-muted-foreground">{emptyLabel}</p>
        ) : (
          visible.map((line, index) => (
            <div key={`${line.ts}-${index}`} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/60">
                {new Date(line.ts * 1000).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={cn("shrink-0 uppercase", LEVEL_CLASS[line.level] ?? "text-muted-foreground")}>
                {line.level.slice(0, 4)}
              </span>
              <span className={cn("min-w-0 break-words", LEVEL_CLASS[line.level] ?? "text-foreground")}>
                {line.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
