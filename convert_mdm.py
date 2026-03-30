"""
convert_mdm.py
Converts ExamenesLaboratorio_DataPrepMDM.csv → measures.csv (MedEx format)

Source columns (comma-separated):
  TEMA, SUBTEMA, ANALISIS, UNIDAD DE MEDIDA,
  LIMITE INFERIOR, LIMITE SUPERIOR, EXPLICACION, EXPLICACION2

Target columns (semicolon-separated):
  MeasureId;MeasureName;Unit;LowRef;HighRef;Topic;Subtopic;Explanation;Explanation2

Deduplication rule:
  When the same ANALISIS name appears in multiple panels (subtemas), the
  HEMATOLOGÍA row wins — the others are dropped entirely.
  Exception: LDL appears twice within CARDIOMETABÓLICA with genuinely different
  reference ranges → both are kept with distinct IDs (ldl_optimo / ldl).
"""

import csv
import re
import unicodedata
import sys
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────
SRC = Path(r"C:\Users\David\OneDrive\Documents\David\David-DocumentosP\Salud\ExamenesYDiagnosticos\ExamenesLaboratorio_DataPrepMDM.csv")
DST = Path(r"C:\Users\David\Claude-MedEx\measures.csv")

# ── Helpers ──────────────────────────────────────────────────────
def slugify(text: str) -> str:
    """Convert display name to a stable ID slug."""
    t = text.strip().lower()
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[\s\-/\(\)\.\,\:]+", "_", t)
    t = re.sub(r"[^a-z0-9_]", "", t)
    t = re.sub(r"_+", "_", t).strip("_")
    return t


def clean_ref(val: str) -> str:
    """Normalize a reference value cell."""
    v = val.strip()
    if v in ("-", "- ", " - ", " -  ", "  -  ", ""):
        return ""
    # European comma-only decimal  "4,78" → "4.78"
    if "," in v and "." not in v:
        v = v.replace(",", ".")
    # Thousands comma + period decimal  "4,780.00" → "4780.00"
    elif "," in v and "." in v:
        v = v.replace(",", "")
    return v.strip()


def clean_text(val: str) -> str:
    """Collapse internal newlines/whitespace in free-text fields."""
    return " ".join(val.split())


# ── Deduplication: HEMATOLOGÍA priority ──────────────────────────
# When the same ANALISIS slug appears more than once, rows from HEMATOLOGÍA
# are preferred and all other occurrences are dropped.
# Exception list: slugs where ALL occurrences are intentionally kept.
KEEP_ALL_OCCURRENCES: set[str] = {
    "colesterol_baja_densidad_ldl",   # two genuine clinical ranges
}

# ── Manual ID overrides for intentionally kept duplicates ─────────
# Key = (base_slug, occurrence_index_among_kept_rows)
ID_OVERRIDES: dict[tuple, str] = {
    ("colesterol_baja_densidad_ldl", 0): "ldl_optimo",   # 70–100 optimal
    ("colesterol_baja_densidad_ldl", 1): "ldl",           # <129 standard
}

# ── Manual value overrides ────────────────────────────────────────
MANUAL_OVERRIDES: dict[str, dict] = {
    # TSH: "4,780.00" is a European decimal artefact → 4.78
    "tsh_3ra_generacion": {"HighRef": "4.78"},
}

# ── Main conversion ──────────────────────────────────────────────
def convert():
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = SRC.read_text(encoding=encoding)
            break
        except (UnicodeDecodeError, FileNotFoundError) as e:
            if isinstance(e, FileNotFoundError):
                print(f"ERROR: Source file not found:\n  {SRC}")
                sys.exit(1)
            continue
    else:
        print("ERROR: Could not decode source file with any known encoding.")
        sys.exit(1)

    reader = csv.DictReader(
        text.splitlines(),
        delimiter=",",
        quotechar='"',
        skipinitialspace=True,
    )
    raw_rows = [r for r in reader if r.get("ANALISIS", "").strip()]

    # ── Pass 1: group rows by slug, identify which tema each belongs to ──
    from collections import defaultdict
    by_slug: dict[str, list[dict]] = defaultdict(list)
    for row in raw_rows:
        by_slug[slugify(row["ANALISIS"])].append(row)

    # ── Pass 2: select the winning row(s) per slug ───────────────────────
    selected: list[dict] = []
    dropped_log: list[str] = []

    for slug, rows in by_slug.items():
        if len(rows) == 1 or slug in KEEP_ALL_OCCURRENCES:
            selected.extend(rows)
            continue

        # Multiple occurrences → prefer HEMATOLOGÍA
        hema_rows  = [r for r in rows if r.get("TEMA", "").strip().upper() == "HEMATOLOGÍA"]
        other_rows = [r for r in rows if r.get("TEMA", "").strip().upper() != "HEMATOLOGÍA"]

        if hema_rows:
            selected.extend(hema_rows)
            for r in other_rows:
                dropped_log.append(
                    f"  DROPPED '{r['ANALISIS']}' "
                    f"(TEMA={r['TEMA'].strip()}, SUBTEMA={r['SUBTEMA'].strip()})"
                )
        else:
            # No HEMATOLOGÍA row → keep first, drop rest
            selected.append(rows[0])
            for r in rows[1:]:
                dropped_log.append(
                    f"  DROPPED '{r['ANALISIS']}' "
                    f"(TEMA={r['TEMA'].strip()}, SUBTEMA={r['SUBTEMA'].strip()}) — no HEMATOLOGÍA row"
                )

    # ── Pass 3: build output records ────────────────────────────────────
    out_rows    = []
    slug_count: dict[str, int] = {}

    for row in selected:
        analisis  = row["ANALISIS"].strip()
        base_slug = slugify(analisis)
        occ       = slug_count.get(base_slug, 0)
        slug_count[base_slug] = occ + 1

        measure_id = ID_OVERRIDES.get((base_slug, occ), base_slug)

        record = {
            "MeasureId":    measure_id,
            "MeasureName":  analisis,
            "Unit":         row.get("UNIDAD DE MEDIDA", "").strip(),
            "LowRef":       clean_ref(row.get("LIMITE INFERIOR ", "")),
            "HighRef":      clean_ref(row.get("LIMITE SUPERIOR ", "")),
            "Topic":        row.get("TEMA",    "").strip(),
            "Subtopic":     row.get("SUBTEMA", "").strip(),
            "Explanation":  clean_text(row.get("EXPLICACION ",  "")),
            "Explanation2": clean_text(row.get("EXPLICACION2 ", "")),
        }

        if measure_id in MANUAL_OVERRIDES:
            record.update(MANUAL_OVERRIDES[measure_id])

        out_rows.append(record)

    # ── Write output ─────────────────────────────────────────────────────
    fieldnames = ["MeasureId","MeasureName","Unit","LowRef","HighRef",
                  "Topic","Subtopic","Explanation","Explanation2"]

    with DST.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=fieldnames, delimiter=";",
            quoting=csv.QUOTE_MINIMAL, quotechar='"', extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Done. {len(out_rows)} measures written to:\n  {DST}")
    if dropped_log:
        print(f"\nDropped {len(dropped_log)} duplicate(s) (HEMATOLOGÍA priority):")
        for line in dropped_log:
            print(line)


if __name__ == "__main__":
    convert()
