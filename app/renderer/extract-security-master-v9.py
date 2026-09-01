from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT.parent / "行程单满意版本.png"
OUTPUT = ROOT / "output/master-security-broad-v9.png"
FOCUSED = ROOT / "output/master-security-focused-v9.png"
QR_CANDIDATE = ROOT / "output/alipay-qr-candidate-v9.png"

image = Image.open(MASTER).convert("RGB")
crop = image.crop((0, 33000, 2000, 39500))
crop.save(OUTPUT, optimize=True)
image.crop((0, 35000, 2000, 38800)).save(FOCUSED, optimize=True)
image.crop((550, 36375, 1430, 37425)).save(QR_CANDIDATE, optimize=True)
print(OUTPUT)
print(FOCUSED)
print(QR_CANDIDATE)
