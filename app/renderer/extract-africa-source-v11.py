from pathlib import Path
from PIL import Image

SOURCE = Path(r"C:\Users\Administrator\AppData\Local\Temp\闈炴床.png")
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "africa-source"
OUT.mkdir(parents=True, exist_ok=True)
ASSET_DIRS = [ROOT / "assets" / "travel" / "africa", ROOT / "public" / "assets" / "travel" / "africa"]
for directory in ASSET_DIRS:
    directory.mkdir(parents=True, exist_ok=True)

image = Image.open(SOURCE).convert("RGB")
rows = {
    "day01": (52, 505),
    "day02": (505, 1000),
    "day03": (1000, 1455),
    "day04": (1455, 1900),
    "day05": (1900, 2350),
    "day06": (2350, 2800),
    "day07": (2800, 3235),
    "day08": (3235, 3665),
    "day09": (3665, 4055),
    "day10": (4055, 4195),
    "pricing": (4195, 4484),
}

for name, (top, bottom) in rows.items():
    crop = image.crop((0, top, image.width, bottom))
    crop.resize((crop.width * 2, crop.height * 2), Image.Resampling.LANCZOS).save(OUT / f"{name}-2x.png")

photos = {
    "source-day01-kilimanjaro-giraffes.jpg": (585, 167, 1056, 489),
    "source-day01-safari-drive.jpg": (1120, 170, 1586, 499),
    "source-day02-tarangire-elephants.jpg": (660, 579, 1401, 973),
    "source-day03-ngorongoro-herds.jpg": (603, 1138, 1112, 1394),
    "source-day03-safari-vehicle.jpg": (1176, 1138, 1565, 1402),
    "source-day04-serengeti-lions.jpg": (588, 1586, 1204, 1872),
    "source-day05-mara-crossing.jpg": (671, 1982, 1295, 2330),
    "source-day06-serengeti-balloon.jpg": (689, 2450, 1485, 2788),
    "source-day07-zanzibar-sandbar.jpg": (713, 2854, 1358, 3192),
    "source-day08-mnemba-snorkeling.jpg": (771, 3263, 1466, 3620),
    "source-day09-zanzibar-beach.jpg": (888, 3670, 1554, 4002),
}

for name, box in photos.items():
    photo = image.crop(box)
    for directory in ASSET_DIRS:
        photo.save(directory / name, quality=94, subsampling=0)

# Keep downloaded documentary photos large enough for the 2000px export while
# avoiding multi-megabyte originals in every preview/render pass.
for web_photo in ASSET_DIRS[0].glob("web-*.jpg"):
    photo = Image.open(web_photo).convert("RGB")
    if photo.width > 2400:
        height = round(photo.height * 2400 / photo.width)
        photo = photo.resize((2400, height), Image.Resampling.LANCZOS)
    for directory in ASSET_DIRS:
        photo.save(directory / web_photo.name, quality=90, optimize=True, subsampling=0)

print(OUT)
