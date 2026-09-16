"""Single-shot validation endpoints (mirrors GET /shopify, GET /check)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from ...core.errors import ApiException
from ...models.schemas import CheckRequest, CheckResponse, ProductsResponse, RawResult, ValidateRequest
from ...services.engine import LIVE_RESPONSES
from ..deps import cards_store, engine, jobs, normalize_site, parse_card_or_none, runtime, validate_proxy

router = APIRouter(prefix="/api", tags=["validation"])


@router.post("/validate", response_model=RawResult, summary="Validate one card on one store")
async def validate(payload: ValidateRequest) -> dict[str, Any]:
    """
    Full checkout flow against a single store:

    cart → checkout page → shipping proposal → delivery proposal →
    card tokenization → submit → receipt poll.
    """
    try:
        site = normalize_site(payload.site)
    except ValueError as ex:
        raise ApiException("INVALID_SITE", f"Invalid store URL: {ex}", 422)

    card = parse_card_or_none(payload.card)
    if payload.card and card is None:
        raise ApiException(
            "INVALID_CARD", "Bad card format. Use cc|mm|yy|cvv or cc|mm|yyyy|cvv", 422
        )

    try:
        proxy = validate_proxy(payload.proxy)
    except ValueError as ex:
        raise ApiException("INVALID_PROXY", str(ex), 422)

    if card is None and not cards_store.get():
        raise ApiException(
            "NO_CARDS",
            f"No card supplied and {cards_store.path} is empty. Upload cards or send a card.",
            400,
        )

    return await jobs.run_single(
        site,
        card=card,
        proxy=proxy,
        max_price=payload.max_price,
        variant_id=payload.variant_id,
    )


@router.post("/check", response_model=CheckResponse, summary="Probe a store's gateway (live/die)")
async def check(payload: CheckRequest) -> dict[str, Any]:
    try:
        site = normalize_site(payload.site)
    except ValueError as ex:
        raise ApiException("INVALID_SITE", f"Invalid store URL: {ex}", 422)

    card = parse_card_or_none(payload.card)
    if payload.card and card is None:
        raise ApiException("INVALID_CARD", "Bad card format. Use cc|mm|yy|cvv or cc|mm|yyyy|cvv", 422)
    if card is None:
        card = cards_store.random_card()
    if card is None:
        raise ApiException("NO_CARDS", f"cards.txt is empty ({cards_store.path})", 400)

    try:
        proxy = validate_proxy(payload.proxy)
    except ValueError as ex:
        raise ApiException("INVALID_PROXY", str(ex), 422)

    probe = await engine.probe_store(
        site, card, proxy_str=proxy, max_price=payload.max_price, variant_id=payload.variant_id
    )
    jobs._record(probe["raw"], origin="check", proxy=bool(proxy))
    return probe


@router.get("/products", response_model=ProductsResponse, summary="List variants under the price cap")
async def products(
    site: str = Query(..., description="Store URL or hostname"),
    max_price: float | None = Query(None, gt=0, le=1_000_000),
    refresh: bool = Query(False, description="Bypass the product cache"),
    limit: int = Query(100, ge=1, le=250),
    proxy: str | None = Query(None, description="host:port:user:pass"),
) -> dict[str, Any]:
    """Uses the same product discovery routine as the checkout flow."""
    try:
        url = normalize_site(site)
    except ValueError as ex:
        raise ApiException("INVALID_SITE", f"Invalid store URL: {ex}", 422)
    try:
        proxy_clean = validate_proxy(proxy)
    except ValueError as ex:
        raise ApiException("INVALID_PROXY", str(ex), 422)

    from urllib.parse import urlparse

    host = urlparse(url).netloc
    cap = max_price if max_price is not None else runtime.max_price
    before = {(entry["host"], entry["max_price"]) for entry in engine.cache_snapshot()}
    best, candidates, err = await engine.fetch_products(
        url, proxy_str=proxy_clean, max_price=max_price, use_cache=not refresh
    )
    cached = (host, cap) in before and not refresh

    # The engine filters while building the cache; filter again for the caller's
    # cap so a shared cache entry always honours the requested limit.
    candidates = [c for c in candidates if float(c.get("price", "inf")) <= cap]
    best = min(candidates, key=lambda c: float(c["price"]), default=None)

    trimmed = candidates[:limit]
    return {
        "site": url,
        "host": host,
        "max_price": cap,
        "best": best and {
            "variant_id": best["variant_id"], "title": best.get("title", ""),
            "price": best["price"], "handle": best.get("handle", ""),
        },
        "candidates": [
            {
                "variant_id": c["variant_id"], "title": c.get("title", ""),
                "price": c["price"], "handle": c.get("handle", ""),
            }
            for c in trimmed
        ],
        "count": len(candidates),
        "error": err or (None if candidates else f"No products under ${cap:.2f}"),
        "cached": cached,
    }


@router.get("/responses", summary="Response codes recognised by the classifier")
async def response_codes() -> dict[str, Any]:
    return {
        "live_responses": sorted(LIVE_RESPONSES),
        "note": "LIVE_RESPONSES mirrors the original module-level set in main.py.",
    }
