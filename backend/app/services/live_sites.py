"""
Aggregated "live sites" pool.

The card validator needs a target store, and the natural source is whatever the
site validator already proved to be live. This module collects that pool from
two places so results survive a restart:

  * the in-memory jobs this process is holding (fast path, includes running jobs)
  * the persisted history file (survives restarts, covers earlier sessions)
"""

from __future__ import annotations

import time
from typing import Any

from ..core.config import settings as app_settings
from ..services.jobs import TERMINAL, JobManager
from ..services.history import HistoryStore

# The pool is rebuilt from the (potentially large) history file, so the result is
# memoised briefly. Without this every keystroke in the UI search box would walk
# the whole history again.
_CACHE_TTL = 5.0
_cache: dict[str, Any] = {"key": None, "ts": 0.0, "value": None}


def _cache_key(source: str, include_running: bool, job_signature: str) -> str:
    return f"{source}|{include_running}|{job_signature}"


def _entry(
    site: str,
    *,
    responses: set[str],
    gate: str,
    last_seen: float,
    product: str = "",
    price: str = "",
) -> dict[str, Any]:
    return {
        "site": site,
        "responses": sorted(responses),
        "gate": gate,
        "last_seen": last_seen,
        "product": product,
        "price": price,
        "hits": len(responses),
    }


def _job_signature(manager: JobManager) -> str:
    """Cheap fingerprint so new job results invalidate the memo."""
    summaries = manager.list(limit=500)
    return f"{len(summaries)}:{summaries[0]['id'] if summaries else ''}:{summaries[0]['completed'] if summaries else 0}"


def _build(
    manager: JobManager,
    history: HistoryStore,
    *,
    include_running: bool,
    source: str,
) -> list[dict[str, Any]]:
    pool: dict[str, dict[str, Any]] = {}
    # A store that keeps erroring on card checks (captcha, throttle, …) is no
    # longer a usable target, so it is dropped from the pool entirely once it
    # has failed this many card tasks. `card_error_limit` defaults to 2.
    card_errors: dict[str, int] = {}

    def host_key(site: str) -> str:
        return site.rstrip("/").lower().removeprefix("https://").removeprefix("http://")

    def add(site: str, response: str, gate: str, ts: float, product: str = "", price: str = "") -> None:
        if not site:
            return
        key = site.rstrip("/").lower()
        existing = pool.get(key)
        if existing is None:
            pool[key] = {
                "site": site,
                "responses": {response},
                "gate": gate or "UNKNOWN",
                "last_seen": ts,
                "product": product,
                "price": price,
            }
            return
        existing["responses"].add(response)
        if ts >= existing["last_seen"]:
            existing["last_seen"] = ts
            existing["gate"] = gate or existing["gate"]
            if product:
                existing["product"] = product
            if price:
                existing["price"] = price

    if source in ("all", "jobs"):
        for summary in manager.list(limit=500):
            job = manager.get(summary["id"])
            if job is None:
                continue
            if not include_running and job.status not in TERMINAL:
                continue
            card_job = job.kind == "card"
            for row in job.results:
                site = row.get("site") or row.get("requested_site") or ""
                bucket = row.get("bucket")
                if bucket == "live":
                    add(
                        site,
                        row.get("response", ""),
                        row.get("gate", ""),
                        job.finished_at or job.started_at or job.created_at,
                        row.get("product", ""),
                        row.get("price", ""),
                    )
                    card_errors[host_key(site)] = 0
                elif card_job and bucket == "error":
                    if str(row.get("response", "")) == "CANCELLED":
                        # A cancel is the user's call, not a store failure.
                        continue
                    key = host_key(site)
                    card_errors[key] = card_errors.get(key, 0) + 1
                elif card_job and bucket:
                    # A real card verdict (success or decline) proves the store works.
                    card_errors[host_key(site)] = 0

    if source in ("all", "history"):
        # One ordered pass: the counter is the number of card errors *since* the
        # store last proved itself, so a store that recovers comes back on its own.
        for item in history.iter_items():
            site = item.get("site", "")
            bucket = item.get("bucket")
            if bucket == "live":
                add(
                    site,
                    item.get("response", ""),
                    item.get("gate", ""),
                    item.get("ts", 0.0),
                    item.get("product", ""),
                    item.get("price", ""),
                )
                card_errors[host_key(site)] = 0
            elif item.get("mode") != "card":
                continue
            elif bucket == "error":
                if str(item.get("response", "")) == "CANCELLED":
                    # A cancel is the user's call, not a store failure.
                    continue
                key = host_key(site)
                if key:
                    card_errors[key] = card_errors.get(key, 0) + 1
            elif bucket:
                # success/decline on a card check: usable again
                card_errors[host_key(site)] = 0

    limit = max(1, int(app_settings.card_error_limit))
    entries = []
    for value in pool.values():
        failures = card_errors.get(host_key(value["site"]), 0)
        if failures >= limit:
            continue
        entry = _entry(
            value["site"],
            responses=value["responses"],
            gate=value["gate"],
            last_seen=value["last_seen"],
            product=value.get("product", ""),
            price=value.get("price", ""),
        )
        entry["errors"] = failures
        entries.append(entry)
    entries.sort(key=lambda e: (-e["last_seen"], e["site"]))
    return entries


