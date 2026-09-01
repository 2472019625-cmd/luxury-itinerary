from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math
import random
import shutil

ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = ROOT.parent / "assets"
SOURCE_LOGO = ROOT.parent.parent / "品牌规范" / "奢游logo [新]左右2（不带R）.png"


def ensure_dirs():
    for rel in [
        "assets/logos", "assets/icons", "assets/backgrounds", "assets/textures", "assets/placeholders",
        "public/assets/logos", "public/assets/icons", "public/assets/backgrounds", "public/assets/textures", "public/assets/placeholders",
        "public/data",
    ]:
        (ASSET_ROOT / rel.removeprefix("assets/") if rel.startswith("assets/") else ROOT / rel).mkdir(parents=True, exist_ok=True)


def trim_alpha(image):
    box = image.getbbox()
    return image.crop(box) if box else image


def build_logo_pngs():
    src = Image.open(SOURCE_LOGO).convert("RGBA")
    px = src.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = px[x, y]
            # 官方PNG带白底：以颜色距离生成干净透明度，保留金色边缘抗锯齿。
            distance = max(0, 255 - min(r, g, b))
            computed_alpha = 0 if distance < 8 else min(255, int((distance - 8) * 2.3))
            alpha = min(a, computed_alpha)
            px[x, y] = (r, g, b, alpha)
    src = trim_alpha(src)
    colors = {
        "gold": (178, 139, 51),
        "dark": (58, 51, 43),
        "white": (255, 255, 255),
    }
    for name, color in colors.items():
        alpha = src.getchannel("A")
        out = Image.new("RGBA", src.size, color + (0,))
        out.putalpha(alpha)
        out.thumbnail((3200, 1200), Image.Resampling.LANCZOS)
        out.save(ASSET_ROOT / f"logos/logo-{name}.png", optimize=True)
        out.save(ROOT / f"public/assets/logos/logo-{name}.png", optimize=True)
    shutil.copy2(SOURCE_LOGO, ASSET_ROOT / "logos/logo-official-source.png")


def background_base(size=(2000, 1600)):
    im = Image.new("RGB", size, "#FBF8F2")
    d = ImageDraw.Draw(im, "RGBA")
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        d.line((0, y, size[0], y), fill=(255, 252, 247, int(95 * (1 - t))))
    return im


def build_backgrounds():
    random.seed(20260825)
    bg = background_base()
    bg.save(ASSET_ROOT / "backgrounds/warm-white-base.png")

    lines = Image.new("RGBA", (2000, 1000), (0, 0, 0, 0))
    d = ImageDraw.Draw(lines, "RGBA")
    for i in range(18):
        points = []
        for x in range(-100, 2100, 20):
            y = 500 + 115 * math.sin((x / 220) + i * 0.23) + (i - 9) * 13
            points.append((x, y))
        d.line(points, fill=(178, 139, 51, 28), width=2)
    lines.save(ASSET_ROOT / "textures/light-gold-flow-lines.png")

    grad = Image.new("RGB", (2000, 1000), "#FBF8F2")
    gd = ImageDraw.Draw(grad, "RGBA")
    for radius in range(900, 20, -18):
        alpha = int(1.4 + (900 - radius) / 900 * 2)
        gd.ellipse((1000-radius, 500-radius, 1000+radius, 500+radius), fill=(212, 186, 154, alpha))
    grad = grad.filter(ImageFilter.GaussianBlur(55))
    grad.save(ASSET_ROOT / "backgrounds/champagne-soft-glow.png")

    silk = Image.new("RGB", (2000, 420), "#F8EBD5")
    sd = ImageDraw.Draw(silk, "RGBA")
    gradient_stops = [(0, (248, 235, 213)), (.42, (255, 249, 239)), (.70, (233, 204, 170)), (1, (248, 232, 209))]
    for x in range(silk.width):
        t = x / (silk.width - 1)
        left, right = gradient_stops[0], gradient_stops[-1]
        for start, end in zip(gradient_stops, gradient_stops[1:]):
            if start[0] <= t <= end[0]:
                left, right = start, end
                break
        ratio = (t - left[0]) / max(.001, right[0] - left[0])
        color = tuple(int(left[1][i] * (1 - ratio) + right[1][i] * ratio) for i in range(3))
        sd.line((x, 0, x, silk.height), fill=color + (255,))
    folds = Image.new("RGBA", silk.size, (0, 0, 0, 0))
    fd = ImageDraw.Draw(folds, "RGBA")
    for i in range(9):
        points = []
        for x in range(-80, 2080, 16):
            y = 220 + 94 * math.sin(x / (190 + i * 9) + i * .72) + (i - 4) * 18
            points.append((x, y))
        fd.line(points, fill=(255, 255, 255, 34), width=16)
        fd.line([(x, y + 24) for x, y in points], fill=(154, 103, 42, 24), width=12)
    folds = folds.filter(ImageFilter.GaussianBlur(13))
    silk = Image.alpha_composite(silk.convert("RGBA"), folds).convert("RGB")
    silk.save(ASSET_ROOT / "backgrounds/day-silk.png")

    glow = Image.new("RGBA", (2000, 640), (255, 255, 255, 0))
    gd = ImageDraw.Draw(glow, "RGBA")
    for r in range(520, 20, -12):
        a = max(0, int((520-r) / 500 * 2.8))
        gd.ellipse((1000-r*2, 320-r, 1000+r*2, 320+r), fill=(212, 186, 154, a))
    glow = glow.filter(ImageFilter.GaussianBlur(38))
    glow.save(ASSET_ROOT / "backgrounds/section-title-glow.png")

    card = Image.new("RGB", (1800, 1000), "#FFFDFC")
    cd = ImageDraw.Draw(card, "RGBA")
    for y in range(card.height):
        cd.line((0, y, card.width, y), fill=(233, 216, 190, int(38 * (1-y/card.height))))
    card.save(ASSET_ROOT / "backgrounds/fee-card.png")

    seamless = background_base((2000, 2000)).convert("RGBA")
    seamless.alpha_composite(lines.resize((2000, 1000)), (0, 820))
    mirrored = lines.transpose(Image.Transpose.FLIP_LEFT_RIGHT).resize((2000, 1000))
    seamless.alpha_composite(mirrored, (0, 1380))
    seamless.convert("RGB").save(ASSET_ROOT / "backgrounds/seamless-long-background.png")

    for folder in ["backgrounds", "textures"]:
        for file in (ASSET_ROOT / folder).glob("*.png"):
            shutil.copy2(file, ROOT / f"public/assets/{folder}/{file.name}")


