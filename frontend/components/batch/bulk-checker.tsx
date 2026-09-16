"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Combine, CreditCard, ListChecks, Store } from "lucide-react";

import { splitLines } from "@/lib/utils";
import type { JobMode } from "@/types/api";

import { BatchForm } from "@/components/batch/batch-form";
import { JobRunner } from "@/components/batch/job-runner";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useJobStream } from "@/hooks/use-job-stream";
import { useJobLauncher } from "@/hooks/use-job-launcher";

const STORAGE_KEY = "shopify-validator:bulk-checker";

const MODE_DESCRIPTION: Record<JobMode, string> = {
  site: "One task per store — the engine picks a card for each",
  card: "One task per card, all against a single target store",
  pair: "Stores and cards matched by index (the shorter list repeats)",
};

/**
 * The original combined workspace. Kept for power users who want to pair both
 * lists or switch modes without leaving the page.
 */
export function BulkChecker({ initialJobId = null }: { initialJobId?: string | null }) {
  const [mode, setMode] = useState<JobMode>("site");
  const [jobId, setJobId] = useState<string | null>(initialJobId);

  // A job id can also arrive through the URL (deep link from /jobs, back button).
  // Adopt it, but never remount on it — that would wipe the job id we just set
  // ourselves plus everything the user typed.
  const urlJobRef = useRef<string | null>(initialJobId);
  useEffect(() => {
    const next = initialJobId ?? null;
    if (next === urlJobRef.current) return;
    urlJobRef.current = next;
    if (next) setJobId(next);
  }, [initialJobId]);

  const stream = useJobStream(jobId, { resumeLast: STORAGE_KEY, onResume: setJobId });
  const { start, starting, forget } = useJobLauncher(setJobId);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY + ":mode") as JobMode | null;
    if (stored) setMode(stored);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY + ":mode", mode);
  }, [mode]);

  const handleStart = useCallback(
    (payload: Omit<Parameters<typeof start>[0], "mode">) => {
      void start({ ...payload, mode }, undefined);
    },
    [start, mode],
  );

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={mode} onValueChange={(v) => setMode(v as JobMode)}>
              <TabsList>
                <TabsTrigger value="site">
                  <Store className="h-3.5 w-3.5" />
                  Stores only
                </TabsTrigger>
                <TabsTrigger value="card">
                  <CreditCard className="h-3.5 w-3.5" />
                  Cards → one store
                </TabsTrigger>
                <TabsTrigger value="pair">
                  <Combine className="h-3.5 w-3.5" />
                  Paired
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">{MODE_DESCRIPTION[mode]}</p>
          </div>
        </CardContent>
      </Card>

      <BatchForm
        key={mode}
        onStart={handleStart}
        starting={starting}
        mode={mode}
        initial={mode === "pair" ? { endpoint: "shopify" } : { endpoint: "check" }}
      />

      <JobRunner
        jobId={jobId}
        stream={stream}
        onForget={() => {
          forget();
          setJobId(null);
        }}
        emptyHint={{
          icon: ListChecks,
          title: "No job selected",
          description: "Pick a mode, fill the inputs above and start a job. Progress and results appear here.",
        }}
      />
    </div>
  );
}

/** Task count preview for a given mode — shared with the form. */
export function modeTaskCount(mode: JobMode, sites: string, cards: string): number {
  const siteCount = splitLines(sites).length;
  const cardCount = splitLines(cards).length;
  if (mode === "site") return siteCount;
  if (mode === "card") return cardCount;
  return cardCount > 0 ? Math.max(siteCount, cardCount) : siteCount;
}
