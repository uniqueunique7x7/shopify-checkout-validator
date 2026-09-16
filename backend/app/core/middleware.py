"""Request timing + structured access logging middleware."""

from __future__ import annotations

import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from ..core.config import settings
from ..core.logging import add_entry, log

SKIP_PATHS = {"/api/health", "/favicon.ico"}


class TimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        started = time.time()
        try:
            response = await call_next(request)
        except Exception:
            elapsed = (time.time() - started) * 1000
            add_entry("ERROR", "shopify.access", f"{request.method} {request.url.path} failed in {elapsed:.0f}ms")
            raise

        elapsed_ms = (time.time() - started) * 1000
        response.headers["X-Response-Time"] = f"{elapsed_ms:.1f}ms"
        response.headers["X-API-Version"] = "4.0.0"

        path = request.url.path
        if path not in SKIP_PATHS and path.startswith("/api"):
            add_entry(
                "INFO" if response.status_code < 400 else "WARNING",
                "shopify.access",
                f"{request.method} {path} -> {response.status_code} ({elapsed_ms:.0f}ms)",
            )
        if settings.log_level == "debug":
            log.debug("%s %s -> %s in %.1fms", request.method, path, response.status_code, elapsed_ms)
        return response
