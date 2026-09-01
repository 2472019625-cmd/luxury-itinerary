from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
CARD_SIZE = (1910, 900)
DAY_SIZE = (2000, 430)
COVER_SIZE = (2000, 1300)
TITLE_GRADIENT_SIZE = (32, 512)


def mix(left, right, ratio):
    return tuple(round(left[i] * (1 - ratio) + right[i] * ratio) for i in range(3))


def build_fee_card():
    warm = (244, 222, 190)
    cream = (255, 253, 248)
    card = Image.new("RGB", CARD_SIZE, cream)
    pixels = card.load()

    for y in range(CARD_SIZE[1]):
        ratio = y / max(1, CARD_SIZE[1] - 1)
        color = mix(warm, cream, ratio)
        for x in range(CARD_SIZE[0]):
            pixels[x, y] = color

    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        card.save(folder / "fee-card-proof-a.png", optimize=True)


def build_reverse_profile_card():
    cream = (255, 253, 248)
    warm = (243, 218, 182)
    card = Image.new("RGB", CARD_SIZE, cream)
    pixels = card.load()
    for y in range(CARD_SIZE[1]):
        ratio = y / max(1, CARD_SIZE[1] - 1)
        eased = ratio * ratio * (3 - 2 * ratio)
        color = mix(cream, warm, eased * .82)
        for x in range(CARD_SIZE[0]):
            pixels[x, y] = color
    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        card.save(folder / "profile-meta-reverse-v2.png", optimize=True)


def build_designer_performance_card():
    cream = (255, 253, 248)
    warm = (242, 216, 179)
    card = Image.new("RGB", CARD_SIZE, cream)
    pixels = card.load()
    transition = .56
    for y in range(CARD_SIZE[1]):
        ratio = y / max(1, CARD_SIZE[1] - 1)
        if ratio <= transition:
            color = cream
        else:
            local = (ratio - transition) / (1 - transition)
            eased = local * local * (3 - 2 * local)
            color = mix(cream, warm, eased * .88)
        for x in range(CARD_SIZE[0]):
            pixels[x, y] = color
    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        card.save(folder / "designer-performance-gradient-v3.png", optimize=True)


def build_section_title_text_gradient():
    top = (199, 155, 100, 122)
    bottom = (244, 225, 198, 34)
    image = Image.new("RGBA", TITLE_GRADIENT_SIZE, top)
    pixels = image.load()
    for y in range(TITLE_GRADIENT_SIZE[1]):
        ratio = y / max(1, TITLE_GRADIENT_SIZE[1] - 1)
        rgba = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(4))
        for x in range(TITLE_GRADIENT_SIZE[0]):
            pixels[x, y] = rgba
    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        image.save(folder / "section-title-text-gradient-v1.png", optimize=True)


def build_day_header():
    top = (244, 218, 181)
    bottom = (255, 246, 232)
    day = Image.new("RGB", DAY_SIZE, bottom)
    pixels = day.load()

    for y in range(DAY_SIZE[1]):
        ratio = y / max(1, DAY_SIZE[1] - 1)
        color = mix(top, bottom, ratio)
        for x in range(DAY_SIZE[0]):
            pixels[x, y] = color

    shapes = Image.new("RGBA", DAY_SIZE, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shapes, "RGBA")
    draw.ellipse((1220, -420, 2380, 680), fill=(212, 186, 154, 68))
    draw.ellipse((1450, -300, 2200, 510), fill=(255, 253, 248, 104))

    upper = []
    lower = []
    for x in range(-100, 2101, 20):
        center = 260 + 58 * math.sin(x / 260 + .6)
        upper.append((x, center - 46))
        lower.append((x, center + 44))
    draw.polygon(upper + list(reversed(lower)), fill=(231, 199, 156, 58))

    for offset in (-34, -18, 0, 19, 38):
        points = []
        for x in range(900, 2101, 16):
            y = 238 + 54 * math.sin(x / 248 + .55) + offset
            points.append((x, y))
        draw.line(points, fill=(178, 139, 51, 36), width=2)

    shapes = shapes.filter(ImageFilter.GaussianBlur(10))
    day = Image.alpha_composite(day.convert("RGBA"), shapes).convert("RGB")
    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        day.save(folder / "day-abstract-proof-a.png", optimize=True)


def build_clean_day_silk():
    day = Image.new("RGB", DAY_SIZE, "#F8EBD5")
    pixels = day.load()
    stops = [
        (0.0, (246, 229, 204)),
        (0.28, (255, 249, 239)),
        (0.53, (249, 235, 214)),
        (0.76, (234, 207, 174)),
        (1.0, (248, 233, 211)),
    ]
    for x in range(DAY_SIZE[0]):
        ratio = x / max(1, DAY_SIZE[0] - 1)
        left, right = stops[0], stops[-1]
        for start, end in zip(stops, stops[1:]):
            if start[0] <= ratio <= end[0]:
                left, right = start, end
                break
        local = (ratio - left[0]) / max(.001, right[0] - left[0])
        color = mix(left[1], right[1], local)
        for y in range(DAY_SIZE[1]):
            vertical = abs(y / max(1, DAY_SIZE[1] - 1) - .48)
            pixels[x, y] = mix(color, (255, 250, 242), max(0, .07 - vertical * .11))

    # Deliberately line-free: the DAY anchor uses only broad colour fields.
    # No curves, bands, folds, shadows or contrast edges are composited here.
    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        day.save(folder / "day-champagne-linefree-v4.png", optimize=True)


def build_cover_wash():
    edge = (255, 253, 249)
    center = (249, 238, 219)
    lower = (253, 247, 238)
    cover = Image.new("RGB", COVER_SIZE, edge)
    pixels = cover.load()
    for y in range(COVER_SIZE[1]):
        vertical = y / max(1, COVER_SIZE[1] - 1)
        for x in range(COVER_SIZE[0]):
            distance = abs((x / max(1, COVER_SIZE[0] - 1)) - .5) / .5
            spread = max(0.0, 1.0 - distance ** 1.55)
            color = mix(edge, center, spread * .78)
            pixels[x, y] = mix(color, lower, vertical * .16)
    for folder in (ROOT / "assets/backgrounds", ROOT / "public/assets/backgrounds"):
        folder.mkdir(parents=True, exist_ok=True)
        cover.save(folder / "cover-center-spread-v3.png", optimize=True)


if __name__ == "__main__":
    build_fee_card()
    build_reverse_profile_card()
    build_designer_performance_card()
    build_section_title_text_gradient()
    build_day_header()
    build_clean_day_silk()
    build_cover_wash()
    print("封面中心扩散、完全无纹线DAY头板与纵向内容卡渐变已生成。")
