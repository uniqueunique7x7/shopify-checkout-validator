"""Structured API errors — no Python tracebacks reach the browser."""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logging import log


class ApiException(Exception):
    """Raised by routes/services; serialised as a structured error payload."""

    def __init__(self, code: str, message: str, status_code: int = 400, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


def error_payload(code: str, message: str, details: Any = None) -> dict:
    return {"success": False, "error": {"code": code, "message": message, "details": details}}


async def api_exception_handler(_: Request, exc: ApiException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=jsonable_encoder(error_payload(exc.code, exc.message, exc.details)),
    )


async def validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    details = [
        {"loc": list(err.get("loc", [])), "msg": err.get("msg"), "type": err.get("type")}
        for err in exc.errors()
    ]
    first = details[0]["msg"] if details else "Invalid request"
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder(error_payload("VALIDATION_ERROR", str(first), details)),
    )


async def http_exception_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "PAYLOAD_TOO_LARGE"}
    return JSONResponse(
        status_code=exc.status_code,
        content=error_payload(codes.get(exc.status_code, "HTTP_ERROR"), str(exc.detail)),
    )


async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content=error_payload("INTERNAL_ERROR", "Unexpected server error. Check the server logs."),
    )
