"""Runtime settings + product cache control."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ...core.errors import ApiException
from ...core.logging import log, set_level
from ...models.schemas import RuntimeSettingsModel, RuntimeSettingsPatch
from ..deps import engine, history_store, runtime

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings", response_model=RuntimeSettingsModel, summary="Current runtime settings")
async def get_settings() -> dict[str, Any]:
    return runtime.get().model_dump()


@router.put("/settings", response_model=RuntimeSettingsModel, summary="Update runtime settings")
async def update_settings(patch: RuntimeSettingsPatch) -> dict[str, Any]:
    payload = patch.model_dump(exclude_none=True)
    if not payload:
        raise ApiException("EMPTY_PATCH", "No settings supplied.", 422)
    updated = runtime.update(payload)

    # apply the effects that can be changed live
    if "log_level" in payload:
        set_level(updated.log_level)
        log.info("log level changed to %s", updated.log_level)
    if "history_limit" in payload or "history_store_full_cards" in payload:
        history_store.configure(
            limit=updated.history_limit, store_full_cards=updated.history_store_full_cards
        )
    if "site_concurrency" in payload:
        engine._site_semaphores.clear()  # new limits apply to the next request
        log.info("per-site concurrency updated to %s", updated.site_concurrency)

    return updated.model_dump()


@router.post("/settings/reset", response_model=RuntimeSettingsModel, summary="Reset to .env defaults")
async def reset_settings() -> dict[str, Any]:
    updated = runtime.reset()
    set_level(updated.log_level)
    return updated.model_dump()


@router.get("/cache", summary="Inspect the product cache")
async def cache() -> dict[str, Any]:
    current = runtime.get()
    items = engine.cache_snapshot()
    return {"count": len(items), "ttl": current.cache_ttl, "items": items}


@router.post("/cache/clear", summary="Clear the product cache")
async def clear_cache() -> dict[str, Any]:
    return {"cleared": engine.clear_cache()}
