/**
 * Shared API types — mirror the FastAPI schemas in backend/app/models/schemas.py
 */

export type Bucket = "live" | "die" | "error";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface RawResult {
  Response: string;
  CC: string;
  CCMasked: string;
  Product: string;
  Price: string;
  Gate: string;
  Site: string;
  Charged: string;
  Approved: string;
  Time: string;
  ElapsedMs: number;
  Detail?: string | null;
  bucket: Bucket;
  gateway_live: boolean;
  approved: boolean;
  charged: boolean;
}

export interface LiveSiteEntry {
  site: string;
  responses: string[];
  gate: string;
  last_seen: number;
  product: string;
  price: string;
  hits: number;
  /** Card errors collected since the store last proved itself (0 or 1 survive). */
  errors?: number;
}

export interface LiveSitesPool {
  total: number;
  total_unfiltered: number;
  offset: number;
  limit: number;
  count: number;
  has_more: boolean;
  sites: string[];
  as_text: string;
  items: LiveSiteEntry[];
  source: "all" | "jobs" | "history";
  include_running: boolean;
  search: string;
  cached: boolean;
}

export interface CheckResult {
  valid: boolean;
  site: string;
  url: string;
  product: string;
  price: string;
  card_response: string;
  gate: string;
  approved: string;
  charged: string;
  time: string;
  bucket: Bucket;
  gateway_live: boolean;
  detail?: string | null;
  raw: RawResult;
}

export interface ResultRecord {
  index: number;
  worker: number;
  site: string;
  requested_site: string;
  /** How many stores this task visited — card scans move on after an error. */
  targets_tried?: number;
  card: string;
  /** Full cc|mm|yy|cvv — shown so every card can be identified. */
  card_full?: string;
  response: string;
  bucket: Bucket;
  gate: string;
  product: string;
  price: string;
  time: string;
  elapsed_ms: number;
  approved: boolean;
  charged: boolean;
  gateway_live: boolean;
  detail?: string | null;
  attempts: number;
}

export interface JobCounters {
  live: number;
  die: number;
  error: number;
  retried: number;
}

export interface JobLogEntry {
  ts: number;
  level: string;
  message: string;
  index?: number | null;
}

export type JobMode = "site" | "card" | "pair";

export interface JobParams {
  mode: JobMode;
  sites: string[];
  /** How many stores the job was given (the whole live pool in random-target mode). */
  sites_count?: number;
  /** card mode: every card was dealt its own store from a pool. */
  random_target?: boolean;
  /** Where the per-card pool came from — the live-site pool or the caller's list. */
  pool_source?: "live" | "custom" | "";
  /** Size of the pool the targets were drawn from, when random_target is set. */
  pool_size?: number;
  cards_count: number;
  cards_preview?: string[];
  proxy: boolean;
  proxy_raw: string;
  concurrency: number;
  retries: number;
  max_price: number;
  variant_id: string | null;
  endpoint: string;
  tasks: number;
}

export interface JobSummary {
  id: string;
  kind: string;
  status: JobStatus;
  params: JobParams;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  total: number;
  completed: number;
  pending: number;
  counters: JobCounters;
  elapsed: number;
  eta: number | null;
  current: string[];
  error: string | null;
  cancel_requested: boolean;
  pause_requested: boolean;
  progress: number;
}

export interface JobDetail extends JobSummary {
  results: ResultRecord[];
  logs: JobLogEntry[];
}

export interface JobListResponse {
  items: JobSummary[];
  counts: Record<string, number>;
}

export interface JobCreateRequest {
  sites: string[];
  cards?: string[];
  proxy?: string | null;
  concurrency?: number;
  retries?: number;
  max_price?: number;
  variant_id?: string | null;
  endpoint?: "check" | "shopify";
  mode?: JobMode;
  /** card mode only: deal each card its own store (custom list, else live pool). */
  random_target?: boolean;
}

export interface HealthResponse {
  status: string;
  version: string;
  cards_loaded: number;
  jobs: Record<string, number>;
  pool_size: number;
  pool_per_host: number;
  site_concurrency: number;
  cache_ttl: number;
  max_price: number;
  cache_entries: number;
  uptime_seconds: number;
}

