"""
Configuration.

Environment variables define the *defaults* (same names as the original
`main.py`). A subset of them ("runtime settings") can also be changed from the
web UI and is persisted to ``backend/data/settings.json``.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = PROJECT_ROOT / "backend"
# Serverless hosts (Vercel, AWS Lambda) only allow writes to /tmp. Vercel
# always sets VERCEL=1, so runtime data lands in /tmp there automatically.
ON_VERCEL = os.environ.get("VERCEL") == "1"
if ON_VERCEL:
    DATA_DIR = Path("/tmp/data")
else:
    DATA_DIR = Path(os.environ.get("DATA_DIR", str(BACKEND_DIR / "data")))
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass

LogLevel = Literal["debug", "info", "warning", "error"]


class Settings(BaseSettings):
    """Static, process-level configuration (read from the environment once)."""

    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- server -----------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8080
    workers: int = 1
    cors_origins: str = "*"

    # --- engine -----------------------------------------------------------
    cards_file: str = str(Path("/tmp/cards.txt") if ON_VERCEL else PROJECT_ROOT / "cards.txt")
    max_price: float = 500.0
    site_concurrency: int = 15
    pool_size: int = 500
    pool_per_host: int = 25
    connect_timeout: float = 8.0
    request_timeout: float = 35.0
    cache_ttl: float = 300.0

    # --- defaults for batch jobs -----------------------------------------
    default_concurrency: int = 3
    default_retries: int = 1
    max_concurrency: int = 50
    max_batch_tasks: int = 50_000
    # Card scans roll a card that errors (captcha, throttle, no product) onto the
    # next store until it earns a real verdict. This caps how many stores one
    # card may visit, and how many card errors a store may collect before it is
    # dropped from the live pool altogether.
    card_max_targets: int = 12
    card_error_limit: int = 2

    # --- storage ----------------------------------------------------------
    history_file: str = str(DATA_DIR / "history.json")
    jobs_file: str = str(DATA_DIR / "jobs.json")
    jobs_keep: int = 30
    job_persist_interval: float = 5.0
    runtime_settings_file: str = str(DATA_DIR / "settings.json")
    history_limit: int = 5000
    history_store_full_cards: bool = False

    # --- logging ----------------------------------------------------------
    log_level: str = "info"
    log_file: str = str(DATA_DIR / "requests.txt")
    log_ring_size: int = 500

    @field_validator("log_level")
    @classmethod
    def _norm_level(cls, v: str) -> str:
        return (v or "info").lower()

    @field_validator("cards_file")
    @classmethod
    def _vercel_cards_path(cls, v: str) -> str:
        # Vercel's auto-detected env may set CARDS_FILE=cards.txt, but the
        # function filesystem is read-only outside /tmp.
        if ON_VERCEL:
            return str(Path("/tmp") / "cards.txt")
        return v

    @property
    def cors_list(self) -> list[str]:
        raw = (self.cors_origins or "*").strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


class RuntimeSettings(BaseModel):
    """Settings that can be changed from the web UI at runtime."""

    max_price: float = Field(500.0, gt=0, le=1_000_000, description="Maximum allowed cart total.")
    site_concurrency: int = Field(15, ge=1, le=200, description="Simultaneous requests per store.")
    request_timeout: float = Field(35.0, ge=5, le=300, description="Full request timeout (seconds).")
    connect_timeout: float = Field(8.0, ge=1, le=120, description="TCP connect timeout (seconds).")
    cache_ttl: float = Field(300.0, ge=0, le=86_400, description="Product cache TTL (seconds).")
    default_concurrency: int = Field(3, ge=1, le=50, description="Default parallel workers for batch jobs.")
    default_retries: int = Field(1, ge=1, le=10, description="Default attempts per task before it is reported.")
    log_level: LogLevel = "info"
    history_store_full_cards: bool = False
    history_limit: int = Field(5000, ge=100, le=500_000)


class RuntimeSettingsStore:
    """Merged view of env defaults + persisted runtime overrides."""

    def __init__(self, base: Settings):
        self._base = base
        self._path = Path(base.runtime_settings_file)
        self._lock = threading.Lock()
        self._values = RuntimeSettings(**_env_defaults(base))
        self._load()

    # -- persistence -------------------------------------------------------
    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            merged = {**self._values.model_dump(), **{k: v for k, v in raw.items() if k in RuntimeSettings.model_fields}}
            self._values = RuntimeSettings(**merged)
        except Exception:  # corrupted file -> keep defaults
            pass

    def _save(self) -> None:
        try:
            self._path.write_text(
                json.dumps(self._values.model_dump(), indent=2), encoding="utf-8"
            )
        except OSError:
            pass

    # -- api ---------------------------------------------------------------
    def get(self) -> RuntimeSettings:
        return self._values

    def update(self, patch: dict[str, Any]) -> RuntimeSettings:
        clean = {k: v for k, v in patch.items() if k in RuntimeSettings.model_fields and v is not None}
        if not clean:
            return self._values
        with self._lock:
            self._values = RuntimeSettings(**{**self._values.model_dump(), **clean})
            self._save()
            return self._values

    def reset(self) -> RuntimeSettings:
        with self._lock:
            self._values = RuntimeSettings(**_env_defaults(self._base))
            self._save()
            return self._values

    # -- convenience accessors used by the engine ---------------------------
    @property
    def max_price(self) -> float:
        return self._values.max_price

    @property
    def site_concurrency(self) -> int:
        return self._values.site_concurrency

    @property
    def request_timeout(self) -> float:
        return self._values.request_timeout

    @property
    def cache_ttl(self) -> float:
        return self._values.cache_ttl

    @property
    def log_level(self) -> str:
        return self._values.log_level


def _env_defaults(base: Settings) -> dict[str, Any]:
    return {
        "max_price": base.max_price,
        "site_concurrency": base.site_concurrency,
        "request_timeout": base.request_timeout,
        "connect_timeout": base.connect_timeout,
        "cache_ttl": base.cache_ttl,
        "default_concurrency": base.default_concurrency,
        "default_retries": base.default_retries,
        "log_level": base.log_level,
        "history_store_full_cards": base.history_store_full_cards,
        "history_limit": base.history_limit,
    }


settings = Settings()
runtime_store = RuntimeSettingsStore(settings)

# Respect the LOG_LEVEL env var on boot.
os.environ.setdefault("LOG_LEVEL", settings.log_level)
