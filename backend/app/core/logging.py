"""Structured logging + in-memory ring buffer feeding the live log viewer."""

from __future__ import annotations

import logging
import sys
import time
from collections import deque
from typing import Any, Deque

from .config import settings

_RING: Deque[dict[str, Any]] = deque(maxlen=settings.log_ring_size)
_SUBSCRIBERS: list[Any] = []


def ring_entries(limit: int = 200, level: str | None = None) -> list[dict[str, Any]]:
    items = list(_RING)
    if level:
        lvl = level.upper()
        items = [i for i in items if i["level"] == lvl]
    return items[-limit:]


def add_entry(level: str, logger: str, message: str, **extra: Any) -> dict[str, Any]:
    entry = {
        "ts": time.time(),
        "level": level,
        "logger": logger,
        "message": message,
        **extra,
    }
    _RING.append(entry)
    return entry


class RingBufferHandler(logging.Handler):
    """Keeps the last N log records in memory for `GET /api/logs`."""

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - logging glue
        try:
            add_entry(record.levelname, record.name, record.getMessage())
        except Exception:
            pass


def setup_logging(level: str | None = None) -> None:
    lvl = (level or settings.log_level).upper()
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_shopify_ring", False) or getattr(h, "_shopify_stream", False):
            root.removeHandler(h)

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    stream._shopify_stream = True  # type: ignore[attr-defined]

    ring = RingBufferHandler()
    ring.setLevel(logging.DEBUG)
    ring._shopify_ring = True  # type: ignore[attr-defined]

    root.addHandler(stream)
    root.addHandler(ring)
    root.setLevel(getattr(logging, lvl, logging.INFO))

    # keep noisy libraries quiet
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def set_level(level: str) -> None:
    lvl = (level or "info").upper()
    logging.getLogger().setLevel(getattr(logging, lvl, logging.INFO))


log = logging.getLogger("shopify")
