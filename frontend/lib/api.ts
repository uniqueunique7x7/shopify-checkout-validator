import { ApiError, type CardsWriteResponse, type JobsApiMap, type LiveSitesPool } from "@/types/api";

/**
 * Thin fetch wrapper. All calls go to /api/* which Next proxies to FastAPI.
 * Errors are normalised into ApiError so the UI can show `error.message`.
 */
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch (cause) {
    throw new ApiError(
      "Cannot reach the API server. Is the backend running on port 8080?",
      "NETWORK_ERROR",
      0,
      cause,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed with status ${response.status}`,
      body?.error?.code ?? "HTTP_ERROR",
      response.status,
      body?.error?.details,
    );
  }

  return payload as T;
}

export const api = {
  health: () => request<JobsApiMap["health"]>("/api/health"),
  config: () => request<JobsApiMap["config"]>("/api/config"),
  stats: () => request<JobsApiMap["stats"]>("/api/stats"),
  logs: (limit = 200, level?: string) =>
    request<{ items: JobsApiMap["logEntry"][] }>(
      `/api/logs?limit=${limit}${level ? `&level=${level}` : ""}`,
    ),
  requestsLog: (lines = 200) => request<string>(`/api/requests-log?lines=${lines}`),

  settings: () => request<JobsApiMap["settings"]>("/api/settings"),
  updateSettings: (patch: Partial<JobsApiMap["settings"]>) =>
    request<JobsApiMap["settings"]>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  resetSettings: () => request<JobsApiMap["settings"]>("/api/settings/reset", { method: "POST" }),

  cache: () => request<JobsApiMap["cache"]>("/api/cache"),
  clearCache: () => request<{ cleared: number }>("/api/cache/clear", { method: "POST" }),

  validate: (body: {
    site: string;
    card?: string;
    proxy?: string;
    max_price?: number;
    variant_id?: string;
  }) => request<JobsApiMap["rawResult"]>("/api/validate", { method: "POST", body: JSON.stringify(body) }),

  check: (body: { site: string; card?: string; proxy?: string; max_price?: number }) =>
    request<JobsApiMap["checkResult"]>("/api/check", { method: "POST", body: JSON.stringify(body) }),

  products: (site: string, maxPrice?: number, refresh = false, limit = 100) => {
    const params = new URLSearchParams({ site, limit: String(limit) });
    if (maxPrice) params.set("max_price", String(maxPrice));
    if (refresh) params.set("refresh", "true");
    return request<JobsApiMap["products"]>(`/api/products?${params}`);
  },

  createJob: (body: JobsApiMap["jobCreate"]) =>
    request<JobsApiMap["jobDetail"]>("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
  jobs: (limit = 50) => request<JobsApiMap["jobList"]>(`/api/jobs?limit=${limit}`),
  job: (id: string) => request<JobsApiMap["jobDetail"]>(`/api/jobs/${id}`),
  cancelJob: (id: string) => request<JobsApiMap["jobSummary"]>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  pauseJob: (id: string) => request<JobsApiMap["jobSummary"]>(`/api/jobs/${id}/pause`, { method: "POST" }),
  resumeJob: (id: string) => request<JobsApiMap["jobSummary"]>(`/api/jobs/${id}/resume`, { method: "POST" }),
  deleteJob: (id: string) => request<{ cancelled: boolean }>(`/api/jobs/${id}`, { method: "DELETE" }),
  jobLiveSites: (id: string) => request<string>(`/api/jobs/${id}/live-sites`),
  /** Pool every store that came back live across all site jobs + history. */
  liveSitesPool: (opts?: {
    source?: "all" | "jobs" | "history";
    includeRunning?: boolean;
    offset?: number;
    limit?: number;
    search?: string;
    refresh?: boolean;
  }) => {
    const params = new URLSearchParams();
    if (opts?.source) params.set("source", opts.source);
    if (opts?.includeRunning !== undefined) params.set("include_running", String(opts.includeRunning));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.search) params.set("search", opts.search);
    if (opts?.refresh) params.set("refresh", "true");
    const qs = params.toString();
    return request<LiveSitesPool>(`/api/jobs/live-sites${qs ? `?${qs}` : ""}`);
  },
  jobLogs: (id: string) => request<string>(`/api/jobs/${id}/logs`),
  jobResultsUrl: (id: string, fmt: "json" | "csv", bucket?: string) =>
    `${BASE}/api/jobs/${id}/results?fmt=${fmt}${bucket ? `&bucket=${bucket}` : ""}`,

  cards: () => request<JobsApiMap["cardsSnapshot"]>("/api/cards"),
  saveCards: (lines: string[]) =>
    request<CardsWriteResponse>("/api/cards", { method: "POST", body: JSON.stringify({ lines }) }),
  appendCards: (lines: string[]) =>
    request<CardsWriteResponse>("/api/cards/append", { method: "POST", body: JSON.stringify({ lines }) }),
  uploadCards: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<CardsWriteResponse>("/api/cards/upload", { method: "POST", body: form });
  },
  clearCards: () => request<JobsApiMap["cardsSnapshot"]>("/api/cards", { method: "DELETE" }),
  reloadCards: () => request<JobsApiMap["cardsSnapshot"]>("/api/cards/reload", { method: "POST" }),
  bins: () => request<{ items: { bin: string; count: number }[] }>("/api/cards/bins"),

  history: (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "" && value !== null) search.set(key, String(value));
    });
    return request<JobsApiMap["history"]>(`/api/history?${search}`);
  },
  historySummary: () => request<JobsApiMap["historySummary"]>("/api/history/summary"),
  clearHistory: () => request<{ deleted: number }>("/api/history?confirm=true", { method: "DELETE" }),
  historyExportUrl: (fmt: "json" | "txt") => `${BASE}/api/history/export?fmt=${fmt}`,
};

export const swrFetcher = <T,>(path: string) => request<T>(path);
export { request, ApiError };
