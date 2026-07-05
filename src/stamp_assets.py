"""Cache-bust the static asset references in docs/index.html.

GitHub Pages serves style.css / agg.js / app.js with a 10-minute cache and
index.html references them by bare filename, so browsers keep serving a stale
copy after a deploy. This rewrites each reference to ``name?v=<hash>`` where
<hash> is a short digest of the file's current contents — when a file changes
its URL changes, so the browser is forced to fetch the new version, while
unchanged files keep their URL and stay cached.

Idempotent: an existing ``?v=...`` is stripped and recomputed. Run before
committing a docs/ change (also wired into src/export_web.py so the weekly
data workflow restamps automatically).

Usage:
    py src/stamp_assets.py
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
INDEX = DOCS / "index.html"
ASSETS = ["style.css", "agg.js", "app.js"]


def _hash(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()[:8]


def stamp() -> bool:
    html = INDEX.read_text(encoding="utf-8")
    original = html
    for name in ASSETS:
        f = DOCS / name
        if not f.exists():
            continue
        ver = _hash(f)
        # match href/src="name" optionally already carrying ?v=...
        pat = re.compile(
            r'((?:href|src)=")' + re.escape(name) + r'(?:\?v=[0-9a-f]+)?(")'
        )
        html, n = pat.subn(rf'\g<1>{name}?v={ver}\g<2>', html)
        if n:
            print(f"  {name}?v={ver}  ({n} ref)")
    if html != original:
        INDEX.write_text(html, encoding="utf-8")
        return True
    print("  (no change)")
    return False


if __name__ == "__main__":
    print("stamp assets -> docs/index.html")
    stamp()
