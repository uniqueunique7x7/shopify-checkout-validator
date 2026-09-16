"""JSON-file execution history (no external database, per project scope)."""

from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from ..core.logging import log


class HistoryStore:
    """Append-only history persisted as a single JSON file."""

    def __init__(self, path: str, limit: int = 5000, store_full_cards: bool = False):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._limit = limit
        self._store_full_cards = store_full_cards
        self._items: list[dict] = []
        self._load()

    # -- persistence -------------------------------------------------------
    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                self._items = raw
        except Exception as ex:
            log.warning("History file unreadable (%s), starting empty", ex)
            self._items = []

    def _flush(self) -> None:
        payload = json.dumps(self._items)
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
            # Last resort: write in place so history still survives a restart.
            try:
                self._path.write_text(payload, encoding="utf-8")
                log.warning("History written in place (atomic rename unavailable: %s)", ex)
            except OSError as fallback_ex:
                log.warning("Could not persist history: %s", fallback_ex)

    # -- api ---------------------------------------------------------------
    def configure(self, limit: int, store_full_cards: bool) -> None:
        self._limit = limit
        self._store_full_cards = store_full_cards

    def add(self, record: dict, origin: str = "single") -> dict:
        entry = {
            "id": uuid.uuid4().hex[:12],
            "ts": time.time(),
            "origin": origin,
            **record,
        }
        if not self._store_full_cards:
            entry.pop("card", None)
        entry.setdefault("card_masked", record.get("card_masked", ""))
        with self._lock:
            self._items.append(entry)
            if len(self._items) > self._limit:
                self._items = self._items[-self._limit:]
            self._flush()
        return entry

    def iter_live(self):
        """
        Yield only the live entries, without materialising a filtered copy of the
        whole history. Used by the live-site pool, which may scan many records.
        """
        for item in self._items:
            if item.get("bucket") == "live":
                yield item

    def iter_items(self):
        """
        Yield every entry in insertion order. The live-site pool walks this to see
        whether a store recovered after a run of card errors.
        """
        for item in self._items:
            yield item

    def list(
        self,
        limit: int = 200,
        offset: int = 0,
        site: Optional[str] = None,
        bucket: Optional[str] = None,
        response: Optional[str] = None,
        search: Optional[str] = None,
    ) -> dict:
        items = list(reversed(self._items))
        if site:
            s = site.lower()
            items = [i for i in items if s in str(i.get("site", "")).lower()]
        if bucket:
            items = [i for i in items if i.get("bucket") == bucket]
        if response:
            items = [i for i in items if i.get("response") == response]
        if search:
            q = search.lower()
            items = [
                i for i in items
                if q in str(i.get("site", "")).lower()
                or q in str(i.get("response", "")).lower()
                or q in str(i.get("gate", "")).lower()
                or q in str(i.get("card_masked", "")).lower()
                or q in str(i.get("product", "")).lower()
            ]
        total = len(items)
        page = items[offset: offset + limit]
        return {"total": total, "offset": offset, "limit": limit, "items": page}

    def summary(self) -> dict[str, Any]:
        buckets = {"live": 0, "die": 0, "error": 0}
        responses: dict[str, int] = {}
        gates: dict[str, int] = {}
        for item in self._items:
            b = item.get("bucket")
            if b in buckets:
                buckets[b] += 1
            r = item.get("response") or "UNKNOWN"
            responses[r] = responses.get(r, 0) + 1
            g = item.get("gate") or "UNKNOWN"
            gates[g] = gates.get(g, 0) + 1
        return {
            "count": len(self._items),
            "buckets": buckets,
            "responses": dict(sorted(responses.items(), key=lambda kv: -kv[1])),
            "gates": dict(sorted(gates.items(), key=lambda kv: -kv[1])[:15]),
        }

    def clear(self) -> int:
        with self._lock:
            count = len(self._items)
            self._items = []
            self._flush()
        return count

    def export(self, fmt: str = "json") -> str:
        items = list(self._items)
        if fmt == "csv":
            cols = ["ts", "site", "response", "bucket", "gate", "price", "product", "card_masked", "time", "origin"]
            lines = [",".join(cols)]
            for it in items:
                lines.append(",".join(f'"{str(it.get(c, ""))}"' for c in cols))
            return "\n".join(lines)
        if fmt == "txt":
            cols = ["ts", "site", "response", "bucket", "gate", "price", "product", "card", "card_masked", "time", "origin"]
            lines = ["\t".join(cols)]
            for it in items:
                lines.append("\t".join(str(it.get(c, "")).replace("\t", " ").replace("\n", " ") for c in cols))
            return "\n".join(lines)
        return json.dumps(items, indent=2)
