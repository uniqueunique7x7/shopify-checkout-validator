"""Shopify Validator — FastAPI application factory.

Run with:
    uvicorn app.main:app --reload --port 8080      (from the backend/ folder)
or:
    python run.py
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api.routes import cards, history, jobs, settings as settings_route, system, validate
from .core.config import settings
from .core.errors import (
    ApiException,
    api_exception_handler,
    http_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from .core.logging import log, setup_logging
from .core.middleware import TimingMiddleware
from .api import deps

setup_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    deps.cards_store.reload()
    log.info(
        "Shopify Validator API ready — cards=%d max_price=%.2f concurrency=%d/site timeout=%.0fs",
        len(deps.cards_store.get()),
        deps.runtime.max_price,
        deps.runtime.site_concurrency,
        deps.runtime.request_timeout,
    )
    try:
        yield
    finally:
        await deps.jobs.shutdown()
        log.info("Shutting down")


app = FastAPI(
    title="Shopify Checkout Validator API",
    version="4.0.0",
    description=(
        "Web API around the original `main.py` engine: multi-store batch validation, "
        "product discovery, gateway probes, cards management and history."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Response-Time"],
)

app.add_exception_handler(ApiException, api_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)

app.add_middleware(TimingMiddleware)

for module in (system, validate, jobs, cards, history, settings_route):
    app.include_router(module.router)


@app.get("/", include_in_schema=False)
async def root() -> JSONResponse:
    return JSONResponse(
        {
            "name": "Shopify Checkout Validator API",
            "version": "4.0.0",
            "docs": "/docs",
            "frontend": "http://localhost:3000",
            "endpoints": [
                "GET  /api/health",
                "POST /api/validate",
                "POST /api/check",
                "GET  /api/products",
                "POST /api/jobs",
                "GET  /api/jobs/{id}",
                "GET  /api/jobs/{id}/events  (SSE)",
                "GET  /api/cards",
                "GET  /api/history",
                "GET  /api/settings",
            ],
        }
    )
