"""Vercel serverless entrypoint for the FastAPI backend.

Vercel's Python runtime exposes any ASGI app found at api/index.py as a
serverless function. vercel.json rewrites every request to this handler.
"""

import sys
from pathlib import Path

# Make the backend/ folder importable regardless of the runtime's cwd.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
