from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT.parent / "行程单满意版本.png"
PROOF = ROOT / "output/style-proof-a-2000.png"
OUTPUT = ROOT / "output/profile-meta-title-comparison.png"


def fit(image, width, height):
    item = image.copy()
    item.thumbnail((width, height), Image.Resampling.LANCZOS)
    return item


def place(canvas, image, x, y, width, height):
    item = fit(image, width, height)
    canvas.paste(item, (x + (width - item.width) // 2, y + (height - item.height) // 2))


master = Image.open(MASTER).convert("RGB")
proof = Image.open(PROOF).convert("RGB")
canvas = Image.new("RGB", (2600, 2300), "#EEE9E0")
draw = ImageDraw.Draw(canvas)
draw.rectangle((40, 30, 1240, 88), fill="#8F5F26")
draw.rectangle((1360, 30, 2560, 88), fill="#B28B33")
draw.text((62, 49), "MASTER", fill="white")
draw.text((1382, 49), "IMPLEMENTATION", fill="white")
place(canvas, master.crop((0, 3000, 2000, 4700)), 40, 120, 1200, 1180)
place(canvas, proof.crop((0, 2750, 2000, 4650)), 1360, 120, 1200, 1180)
place(canvas, master.crop((0, 7000, 2000, 7950)), 40, 1380, 1200, 760)
place(canvas, proof.crop((0, 6900, 2000, 8250)), 1360, 1380, 1200, 760)
canvas.save(OUTPUT, optimize=True)
print(OUTPUT)
