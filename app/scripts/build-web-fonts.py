"""Lossless web-font packaging. Original renderer fonts are never modified.

Run with the isolated fontTools + brotli environment. Generated files are
content-addressed; retain older files on deployment for existing browser tabs.
"""
import hashlib
import json
from pathlib import Path
import re
from concurrent.futures import ProcessPoolExecutor
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = Path(__file__).resolve().parents[1]


def common_characters():
    # GB2312 level-one is a stable common-character set, NOT the text from one
    # trip. Every other source character is included in a disjoint fallback
    # shard, so future destinations and rare names remain supported.
    result = set(range(0x3100)) | set(range(0xFF00, 0xFFF0))
    for high in range(0xB0, 0xD8):
        for low in range(0xA1, 0xFF):
            try:
                result.add(ord(bytes((high, low)).decode('gb2312')))
            except UnicodeDecodeError:
                pass
    return result


def ranges(points):
    ordered = sorted(points)
    runs = []
    for point in ordered:
        if runs and point == runs[-1][1] + 1:
            runs[-1][1] = point
        else:
            runs.append([point, point])
    return ','.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in runs)


def convert(face):
    family, source, weight = face
    original = ROOT / 'public' / source.lstrip('/')
    font = TTFont(original, recalcTimestamp=False)
    before_cmap = font.getBestCmap()
    before_metrics = dict(font['hmtx'].metrics)
    # Web derivatives retain copyright/license records and use distinct internal
    # names (OFL reserved names); the public CSS alias and glyphs stay unchanged.
    internal = 'SheyouWeb' + re.sub(r'[^a-zA-Z]', '', family) + weight
    for record in font['name'].names:
        if record.nameID in (1, 3, 4, 6, 16):
            record.string = internal.encode(record.getEncoding())
    # Keep the full conversion for a baseline, but browser CSS references only
    # disjoint subsets. Small Latin fonts do not need splitting.
    cmap = set(before_cmap)
    common = cmap & common_characters()
    remaining = sorted(cmap - common)
    groups = [common] + [set(remaining[i:i+256]) for i in range(0, len(remaining), 256)] if len(cmap) > 5000 else [cmap]
    import io
    base = io.BytesIO()
    font.save(base)
    shards = []
    coverage = set()
    for index, points in enumerate(groups):
        derived = TTFont(io.BytesIO(base.getvalue()), recalcTimestamp=False)
        if len(groups) > 1:
            options = subset.Options()
            options.layout_features = ['*']
            options.name_IDs = ['*']
            options.name_legacy = True
            options.name_languages = ['*']
            options.glyph_names = True
            worker = subset.Subsetter(options=options)
            worker.populate(unicodes=points)
            worker.subset(derived)
        derived.flavor = 'woff2'
        stream = io.BytesIO()
        derived.save(stream)
        payload = stream.getvalue()
        restored = TTFont(io.BytesIO(payload))
        restored_cmap = restored.getBestCmap()
        assert set(restored_cmap) == points, source + ': cmap changed'
        for point, glyph in restored_cmap.items():
            assert restored['hmtx'].metrics[glyph] == before_metrics[before_cmap[point]], source + ': metrics changed'
        assert not coverage.intersection(points)
        coverage.update(points)
        name = internal + f'-{index}.' + hashlib.sha256(payload).hexdigest()[:16] + '.woff2'
        (ROOT / 'public/fonts/web' / name).write_bytes(payload)
        shards.append({'file': name, 'bytes': len(payload), 'range': ranges(points)})
    assert coverage == cmap
    return {'family': family, 'weight': weight, 'source': source,
            'shards': shards, 'originalBytes': original.stat().st_size,
            'webBytes': sum(s['bytes'] for s in shards), 'glyphCount': len(before_cmap)}


def main():
    source_css = ROOT / 'src/export-fonts.css'
    # One-time mechanical extraction of the original declarations, verbatim.
    if not source_css.exists():
        styles = ROOT / 'src/styles.css'
        text = styles.read_text(encoding='utf-8')
        declarations = [line for line in text.splitlines(keepends=True)
                        if line.startswith('@font-face ')]
        assert len(declarations) == 17
        source_css.write_text(''.join(declarations), encoding='utf-8')
        styles.write_text(''.join(line for line in text.splitlines(keepends=True)
                                 if not line.startswith('@font-face ')), encoding='utf-8')
    faces = re.findall(r'font-family: "([^"]+)"; src: url\(\'([^\']+)\'\).*?font-weight: (\d+);',
                       source_css.read_text(encoding='utf-8'))
    assert len(faces) == 17
    out = ROOT / 'public/fonts/web'
    out.mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(convert, faces))
    css = '\n'.join('@font-face { font-family: "%(family)s"; src: url("/fonts/web/%(file)s") format("woff2"); font-weight: %(weight)s; font-style: normal; font-display: swap; unicode-range: %(range)s; }' % {**item, **shard} for item in results for shard in item['shards'])
    (ROOT / 'src/web-fonts.css').write_text(css + '\n', encoding='utf-8')
    (out / 'manifest.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    # Keep the original upstream license text beside distributed derivatives.
    for directory in (ROOT / 'public/fonts').iterdir():
        if directory.is_dir() and directory != out:
            for license_file in directory.glob('*.txt'):
                (out / (directory.name + '-' + license_file.name)).write_bytes(license_file.read_bytes())
    print(json.dumps({'originalBytes': sum(r['originalBytes'] for r in results),
                      'webBytes': sum(r['webBytes'] for r in results),
                      'faces': len(results), 'allCmapsAndMetricsEqual': True}))


if __name__ == '__main__':
    main()
