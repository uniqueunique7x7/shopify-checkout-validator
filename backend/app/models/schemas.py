"""Pydantic models for requests/responses (used by the OpenAPI docs too)."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

Bucket = Literal["live", "die", "error"]
JobStatus = Literal["queued", "running", "paused", "completed", "failed", "cancelled"]


# ---------------------------------------------------------------------------
# shared
# ---------------------------------------------------------------------------
class ApiError(BaseModel):
    code: str = Field(..., description="Machine readable error code.")
    message: str = Field(..., description="Human readable message.")
    details: Any = Field(None, description="Optional structured details.")


class ErrorResponse(BaseModel):
    success: bool = False
    error: ApiError


class ResultRecord(BaseModel):
    index: int
    worker: int
    site: str
    requested_site: str = ""
    targets_tried: int = Field(
        1,
        description="How many stores this task visited (card scans recheck an errored card on the next store).",
    )
    card: str = ""
    card_full: str = Field(
        "",
        description="Full cc|mm|yy|cvv used for the task, so the exact card can be identified.",
    )
    response: str
    bucket: Bucket
    gate: str = ""
    product: str = ""
    price: str = "0.00"
    time: str = ""
    elapsed_ms: int = 0
    approved: bool = False
    charged: bool = False
    gateway_live: bool = False
    detail: Optional[str] = None
    attempts: int = 1


class RawResult(BaseModel):
    """Direct port of the original `validate_card()` return value."""

    Response: str
    CC: str = ""
    CCMasked: str = ""
    Product: str = ""
    Price: str = "0.00"
    Gate: str = "UNKNOWN"
    Site: str = ""
    Charged: str = "False"
    Approved: str = "False"
    Time: str = "0s"
    ElapsedMs: int = 0
    Detail: Optional[str] = None
    bucket: Bucket = "error"
    gateway_live: bool = False
    approved: bool = False
    charged: bool = False


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
class ValidateRequest(BaseModel):
    site: str = Field(..., min_length=3, max_length=2048, description="Store URL or hostname.")
    card: Optional[str] = Field(None, description="cc|mm|yy|cvv (omit to use the cards file).")
    proxy: Optional[str] = Field(None, description="host:port:user:pass")
    max_price: Optional[float] = Field(None, gt=0, le=1_000_000, description="Override MAX_PRICE.")
    variant_id: Optional[str] = Field(None, description="Target a specific product variant.")

    @field_validator("site", "card", "proxy", "variant_id")
    @classmethod
    def _strip(cls, v):
        return v.strip() if isinstance(v, str) else v


class CheckRequest(ValidateRequest):
    """Store health probe — same flow as `/check` in the original API."""


class CheckResponse(BaseModel):
    valid: bool
    site: str
    url: str = ""
    product: str = ""
    price: str = "0.00"
    card_response: str
    gate: str = "UNKNOWN"
    approved: str = "False"
    charged: str = "False"
    time: str = ""
    bucket: Bucket
    gateway_live: bool
    detail: Optional[str] = None
    raw: RawResult


# ---------------------------------------------------------------------------
# jobs
# ---------------------------------------------------------------------------
class JobCreateRequest(BaseModel):
    sites: list[str] = Field(
        default_factory=list,
        description=(
            "Store URLs, one per entry. May be empty only for card mode with "
            "random_target set, where the stores come from the live-site pool."
        ),
    )
    cards: list[str] = Field(default_factory=list, description="cc|mm|yy|cvv entries (optional).")
    proxy: Optional[str] = None
    concurrency: Optional[int] = Field(None, ge=1, le=50, description="Parallel workers.")
    retries: Optional[int] = Field(None, ge=1, le=10, description="Attempts per task.")
    max_price: Optional[float] = Field(None, gt=0, le=1_000_000)
    variant_id: Optional[str] = None
    endpoint: Literal["check", "shopify"] = "check"
    mode: Literal["site", "card", "pair"] = Field(
        "pair",
        description=(
            "site = one task per store; card = one task per card against a single store; "
            "pair = index-paired store/card lists (legacy behaviour)."
        ),
    )
    random_target: bool = Field(
        False,
        description=(
            "card mode only: ignore the supplied stores and deal each card its own "
            "store from the live-site pool, so one run sweeps many gateways."
        ),
    )

    @field_validator("sites", "cards")
    @classmethod
    def _clean_list(cls, v: list[str]) -> list[str]:
        out = []
        for item in v:
            text = (item or "").strip()
            if text and not text.startswith("#"):
                out.append(text)
        return out


class JobLogEntry(BaseModel):
    ts: float
    level: str
    message: str
    index: Optional[int] = None


class JobSummary(BaseModel):
    id: str
    kind: str
    status: JobStatus
    params: dict[str, Any]
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    total: int
    completed: int
    pending: int
    counters: dict[str, int]
    elapsed: float
    eta: Optional[float] = None
    current: list[str] = []
    error: Optional[str] = None
    cancel_requested: bool = False
    pause_requested: bool = False
    progress: float = 0.0


class JobDetail(JobSummary):
    results: list[ResultRecord] = []
    logs: list[JobLogEntry] = []


class JobListResponse(BaseModel):
    items: list[JobSummary]
    counts: dict[str, int]


# ---------------------------------------------------------------------------
# cards
# ---------------------------------------------------------------------------
class CardItem(BaseModel):
    number: str
    month: str
    year: str
    cvv: str
    bin: str = ""
    last4: str = ""


class CardsSnapshot(BaseModel):
    path: str
    exists: bool
    count: int
    invalid_count: int
    invalid_sample: list[str] = []
    loaded_at: float = 0
    cards: list[CardItem] = []


class CardsWriteRequest(BaseModel):
    lines: list[str] = Field(default_factory=list, description="Raw card lines.")
    text: Optional[str] = Field(None, description="Alternative: one card per line in a single string.")


class CardsWriteResponse(BaseModel):
    saved: int
    added: Optional[int] = None
    invalid_count: int = 0
    invalid: list[str] = []
    snapshot: CardsSnapshot


# ---------------------------------------------------------------------------
# settings / system
# ---------------------------------------------------------------------------
class RuntimeSettingsModel(BaseModel):
    max_price: float
    site_concurrency: int
    request_timeout: float
    connect_timeout: float
    cache_ttl: float
    default_concurrency: int
    default_retries: int
    log_level: str
    history_store_full_cards: bool
    history_limit: int


class RuntimeSettingsPatch(BaseModel):
    max_price: Optional[float] = Field(None, gt=0, le=1_000_000)
    site_concurrency: Optional[int] = Field(None, ge=1, le=200)
    request_timeout: Optional[float] = Field(None, ge=5, le=300)
    connect_timeout: Optional[float] = Field(None, ge=1, le=120)
    cache_ttl: Optional[float] = Field(None, ge=0, le=86_400)
    default_concurrency: Optional[int] = Field(None, ge=1, le=50)
    default_retries: Optional[int] = Field(None, ge=1, le=10)
    log_level: Optional[Literal["debug", "info", "warning", "error"]] = None
    history_store_full_cards: Optional[bool] = None
    history_limit: Optional[int] = Field(None, ge=100, le=500_000)


class HealthResponse(BaseModel):
    status: str
    version: str
    cards_loaded: int
    jobs: dict[str, int]
    pool_size: int
    pool_per_host: int
    site_concurrency: int
    cache_ttl: float
    max_price: float
    cache_entries: int
    uptime_seconds: float


class ProductCandidate(BaseModel):
    variant_id: str
    title: str
    price: str
    handle: str = ""


class ProductsResponse(BaseModel):
    site: str
    host: str
    max_price: float = 0
    best: Optional[ProductCandidate] = None
    candidates: list[ProductCandidate] = []
    count: int = 0
    error: Optional[str] = None
    cached: bool = False


class StatsResponse(BaseModel):
    stats: dict[str, int]
    history: dict[str, Any]
