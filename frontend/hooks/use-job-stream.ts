"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { JobCounters, JobDetail, JobEvent, JobLogEntry, JobStatus, ResultRecord } from "@/types/api";

const TERMINAL: JobStatus[] = ["completed", "failed", "cancelled"];
const MAX_LOGS = 400;

interface JobStreamState {
  job: JobDetail | null;
  results: ResultRecord[];
  logs: JobLogEntry[];
  status: JobStatus | null;
  connected: boolean;
  error: string | null;
  /** True when the backend has no record of this job (e.g. after a restart). */
  missing: boolean;
}

/**
 * Subscribes to a job over SSE and keeps local state in sync.
 * Falls back to polling if EventSource is unavailable or the stream errors.
 * A 404 stops all activity and reports `missing` so the UI can offer a reset.
 *
 * Pass `resumeLast` (a localStorage key) to restore the most recent job id for
 * this validator when the page loads without a `?job=` parameter.
 */
export function useJobStream(
  jobId: string | null,
  options?: { resumeLast?: string; onResume?: (jobId: string) => void },
) {
  const { resumeLast, onResume } = options ?? {};
  const [state, setState] = useState<JobStreamState>({
    job: null,
    results: [],
    logs: [],
    status: null,
    connected: false,
    error: null,
    missing: false,
  });

  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  // restore the previous job id once, before subscribing
  useEffect(() => {
    if (jobId || !resumeLast) return;
    const stored = window.localStorage.getItem(resumeLast);
    if (stored) onResumeRef.current?.(stored);
  }, [jobId, resumeLast]);

  useEffect(() => {
    if (jobId && resumeLast) window.localStorage.setItem(resumeLast, jobId);
  }, [jobId, resumeLast]);

  const sourceRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<Map<number, ResultRecord>>(new Map());

  const applySnapshot = useCallback((job: JobDetail) => {
    resultsRef.current = new Map(job.results.map((r) => [r.index, r]));
    setState({
      job,
      results: [...resultsRef.current.values()].sort((a, b) => a.index - b.index),
      logs: job.logs.slice(-MAX_LOGS),
      status: job.status,
      connected: true,
      error: job.error,
      missing: false,
    });
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    stopPolling();
  }, [stopPolling]);

  const fail = useCallback(
    (message: string, missing = false) => {
      stopStream();
      setState((prev) => ({ ...prev, connected: false, error: message, missing }));
    },
    [stopStream],
  );

  const startPolling = useCallback(
    (id: string) => {
      if (pollRef.current) return;
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.job(id);
          applySnapshot(job);
          if (TERMINAL.includes(job.status)) stopPolling();
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 404) fail("This job no longer exists on the server.", true);
        }
      }, 1500);
    },
    [applySnapshot, fail, stopPolling],
  );

  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      const job = await api.job(jobId);
      applySnapshot(job);
      if (TERMINAL.includes(job.status)) stopPolling();
      else startPolling(jobId);
    } catch {
      /* keep the current state */
    }
  }, [jobId, applySnapshot, startPolling, stopPolling]);

  useEffect(() => {
    resultsRef.current = new Map();
    setState({
      job: null,
      results: [],
      logs: [],
      status: null,
      connected: false,
      error: null,
      missing: false,
    });

    if (!jobId) return;

    // initial fetch so the UI renders immediately
    api
      .job(jobId)
      .then((job) => {
        applySnapshot(job);
        if (TERMINAL.includes(job.status)) return;
        startPolling(jobId);
      })
      .catch((error: Error) => {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          fail("This job no longer exists on the server (it may have restarted).", true);
        } else {
          fail(error.message);
        }
      });

    let source: EventSource | null = null;
    if (typeof window !== "undefined" && "EventSource" in window) {
      source = new EventSource(`/api/jobs/${jobId}/events`);
      sourceRef.current = source;

      const handle = (event: MessageEvent) => {
        let payload: JobEvent;
        try {
          payload = JSON.parse(event.data) as JobEvent;
        } catch {
          return;
        }

        setState((prev) => {
          switch (payload.type) {
            case "snapshot": {
              resultsRef.current = new Map(payload.job.results.map((r) => [r.index, r]));
              return {
                ...prev,
                job: payload.job,
                results: [...resultsRef.current.values()].sort((a, b) => a.index - b.index),
                logs: payload.job.logs.slice(-MAX_LOGS),
                status: payload.job.status,
                connected: true,
              };
            }
            case "task_done": {
              resultsRef.current.set(payload.result.index, payload.result);
              return {
                ...prev,
                results: [...resultsRef.current.values()].sort((a, b) => a.index - b.index),
              };
            }
            case "progress": {
              if (!prev.job) return prev;
              return {
                ...prev,
                job: {
                  ...prev.job,
                  completed: payload.completed,
                  total: payload.total,
                  counters: payload.counters as JobCounters,
                  elapsed: payload.elapsed,
                  eta: payload.eta,
                  progress: payload.progress,
                },
                status: prev.job.status,
              };
            }
            case "log": {
              const entry: JobLogEntry = { ts: payload.ts, level: payload.level, message: payload.message };
              return { ...prev, logs: [...prev.logs, entry].slice(-MAX_LOGS) };
            }
            case "status": {
              if (!prev.job) return { ...prev, status: payload.status };
              return { ...prev, job: { ...prev.job, status: payload.status }, status: payload.status };
            }
            case "task_start": {
              if (!prev.job) return prev;
              const card = payload.card_full || payload.card || "";
              return {
                ...prev,
                job: {
                  ...prev.job,
                  current: [`w${payload.worker} → ${payload.site}${card ? ` · ${card}` : ""}`],
                },
              };
            }
            default:
              return prev;
          }
        });

        if (payload.type === "status" && TERMINAL.includes(payload.status)) {
          stopPolling();
          source?.close();
        }
      };

      const types = ["snapshot", "status", "log", "task_start", "task_done", "progress", "ping"];
      types.forEach((type) => source?.addEventListener(type, handle as EventListener));

      source.onerror = () => {
        if (sourceRef.current) sourceRef.current.close();
        sourceRef.current = null;
        setState((prev) => {
          // never resurrect a job the server has forgotten
          if (prev.missing) return prev;
          return { ...prev, connected: false };
        });
        // the initial fetch decides whether the job exists at all
        if (jobId) startPolling(jobId);
      };
    }

    return () => {
      source?.close();
      sourceRef.current = null;
      stopPolling();
    };
  }, [jobId, applySnapshot, startPolling, stopPolling, fail]);

  return { ...state, refresh };
}
