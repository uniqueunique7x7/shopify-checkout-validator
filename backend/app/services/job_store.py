"""Job snapshots persisted to a JSON file.

Jobs live in memory while they run, so a backend restart — a `--reload` code
change, a reboot, a crash — used to erase every job and leave the dashboard
showing *"this job no longer exists on the server"*.

Snapshots are written throttled while a job runs and immediately once it
finishes, then loaded back on startup. A job that was still running when the
process died cannot be resumed, so it is restored with its results and logs
intact and an explicit *"server restarted"* error instead of silently vanishing.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from ..core.logging import log


class JobStore:
    """Bounded set of job snapshots in one JSON file (newest kept)."""

    def __init__(
        self,
        path: str,
        keep: int = 50,
        max_results: int = 1000,
        max_logs: int = 400,
    ):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._keep = max(1, keep)
        self._max_results = max(1, max_results)
        self._max_logs = max(1, max_logs)
        self._items: dict[str, dict] = {}
        self._order: list[str] = []

    @property
    def path(self) -> Path:
        return self._path

    # -- persistence -------------------------------------------------------
    def load(self) -> list[dict]:
        """Read the file into memory and return the snapshots, oldest first."""
        if not self._path.exists():
            return []
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception as ex:
            log.warning("Job file unreadable (%s), starting empty", ex)
            return []
        items = raw.get("jobs") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            return []
        with self._lock:
            for item in items:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                job_id = str(item["id"])
                if job_id not in self._items:
                    self._order.append(job_id)
                self._items[job_id] = item
        return [self._items[i] for i in self._order]

    def _write(self, payload: str) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(payload, encoding="utf-8")
            # Windows can transiently refuse the rename (indexer or antivirus
            # holding the file), so retry briefly before falling back.
            for attempt in range(4):
                try:
                    tmp.replace(self._path)
                    return
                except OSError:
                    if attempt == 3:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        except OSError as ex:
            try:
                self._path.write_text(payload, encoding="utf-8")
            except OSError as fallback_ex:
                log.warning("Could not persist jobs: %s", fallback_ex)
            else:
                log.warning("Jobs written in place (atomic rename unavailable: %s)", ex)

    def upsert(self, snapshot: dict[str, Any]) -> None:
        job_id = str(snapshot.get("id") or "")
        if not job_id:
            return
        entry = {
            **snapshot,
            "results": list(snapshot.get("results") or [])[-self._max_results:],
            "logs": list(snapshot.get("logs") or [])[-self._max_logs:],
        }
        with self._lock:
            if job_id not in self._items:
                self._order.append(job_id)
            self._items[job_id] = entry
            while len(self._order) > self._keep:
                self._items.pop(self._order.pop(0), None)
            self._write(self._payload())

    def remove(self, job_id: str) -> None:
        with self._lock:
            if job_id not in self._items:
                return
            self._items.pop(job_id, None)
            self._order = [i for i in self._order if i != job_id]
            self._write(self._payload())

    def _payload(self) -> str:
        return json.dumps({"jobs": [self._items[i] for i in self._order]}, default=str)
