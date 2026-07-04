#!/usr/bin/env python3
"""Build a palette config from a master atlas PNG.

Samples the atlas on a grid, drops near-duplicate colors, and records each
kept swatch's color and its UV location on the atlas. The palette-snap step
later maps any face color to the nearest swatch's UV, so every processed
asset ends up texturing from this one atlas.

UV convention: Blender-style, (0,0) = bottom-left. The glTF exporter handles
the flip to glTF's top-left convention on export.

Usage:
    python3 build_palette.py <atlas.png> -o palette.json [--stride 16] [--threshold 350]
"""

from __future__ import annotations

import argparse
import json

from pnglite import read_png
from quantize import dist2_redmean


def build_palette(
    atlas_path: str, stride: int = 16, threshold: float = 350.0
) -> dict:
    width, height, rows = read_png(atlas_path)
    entries: list[dict] = []
    for y in range(stride // 2, height, stride):
        row = rows[y]
        for x in range(stride // 2, width, stride):
            r, g, b, a = row[x * 4 : x * 4 + 4]
            if a < 128:
                continue
            rgb = (r, g, b)
            if any(dist2_redmean(rgb, tuple(e["rgb"])) < threshold for e in entries):
                continue
            entries.append(
                {
                    "rgb": [r, g, b],
                    "uv": [(x + 0.5) / width, 1.0 - (y + 0.5) / height],
                }
            )
    return {
        "source": atlas_path,
        "width": width,
        "height": height,
        "stride": stride,
        "threshold": threshold,
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("atlas", help="master atlas PNG")
    parser.add_argument("-o", "--output", default="palette.json")
    parser.add_argument("--stride", type=int, default=16, help="sample grid step in pixels")
    parser.add_argument(
        "--threshold",
        type=float,
        default=350.0,
        help="squared redmean distance below which two samples count as duplicates",
    )
    args = parser.parse_args()
    palette = build_palette(args.atlas, args.stride, args.threshold)
    with open(args.output, "w") as f:
        json.dump(palette, f, indent=2)
    print(f"{args.output}: {len(palette['entries'])} swatches from {args.atlas}")


if __name__ == "__main__":
    main()
