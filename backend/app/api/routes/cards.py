"""Cards file management (equivalent of editing cards.txt by hand)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, UploadFile

from ...core.errors import ApiException
from ...models.schemas import CardsSnapshot, CardsWriteRequest, CardsWriteResponse
from ..deps import cards_store

router = APIRouter(prefix="/api/cards", tags=["cards"])

MAX_UPLOAD_BYTES = 4 * 1024 * 1024


@router.get("", response_model=CardsSnapshot, summary="Inspect the loaded cards")
async def get_cards() -> dict[str, Any]:
    return cards_store.snapshot(masked=True)


@router.post("", response_model=CardsWriteResponse, summary="Replace the cards file")
async def replace_cards(payload: CardsWriteRequest) -> dict[str, Any]:
    lines = _collect(payload)
    if not lines:
        raise ApiException("EMPTY_PAYLOAD", "Provide at least one card line.", 422)
    result = cards_store.write_lines(lines)
    return {**result, "snapshot": cards_store.snapshot()}


@router.post("/append", response_model=CardsWriteResponse, summary="Append cards to the file")
async def append_cards(payload: CardsWriteRequest) -> dict[str, Any]:
    lines = _collect(payload)
    if not lines:
        raise ApiException("EMPTY_PAYLOAD", "Provide at least one card line.", 422)
    result = cards_store.append_lines(lines)
    return {**result, "snapshot": cards_store.snapshot()}


@router.post("/upload", response_model=CardsWriteResponse, summary="Upload a .txt cards file")
async def upload_cards(
    file: UploadFile = File(..., description="Plain text file, one card per line"),
) -> dict[str, Any]:
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ApiException("FILE_TOO_LARGE", "Cards file must be smaller than 4 MB.", 413)
    text = raw.decode("utf-8", errors="ignore")
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ApiException("EMPTY_FILE", "The uploaded file contains no card lines.", 422)
    result = cards_store.write_lines(lines)
    return {**result, "snapshot": cards_store.snapshot()}


@router.post("/reload", response_model=CardsSnapshot, summary="Reload cards from disk")
async def reload_cards() -> dict[str, Any]:
    cards_store.reload()
    return cards_store.snapshot(masked=True)


@router.delete("", response_model=CardsSnapshot, summary="Empty the cards file")
async def clear_cards() -> dict[str, Any]:
    cards_store.clear()
    return cards_store.snapshot(masked=True)


@router.get("/bins", summary="BIN distribution of the loaded cards")
async def bins() -> dict[str, Any]:
    return {"items": cards_store.bins()}


def _collect(payload: CardsWriteRequest) -> list[str]:
    if payload.text:
        return [line for line in payload.text.splitlines() if line.strip()]
    return payload.lines