export interface CardItem {
  number: string;
  month: string;
  year: string;
  cvv: string;
  bin: string;
  last4: string;
}

export interface CardsSnapshot {
  path: string;
  exists: boolean;
  count: number;
  invalid_count: number;
  invalid_sample: string[];
  loaded_at: number;
  cards: CardItem[];
}

export interface CardsWriteResponse {
  saved: number;
  added?: number | null;
  invalid_count: number;
  invalid: string[];
  snapshot: CardsSnapshot;
}

export interface RuntimeSettings {
  max_price: number;
  site_concurrency: number;
  request_timeout: number;
  connect_timeout: number;
  cache_ttl: number;
  default_concurrency: number;
  default_retries: number;
  log_level: "debug" | "info" | "warning" | "error";
  history_store_full_cards: boolean;
  history_limit: number;
}

export interface HistoryItem {
  id: string;
  ts: number;
  origin: string;
  site: string;
  product: string;
  price: string;
  gate: string;
  response: string;
  bucket: Bucket;
  approved: boolean;
  charged: boolean;
  gateway_live: boolean;
  card_masked: string;
  card?: string;
  /** Which validator produced this row — decides the bucket wording. */
  mode?: JobMode;
  time: string;
  detail?: string | null;
}

export interface HistoryResponse {
  total: number;
  offset: number;
  limit: number;
  items: HistoryItem[];
}

export interface HistorySummary {
  count: number;
  buckets: { live: number; die: number; error: number };
  responses: Record<string, number>;
  gates: Record<string, number>;
}

export interface StatsResponse {
  stats: Record<string, number>;
  history: HistorySummary;
}

export interface ProductCandidate {
  variant_id: string;
  title: string;
  price: string;
  handle: string;
}

export interface ProductsResponse {
  site: string;
  host: string;
  max_price: number;
  best: ProductCandidate | null;
  candidates: ProductCandidate[];
  count: number;
  error: string | null;
  cached: boolean;
}

export interface CacheEntry {
  host: string;
  max_price: number | null;
  product_title: string | null;
  price: string | null;
  candidates: number;
  error: string | null;
  age_seconds: number;
  expires_in: number;
}

export interface LogEntry {
  ts: number;
  level: string;
  logger: string;
  message: string;
}

export interface ConfigResponse {
  version: string;
  log_level: string;
  runtime_settings: RuntimeSettings;
  env: Record<string, string | number>;
  limits: {
    pool_size: number;
    pool_per_host: number;
    max_concurrency: number;
    max_batch_tasks: number;
    cors_origins: string[];
  };
  responses: { live: string[]; error: string[] };
}

export type JobEvent =
  | { type: "snapshot"; job: JobDetail; ts: number }
  | { type: "status"; status: JobStatus; error?: string; cancel_requested?: boolean; ts: number }
  | { type: "log"; message: string; level: string; index?: number | null; ts: number }
  | {
      type: "task_start";
      index: number;
      worker: number;
      site: string;
      card: string;
      card_full?: string;
      attempt: number;
      attempts: number;
      ts: number;
    }
  | { type: "task_done"; index: number; result: ResultRecord; ts: number }
  | {
      type: "progress";
      completed: number;
      total: number;
      counters: JobCounters;
      elapsed: number;
      eta: number | null;
      progress: number;
      ts: number;
    }
  | { type: "ping"; status: JobStatus; ts: number };

/**
 * Convenience lookup used by lib/api.ts so each endpoint can reference the
 * exact response shape it returns.
 */
export interface JobsApiMap {
  health: HealthResponse;
  config: ConfigResponse;
  stats: StatsResponse;
  logEntry: LogEntry;
  settings: RuntimeSettings;
  cache: { count: number; ttl: number; items: CacheEntry[] };
  rawResult: RawResult;
  checkResult: CheckResult;
  products: ProductsResponse;
  jobCreate: JobCreateRequest;
  jobDetail: JobDetail;
  jobSummary: JobSummary;
  jobList: JobListResponse;
  cardsSnapshot: CardsSnapshot;
  history: HistoryResponse;
  historySummary: HistorySummary;
}
