"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import type { JobCreateRequest } from "@/types/api";

/**
 * Shared job submission for both validators: creates the job, stores the id so
 * a refresh can resume it, and surfaces validation errors as toasts.
 */
export function useJobLauncher(onCreated: (jobId: string) => void) {
  const [starting, setStarting] = useState(false);

  const start = useCallback(
    async (payload: JobCreateRequest, meta?: { label?: string }) => {
      setStarting(true);
      try {
        const job = await api.createJob(payload);
        onCreated(job.id);
        window.history.replaceState(null, "", `?job=${job.id}`);
        toast.success("Job started", {
          description: `${meta?.label ? `${meta.label} · ` : ""}${job.total} task(s) with ${job.params.concurrency} worker(s).`,
        });
        return job;
      } catch (error) {
        const apiError = reportError(error, "Could not start the job");
        const details = (apiError as { details?: { rejected?: { value: string; reason: string }[] } }).details;
        if (details?.rejected?.length) {
          toast.info(`${details.rejected.length} input line(s) rejected`, {
            description: details.rejected
              .slice(0, 3)
              .map((item) => `${item.value} — ${item.reason}`)
              .join("\n"),
          });
        }
        return null;
      } finally {
        setStarting(false);
      }
    },
    [onCreated],
  );

  const forget = useCallback((storageKey?: string) => {
    // drop the resume pointer too, otherwise the stream hook immediately adopts
    // the job again the moment the id is cleared
    if (storageKey) window.localStorage.removeItem(storageKey);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return { start, starting, forget };
}
