"""Cards file handling — mirrors the original cards.txt workflow."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Iterable, Optional

from ..core.logging import log
from .engine import parse_card

_lock = asyncio.Lock()


class CardsStore:
    """
    Loads cards from ``CARDS_FILE`` (cc|mm|yy|cvv or cc|mm|yyyy|cvv, one per
    line, ``#`` comments allowed) with the same 120s refresh window as the
    original implementation.
    """

    def __init__(self, cards_file: str):
        self._path = Path(cards_file)
        self._cache: list[dict] = []
        self._loaded_at: float = 0.0
        self._last_invalid: list[str] = []

    # -- paths -------------------------------------------------------------
    @property
    def path(self) -> Path:
        return self._path

    def set_path(self, path: str | Path) -> None:
        self._path = Path(path)
        self.reload()

    # -- loading -----------------------------------------------------------
    def _load_from_file(self) -> list[dict]:
        cards: list[dict] = []
        invalid: list[str] = []
        if not self._path.exists():
            self._last_invalid = []
            return cards
        try:
            with open(self._path, "r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    raw = line.strip()
                    if not raw or raw.startswith("#"):
                        continue
                    card = parse_card(raw)
                    if card:
                        cards.append(card)
                    else:
                        invalid.append(raw)
        except OSError as ex:
            log.warning("Could not read cards file %s: %s", self._path, ex)
            return []
        self._last_invalid = invalid
        return cards

    def reload(self) -> int:
        self._cache = self._load_from_file()
        self._loaded_at = time.time()
        return len(self._cache)

    def get(self, force: bool = False) -> list[dict]:
        if force or not self._cache or (time.time() - self._loaded_at) > 120:
            self.reload()
        return self._cache

    def random_card(self, cards: Optional[list[dict]] = None) -> Optional[dict]:
        pool = cards if cards is not None else self.get()
        if not pool:
            return None
        import random

        return random.choice(pool)

    # -- writing -----------------------------------------------------------
    def write_lines(self, lines: Iterable[str]) -> dict:
        """Replace the cards file with the provided lines. Returns a summary."""
        kept: list[str] = []
        invalid: list[str] = []
        for raw in lines:
            text = (raw or "").strip()
            if not text or text.startswith("#"):
                continue
            if parse_card(text):
                kept.append(text)
            else:
                invalid.append(text)

        self._path.parent.mkdir(parents=True, exist_ok=True)
        header = "# cards.txt - one card per line: cc|mm|yy|cvv or cc|mm|yyyy|cvv\n"
        self._path.write_text(header + "\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        count = self.reload()
        return {"saved": count, "invalid": invalid[:50], "invalid_count": len(invalid)}

    def append_lines(self, lines: Iterable[str]) -> dict:
        kept: list[str] = []
        invalid: list[str] = []
        for raw in lines:
            text = (raw or "").strip()
            if not text or text.startswith("#"):
                continue
            if parse_card(text):
                kept.append(text)
            else:
                invalid.append(text)

        existing = self.get(force=True)
        existing_keys = {c["cc"] + c["month"] + c["year"] + c["cvv"] for c in existing}
        fresh = [k for k in kept if (c := parse_card(k)) and (c["cc"] + c["month"] + c["year"] + c["cvv"]) not in existing_keys]

        if fresh:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._path, "a", encoding="utf-8") as fh:
                fh.write("\n".join(fresh) + "\n")
        count = self.reload()
        return {"saved": count, "added": len(fresh), "invalid": invalid[:50], "invalid_count": len(invalid)}

    def clear(self) -> int:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            "# cards.txt - one card per line: cc|mm|yy|cvv or cc|mm|yyyy|cvv\n", encoding="utf-8"
        )
        self.reload()
        return len(self._cache)

    # -- introspection -----------------------------------------------------
    def snapshot(self, masked: bool = True) -> dict:
        cards = self.get(force=True)
        items = []
        for card in cards:
            cc = card["cc"]
            shown = f"{cc[:6]}{'*' * max(0, len(cc) - 10)}{cc[-4:]}" if masked and len(cc) > 10 else cc
            items.append({"number": shown, "month": card["month"], "year": card["year"], "cvv": "***" if masked else card["cvv"],
                          "bin": cc[:6], "last4": cc[-4:]})
        return {
            "path": str(self._path),
            "exists": self._path.exists(),
            "count": len(cards),
            "invalid_count": len(self._last_invalid),
            "invalid_sample": self._last_invalid[:20],
            "loaded_at": self._loaded_at,
            "cards": items,
        }

    def bins(self) -> list[dict]:
        counts: dict[str, int] = {}
        for card in self.get():
            counts[card["cc"][:6]] = counts.get(card["cc"][:6], 0) + 1
        return [
            {"bin": bin_, "count": count}
            for bin_, count in sorted(counts.items(), key=lambda kv: -kv[1])
        ]
