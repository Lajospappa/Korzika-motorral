#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Read-only összehasonlító: Korzika 2026 POI HTML-ek és LaStrada (francia/korzikai útvonal) HTML-ek
címének párosítása normalizált alapon. Nem módosít semmilyen forrásfájlt; csak CSV riport.

Futtatás:
  python korzika_lastrada_poi_title_compare.py

CSV kimenet (alapból két példány, ugyanaz a tartalom):
  - C:\\Users\\lajos\\Documents\\korzika_lastrada_title_match_report.csv
  - a script mellett (Korzika 2026 mappa): korzika_lastrada_title_match_report.csv

Megjegyzés: Ha a gépen nincs telepített Python (a WindowsApps python csak átirányító),
fusson a párhuzamos Node változat: korzika_lastrada_poi_title_compare.mjs
"""

from __future__ import annotations

import csv
import re
import sys
import unicodedata
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path

# --- Projektútak (állíthatók argumentummal), alapértelmezés a feladat szerint ---
DEFAULT_KORZIKA_ROOT = Path(r"C:\Users\lajos\Documents\Korzika 2026")
DEFAULT_LASTRADA_ROOT = Path(r"C:\Users\lajos\Documents\Kirándulás szerkesztő")
DEFAULT_REPORT_CSV = Path(r"C:\Users\lajos\Documents\korzika_lastrada_title_match_report.csv")
SCRIPT_DIR = Path(__file__).resolve().parent
LOCAL_REPORT_COPY = SCRIPT_DIR / "korzika_lastrada_title_match_report.csv"

LASTRADA_PATH_MARKERS = (
    "france",
    "francia",
    "franciaorszag",
    "franciaország",
    "corsica",
    "korzika",
)


class PoiTitleExtractor(HTMLParser):
    """Első <h1>, ha nincs akkor első <h2>, ha nincs akkor <title> szövege."""

    _skip_tags = frozenset(
        {"script", "style", "noscript", "template"}
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._stack: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self._title_chunks: list[str] = []

        self._collecting: str | None = None  # "h1" | "h2"
        self._heading_chunks: list[str] = []

        self.title_from_tag: str | None = None
        self._h1_candidates: list[str] = []
        self._h2_candidates: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        t = tag.lower()
        if self._skip_depth > 0:
            self._skip_depth += 1
            return
        if t in self._skip_tags:
            self._skip_depth = 1
            return

        parent = self._stack[-1] if self._stack else None
        self._stack.append(t)

        if t == "title" and parent == "head":
            self._in_title = True
            self._title_chunks = []
        elif t == "h1":
            self._collecting = "h1"
            self._heading_chunks = []
        elif t == "h2":
            self._collecting = "h2"
            self._heading_chunks = []

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if self._skip_depth > 0:
            self._skip_depth -= 1
            return

        if t == "title" and self._in_title:
            self._in_title = False
            text = _collapse_whitespace("".join(self._title_chunks))
            if text and self.title_from_tag is None:
                self.title_from_tag = text

        if self._collecting == t:
            text = _collapse_whitespace("".join(self._heading_chunks))
            if text:
                if t == "h1":
                    self._h1_candidates.append(text)
                else:
                    self._h2_candidates.append(text)
            self._collecting = None
            self._heading_chunks = []

        if self._stack and self._stack[-1] == t:
            self._stack.pop()

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_title:
            self._title_chunks.append(data)
        elif self._collecting in {"h1", "h2"}:
            self._heading_chunks.append(data)

    def chosen_title(self) -> str:
        if self._h1_candidates:
            return self._h1_candidates[0]
        if self._h2_candidates:
            return self._h2_candidates[0]
        if self.title_from_tag:
            return self.title_from_tag
        return ""


def _collapse_whitespace(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def extract_poi_title(html_text: str) -> str:
    parser = PoiTitleExtractor()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        return ""
    return parser.chosen_title()


def normalize_title(title: str) -> str:
    """Kisbetű, ékezetek eltávolítása, extra szóközök, írásjelek egyszerűsítése (nem betű/szám -> szóköz)."""
    if not title:
        return ""
    nfkd = unicodedata.normalize("NFD", title)
    no_marks = "".join(ch for ch in nfkd if unicodedata.category(ch) != "Mn")
    lower = no_marks.lower()
    simplified = re.sub(r"[^\w]+", " ", lower, flags=re.UNICODE)
    return _collapse_whitespace(simplified)


def iter_html_files(root: Path):
    if not root.is_dir():
        return
    yield from root.rglob("*.html")
    yield from root.rglob("*.htm")


def lastrada_path_is_relevant(full_path: Path) -> bool:
    p = str(full_path).casefold().replace("/", "\\")
    return any(marker.casefold() in p for marker in LASTRADA_PATH_MARKERS)


def collect_file_records(root: Path, filter_paths: bool) -> list[dict]:
    rows: list[dict] = []
    for fp in sorted(iter_html_files(root), key=lambda p: str(p).casefold()):
        if filter_paths and not lastrada_path_is_relevant(fp):
            continue
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        raw_title = extract_poi_title(text)
        norm = normalize_title(raw_title)
        rows.append(
            {
                "file": fp.resolve(),
                "raw_title": raw_title,
                "normalized_title": norm,
            }
        )
    return rows


def build_index(records: list[dict]) -> dict[str, list[dict]]:
    idx: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        idx[r["normalized_title"]].append(r)
    return idx


def compute_report_rows(
    kor_records: list[dict], ls_records: list[dict]
) -> list[dict]:
    k_idx = build_index(kor_records)
    l_idx = build_index(ls_records)

    all_keys = sorted(
        set(k_idx.keys()) | set(l_idx.keys()),
        key=lambda k: (k == "", k),
    )

    out: list[dict] = []
    for key in all_keys:
        ks = sorted(k_idx.get(key, []), key=lambda r: str(r["file"]))
        ls = sorted(l_idx.get(key, []), key=lambda r: str(r["file"]))

        if not ks:
            for r in ls:
                out.append(
                    {
                        "match_status": "lastrada_only",
                        "korzika_title": "",
                        "lastrada_title": r["raw_title"],
                        "korzika_file": "",
                        "lastrada_file": str(r["file"]),
                        "normalized_title": key,
                    }
                )
            continue

        if not ls:
            for r in ks:
                out.append(
                    {
                        "match_status": "korzika_only",
                        "korzika_title": r["raw_title"],
                        "lastrada_title": "",
                        "korzika_file": str(r["file"]),
                        "lastrada_file": "",
                        "normalized_title": key,
                    }
                )
            continue

        # Van mindkét oldalon
        pairs = min(len(ks), len(ls))
        for i in range(pairs):
            kr, lr = ks[i], ls[i]
            out.append(
                {
                    "match_status": "exact_normalized_match",
                    "korzika_title": kr["raw_title"],
                    "lastrada_title": lr["raw_title"],
                    "korzika_file": str(kr["file"]),
                    "lastrada_file": str(lr["file"]),
                    "normalized_title": key,
                }
            )

        ref_l = ls[0] if ls else None
        for kr in ks[pairs:]:
            out.append(
                {
                    "match_status": "duplicate_in_korzika",
                    "korzika_title": kr["raw_title"],
                    "lastrada_title": ref_l["raw_title"] if ref_l else "",
                    "korzika_file": str(kr["file"]),
                    "lastrada_file": str(ref_l["file"]) if ref_l else "",
                    "normalized_title": key,
                }
            )

        ref_k = ks[0] if ks else None
        for lr in ls[pairs:]:
            out.append(
                {
                    "match_status": "duplicate_in_lastrada",
                    "korzika_title": ref_k["raw_title"] if ref_k else "",
                    "lastrada_title": lr["raw_title"],
                    "korzika_file": str(ref_k["file"]) if ref_k else "",
                    "lastrada_file": str(lr["file"]),
                    "normalized_title": key,
                }
            )

    return out


def write_csv(report_path: Path, rows: list[dict]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "match_status",
        "korzika_title",
        "lastrada_title",
        "korzika_file",
        "lastrada_file",
        "normalized_title",
    ]
    with report_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for row in rows:
            w.writerow(row)


def main(argv: list[str]) -> int:
    kor_root = DEFAULT_KORZIKA_ROOT
    ls_root = DEFAULT_LASTRADA_ROOT
    report_csv = DEFAULT_REPORT_CSV

    args = argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        print("\nOpcionális argumentumok:")
        print("  --korzika-root PATH")
        print("  --lastrada-root PATH")
        print("  --report-csv PATH")
        return 0

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--korzika-root" and i + 1 < len(args):
            kor_root = Path(args[i + 1])
            i += 2
        elif a == "--lastrada-root" and i + 1 < len(args):
            ls_root = Path(args[i + 1])
            i += 2
        elif a == "--report-csv" and i + 1 < len(args):
            report_csv = Path(args[i + 1])
            i += 2
        else:
            print(f"Ismeretlen argumentum: {a}", file=sys.stderr)
            return 2

    kor_records = collect_file_records(kor_root, filter_paths=False)
    ls_records = collect_file_records(ls_root, filter_paths=True)
    report_rows = compute_report_rows(kor_records, ls_records)
    write_csv(report_csv, report_rows)
    write_csv(LOCAL_REPORT_COPY, report_rows)

    n_exact = sum(1 for r in report_rows if r["match_status"] == "exact_normalized_match")
    n_k_only = sum(1 for r in report_rows if r["match_status"] == "korzika_only")
    n_l_only = sum(1 for r in report_rows if r["match_status"] == "lastrada_only")
    n_dup_k = sum(1 for r in report_rows if r["match_status"] == "duplicate_in_korzika")
    n_dup_l = sum(1 for r in report_rows if r["match_status"] == "duplicate_in_lastrada")

    duplicate_titles = 0
    k_idx = build_index(kor_records)
    l_idx = build_index(ls_records)
    for key in set(k_idx) | set(l_idx):
        if key == "":
            continue
        if len(k_idx.get(key, [])) > 1 or len(l_idx.get(key, [])) > 1:
            duplicate_titles += 1

    print(f"Riport elkészült: {report_csv}")
    print(f"Riport másolat (projektmappa): {LOCAL_REPORT_COPY}")
    print(f"- Korzika HTML (összes rekurzív): {len(kor_records)}")
    print(f"- LaStrada HTML (útban francia/korzikai kulcsszűrővel): {len(ls_records)}")
    print(f"- Pontos normalizált cím egyezés (sor): {n_exact}")
    print(f"- Korzika-only sorok: {n_k_only}")
    print(f"- LaStrada-only sorok: {n_l_only}")
    print(f"- Duplikátum sor duplicate_in_korzika: {n_dup_k}")
    print(f"- Duplikátum sor duplicate_in_lastrada: {n_dup_l}")
    print(f"- Összesen „duplikált utasítás” típus sor: {n_dup_k + n_dup_l}")
    print(f"- Olyan normalizált címek száma, amely több fájlra is ráillik ( bármelyik oldalon ): {duplicate_titles}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
