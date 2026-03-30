"""
convert_observations.py
Converts ExamenesLaboratorio_DataPrepObservations.csv → observations.csv (MedEx format)

Source columns (comma-separated):
  NombreMedida, Fecha, Valor, Tema, Subtema,
  ReferenciaBaja, ReferenciaAlta, UnidadDeMedida, Explicacion

Target columns (semicolon-separated):
  MeasureId;Date;Value

MeasureId is resolved by:
  1. Slugifying NombreMedida (same algorithm used in convert_mdm.py)
  2. For measures that exist in both HEMATOLOGÍA and another panel,
     HEMATOLOGÍA is the canonical ID — Tema column in the observation
     is used to pick the right one when ambiguous.
  3. LDL is disambiguated by ReferenciaBaja: 70 → ldl_optimo, else → ldl
"""

import csv
import re
import unicodedata
import sys
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────
SRC_OBS = Path(r"C:\Users\David\OneDrive\Documents\David\David-DocumentosP\Salud\ExamenesYDiagnosticos\ExamenesLaboratorio_DataPrepObservations.csv")
DST     = Path(r"C:\Users\David\Claude-MedEx\observations.csv")

# ── Helpers (must match convert_mdm.py exactly) ──────────────────
def slugify(text: str) -> str:
    t = text.strip().lower()
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[\s\-/\(\)\.\,\:]+", "_", t)
    t = re.sub(r"[^a-z0-9_]", "", t)
    t = re.sub(r"_+", "_", t).strip("_")
    return t


def clean_value(val: str) -> str:
    """Strip whitespace; return as-is (numeric string)."""
    return val.strip()


# ── Resolution rules ─────────────────────────────────────────────
# For slugs that had multiple MDM entries, map (slug, tema_upper) → MeasureId.
# HEMATOLOGÍA wins: its slug is the canonical one.
# Ionograma duplicates were dropped from the catalog — all obs map to the
# HEMATOLOGÍA id regardless of which panel the observation recorded.
SLUG_TEMA_TO_ID: dict[tuple[str, str], str] = {
    # CALCIO: ionograma entry dropped from catalog; all observations → 'calcio' (HEMATOLOGÍA id)
    ("calcio", "HEMATOLOGÍA"):      "calcio",
    ("calcio", "CARDIOMETABÓLICA"): "calcio",
    # CLORO EN SANGRE: same — ionograma dropped; all observations → 'cloro_en_sangre'
    ("cloro_en_sangre", "HEMATOLOGÍA"):      "cloro_en_sangre",
    ("cloro_en_sangre", "CARDIOMETABÓLICA"): "cloro_en_sangre",
}

def resolve_id(slug: str, tema: str, ref_baja: str) -> str:
    """Return the canonical MeasureId for a given observation row."""

    # LDL: two intentional catalog entries — distinguish by reference
    if slug == "colesterol_baja_densidad_ldl":
        try:
            return "ldl_optimo" if float(ref_baja) == 70.0 else "ldl"
        except (ValueError, TypeError):
            return "ldl"

    # Tema-based disambiguation
    key = (slug, tema.strip().upper())
    if key in SLUG_TEMA_TO_ID:
        return SLUG_TEMA_TO_ID[key]

    # Default: slug is already the MeasureId
    return slug


# ── Main conversion ──────────────────────────────────────────────
def convert():
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = SRC_OBS.read_text(encoding=encoding)
            break
        except (UnicodeDecodeError, FileNotFoundError) as e:
            if isinstance(e, FileNotFoundError):
                print(f"ERROR: Source file not found:\n  {SRC_OBS}")
                sys.exit(1)
            continue
    else:
        print("ERROR: Could not decode source file.")
        sys.exit(1)

    reader = csv.DictReader(
        text.splitlines(),
        delimiter=",",
        quotechar='"',
        skipinitialspace=True,
    )

    out_rows      = []
    unmapped      = {}   # slug → NombreMedida (for unknown IDs report)

    for row in reader:
        nombre = row.get("NombreMedida", "").strip()
        fecha  = row.get("Fecha",        "").strip()
        valor  = clean_value(row.get("Valor", ""))
        tema   = row.get("Tema",          "")
        ref_lo = row.get("ReferenciaBaja","")

        if not nombre or not fecha or valor == "":
            continue   # skip blank rows

        slug       = slugify(nombre)
        measure_id = resolve_id(slug, tema, ref_lo)

        out_rows.append({
            "MeasureId": measure_id,
            "Date":      fecha,
            "Value":     valor,
        })

    # ── Write output ─────────────────────────────────────────────
    with DST.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["MeasureId", "Date", "Value"],
            delimiter=";",
            quoting=csv.QUOTE_MINIMAL,
            quotechar='"',
        )
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Done. {len(out_rows)} observations written to:\n  {DST}")

    # ── Summary ──────────────────────────────────────────────────
    from collections import Counter
    id_counts = Counter(r["MeasureId"] for r in out_rows)
    print(f"\nTop 10 measures by observation count:")
    for mid, cnt in id_counts.most_common(10):
        print(f"  {cnt:3d}  {mid}")

    # Show unique MeasureIds in observations
    print(f"\nTotal unique MeasureIds in observations: {len(id_counts)}")


if __name__ == "__main__":
    convert()
