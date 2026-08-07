#!/usr/bin/env python3
"""Regenerate public/fonts/*.woff2 from the committed TTF masters.

The TTFs stay in the repo: they are the masters, they are the license-bearing
originals recorded in ASSETS.md, and iso.html keeps them as the second `src:`
so a pre-woff2 WebKit still gets real type. Only the woff2 is on the boot wire
for anything shipped this decade.

Two things here are load-bearing and easy to get wrong:

  * `--layout-features='*'`. The UI leans on `font-variant: small-caps`
    (every Cinzel/Alegreya title, label and plaque) and
    `font-variant-numeric: tabular-nums` (every HUD number). Those resolve
    through the OpenType `smcp`/`c2sc`/`tnum` features, which pyftsubset's
    DEFAULT feature list drops. Subsetting with defaults renders the same
    text in synthesized small-caps and proportional figures — a visible
    regression that no byte count would catch.

  * Cinzel is a VARIABLE font (wght 400..900, declared `font-weight: 400 900`).
    Do not instance it; the subsetter keeps fvar/gvar/HVAR/avar/STAT as long
    as no axis is pinned.

Usage:  python tools/fonts/subset.py        (from the repo root)
Deps:   pip install fonttools brotli
"""

import os
import subprocess
import sys

# Generous by design. The cut we want is the ~1000 codepoints of Cyrillic,
# Greek-extended and Vietnamese these Google fonts carry that this game will
# never type; the cut we must NOT make is a punctuation or symbol range the UI
# quietly relies on. Every non-ASCII codepoint that appears anywhere in
# iso.html or src/ falls inside these ranges.
UNICODES = ",".join([
    "U+0000-00FF",   # Basic Latin + Latin-1 Supplement (§ · ° ± × ÷ ² ¢ ¦ ™-adjacent)
    "U+0100-024F",   # Latin Extended-A/B — accented names
    "U+0259",        # schwa (Google latin subset convention)
    "U+02B0-02FF",   # spacing modifier letters — ˆ ˚ ˜ ʻ ʼ
    "U+0300-036F",   # combining diacriticals
    "U+0370-03FF",   # Greek (π)
    "U+1E00-1EFF",   # Latin Extended Additional
    "U+2000-206F",   # General Punctuation — — – … ‚ „ ' ' " " ‹ › •
    "U+2070-209F",   # super/subscripts
    "U+20A0-20BF",   # currency
    "U+2100-214F",   # letterlike — ™ №
    "U+2150-218F",   # number forms
    "U+2190-21FF",   # arrows — → ← ↑ ↓
    "U+2200-22FF",   # math operators — − ≈ ≤ ≥ √
    "U+2300-23FF",   # misc technical
    "U+25A0-25FF",   # geometric shapes — ◆ ◇ ▶ ▸ ▼ ▾ ▲ ● ▌
    "U+2600-26FF",   # misc symbols — ⚙ ⚠ ☰ ☠ ⛨
    "U+2700-27BF",   # dingbats — ✓ ✕
    "U+2B00-2BFF",   # misc symbols and arrows — ⭑
    "U+FB00-FB4F",   # alphabetic presentation forms (fi/fl ligatures)
    "U+FEFF",        # BOM
])

FONTS = [
    "Cinzel.ttf",
    "AlegreyaSans-Regular.ttf",
    "AlegreyaSans-Bold.ttf",
    "AlegreyaSans-Italic.ttf",
]

FONT_DIR = os.path.join("public", "fonts")


def main() -> int:
    if not os.path.isdir(FONT_DIR):
        print(f"run me from the repo root (no {FONT_DIR})", file=sys.stderr)
        return 1
    total_in = total_out = 0
    for name in FONTS:
        src = os.path.join(FONT_DIR, name)
        dst = os.path.join(FONT_DIR, name[:-4] + ".woff2")
        subprocess.run([
            sys.executable, "-m", "fontTools.subset", src,
            f"--unicodes={UNICODES}",
            "--layout-features=*",
            "--flavor=woff2",
            "--with-zopfli",
            f"--output-file={dst}",
        ], check=True)
        a, b = os.path.getsize(src), os.path.getsize(dst)
        total_in += a
        total_out += b
        print(f"{name:28s} {a:>8,} -> {b:>8,}  ({100 * b / a:.0f}%)")
    print(f"{'TOTAL':28s} {total_in:>8,} -> {total_out:>8,}  "
          f"({100 * total_out / total_in:.0f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
