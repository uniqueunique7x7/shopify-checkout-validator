"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { JobCounters, JobDetail, JobEvent, JobLogEntry, JobStatus, ResultRecord } from "@/types/api";

const TERMINAL: JobStatus[] = ["completed", "failed", "cancelled"];
const MAX_LOGS = 400;
/** Reconnect backoff — 1s, 2s, 4s, 8s, then every 10s until the server answers. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;

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
 *
 * Network trouble never throws the job away: the last snapshot stays on screen,
 * `connected` flips to false and the hook reconnects with a growing backoff until
 * the backend answers again. Only a 404 — the job is gone, e.g. after a backend
 * restart — is terminal, and it reports `missing` so the UI can reset.
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
  // bumped to tear the current stream down and connect again (manual retry / backoff)
  const [nonce, setNonce] = useState(0);
  const attemptRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;
  /** Last id written to `resumeLast` — avoids a write on every poll tick. */
  const persistedRef = useRef<string | null>(null);

  const clearRetry = useCallback(() => {
    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
  }, []);

  /** Reconnect after a delay, doubling up to RETRY_MAX_MS. Never queues twice. */
  const scheduleReconnect = useCallback(() => {
    if (retryRef.current) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attemptRef.current, 4));
    attemptRef.current += 1;
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      setNonce((value) => value + 1);
    }, delay);
  }, []);

  // restore the previous job id once, before subscribing
  useEffect(() => {
    if (jobId || !resumeLast) return;
    const stored = window.localStorage.getItem(resumeLast);
    if (stored) onResumeRef.current?.(stored);
  }, [jobId, resumeLast]);

  const sourceRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<Map<number, ResultRecord>>(new Map());

  const applySnapshot = useCallback(
    (job: JobDetail) => {
      attemptRef.current = 0;
      clearRetry();
      // only jobs the backend actually knows are worth resuming next time
      if (resumeLast && persistedRef.current !== job.id) {
        persistedRef.current = job.id;
        window.localStorage.setItem(resumeLast, job.id);
      }
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
    },
    [clearRetry, resumeLast],
  );

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

  /** Terminal: the backend has no record of this job, so stop retrying. */
  const fail = useCallback(
    (message: string, missing = false) => {
      stopStream();
      clearRetry();
      setState((prev) => ({ ...prev, connected: false, error: message, missing }));
    },
    [clearRetry, stopStream],
  );

  /** A blip, not a dead job: keep the last snapshot on screen and try again. */
  const transient = useCallback((message: string) => {
    setState((prev) => (prev.missing ? prev : { ...prev, connected: false, error: message }));
  }, []);

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
          if (status === 404) {
            fail("This job no longer exists on the server.", true);
            return;
          }
          // backend unreachable — hold on to the numbers we already have
          transient(error instanceof Error ? error.message : "Connection lost");
          scheduleReconnect();
        }
      }, 1500);
    },
    [applySnapshot, fail, scheduleReconnect, stopPolling, transient],
  );

  /** Manual retry: drop the backoff and reconnect right now. */
  const refresh = useCallback(async () => {
    if (!jobId) return;
    attemptRef.current = 0;
    clearRetry();
    setState((prev) => (prev.missing ? prev : { ...prev, error: null }));
    try {
      const job = await api.job(jobId);
      applySnapshot(job);
      // re-open the stream so live events resume with a fresh snapshot
      setNonce((value) => value + 1);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        fail("This job no longer exists on the server (it may have restarted).", true);
      } else {
        transient(error instanceof Error ? error.message : "Connection lost");
        scheduleReconnect();
      }
    }
  }, [jobId, applySnapshot, clearRetry, fail, scheduleReconnect, transient]);

  // A new job id starts from a clean slate. A *reconnect* (the nonce bump) must
  // not wipe what is on screen, so the reset lives in its own effect.
  useEffect(() => {
    resultsRef.current = new Map();
    attemptRef.current = 0;
    clearRetry();
    setState({
      job: null,
      results: [],
      logs: [],
      status: null,
      connected: false,
      error: null,
      missing: false,
    });
  }, [jobId, clearRetry]);

  useEffect(() => {
    if (!jobId) return;

    // initial fetch so the UI renders immediately, and so a dead job is spotted
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
          // the job is still running on the server — keep the last snapshot
          transient(error.message);
          scheduleReconnect();
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
                error: payload.job.error,
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
        // The stream can also end because the job finished; polling decides
        // whether this was a network blip or a normal close.
        if (jobId) startPolling(jobId);
      };
    }

    return () => {
      source?.close();
      sourceRef.current = null;
      stopPolling();
    };
  }, [jobId, nonce, applySnapshot, startPolling, stopPolling, fail, transient, scheduleReconnect]);

  return { ...state, refresh };
}
