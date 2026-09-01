from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = Image.open(
    r"C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-fdf304f8-8345-4574-88dc-c92d82a71bb0.png"
).convert("RGB")
IMPLEMENTATION = Image.open(ROOT / "output/proof-booking-component-v8-2000.png").convert("RGB")
OUTPUT = ROOT / "output/booking-comparison-v8-2000-each.png"


def resize_to_width(image, width):
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.Resampling.LANCZOS)


reference = resize_to_width(REFERENCE, 2000)
implementation = resize_to_width(IMPLEMENTATION, 2000)
header = 100
gutter = 80
height = max(reference.height, implementation.height)
canvas = Image.new("RGB", (4080, height + header), "#EEE9E0")
draw = ImageDraw.Draw(canvas)
draw.rectangle((0, 0, 2000, header), fill="#8F5F26")
draw.rectangle((2080, 0, 4080, header), fill="#B28B33")
draw.text((42, 38), "REFERENCE — 2000 PX WIDE", fill="white")
draw.text((2122, 38), "IMPLEMENTATION V8 — 2000 PX WIDE", fill="white")
canvas.paste(reference, (0, header + (height - reference.height) // 2))
canvas.paste(implementation, (2000 + gutter, header + (height - implementation.height) // 2))
canvas.save(OUTPUT, optimize=True)
print(OUTPUT)
