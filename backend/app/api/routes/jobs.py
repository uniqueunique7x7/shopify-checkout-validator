"""Batch job API: create, monitor (poll + SSE), pause, resume, cancel, export."""

from __future__ import annotations

import asyncio
import csv
import io
import json
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import PlainTextResponse, StreamingResponse

from ...core.config import settings
from ...core.errors import ApiException
from ...models.schemas import JobCreateRequest, JobDetail, JobListResponse
from ...services.jobs import TERMINAL, sse_format
from ...services.live_sites import all_live_sites, collect_live_sites
from ..deps import history_store, jobs, normalize_sites, parse_card_or_none, runtime, validate_proxy

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("/live-sites", summary="Aggregated pool of stores that came back live")
async def live_sites_pool(
    source: str = Query("all", pattern="^(all|jobs|history)$"),
    include_running: bool = Query(True, description="Include jobs that are still running"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    limit: int = Query(100, ge=1, le=1000, description="Rows per page"),
    search: str = Query("", max_length=200, description="Filter by store, gateway or response"),
    refresh: bool = Query(False, description="Bypass the 5s pool memo"),
    fmt: str = Query("json", pattern="^(json|text)$"),
) -> Any:
    """
    Every store that produced approved-class evidence, pooled across all site
    jobs and the persisted history file. Filtering and paging happen server-side
    so the browser only ever receives one page at a time.

    ``fmt=text`` returns the current *page* as newline-separated URLs.
    """
    pool = collect_live_sites(
        jobs,
        history_store,
        include_running=include_running,
        source=source,
        offset=offset,
        limit=limit,
        search=search,
        refresh=refresh,
    )
    if fmt == "text":
        return PlainTextResponse(
            pool["as_text"],
            media_type="text/plain",
            headers={"Content-Disposition": 'attachment; filename="live-sites.txt"'},
        )
    return pool


@router.post("", response_model=JobDetail, status_code=201, summary="Start a batch validation job")
async def create_job(payload: JobCreateRequest) -> dict[str, Any]:
    mode = payload.mode
    random_target = bool(payload.random_target) and mode == "card"
    sites, rejected = normalize_sites(payload.sites)
    # Where the per-card targets come from: a custom list wins, and only when the
    # caller supplies none do the stores get pulled from the live pool.
    pool_source = "live"

    # --- per-mode input requirements ------------------------------------
    if random_target:
        # Every card is dealt its own store, so a single target store is neither
        # required nor accepted — the supplied sites *are* the pool.
        if not payload.cards:
            raise ApiException("NO_CARDS", "Card jobs need at least one card.", 422)
        if sites:
            pool_source = "custom"
        else:
            sites = all_live_sites(jobs, history_store, include_running=True)
        if not sites:
            raise ApiException(
                "NO_LIVE_SITES",
                "No store pool to target. Paste a custom sites list, or run a site "
                "scan first so the live pool is not empty.",
                422,
            )
    elif mode == "site":
        if not sites:
            raise ApiException(
                "NO_VALID_SITES",
                "No valid store URLs supplied.",
                422,
                details={"rejected": rejected[:20]},
            )
    elif mode == "card":
        if not sites:
            raise ApiException(
                "MISSING_STORE",
                "Card jobs validate every card against a single store — provide exactly one store URL.",
                422,
                details={"rejected": rejected[:20]},
            )
        if not payload.cards:
            raise ApiException(
                "NO_CARDS",
                "Card jobs need at least one card.",
                422,
            )
        # The live pool becomes the fallback chain: a card that errors on the
        # chosen store is rechecked on the next one, so it still gets a verdict.
        pool = all_live_sites(jobs, history_store, include_running=True)
        primary = sites[0]
        key = primary.rstrip("/").lower()
        sites = sites + [s for s in pool if s.rstrip("/").lower() != key]
    else:  # pair
        if not sites:
            raise ApiException(
                "NO_VALID_SITES",
                "No valid store URLs supplied.",
                422,
                details={"rejected": rejected[:20]},
            )

    if random_target or mode == "card":
        # Card jobs carry a pool of fallback stores, so the number of *tasks* is
        # what has to stay bounded — and that is the card count.
        if len(payload.cards) > settings.max_batch_tasks:
            raise ApiException(
                "TOO_MANY_CARDS",
                f"Maximum {settings.max_batch_tasks} cards per job.",
                422,
            )
    else:
        if len(sites) > settings.max_batch_tasks:
            raise ApiException(
                "TOO_MANY_SITES",
                f"Maximum {settings.max_batch_tasks} sites per job.",
                422,
            )
        if mode == "card" and len(payload.cards) > settings.max_batch_tasks:
            raise ApiException(
                "TOO_MANY_CARDS",
                f"Maximum {settings.max_batch_tasks} cards per job.",
                422,
            )

    bad_cards = [c for c in payload.cards if parse_card_or_none(c) is None]
    if bad_cards:
        raise ApiException(
            "INVALID_CARD",
            "One or more cards are malformed (expected cc|mm|yy|cvv).",
            422,
            details={"invalid": bad_cards[:20]},
        )

    try:
        proxy = validate_proxy(payload.proxy)
    except ValueError as ex:
        raise ApiException("INVALID_PROXY", str(ex), 422)

    current = runtime.get()
    # Site jobs can fall back to cards.txt; card jobs always supply their own.
    if mode != "card" and not payload.cards and not jobs.cards.get():
        raise ApiException(
            "NO_CARDS",
            f"No cards supplied and {jobs.cards.path} is empty.",
            400,
        )

    concurrency = payload.concurrency or current.default_concurrency
    concurrency = max(1, min(concurrency, settings.max_concurrency, len(sites) or 1))

    job = await jobs.start_batch(
        sites=sites,
        cards=payload.cards,
        proxy=proxy,
        concurrency=concurrency,
        retries=payload.retries or current.default_retries,
        max_price=payload.max_price,
        variant_id=payload.variant_id,
        endpoint=payload.endpoint,
        mode=mode,
        random_target=random_target,
        pool_source=pool_source,
    )
    label = {"site": "site", "card": "card", "pair": "paired"}[mode]
    if random_target:
        pool_label = "custom site(s)" if pool_source == "custom" else "live site(s)"
        await job.push_log(
            f"{label} job · {len(payload.cards)} card(s) · {len(sites)} {pool_label}, "
            f"one random target per card"
        )
    else:
        await job.push_log(f"{label} job · {len(payload.cards)} card(s) · {len(sites)} store(s)")
    await job.push_log(
        f"{len(rejected)} input line(s) rejected" if rejected else "All inputs validated",
        level="warning" if rejected else "info",
    )
    return job.to_dict()


@router.get("", response_model=JobListResponse, summary="List jobs (newest first)")
async def list_jobs(limit: int = Query(50, ge=1, le=200)) -> dict[str, Any]:
    return {"items": jobs.list(limit=limit), "counts": jobs.counts()}


@router.get("/{job_id}", response_model=JobDetail, summary="Job status, results and logs")
async def get_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    return job.to_dict()


@router.get("/{job_id}/events", summary="Server-Sent Events stream for a job")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    """
    Live stream. Event types: ``snapshot``, ``status``, ``log``, ``task_start``,
    ``task_done``, ``progress``, ``ping``.
    """
    job = jobs.get(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)

    queue = job.subscribe()

    async def event_stream():
        try:
            yield sse_format({"type": "snapshot", "job": job.to_dict(include_logs=True)})
            if job.status in TERMINAL:
                return
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield sse_format({"type": "ping", "status": job.status})
                    if job.status in TERMINAL:
                        break
                    continue
                yield sse_format(event)
                if event.get("type") == "status" and event.get("status") in TERMINAL:
                    break
        finally:
            job.unsubscribe(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{job_id}/cancel", summary="Cancel a running job")
async def cancel_job(job_id: str) -> dict[str, Any]:
    job = await jobs.cancel(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    return job.to_dict(include_results=False, include_logs=False)


@router.post("/{job_id}/pause", summary="Pause a running job")
async def pause_job(job_id: str) -> dict[str, Any]:
    job = await jobs.pause(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    if job.status in TERMINAL:
        raise ApiException("JOB_FINISHED", "Job already finished.", 409)
    return job.to_dict(include_results=False, include_logs=False)


@router.post("/{job_id}/resume", summary="Resume a paused job")
async def resume_job(job_id: str) -> dict[str, Any]:
    job = await jobs.resume(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    return job.to_dict(include_results=False, include_logs=False)


@router.delete("/{job_id}", summary="Cancel and forget a job")
async def delete_job(job_id: str) -> dict[str, Any]:
    job = await jobs.cancel(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    return {"cancelled": True, "id": job_id, "status": job.status}


@router.get("/{job_id}/results", summary="Job results as JSON or CSV")
async def job_results(
    job_id: str,
    fmt: str = Query("json", pattern="^(json|csv|txt)$"),
    bucket: str | None = Query(None, pattern="^(live|die|error)$"),
) -> Any:
    job = jobs.get(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)

    rows = job.results if not bucket else [r for r in job.results if r["bucket"] == bucket]

    if fmt == "csv":
        buf = io.StringIO()
        cols = ["index", "site", "response", "bucket", "gate", "price", "product", "card", "card_full",
                "time", "elapsed_ms", "attempts", "targets_tried", "approved", "charged", "detail"]
        writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
        return PlainTextResponse(
            buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="job-{job_id}.csv"'},
        )

    if fmt == "txt":
        cols = ["index", "site", "response", "bucket", "gate", "price", "product", "card", "card_full",
                "time", "attempts", "targets_tried", "approved", "charged", "detail"]
        lines = ["\t".join(cols)]
        for row in rows:
            lines.append("\t".join(str(row.get(c, "")).replace("\t", " ").replace("\n", " ") for c in cols))
        return PlainTextResponse(
            "\n".join(lines),
            media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="job-{job_id}.txt"'},
        )

    body = json.dumps(
        {"job": job.to_dict(include_results=False, include_logs=False), "results": rows},
        indent=2,
    )
    return PlainTextResponse(
        body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="job-{job_id}.json"'},
    )


@router.get("/{job_id}/live-sites", response_class=PlainTextResponse, summary="Unique live sites")
async def job_live_sites(job_id: str) -> str:
    """Equivalent of the original UI's "copy live sites" button."""
    job = jobs.get(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    seen: list[str] = []
    for row in job.results:
        if row.get("bucket") == "live":
            site = row.get("site") or row.get("requested_site")
            if site and site not in seen:
                seen.append(site)
    return "\n".join(seen)


@router.get("/{job_id}/logs", response_class=PlainTextResponse, summary="Job log as plain text")
async def job_logs_plain(job_id: str) -> str:
    job = jobs.get(job_id)
    if not job:
        raise ApiException("JOB_NOT_FOUND", f"No job with id {job_id}", 404)
    return "\n".join(entry["message"] for entry in job.logs)
