from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output/spacing-footer-comparison-v7.png"


def fit(image, width, height):
    item = image.copy()
    item.thumbnail((width, height), Image.Resampling.LANCZOS)
    return item


def place(canvas, image, x, y, width, height):
    item = fit(image, width, height)
    canvas.paste(item, (x + (width - item.width) // 2, y + (height - item.height) // 2))


reference_gap = Image.open(
    r"C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-740e8124-457c-4c2c-b14b-422afab67cdb.png"
).convert("RGB")
footer_source = Image.open(ROOT / "public/assets/brand/fixed-footer-template-v1.jpg").convert("RGB")
footer_result = Image.open(ROOT / "output/proof-footer-seam-v7.png").convert("RGB")

title_paths = [
    ROOT / "output/proof-expense-section-spacing-v7.png",
    ROOT / "output/proof-booking-section-spacing-v7.png",
    ROOT / "output/proof-security-section-spacing-v7.png",
    ROOT / "output/proof-notes-section-spacing-v7.png",
]
titles = [Image.open(path).convert("RGB") for path in title_paths]
title_board = Image.new("RGB", (1200, 1380), "#FCF8F1")
for index, item in enumerate(titles):
    x = (index % 2) * 600
    y = (index // 2) * 690
    place(title_board, item, x, y, 600, 690)

canvas = Image.new("RGB", (2600, 3250), "#EEE9E0")
draw = ImageDraw.Draw(canvas)
draw.rectangle((40, 30, 1240, 88), fill="#8F5F26")
draw.rectangle((1360, 30, 2560, 88), fill="#B28B33")
draw.text((62, 49), "USER REFERENCE", fill="white")
draw.text((1382, 49), "IMPLEMENTATION V7", fill="white")

place(canvas, reference_gap, 40, 120, 1200, 1380)
place(canvas, title_board, 1360, 120, 1200, 1380)
place(canvas, footer_source, 40, 1580, 1200, 1550)
place(canvas, footer_result, 1360, 1580, 1200, 1550)

canvas.save(OUTPUT, optimize=True)
print(OUTPUT)