def collect_live_sites(
    manager: JobManager,
    history: HistoryStore,
    *,
    include_running: bool = True,
    source: str = "all",
    offset: int = 0,
    limit: int = 100,
    search: str = "",
    refresh: bool = False,
) -> dict[str, Any]:
    """
    Paginated, de-duplicated list of stores that produced approved-class evidence.

    Filtering and slicing happen **server-side** so the browser never receives
    (or renders) more rows than it asked for — the pool can hold tens of
    thousands of stores without slowing the UI down.

    ``source`` narrows where the data comes from:
      * ``all``     – live jobs + history
      * ``jobs``    – in-memory jobs only
      * ``history`` – the persisted history file only
    """
    signature = _job_signature(manager) if source in ("all", "jobs") else "history"
    key = _cache_key(source, include_running, signature)
    now = time.time()

    entries = None
    if (
        not refresh
        and _cache["value"] is not None
        and _cache["key"] == key
        and (now - _cache["ts"]) < _CACHE_TTL
    ):
        entries = _cache["value"]

    if entries is None:
        entries = _build(manager, history, include_running=include_running, source=source)
        _cache.update({"key": key, "ts": now, "value": entries})

    total_unfiltered = len(entries)

    needle = (search or "").strip().lower()
    if needle:
        entries = [
            e
            for e in entries
            if needle in e["site"].lower()
            or needle in e["gate"].lower()
            or needle in " ".join(e["responses"]).lower()
        ]

    total = len(entries)
    offset = max(0, offset)
    limit = max(1, min(limit, 1000))
    page = entries[offset: offset + limit]

    return {
        "total": total,
        "total_unfiltered": total_unfiltered,
        "offset": offset,
        "limit": limit,
        "count": len(page),
        "has_more": offset + len(page) < total,
        "sites": [e["site"] for e in page],
        "as_text": "\n".join(e["site"] for e in page),
        "items": page,
        "source": source,
        "include_running": include_running,
        "search": search,
        "cached": entries is not None and _cache["key"] == key,
    }


def invalidate_cache() -> None:
    """Called when a job finishes so the next read sees the new results."""
    _cache.update({"key": None, "ts": 0.0, "value": None})


# Hard ceiling for the unpaged read below. A job cannot fan out further than
# this anyway, because every card needs its own task.
MAX_POOL_SITES = 20_000


def all_live_sites(
    manager: JobManager,
    history: HistoryStore,
    *,
    include_running: bool = True,
    source: str = "all",
    cap: int = MAX_POOL_SITES,
) -> list[str]:
    """
    Every live store as a flat, de-duplicated list of URLs.

    Used when a job needs the *whole* pool rather than one page — currently the
    card validator's random-target mode, which deals one store per card. The
    memo inside :func:`collect_live_sites` is reused, so this stays a single
    walk over the jobs and the history file.
    """
    sites: list[str] = []
    offset = 0
    page_size = 1000

    while len(sites) < cap:
        page = collect_live_sites(
            manager,
            history,
            include_running=include_running,
            source=source,
            offset=offset,
            limit=page_size,
        )
        sites.extend(page["sites"])
        if not page["has_more"] or not page["count"]:
            break
        offset += page["count"]

    if not sites:
        return []

    # Keep the newest-first order while dropping duplicates the pool may hold
    # under differently cased or trailing-slash spellings of the same host.
    seen: set[str] = set()
    unique: list[str] = []
    for site in sites:
        key = site.rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(site)
    return unique[:cap]

