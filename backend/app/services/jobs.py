"""
Job runner.

Batch validation runs as a background asyncio task: the HTTP request returns a
job id immediately, the browser follows progress over Server-Sent Events
(``GET /api/jobs/{id}/events``) or by polling ``GET /api/jobs/{id}``.

Task pairing replicates the original UI exactly:
    tasks[i] = (sites[i % len(sites)], cards[i % len(cards)])
with one task per site when no cards are supplied (the engine then falls back
to the cards file).
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from typing import Any, Optional, TYPE_CHECKING

from ..core.config import RuntimeSettingsStore, settings as app_settings
from ..core.logging import add_entry, log
from .cards import CardsStore
from .engine import JobCancelled, ShopifyEngine, classify, mask_card, parse_card

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from .job_store import JobStore


def _host_key(site: str) -> str:
    """Normalise a store URL to a bare host, for per-domain bookkeeping."""
    return site.strip().rstrip("/").lower().removeprefix("https://").removeprefix("http://")


# Store-level failures ban a host for the rest of a card job: more cards at a
# captcha-walled or throttled store just burn time. Card-level failures
# (tokenization, submit) say nothing about the store — banning on them used to
# take the whole target out of a run after a single rate-limited card.
STORE_ERRORS = {
    "CAPTCHA_REQUIRED", "THROTTLED", "TIMEOUT", "NO_PRODUCT",
    "NO_SHOPIFY_PAYMENTS_GATEWAY", "SESSION_EXPIRED", "CHECKPOINTDENIED",
    "GRAPHQL_ERROR", "SITE_REQUIRES_LOGIN", "NO_SELLER_PROPOSAL",
    "NEGOTIATE_FAILED",
}


def _bans_site(response: str) -> bool:
    return (response or "").split(":", 1)[0].strip().upper() in STORE_ERRORS

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_PAUSED = "paused"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

TERMINAL = {STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED}

# Results kept in the periodic snapshot of a job that is still running. The
# final snapshot always carries the full set.
INFLIGHT_RESULTS = 300


class Job:
    def __init__(self, job_id: str, kind: str, params: dict[str, Any]):
        self.id = job_id
        self.kind = kind
        self.params = params
        self.status = STATUS_QUEUED
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.total = 0
        self.completed = 0
        self.counters = {"live": 0, "die": 0, "error": 0, "retried": 0}
        self.results: list[dict] = []
        self.logs: list[dict] = []
        self.error: Optional[str] = None
        self.current: list[str] = []
        self.cancel_requested = False
        self.pause_requested = False
        # Sites that errored on a card check in this job. One error marks a
        # site as bad and no other card is ever sent to it again.
        self.bad_sites: set[str] = set()
        self.pause_gate = asyncio.Event()
        self.pause_gate.set()
        self._subscribers: set[asyncio.Queue] = set()
        self.task: Optional[asyncio.Task] = None

    # -- events ------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def emit(self, event: dict[str, Any]) -> None:
        event = {"ts": time.time(), **event}
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass

    async def push_log(self, message: str, level: str = "info", **extra: Any) -> None:
        entry = {"ts": time.time(), "level": level, "message": message, **extra}
        self.logs.append(entry)
        if len(self.logs) > 2000:
            del self.logs[: len(self.logs) - 2000]
        await self.emit({"type": "log", **entry})

    # -- snapshot ----------------------------------------------------------
    @property
    def elapsed(self) -> float:
        if self.started_at is None:
            return 0.0
        end = self.finished_at or time.time()
        return round(end - self.started_at, 2)

    @property
    def eta(self) -> Optional[float]:
        if self.completed <= 0 or self.completed >= self.total or self.started_at is None:
            return None
        per_item = self.elapsed / self.completed
        return round(per_item * (self.total - self.completed), 1)

    def to_dict(self, include_results: bool = True, include_logs: bool = True) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "params": self.params,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "total": self.total,
            "completed": self.completed,
            "pending": max(0, self.total - self.completed),
            "counters": self.counters,
            "elapsed": self.elapsed,
            "eta": self.eta,
            "current": self.current,
            "error": self.error,
            "cancel_requested": self.cancel_requested,
            "pause_requested": self.pause_requested,
            "progress": round((self.completed / self.total) * 100, 1) if self.total else 0.0,
        }
        if include_results:
            data["results"] = self.results
        if include_logs:
            data["logs"] = self.logs[-400:]
        return data

    # -- restore -----------------------------------------------------------
    @classmethod
    def restore(cls, payload: dict[str, Any]) -> "Job":
        """Rebuild a job from a persisted snapshot (server restart recovery)."""
        job = cls(
            str(payload.get("id") or uuid.uuid4().hex[:12]),
            payload.get("kind") or "pair",
            payload.get("params") or {},
        )
        job.status = payload.get("status") or STATUS_FAILED
        job.created_at = float(payload.get("created_at") or time.time())
        job.started_at = payload.get("started_at")
        job.finished_at = payload.get("finished_at")
        job.total = int(payload.get("total") or 0)
        job.completed = int(payload.get("completed") or 0)
        job.counters = {"live": 0, "die": 0, "error": 0, "retried": 0, **(payload.get("counters") or {})}
        job.results = list(payload.get("results") or [])
        job.logs = list(payload.get("logs") or [])
        job.error = payload.get("error")
        job.current = []
        if job.status not in TERMINAL:
            # The process that was running it is gone, so it can never finish.
            # Keep whatever it produced and say plainly why it stopped.
            job.status = STATUS_FAILED
            job.error = "Server restarted while this job was still running"
            job.finished_at = job.finished_at or time.time()
            job.logs.append({"ts": time.time(), "level": "error", "message": job.error})
        return job


class JobManager:
    def __init__(self, engine: ShopifyEngine, cards: CardsStore, runtime: RuntimeSettingsStore, history,
                 store: Optional["JobStore"] = None):
        self.engine = engine
        self.cards = cards
        self.runtime = runtime
        self.history = history
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = asyncio.Lock()
        # Snapshots on disk so a restart does not erase finished work.
        self._store = store
        self._persisted_at: dict[str, float] = {}
        if store is not None:
            self._restore()

    # -- persistence -------------------------------------------------------
    def _restore(self) -> None:
        assert self._store is not None
        try:
            snapshots = self._store.load()
        except Exception as ex:
            log.warning("Could not load persisted jobs: %s", ex)
            return
        restored = 0
        for payload in snapshots:
            try:
                job = Job.restore(payload)
            except Exception as ex:
                log.warning("Skipping unreadable job snapshot: %s", ex)
                continue
            if job.id in self._jobs:
                continue
            self._jobs[job.id] = job
            self._order.append(job.id)
            restored += 1
        if restored:
            log.info("Restored %d job(s) from %s", restored, self._store.path)

    def _persist(self, job: Job, force: bool = False) -> None:
        """Snapshot a job to disk, throttled unless ``force`` is set."""
        store = self._store
        if store is None:
            return
        now = time.time()
        if not force and now - self._persisted_at.get(job.id, 0.0) < app_settings.job_persist_interval:
            return
        self._persisted_at[job.id] = now
        try:
            snapshot = job.to_dict()
            if job.status not in TERMINAL:
                # A long run would otherwise rewrite every result every few
                # seconds; the final write carries the whole set.
                snapshot["results"] = snapshot.get("results", [])[-INFLIGHT_RESULTS:]
            store.upsert(snapshot)
        except Exception as ex:
            log.warning("Could not persist job %s: %s", job.id, ex)

    # -- lifecycle ---------------------------------------------------------
    async def shutdown(self) -> None:
        for job in list(self._jobs.values()):
            if job.status in (STATUS_RUNNING, STATUS_PAUSED, STATUS_QUEUED):
                job.cancel_requested = True
                job.pause_gate.set()
                # keep whatever the run gathered before the process exits
                self._persist(job, force=True)
            if job.task and not job.task.done():
                job.task.cancel()

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self, limit: int = 50) -> list[dict]:
        ids = self._order[-limit:][::-1]
        return [self._jobs[i].to_dict(include_results=False, include_logs=False) for i in ids if i in self._jobs]

    def active(self) -> list[Job]:
        return [j for j in self._jobs.values() if j.status not in TERMINAL]

    def counts(self) -> dict[str, int]:
        out = {"queued": 0, "running": 0, "paused": 0, "completed": 0, "failed": 0, "cancelled": 0}
        for j in self._jobs.values():
            out[j.status] = out.get(j.status, 0) + 1
        out["total"] = len(self._jobs)
        return out

    async def cancel(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job.cancel_requested = True
        job.pause_requested = False
        job.pause_gate.set()
        if job.status == STATUS_QUEUED:
            job.status = STATUS_CANCELLED
            job.finished_at = time.time()
        await job.push_log("Cancellation requested", level="warning")
        await job.emit({"type": "status", "status": job.status, "cancel_requested": True})
        self._persist(job, force=True)
        return job

    async def forget(self, job_id: str) -> Optional[Job]:
        """Cancel a job and drop it entirely — memory, snapshots and all."""
        job = await self.cancel(job_id)
        if not job:
            return None
        self._jobs.pop(job_id, None)
        self._persisted_at.pop(job_id, None)
        self._order = [i for i in self._order if i != job_id]
        if self._store is not None:
            self._store.remove(job_id)
        return job

    async def pause(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job.pause_requested = True
        job.pause_gate.clear()
        if job.status == STATUS_RUNNING:
            job.status = STATUS_PAUSED
        await job.push_log("Job paused by operator", level="warning")
        await job.emit({"type": "status", "status": job.status})
        self._persist(job, force=True)
        return job

    async def resume(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job.pause_requested = False
        job.pause_gate.set()
        if job.status == STATUS_PAUSED:
            job.status = STATUS_RUNNING
        await job.push_log("Job resumed")
        await job.emit({"type": "status", "status": job.status})
        self._persist(job, force=True)
        return job

    def prune(self, keep: int = 60) -> None:
        while len(self._order) > keep:
            old = self._order[0]
            job = self._jobs.get(old)
            if job is None or (job.status in TERMINAL and not job._subscribers):
                self._order.pop(0)
                self._jobs.pop(old, None)
                self._persisted_at.pop(old, None)
                if self._store is not None:
                    self._store.remove(old)
            else:
                break

    # -- task building -----------------------------------------------------
    @staticmethod
    def build_tasks(
        sites: list[str],
        cards: list[str],
        mode: str = "pair",
        random_target: bool = False,
        max_targets: int = 1,
    ) -> list[dict[str, Any]]:
        """
        Build the task list for a job.

        mode="site"  -> one task per store; the engine picks a card
                        (the supplied card, or a random one from cards.txt).
        mode="card"  -> one task per card. The first entry of ``sites`` is the
                        primary target (the whole pool when ``random_target``);
                        the rest form a fallback chain so a card that errors on
                        one store is rechecked on the next, until it earns a real
                        verdict (success or decline). ``max_targets`` caps the
                        chain length.
        mode="pair"  -> the original behaviour: index-paired lists.
        """
        tasks: list[dict[str, Any]] = []
        chain_size = max(1, int(max_targets or 1))

        if mode == "site":
            fallback = cards[0] if cards else ""
            for site in sites:
                tasks.append({"site": site, "card": fallback})
            return tasks

        if mode == "card":
            if random_target and sites:
                # Shuffle once, then deal the sites out in order. Every card still
                # gets a random store, but consecutive cards never land on the same
                # one until the pool has been used up — even coverage without
                # clustering the whole run onto two or three hosts. Each card also
                # takes the following stores as its fallback chain.
                shuffled = list(sites)
                random.shuffle(shuffled)
                span = min(chain_size, len(shuffled))
                for i, card in enumerate(cards):
                    start = i % len(shuffled)
                    chain = [shuffled[(start + j) % len(shuffled)] for j in range(span)]
                    tasks.append({"site": chain[0], "card": card, "fallbacks": chain[1:]})
                return tasks

            store = sites[0] if sites else ""
            # A failed primary is retried on other stores from the pool, so a
            # captcha-walled target never leaves the card unjudged. Every card
            # gets a different rotating window of the pool so errors spread
            # instead of every card hammering the same few stores.
            extras = [s for s in sites[1:] if s and s != store]
            random.shuffle(extras)
            for i, card in enumerate(cards):
                if extras:
                    step = max(1, chain_size - 1)
                    start = (i * step) % len(extras)
                    span = min(chain_size - 1, len(extras))
                    chain = [extras[(start + j) % len(extras)] for j in range(span)]
                else:
                    chain = []
                tasks.append({"site": store, "card": card, "fallbacks": chain})
            return tasks

        if cards:
            for i in range(max(len(sites), len(cards))):
                tasks.append({"site": sites[i % len(sites)], "card": cards[i % len(cards)]})
        else:
            for site in sites:
                tasks.append({"site": site, "card": ""})
        return tasks

    # -- start -------------------------------------------------------------
    async def start_batch(
        self,
        sites: list[str],
        cards: Optional[list[str]] = None,
        proxy: Optional[str] = None,
        concurrency: Optional[int] = None,
        retries: Optional[int] = None,
        max_price: Optional[float] = None,
        variant_id: Optional[str] = None,
        endpoint: str = "check",
        mode: str = "pair",
        random_target: bool = False,
        pool_source: str = "live",
    ) -> Job:
        cards = cards or []
        max_targets = app_settings.card_max_targets if mode == "card" else 1
        tasks = self.build_tasks(
            sites, cards, mode, random_target=random_target, max_targets=max_targets
        )
        job_id = uuid.uuid4().hex[:12]
        # In random-target mode `sites` is the whole live pool and in card mode it
        # carries the fallback chain: keep the job snapshot small either way so
        # polling and SSE never ship thousands of URLs.
        pool_size = len(sites) if random_target else 0
        params = {
            "mode": mode,
            "sites": [] if random_target else (sites[:1] if mode == "card" else sites),
            "sites_count": len(sites),
            "random_target": bool(random_target),
            "pool_source": pool_source if random_target else "",
            "pool_size": pool_size,
            "card_max_targets": max_targets if mode == "card" else 0,
            "cards_count": len(cards),
            "cards_preview": cards[:3],
            "proxy": bool(proxy),
            "proxy_raw": proxy or "",
            "concurrency": concurrency or self.runtime.get().default_concurrency,
            "retries": retries or self.runtime.get().default_retries,
            "max_price": max_price if max_price is not None else self.runtime.max_price,
            "variant_id": variant_id,
            "endpoint": endpoint,
            "tasks": len(tasks),
        }
        job = Job(job_id, mode, params)
        job.total = len(tasks)
        self._jobs[job_id] = job
        self._order.append(job_id)
        self.prune()
        self._persist(job, force=True)
        job.task = asyncio.create_task(self._run_batch(job, tasks, proxy, variant_id))
        return job

    async def run_single(
        self,
        site: str,
        card: Optional[dict],
        proxy: Optional[str] = None,
        max_price: Optional[float] = None,
        variant_id: Optional[str] = None,
    ) -> dict:
        """Direct (blocking) single validation used by POST /api/validate."""
        if card is None:
            card = self.cards.random_card()
        if card is None:
            raise ValueError("No card supplied and no cards.txt entries available")
        result = await self.engine.validate_card(
            card["cc"], card["month"], card["year"], card["cvv"],
            site, variant_id=variant_id, proxy_str=proxy, max_price=max_price,
        )
        self._record(result, origin="single", proxy=bool(proxy))
        return result

    # -- internals ---------------------------------------------------------
    def _record(self, result: dict, origin: str, proxy: bool = False, mode: str = "site") -> None:
        code = result.get("Response", "UNKNOWN")
        self.engine.stats[f"response_{code}"] += 1
        self.engine.stats[f"bucket_{result.get('bucket', 'unknown')}"] += 1
        self.engine.stats["total_checks"] += 1
        self.engine.stats["with_proxy"] += 1 if proxy else 0
        self.history.configure(
            limit=self.runtime.get().history_limit,
            store_full_cards=self.runtime.get().history_store_full_cards,
        )
        self.history.add(
            {
                "site": result.get("Site", ""),
                "product": result.get("Product", ""),
                "price": result.get("Price", "0.00"),
                "gate": result.get("Gate", ""),
                "response": code,
                "bucket": result.get("bucket"),
                "approved": result.get("approved"),
                "charged": result.get("charged"),
                "card_masked": result.get("CCMasked", mask_card(result.get("CC", ""))),
                "card": result.get("CC", ""),
                "mode": mode,
                "time": result.get("Time", ""),
                "detail": result.get("Detail"),
            },
            origin=origin,
        )

    async def _run_batch(
        self,
        job: Job,
        tasks: list[dict[str, str]],
        proxy: Optional[str],
        variant_id: Optional[str],
    ) -> None:
        job.status = STATUS_RUNNING
        job.started_at = time.time()
        params = job.params
        mode = params.get("mode", "pair")
        await job.push_log(
            f"Job {job.id} started [{mode}] — {job.total} task(s), {params['concurrency']} worker(s), "
            f"max price ${params['max_price']:.2f}, retries {params['retries']}"
        )
        await job.emit({"type": "status", "status": job.status})
        self.engine.stats["jobs_started"] += 1

        try:
            supplied = [t["card"] for t in tasks if t["card"]]
            card_pool: list[dict] = [c for c in (parse_card(raw) for raw in supplied) if c]
            if not card_pool:
                card_pool = self.cards.get()

            needs_card_pool = any(not t["card"] for t in tasks)
            if needs_card_pool and not card_pool:
                job.status = STATUS_FAILED
                job.error = (
                    "No cards supplied and cards.txt is empty"
                    if mode != "card"
                    else "Card job tasks all carry their own card"
                )
                job.finished_at = time.time()
                await job.push_log(job.error, level="error")
                await job.emit({"type": "status", "status": job.status, "error": job.error})
                self._persist(job, force=True)
                return

            cursor = 0
            card_cursor = 0
            index_lock = asyncio.Lock()

            async def step_callback(name: str) -> None:
                if job.cancel_requested:
                    raise JobCancelled()
                while job.pause_requested:
                    await job.pause_gate.wait()
                if job.cancel_requested:
                    raise JobCancelled()

            async def worker(worker_id: int) -> None:
                nonlocal cursor, card_cursor
                while True:
                    if job.cancel_requested:
                        return
                    await job.pause_gate.wait()
                    if job.cancel_requested:
                        return
                    async with index_lock:
                        if cursor >= len(tasks):
                            return
                        idx = cursor
                        cursor += 1

                    task = tasks[idx]
                    raw_card = task["card"]

                    if raw_card:
                        card = parse_card(raw_card)
                        if card is None:
                            job.completed += 1
                            job.counters["error"] += 1
                            bad = {
                                "Response": "INVALID_CARD_FORMAT",
                                "Site": task["site"], "Product": "", "Price": "0.00",
                                "Gate": "N/A", "Charged": "False", "Approved": "False",
                                "Time": "0s", "CCMasked": mask_card(raw_card),
                                "bucket": "error", "approved": False, "charged": False,
                                "gateway_live": False,
                            }
                            record = self._task_record(idx, task, bad, worker_id, 1)
                            job.results.append(record)
                            await job.push_log(
                                f"[w{worker_id}] #{idx + 1} invalid card format, skipped: {raw_card[:8]}…",
                                level="warning", index=idx,
                            )
                            await job.emit({"type": "task_done", "index": idx, "result": record})
                            await self._emit_progress(job)
                            continue
                    else:
                        # Site / pair modes may leave the card blank: fall back to a
                        # card from cards.txt. It is pinned per task so retries keep
                        # the same card. `card_cursor` keeps concurrent workers from
                        # all picking the identical entry.
                        async with index_lock:
                            card = card_pool[card_cursor % len(card_pool)]
                            card_cursor += 1

                    attempts = max(1, int(params.get("retries") or 1))
                    task_start = time.time()
                    result: dict[str, Any] = {}
                    attempt_used = 0
                    # Card scans walk a chain of stores: when a card errors out
                    # (captcha, throttle, no product) the same card is rechecked on
                    # the next store until it earns a real verdict. Store scans keep
                    # the single target they were built with.
                    targets = [task["site"], *task.get("fallbacks", [])]
                    remaining = list(targets)
                    targets_tried = 0
                    last_attempted: Optional[str] = None

                    while remaining and not job.cancel_requested:
                        target = remaining.pop(0)
                        # A site that errored on any earlier card is banned for
                        # the rest of the job — sending more cards at it just
                        # burns time.
                        if mode == "card" and _host_key(target) in job.bad_sites:
                            await job.push_log(
                                f"[w{worker_id}] #{idx + 1} skipping {target} — "
                                f"banned after an earlier card error",
                                level="warning", index=idx,
                            )
                            continue
                        targets_tried += 1
                        if last_attempted is not None:
                            # Only report a hop when a store was actually tried.
                            await job.push_log(
                                f"[w{worker_id}] #{idx + 1} — {result.get('Response', 'error')} on "
                                f"{last_attempted}, rechecking on {target} "
                                f"({targets_tried}/{len(targets)})",
                                level="warning", index=idx,
                            )
                        for attempt in range(1, attempts + 1):
                            attempt_used = attempt
                            if job.cancel_requested:
                                break
                            label = f"[w{worker_id}] #{idx + 1}/{len(tasks)} {target}"
                            job.current = [f"w{worker_id} → {target}"]
                            await job.push_log(f"{label} — attempt {attempt}/{attempts}", index=idx)
                            await job.emit({
                                "type": "task_start",
                                "index": idx,
                                "worker": worker_id,
                                "site": target,
                                "card": mask_card(f"{card['cc']}|{card['month']}|{card['year']}|{card['cvv']}"),
                                "card_full": f"{card['cc']}|{card['month']}|{card['year']}|{card['cvv']}",
                                "attempt": attempt,
                                "attempts": attempts,
                            })
                            try:
                                result = await self.engine.validate_card(
                                    card["cc"], card["month"], card["year"], card["cvv"],
                                    target,
                                    variant_id=variant_id,
                                    proxy_str=proxy,
                                    max_price=params["max_price"],
                                    on_step=step_callback,
                                )
                            except JobCancelled:
                                result = {
                                    "Response": "CANCELLED", "Site": target, "Product": "",
                                    "Price": "0.00", "Gate": "N/A", "Charged": "False",
                                    "Approved": "False", "Time": "0s",
                                    "CCMasked": mask_card(
                                        f"{card['cc']}|{card['month']}|{card['year']}|{card['cvv']}"
                                    ),
                                    "bucket": "error", "approved": False, "charged": False,
                                    "gateway_live": False,
                                }
                            except Exception as ex:  # a failed task must never kill the worker
                                log.exception("task failed for %s", target)
                                result = {
                                    "Response": "ERROR", "Site": target, "Product": "",
                                    "Price": "0.00", "Gate": "UNKNOWN", "Charged": "False",
                                    "Approved": "False", "Time": "0s",
                                    "Detail": f"{type(ex).__name__}: {ex}",
                                    "bucket": "error", "approved": False, "charged": False,
                                    "gateway_live": False,
                                }

                            # Judge the outcome from the job's point of view: a site
                            # scan asks whether the store is live, a card scan asks
                            # whether the card is good. `mode` comes from the job.
                            if mode == "card" and result:
                                result.update(
                                    classify(
                                        result.get("Response", ""),
                                        result.get("Approved", "False"),
                                        mode="card",
                                    )
                                )

                            bucket = result.get("bucket") or classify(result.get("Response", ""))["bucket"]
                            if bucket != "error":
                                break
                            if attempt < attempts and not job.cancel_requested:
                                job.counters["retried"] += 1
                                await job.push_log(
                                    f"{label} — retrying after {result.get('Response')}",
                                    level="warning", index=idx,
                                )
                                await asyncio.sleep(min(0.6 * attempt, 2.5))

                        # A real verdict settles the card; only an error keeps
                        # walking the chain.
                        last_attempted = target
                        if job.cancel_requested:
                            # A cancel is the user's call, not the store's fault:
                            # never ban a site for it, and stop walking.
                            break
                        if (result.get("bucket") or "error") != "error":
                            break
                        if mode == "card" and _bans_site(result.get("Response", "")):
                            key = _host_key(target)
                            job.bad_sites.add(key)
                            await job.push_log(
                                f"[w{worker_id}] #{idx + 1} {target} errored "
                                f"({result.get('Response')}) — banned for this job",
                                level="warning", index=idx,
                            )
                        if job.cancel_requested:
                            break

                    if mode == "card" and targets_tried == 0:
                        # Every candidate store was already banned in this job.
                        result = {
                            "Response": "NO_TARGET_AVAILABLE", "Site": task["site"],
                            "Product": "", "Price": "0.00", "Gate": "N/A",
                            "Charged": "False", "Approved": "False", "Time": "0s",
                            "Detail": (
                                f"all {len(targets)} candidate store(s) already errored "
                                f"earlier in this job"
                            ),
                            "bucket": "error", "approved": False, "charged": False,
                            "gateway_live": False,
                        }

                    if job.cancel_requested and result.get("Response") != "CANCELLED":
                        result["Response"] = "CANCELLED"
                        result["bucket"] = "error"

                    elapsed = round(time.time() - task_start, 2)
                    job.completed += 1
                    bucket = result.get("bucket", "error")
                    if bucket in job.counters:
                        job.counters[bucket] += 1
                    record = self._task_record(
                        idx, task, result, worker_id, attempt_used, elapsed,
                        targets_tried=targets_tried,
                    )
                    job.results.append(record)
                    self._record(result, origin=f"job:{job.id}", proxy=bool(proxy), mode=mode)
                    await job.push_log(
                        f"[w{worker_id}] #{idx + 1} {result.get('Site') or task['site']} → "
                        f"{result.get('Response')} ({bucket}) {result.get('Time', '')}"
                        + (f" after {targets_tried} store(s)" if targets_tried > 1 else ""),
                        level="info" if bucket != "error" else "warning",
                        index=idx,
                    )
                    await job.emit({"type": "task_done", "index": idx, "result": record})
                    await self._emit_progress(job)

            workers = [
                asyncio.create_task(worker(i + 1))
                for i in range(max(1, min(int(params["concurrency"]), len(tasks))))
            ]
            try:
                await asyncio.gather(*workers)
            except asyncio.CancelledError:
                for w in workers:
                    w.cancel()
                raise

        except asyncio.CancelledError:
            job.status = STATUS_CANCELLED
            job.finished_at = time.time()
            await job.push_log("Job cancelled (server shutdown)", level="warning")
            await job.emit({"type": "status", "status": job.status})
            self._persist(job, force=True)
            raise
        except Exception as ex:
            log.exception("job %s failed", job.id)
            job.status = STATUS_FAILED
            job.error = f"{type(ex).__name__}: {ex}"
            job.finished_at = time.time()
            await job.push_log(job.error, level="error")
            await job.emit({"type": "status", "status": job.status, "error": job.error})
            self._persist(job, force=True)
            return

        job.finished_at = time.time()
        if job.cancel_requested:
            job.status = STATUS_CANCELLED
            await job.push_log(
                f"Job cancelled — {job.completed}/{job.total} processed in {job.elapsed:.1f}s",
                level="warning",
            )
        else:
            job.status = STATUS_COMPLETED
            await job.push_log(
                f"Job completed — {job.completed}/{job.total} processed in {job.elapsed:.1f}s "
                f"(live {job.counters['live']}, die {job.counters['die']}, errors {job.counters['error']})"
            )
        job.current = []
        self.engine.stats["jobs_finished"] += 1
        await job.emit({"type": "status", "status": job.status})
        self._persist(job, force=True)
        add_entry("INFO", "shopify.jobs", f"job {job.id} {job.status}")

    @staticmethod
    def _task_record(
        idx: int, task: dict, result: dict, worker: int, attempts: int, elapsed: float = 0.0,
        targets_tried: int = 1,
    ) -> dict:
        return {
            "index": idx,
            "worker": worker,
            "site": result.get("Site") or task["site"],
            "requested_site": task["site"],
            "targets_tried": targets_tried,
            "card": result.get("CCMasked") or mask_card(task.get("card", "")),
            "card_full": result.get("CC") or task.get("card", ""),
            "response": result.get("Response", "UNKNOWN"),
            "bucket": result.get("bucket", "error"),
            "gate": result.get("Gate", ""),
            "product": result.get("Product", ""),
            "price": result.get("Price", "0.00"),
            "time": result.get("Time", ""),
            "elapsed_ms": result.get("ElapsedMs", round(elapsed * 1000)),
            "approved": result.get("approved", False),
            "charged": result.get("charged", False),
            "gateway_live": result.get("gateway_live", False),
            "detail": result.get("Detail") or result.get("detail"),
            "attempts": attempts,
        }

    async def _emit_progress(self, job: Job) -> None:
        # throttled on-disk snapshot, so a restart keeps the run so far
        self._persist(job)
        await job.emit({
            "type": "progress",
            "completed": job.completed,
            "total": job.total,
            "counters": job.counters,
            "elapsed": job.elapsed,
            "eta": job.eta,
            "progress": round((job.completed / job.total) * 100, 1) if job.total else 0.0,
        })


# ---------------------------------------------------------------------------
# SSE formatting helper
# ---------------------------------------------------------------------------
def sse_format(event: dict[str, Any]) -> str:
    import json

    name = event.get("type", "message")
    return f"event: {name}\ndata: {json.dumps(event, default=str)}\n\n"
