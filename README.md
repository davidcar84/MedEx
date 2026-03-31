# MedEx — Know Your Numbers, Track Your Health

**Your lab results, charted over time. Private, offline, and always in your hands.**

Import your data, see every measurement trend instantly — green when you're in range, red when you're not. Add new results in seconds, edit past entries inline, and export a professional PDF report with a single click.

A clean catalog keeps your reference ranges and medical explanations in one place. Powerful filters and a full cross-measure table let you review, validate, and correct your data without friction.

No account. No server. No data sharing. Just clarity.

---

## Live App

**[https://davidcar84.github.io/MedEx/](https://davidcar84.github.io/MedEx/)**

---

## How It Works

MedEx uses a simple two-file data model:

| File | Contents |
|---|---|
| `measures.csv` | Catalog — one row per test (name, unit, reference range, topic, explanation) |
| `observations.csv` | Results — one row per reading (measure ID, date, value) |

Both files are bundled into a single **ZIP** for import and export.

### CSV Format

**measures.csv** (semicolon-separated)
```
MeasureId;MeasureName;Unit;LowRef;HighRef;Topic;Subtopic;Explanation;Explanation2
glucose_fasting;Glucosa en Ayunas;mg/dL;70;100;Metabolismo;Carbohidratos;Mide el nivel de glucosa...;
```

**observations.csv** (semicolon-separated)
```
MeasureId;Date;Value
glucose_fasting;2025-03-15;92.5
```

Dates use ISO 8601 format (`YYYY-MM-DD`). Empty `LowRef` or `HighRef` means the threshold is one-sided.

---

## Features

- **Trend charts** — one per measure, colour-coded green/red against reference limits
- **Measures catalog** — create, edit, and delete measures with full metadata
- **Inline observation editing** — correct any past entry directly in the table
- **PDF export** — clickable table of contents, topic cover pages, one chart per page
- **Topic & subtopic filters** — focus on the panel that matters
- **PWA** — installable on desktop and mobile, works fully offline

---

## Data Preparation Scripts

Two Python scripts are included to convert existing data into the MedEx format:

```bash
python convert_mdm.py          # converts your measures master data
python convert_observations.py # converts your historical observations
```

---

## Tech Stack

Pure HTML / CSS / JavaScript — no build step, no backend, no framework.

| Library | Purpose |
|---|---|
| [Chart.js](https://www.chartjs.org/) | Charts |
| [PapaParse](https://www.papaparse.com/) | CSV parsing |
| [JSZip](https://stuk.github.io/jszip/) | ZIP import / export |
| [jsPDF](https://github.com/parallax/jsPDF) | PDF generation |

---

## Privacy

All data is processed entirely in the browser. No information is transmitted to any server at any point.

---

*Built with [Claude Code](https://claude.ai/code)*