def build_landscape(index, size=(1600, 1000)):
    palettes = [
        ("#D9C7B1", "#7892A0", "#C79053"), ("#C7D6D2", "#7B9D9A", "#D0A35D"),
        ("#D9CBB8", "#6E8D8B", "#A87845"), ("#E0D3C4", "#81929B", "#B18B5C")
    ]
    sky, mountain, land = palettes[index % len(palettes)]
    im = Image.new("RGB", size, sky)
    d = ImageDraw.Draw(im, "RGBA")
    for y in range(size[1]):
        t = y / size[1]
        d.line((0, y, size[0], y), fill=(255, 250, 242, int(90 * (1-t))))
    rng = random.Random(index * 1777)
    horizon = int(size[1] * (0.46 + rng.random() * 0.08))
    back = [(0, horizon)]
    for x in range(0, size[0] + 160, 160):
        back.append((x, horizon - rng.randint(80, 330)))
    back += [(size[0], size[1]), (0, size[1])]
    d.polygon(back, fill=mountain)
    front = [(0, int(size[1] * .68))]
    for x in range(0, size[0] + 120, 120):
        front.append((x, int(size[1] * .62) + rng.randint(-55, 85)))
    front += [(size[0], size[1]), (0, size[1])]
    d.polygon(front, fill=land)
    # 湖面或河流
    river = [(0, int(size[1]*.78)), (size[0]*.42, int(size[1]*.66)), (size[0], int(size[1]*.82)), (size[0], size[1]), (0, size[1])]
    d.polygon(river, fill=(226, 219, 204, 185))
    # 柔光颗粒让占位图更接近低饱和旅行摄影。
    for _ in range(1000):
        x, y = rng.randrange(size[0]), rng.randrange(size[1])
        d.point((x, y), fill=(255, 255, 255, rng.randrange(5, 24)))
    return im.filter(ImageFilter.GaussianBlur(.35))


def build_placeholders():
    for i in range(1, 13):
        im = build_landscape(i)
        name = f"destination-{i:02d}.png"
        im.save(ASSET_ROOT / f"placeholders/{name}", optimize=True)
        im.save(ROOT / f"public/assets/placeholders/{name}", optimize=True)
    avatar = Image.new("RGB", (600, 600), "#E7D7C0")
    d = ImageDraw.Draw(avatar)
    d.ellipse((180, 90, 420, 330), fill="#F7EFE3")
    d.ellipse((80, 300, 520, 720), fill="#B28B33")
    avatar.save(ASSET_ROOT / "placeholders/avatar.png", optimize=True)
    avatar.save(ROOT / "public/assets/placeholders/avatar.png", optimize=True)


def copy_icons_and_data():
    icon_map = {
        "people": "users", "calendar": "calendar", "departure": "plane-departure", "return": "plane-arrival",
        "city": "map-pin", "meal": "tools-kitchen-2", "itinerary": "route", "hotel": "building-skyscraper",
        "vehicle": "car", "driver": "steering-wheel", "guide": "user-star", "included": "circle-check",
        "excluded": "circle-x", "cancellation": "arrows-exchange", "warning": "alert-triangle",
        "process": "list-check", "advantage": "building-skyscraper", "security": "shield-check",
        "payment": "credit-card", "contact": "phone", "crown": "crown"
    }
    source = ROOT / "node_modules/@tabler/icons/icons/outline"
    for target, original in icon_map.items():
        for dest in [ASSET_ROOT / "icons", ROOT / "public/assets/icons"]:
            shutil.copy2(source / f"{original}.svg", dest / f"{target}.svg")
    shutil.copy2(ROOT / "data/sample-itinerary.json", ROOT / "public/data/sample-itinerary.json")


if __name__ == "__main__":
    ensure_dirs()
    build_logo_pngs()
    build_backgrounds()
    build_placeholders()
    copy_icons_and_data()
    print("素材资产已生成。")
