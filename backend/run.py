"""Cross-platform launcher: python run.py  (from the backend/ folder)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from app.main import app  # noqa: E402


def main() -> None:
    settings_mod = __import__("app.core.config", fromlist=["settings"]).settings
    port = int(os.environ.get("PORT", settings_mod.port))
    host = os.environ.get("HOST", settings_mod.host)
    reload_enabled = os.environ.get("RELOAD", "1").lower() not in ("0", "false", "no")

    print("=" * 64)
    print("  Shopify Checkout Validator API  v4.0.0")
    print(f"  URL:    http://{host}:{port}")
    print(f"  Docs:   http://{host}:{port}/docs")
    print(f"  Cards:  {settings_mod.cards_file}")
    print("=" * 64)

    if reload_enabled:
        uvicorn.run("app.main:app", host=host, port=port, reload=True, reload_dirs=[str(BACKEND_DIR)])
    else:
        uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
