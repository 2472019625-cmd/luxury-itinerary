from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT.parent / "行程单满意版本.png"
PROOF = ROOT / "output/style-proof-a-2000.png"
OUTPUT = ROOT / "output/style-proof-a-comparison.png"


def contain(image, width, height):
    result = image.copy()
    result.thumbnail((width, height), Image.Resampling.LANCZOS)
    return result


def paste_center(canvas, image, box):
    x, y, width, height = box
    item = contain(image, width, height)
    canvas.paste(item, (x + (width - item.width) // 2, y + (height - item.height) // 2))


def build():
    master = Image.open(MASTER).convert("RGB")
    proof = Image.open(PROOF).convert("RGB")
    rows = [
        (master.crop((0, 0, 2000, 1500)), proof.crop((0, 0, 2000, 1500)), 720),
        (master.crop((0, 3000, 2000, 7500)), proof.crop((0, 3000, 2000, 7440)), 1200),
        (master.crop((0, 7750, 2000, 8400)), proof.crop((0, 7440, 2000, 7899)), 430),
    ]
    canvas = Image.new("RGB", (2600, 2650), "#EEE9E0")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((40, 30, 1240, 84), fill="#8F5F26")
    draw.rectangle((1360, 30, 2560, 84), fill="#B28B33")
    draw.text((62, 47), "MASTER", fill="white")
    draw.text((1382, 47), "IMPLEMENTATION", fill="white")
    y = 110
    for source, implementation, height in rows:
        paste_center(canvas, source, (40, y, 1200, height))
        paste_center(canvas, implementation, (1360, y, 1200, height))
        y += height + 70
    canvas.save(OUTPUT, optimize=True)
    print(OUTPUT)


if __name__ == "__main__":
    build()
