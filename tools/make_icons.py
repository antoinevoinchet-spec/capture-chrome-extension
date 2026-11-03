"""Dessine les icônes de l'extension (appareil photo blanc sur tapis vert, objectif jaune)."""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

MAT = (35, 69, 59, 255)
PAPER = (255, 255, 255, 255)
CUT = (244, 197, 66, 255)
BIG = 1024


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, BIG - 1, BIG - 1), radius=230, fill=MAT)
    # Boîtier et viseur
    d.rounded_rectangle((150, 330, 874, 810), radius=80, fill=PAPER)
    d.polygon([(372, 240), (652, 240), (712, 340), (312, 340)], fill=PAPER)
    # Objectif : bague verte, lentille jaune
    cx, cy = 512, 572
    d.ellipse((cx - 170, cy - 170, cx + 170, cy + 170), fill=MAT)
    d.ellipse((cx - 112, cy - 112, cx + 112, cy + 112), fill=CUT)
    # Flash
    d.ellipse((740, 392, 800, 452), fill=MAT)
    return img


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    master = draw_master()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(out / f"icon{size}.png")


if __name__ == "__main__":
    main(sys.argv[1])
