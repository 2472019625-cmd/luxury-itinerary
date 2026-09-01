from pathlib import Path
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "output" / "africa-itinerary-2000.png"
OUT = ROOT / "output" / "africa-qa"
OUT.mkdir(parents=True, exist_ok=True)

image = Image.open(SOURCE).convert("RGB")
segments = {
    "01-cover-intro": (0, 0, 2000, 7200),
    "02-days-1-4": (0, 7000, 2000, 18500),
    "03-days-5-10": (0, 18000, 2000, 33200),
    "04-closing": (0, 32500, 2000, image.height),
}

thumbs = []
for name, box in segments.items():
    crop = image.crop(box)
    crop.save(OUT / f"{name}.png")
    thumb = crop.copy()
    thumb.thumbnail((475, 2600), Image.Resampling.LANCZOS)
    thumbs.append((name, thumb))

canvas_height = max(thumb.height for _, thumb in thumbs) + 90
canvas = Image.new("RGB", (2000, canvas_height), "#f7f1e7")
draw = ImageDraw.Draw(canvas)
for index, (name, thumb) in enumerate(thumbs):
    x = index * 500 + 12
    canvas.paste(thumb, (x, 70))
    draw.text((x, 24), name, fill="#7a5524")
canvas.save(OUT / "africa-full-qa-board.png")

print(OUT)
