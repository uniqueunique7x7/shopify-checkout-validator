"""Health, config, stats and raw log endpoints."""

from __future__ import annotations

import time
from typing import Any, Optional

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from ...core.config import settings
from ...core.logging import ring_entries
from ...models.schemas import HealthResponse, StatsResponse
from ...services.engine import module_env_summary
from ..deps import cards_store, engine, history_store, jobs, runtime

router = APIRouter(prefix="/api", tags=["system"])

STARTED_AT = time.time()
VERSION = "4.0.0"


def _health_payload() -> dict[str, Any]:
    current = runtime.get()
    return {
        "status": "ok",
        "version": VERSION,
        "cards_loaded": len(cards_store.get()),
        "jobs": jobs.counts(),
        "pool_size": settings.pool_size,
        "pool_per_host": settings.pool_per_host,
        "site_concurrency": current.site_concurrency,
        "cache_ttl": current.cache_ttl,
        "max_price": current.max_price,
        "cache_entries": len(engine.cache_snapshot()),
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
    }


@router.get("/health", response_model=HealthResponse, summary="Service health + live counters")
async def health() -> dict[str, Any]:
    return _health_payload()


@router.get("/config", summary="Static configuration (safe to expose)")
async def config() -> dict[str, Any]:
    current = runtime.get()
    return {
        "version": VERSION,
        "log_level": current.log_level,
        "runtime_settings": current.model_dump(),
        "env": module_env_summary(),
        "limits": {
            "pool_size": settings.pool_size,
            "pool_per_host": settings.pool_per_host,
            "max_concurrency": settings.max_concurrency,
            "max_batch_tasks": settings.max_batch_tasks,
            "cors_origins": settings.cors_list,
        },
        "responses": {
            "live": sorted(["ORDER_PLACED", "3DS_REQUIRED", "INSUFFICIENT_FUNDS", "INVALID_CVC",
                            "EXPIRED_CARD", "INVALID_CARD", "CARD_DECLINED"]),
            "error": sorted(["CAPTCHA_REQUIRED", "THROTTLED", "TIMEOUT", "GRAPHQL_ERROR",
                             "CART_FAILED", "NO_ATTEMPT_TOKEN", "NO_SESSION_TOKEN",
                             "SESSION_EXPIRED", "NO_SHOPIFY_PAYMENTS_GATEWAY", "NO_PRODUCT",
                             "SITE_REQUIRES_LOGIN", "CHECKPOINTDENIED", "NEGOTIATE_FAILED",
                             "TOKENIZATION_FAILED", "SUBMIT_FAILED", "PRICE_OVER_MAX"]),
        },
    }


@router.get("/stats", response_model=StatsResponse, summary="Runtime statistics + history summary")
async def stats() -> dict[str, Any]:
    return {"stats": dict(engine.stats), "history": history_store.summary()}


@router.get("/logs", summary="Recent server log records (ring buffer)")
async def logs(
    limit: int = Query(200, ge=1, le=1000),
    level: Optional[str] = Query(None, description="DEBUG | INFO | WARNING | ERROR"),
) -> dict[str, Any]:
    return {"items": ring_entries(limit=limit, level=level)}


@router.get("/requests-log", response_class=PlainTextResponse, summary="Tail of requests.txt")
async def requests_log(lines: int = Query(200, ge=1, le=5000)) -> str:
    from pathlib import Path

    path = Path(settings.log_file)
    if not path.exists():
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        data = fh.readlines()
    return "".join(data[-lines:])
