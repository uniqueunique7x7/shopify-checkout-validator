"""Execution history stored in a JSON file (no external database)."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from ...core.errors import ApiException
from ..deps import history_store

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("", summary="Paginated history with filters")
async def list_history(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    site: Optional[str] = None,
    bucket: Optional[str] = Query(None, pattern="^(live|die|error)$"),
    response: Optional[str] = None,
    search: Optional[str] = None,
) -> dict[str, Any]:
    return history_store.list(
        limit=limit, offset=offset, site=site, bucket=bucket, response=response, search=search
    )


@router.get("/summary", summary="Aggregated history counters")
async def history_summary() -> dict[str, Any]:
    return history_store.summary()


@router.get("/export", response_class=PlainTextResponse, summary="Download history (json|txt)")
async def export_history(fmt: str = Query("json", pattern="^(json|csv|txt)$")) -> PlainTextResponse:
    body = history_store.export(fmt)
    ext = "csv" if fmt == "csv" else "txt" if fmt == "txt" else "json"
    mime = "text/csv" if fmt == "csv" else "text/plain" if fmt == "txt" else "application/json"
    return PlainTextResponse(
        body,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="shopify-history.{ext}"'},
    )


@router.delete("", summary="Clear history (confirmation required)")
async def clear_history(confirm: bool = Query(False, description="Must be true")) -> dict[str, Any]:
    if not confirm:
        raise ApiException(
            "CONFIRMATION_REQUIRED", "Set confirm=true to delete the stored history.", 400
        )
    return {"deleted": history_store.clear()}
