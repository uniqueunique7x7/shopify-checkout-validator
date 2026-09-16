"""Vercel serverless entrypoint — runs the FastAPI backend as a Python function
inside the Next.js project, so backend + frontend share one deployment.
"""

import os
import sys

# The full repo is checked out; make the backend package importable.
sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"),
)

from app.main import app  # noqa: E402
