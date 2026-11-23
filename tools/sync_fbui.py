"""Copy the shared FB UI kit (js/fbui/), the file browser (js/file_browser.js)
and docs/UI_RULES.md into another pack. The pack keeps its own
js/path_browser.js, which names its routes for the browser.

FBnodes holds the canonical copy. Run after changing the kit:

    python tools/sync_fbui.py ../ComfyUI-Prompt-Manager ../ComfyUI-H3RefModPicker
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "js" / "fbui"
RULES = ROOT / "docs" / "UI_RULES.md"
BROWSER = ROOT / "js" / "file_browser.js"


def sync(target: Path) -> None:
    web = target / "js"
    if not web.is_dir():
        raise SystemExit(f"{target} has no js/ folder")
    dest = web / "fbui"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(KIT, dest)
    shutil.copy2(BROWSER, web / "file_browser.js")
    (target / "docs").mkdir(exist_ok=True)
    shutil.copy2(RULES, target / "docs" / "UI_RULES.md")
    print(f"synced {dest}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for arg in sys.argv[1:]:
        sync(Path(arg).resolve())
