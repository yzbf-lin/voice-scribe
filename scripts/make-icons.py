#!/usr/bin/env python3
"""Generate the app icons (macOS .icns + Windows .ico) from code.

Keeping the icon in a script instead of a binary blob means the brand colour and
the bar heights stay reviewable in the repo, and regenerating after a palette
change is one command:

    python3 scripts/make-icons.py

Requires Pillow (only needed when regenerating, not to build the app).
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

# Matches --primary in src/index.css: oklch(0.24 0.004 90) ≈ #2c2c29, and the
# AudioLines mark that the top bar shows next to the wordmark.
BG = (44, 44, 41, 255)
FG = (255, 255, 255, 255)

SIZE = 1024
# Apple's macOS icon grid: the artwork occupies the middle 824px of a 1024 canvas
# so the rounded square sits optically the same size as system icons.
INSET = 100
CORNER = 185


def draw_icon(size: int = SIZE) -> Image.Image:
    scale = 4  # supersample, then downscale for clean edges
    w = size * scale
    # Everything below is expressed in the 1024px design grid.
    u = w / SIZE
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    inset = INSET * u
    radius = CORNER * u
    d.rounded_rectangle(
        [inset, inset, w - inset, w - inset], radius=radius, fill=BG
    )

    # Five audio bars, mirroring the lucide AudioLines glyph (tallest in middle).
    bar_w = 46 * u
    gap = 74 * u
    heights = [0.30, 0.46, 0.60, 0.44, 0.34]
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x = (w - total) / 2
    cy = w / 2
    for h in heights:
        bar_h = w * h
        # radius cannot exceed half the shorter side
        d.rounded_rectangle(
            [x, cy - bar_h / 2, x + bar_w, cy + bar_h / 2],
            radius=min(bar_w, bar_h) / 2,
            fill=FG,
        )
        x += bar_w + gap

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    BUILD.mkdir(exist_ok=True)
    icon = draw_icon()
    png = BUILD / "icon.png"
    icon.save(png)

    # Windows: a single .ico carrying every size Explorer asks for.
    ico = BUILD / "icon.ico"
    icon.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # macOS: iconutil wants an .iconset directory with exact pixel sizes.
    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        for stale in iconset.iterdir():
            stale.unlink()
    iconset.mkdir(exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        draw_icon(base).save(iconset / f"icon_{base}x{base}.png")
        draw_icon(base * 2).save(iconset / f"icon_{base}x{base}@2x.png")
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")],
        check=True,
    )

    for name in ("icon.png", "icon.ico", "icon.icns"):
        path = BUILD / name
        print(f"{name}: {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
