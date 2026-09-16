"use client";

import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  tone = "default",
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "primary" | "success" | "destructive" | "warning";
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("stat-tile", className)} title={hint}>
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-lg font-semibold leading-none",
          tone === "primary" && "text-primary",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function StatStrip({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">{children}</div>;
}
