# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A client-side PWA for tracking personal medical lab results over time. No build step, no backend, no framework — pure HTML/CSS/JS deployed on GitHub Pages.

Live: https://davidcar84.github.io/MedEx/

## Architecture

Single-page app with three tabs (Gráficas, Catálogo, Añadir Resultado). All state lives in a global `DB` object in `app.js`:

```js
DB = {
  measures:     [],   // catalog: { id, name, unit, lowRef, highRef, topic, subtopic, explanation, explanation2 }
  observations: [],   // results:  { measureId, date, value }
  charts:       {}    // Chart.js instances keyed by measureId
}
```

Data persists via ZIP import/export (two semicolon-delimited CSVs: `measures.csv` + `observations.csv`). No localStorage, no IndexedDB.

## Key Files

- `app.js` — all application logic (~1400 lines). Sections: STATE → HELPERS → IMPORT → EXPORT ZIP → EXPORT PDF → FILTERS → CHART RENDERING → CATALOG → OBSERVATIONS → EVENT WIRING
- `index.html` — shell with tab structure and modal for measure editing
- `styles.css` — CSS custom properties (`--green`, `--red`, `--primary`); notable classes: `.chart-wrapper` (height: 290px), `.obs-inline-input`, `.all-obs-container`
- `sw.js` — cache-first for app shell, network-first for CDN resources

## Important Implementation Details

**Charts**: Chart.js 4.x with `devicePixelRatio: 3` set at creation time (not at export time — changing it at export breaks aspect ratio). Export computes `imgH = imgW * (canvas.height / canvas.width)`.

**PDF export**: Two-pass page numbering — `countTocPages()` simulates TOC layout to count pages, then `topicPageMap` and `chartPageMap` are pre-assigned before rendering begins. jsPDF has no named destinations.

**Inline observation editing**: Composite key `measureId|date|value` URL-encoded for safe use in `onclick` attributes; `CSS.escape()` used for `data-key` selectors.

**CSV column order**: `CSV_MEASURES` and `CSV_OBS` arrays define exact column order for export. Semicolon delimiter throughout.

**Dates**: ISO 8601 (`YYYY-MM-DD`) in storage; `formatDate()` converts to `DD/MM/YYYY` for display.

## Deploying

```bash
git push origin main
```

GitHub Pages serves from `main` branch root. No build required.

## Data Files

`measures.csv`, `observations.csv`, and `*.zip` are gitignored — never commit personal health data.
