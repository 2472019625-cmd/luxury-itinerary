from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output"
reference = Image.open(OUT / "master-security-focused-v9.png").convert("RGB")
implementation = Image.open(OUT / "proof-security-payment-v9-2000.png").convert("RGB")

reference = reference.crop((0, 240, reference.width, min(reference.height, 3540)))
target_height = max(reference.height, implementation.height)
canvas = Image.new("RGB", (4080, target_height + 150), "#efe8dc")

def paste_centered(image, left):
    top = 150 + (target_height - image.height) // 2
    canvas.paste(image, (left, top))

paste_centered(reference, 0)
paste_centered(implementation, 2080)
draw = ImageDraw.Draw(canvas)
font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 52)
draw.text((60, 42), "高清母版", fill="#6e4b28", font=font)
draw.text((2140, 42), "专项重做 V9", fill="#6e4b28", font=font)
result = OUT / "comparison-security-payment-v9.png"
canvas.save(result, quality=95)
print(result)
