from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
PROOF = Image.open(ROOT / "output/style-proof-a-2000.png").convert("RGB")
FULL = Image.open(ROOT / "output/sample-itinerary-2000.png").convert("RGB")
OUTPUT = ROOT / "output/closing-components-comparison-v6.png"

SOURCES = [
    Image.open(r"C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-1ef314ad-7726-4f86-856c-ddaa3448d792.png").convert("RGB"),
    Image.open(r"C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-6113189e-d6fc-4184-ba0b-e87ad909cf24.png").convert("RGB"),
    Image.open(r"C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-381ecc67-1200-424e-843e-9c2b057ff2fc.png").convert("RGB"),
    Image.open(r"C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-2ee55716-41e1-4c67-96b2-8ad3328ab934.png").convert("RGB"),
    Image.open(r"C:\Users\Administrator\Documents\xwechat_files\wxid_sh6qd36fkerf22_7a26\temp\RWTemp\2026-08\9e20f478899dc29eb19741386f9343c8\407431f57b194314d35fb67727df9468.jpg").convert("RGB"),
]

IMPLEMENTATIONS = [
    PROOF.crop((0, 2750, 2000, 4650)),
    PROOF.crop((0, 6550, 2000, 8264)),
    FULL.crop((0, 28200, 2000, 30200)),
    FULL.crop((0, 30200, 2000, 33800)),
    FULL.crop((0, 37920, 2000, 40668)),
]


def fit(image, width, height):
    item = image.copy()
    item.thumbnail((width, height), Image.Resampling.LANCZOS)
    return item


def place(canvas, image, x, y, width, height):
    item = fit(image, width, height)
    canvas.paste(item, (x + (width - item.width) // 2, y + (height - item.height) // 2))


heights = [610, 470, 560, 820, 760]
canvas = Image.new("RGB", (2600, 3540), "#EEE9E0")
draw = ImageDraw.Draw(canvas)
draw.rectangle((40, 30, 1240, 88), fill="#8F5F26")
draw.rectangle((1360, 30, 2560, 88), fill="#B28B33")
draw.text((62, 49), "REFERENCE", fill="white")
draw.text((1382, 49), "IMPLEMENTATION", fill="white")
y = 120
for source, implementation, height in zip(SOURCES, IMPLEMENTATIONS, heights):
    place(canvas, source, 40, y, 1200, height)
    place(canvas, implementation, 1360, y, 1200, height)
    y += height + 60
canvas.save(OUTPUT, optimize=True)
print(OUTPUT)
