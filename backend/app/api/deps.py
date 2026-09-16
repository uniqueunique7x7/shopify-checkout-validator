"""Shared service singletons and small validation helpers for the API layer."""

from __future__ import annotations

import re
from typing import Iterable, Optional
from urllib.parse import urlparse

from ..core.config import runtime_store, settings
from ..services.cards import CardsStore
from ..services.engine import engine, parse_card, parse_proxy
from ..services.history import HistoryStore
from ..services.jobs import JobManager

cards_store = CardsStore(settings.cards_file)
history_store = HistoryStore(
    settings.history_file,
    limit=settings.history_limit,
    store_full_cards=settings.history_store_full_cards,
)
jobs = JobManager(engine, cards_store, runtime_store, history_store)
runtime = runtime_store

HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", re.I)


def normalize_site(raw: str) -> str:
    """Normalize a store URL/hostname and reject anything unusable."""
    site = (raw or "").strip().strip(",")
    if not site:
        raise ValueError("empty site")
    if "://" not in site:
        site = f"https://{site}"
    parsed = urlparse(site)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"unsupported scheme '{parsed.scheme}' for {raw}")
    host = (parsed.netloc or "").split("@")[-1].split(":")[0].lower()
    if not host or not HOST_RE.match(host):
        raise ValueError(f"invalid hostname '{host or raw}'")
    return f"{parsed.scheme}://{host}"


def normalize_sites(values: Iterable[str]) -> tuple[list[str], list[dict]]:
    """Returns (good, rejected). Duplicates are removed, order preserved."""
    good: list[str] = []
    rejected: list[dict] = []
    seen: set[str] = set()
    for raw in values:
        try:
            site = normalize_site(raw)
        except ValueError as ex:
            rejected.append({"value": raw, "reason": str(ex)})
            continue
        if site not in seen:
            seen.add(site)
            good.append(site)
    return good, rejected


def parse_card_or_none(raw: Optional[str]) -> Optional[dict]:
    if not raw:
        return None
    return parse_card(raw)


def validate_proxy(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    if not parse_proxy(raw):
        raise ValueError("Proxy must use the format host:port:user:pass")
    return raw.strip()


def require_card(raw: Optional[str]) -> dict:
    card = parse_card(raw or "")
    if not card:
        raise ValueError("Bad card format. Use cc|mm|yy|cvv or cc|mm|yyyy|cvv")
    return card
