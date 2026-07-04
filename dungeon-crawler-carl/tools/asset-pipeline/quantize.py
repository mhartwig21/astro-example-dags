"""Nearest-swatch color quantization against the master atlas palette.

The palette is a set of (rgb, uv) samples taken from the real KayKit gradient
atlas (see build_palette.py). Snapping a face means: find the palette entry
whose color is perceptually closest, then move the face's UVs to that entry's
spot on the atlas. Distance uses the "redmean" approximation — a cheap,
colorspace-conversion-free stand-in for perceptual distance.
"""

from __future__ import annotations

import json


def dist2_redmean(c1: tuple[int, int, int], c2: tuple[int, int, int]) -> float:
    rmean = (c1[0] + c2[0]) / 2.0
    dr, dg, db = c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]
    return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db


class Palette:
    """Palette entries plus a memoized nearest-color lookup."""

    def __init__(self, entries: list[dict]):
        if not entries:
            raise ValueError("palette has no entries")
        self.entries = entries
        self._cache: dict[tuple[int, int, int], dict] = {}

    @classmethod
    def load(cls, path: str) -> "Palette":
        with open(path) as f:
            data = json.load(f)
        return cls(data["entries"])

    def nearest(self, rgb: tuple[int, int, int]) -> dict:
        # Quantize the cache key to 4-bit per channel: colors that close snap
        # to the same entry anyway, and it keeps the memo table small.
        key = (rgb[0] >> 4, rgb[1] >> 4, rgb[2] >> 4)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        best = min(self.entries, key=lambda e: dist2_redmean(rgb, tuple(e["rgb"])))
        self._cache[key] = best
        return best
