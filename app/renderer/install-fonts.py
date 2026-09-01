from pathlib import Path
from zipfile import ZipFile
from io import BytesIO
import shutil

ROOT = Path(__file__).resolve().parents[1]
ASSET_FONT_ROOT = ROOT.parent / "assets" / "fonts"
SOURCE = ROOT.parent.parent / "字体"


def write_file(relative, data):
    for base in [ASSET_FONT_ROOT, ROOT / "public/fonts"]:
        target = base / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def outer_zip(keyword):
    return next(path for path in SOURCE.glob("*.zip") if keyword in path.name)


def extract_nested_family(outer_keyword, nested_keyword, family_dir):
    with ZipFile(outer_zip(outer_keyword)) as outer:
        nested_name = next(name for name in outer.namelist() if nested_keyword in name)
        with ZipFile(BytesIO(outer.read(nested_name))) as nested:
            for item in nested.infolist():
                if item.is_dir():
                    continue
                name = Path(item.filename).name
                if name.lower().endswith(".otf") or name.lower().startswith("license"):
                    write_file(Path(family_dir) / name, nested.read(item))


def extract_poppins():
    selected = {"Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold"}
    with ZipFile(outer_zip("Poppins")) as archive:
        for item in archive.infolist():
            name = Path(item.filename).name
            if name == "OFL.txt" or any(name == f"Poppins-{weight}.ttf" for weight in selected):
                write_file(Path("Poppins") / name, archive.read(item))


def extract_fangya():
    with ZipFile(outer_zip("风雅宋")) as archive:
        for item in archive.infolist():
            name = Path(item.filename).name
            if name.lower().endswith(".ttf") or name.lower().startswith("license"):
                write_file(Path("FangYaSong") / name, archive.read(item))


if __name__ == "__main__":
    extract_nested_family("思源黑体", "SourceHanSansCN", "SourceHanSansCN")
    extract_nested_family("思源宋体", "SourceHanSerifCN", "SourceHanSerifCN")
    extract_poppins()
    extract_fangya()
    shutil.copy2(outer_zip("思源黑体"), ASSET_FONT_ROOT / "SOURCE-ARCHIVE-NOT-COPIED.txt") if False else None
    print("品牌字体已提取并复制到根目录 assets/fonts/ 与 app/public/fonts/。")
