"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ApiStatus({ compact = false }: { compact?: boolean }) {
  const { data, error, isLoading } = useSWR("health", api.health, {
    refreshInterval: 8000,
    revalidateOnFocus: true,
  });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(!error && Boolean(data));
  }, [data, error]);

  const state = isLoading ? "checking" : online ? "online" : "offline";

  const dot = (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        state === "online" && "bg-success animate-pulse-ring",
        state === "offline" && "bg-destructive",
        state === "checking" && "bg-warning",
      )}
    />
  );

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
            {dot}
            <span className="font-mono uppercase">{state}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {state === "offline"
            ? "API unreachable — start the backend on port 8080"
            : `API ${data?.version ?? ""} · uptime ${Math.round(data?.uptime_seconds ?? 0)}s`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {dot}
        <span className="font-semibold uppercase tracking-wide">
          {state === "online" ? "API online" : state === "offline" ? "API offline" : "Checking"}
        </span>
      </div>
      <span className="hidden text-muted-foreground sm:inline">
        cards <span className="font-mono text-foreground">{data?.cards_loaded ?? 0}</span>
      </span>
      <span className="hidden text-muted-foreground md:inline">
        jobs{" "}
        <span className="font-mono text-foreground">
          {(data?.jobs?.running ?? 0) + (data?.jobs?.queued ?? 0)}
        </span>
      </span>
    </div>
  );
}
