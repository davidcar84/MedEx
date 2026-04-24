'use strict';

// ================================================================
//  MEDEX — Medical Exam Tracker  |  app.js
// ================================================================

// ----------------------------------------------------------------
//  STATE
// ----------------------------------------------------------------
const DB = {
  measures:     [],   // [{ id, name, unit, lowRef, highRef, topic, subtopic, explanation, explanation2 }]
  observations: [],   // [{ measureId, date, value }]
  charts:       {}    // { measureId: Chart instance }
};

// CSV column order (semicolon-separated)
const CSV_MEASURES = ['MeasureId','MeasureName','Unit','LowRef','HighRef','Topic','Subtopic','Explanation','Explanation2'];
const CSV_OBS      = ['MeasureId','Date','Value'];

// ----------------------------------------------------------------
//  PURE HELPERS
// ----------------------------------------------------------------
const $  = id => document.getElementById(id);

const getMeasure = id => DB.measures.find(m => m.id === id);

const getObs = id =>
  DB.observations
    .filter(o => o.measureId === id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

function isInRange(value, lowRef, highRef) {
  const v  = parseFloat(value);
  if (isNaN(v)) return true;
  const lo = parseFloat(lowRef);
  const hi = parseFloat(highRef);
  if (!isNaN(lo) && v < lo) return false;
  if (!isNaN(hi) && v > hi) return false;
  return true;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function slugify(text) {
  return text.trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// ----------------------------------------------------------------
//  IMPORT  (ZIP → two CSVs)
// ----------------------------------------------------------------
async function importZip(file) {
  try {
    const zip   = await JSZip.loadAsync(file);
    const mFile = zip.file('measures.csv');
    const oFile = zip.file('observations.csv');

    if (!mFile || !oFile) {
      showToast('El ZIP debe contener measures.csv y observations.csv', 'error');
      return;
    }

    const parseCsv = async f => {
      const text = await f.async('text');
      return Papa.parse(text, {
        header: true, delimiter: ';',
        skipEmptyLines: true,
        transformHeader: h => h.trim()
      }).data;
    };

    const mRows = await parseCsv(mFile);
    const oRows = await parseCsv(oFile);

    DB.measures = mRows
      .map(r => ({
        id:          (r.MeasureId   || '').trim(),
        name:        (r.MeasureName || '').trim(),
        unit:        (r.Unit        || '').trim(),
        lowRef:      (r.LowRef      || '').trim(),
        highRef:     (r.HighRef     || '').trim(),
        topic:       (r.Topic       || '').trim(),
        subtopic:    (r.Subtopic    || '').trim(),
        explanation:  (r.Explanation  || '').trim(),
        explanation2: (r.Explanation2 || '').trim()
      }))
      .filter(m => m.id && m.name);

    DB.observations = oRows
      .map(r => ({
        measureId: (r.MeasureId || '').trim(),
        date:      (r.Date      || '').trim(),
        value:     (r.Value     || '').trim()
      }))
      .filter(o => o.measureId && o.date && o.value !== '');

    renderAll();
    showToast(
      `Importado: ${DB.measures.length} medidas, ${DB.observations.length} observaciones`
    );
  } catch (err) {
    console.error(err);
    showToast('Error al importar el archivo ZIP', 'error');
  }
}

// ----------------------------------------------------------------
//  EXPORT  (two CSVs → ZIP)
// ----------------------------------------------------------------
async function exportZip() {
  const zip = new JSZip();

  zip.file('measures.csv', Papa.unparse(
    DB.measures.map(m => ({
      MeasureId:   m.id,
      MeasureName: m.name,
      Unit:        m.unit,
      LowRef:      m.lowRef,
      HighRef:     m.highRef,
      Topic:       m.topic,
      Subtopic:    m.subtopic,
      Explanation:  m.explanation,
      Explanation2: m.explanation2
    })),
    { delimiter: ';', columns: CSV_MEASURES }
  ));

  zip.file('observations.csv', Papa.unparse(
    DB.observations.map(o => ({
      MeasureId: o.measureId,
      Date:      o.date,
      Value:     o.value
    })),
    { delimiter: ';', columns: CSV_OBS }
  ));

  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `MedEx_${today()}.zip`);
  showToast('ZIP exportado correctamente');
}

function today() { return new Date().toISOString().slice(0, 10); }

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------
//  PDF EXPORT
// ----------------------------------------------------------------
async function exportPDF() {
  const measures = getFilteredMeasures().filter(m => DB.charts[m.id]);
  if (!measures.length) {
    showToast('No hay gráficas para exportar', 'error');
    return;
  }

  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  showTab('charts');
  await new Promise(r => setTimeout(r, 150));

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const W   = pdf.internal.pageSize.getWidth();
  const H   = pdf.internal.pageSize.getHeight();
  const PAD = 10;

  // ── Step 1: group by topic (preserves insertion order) ──────────
  const topicGroups = {};
  measures.forEach(m => {
    const t = m.topic || 'Sin tema';
    if (!topicGroups[t]) topicGroups[t] = [];
    topicGroups[t].push(m);
  });
  const topicEntries = Object.entries(topicGroups);

  // ── Step 2: simulate TOC layout to count how many pages it needs ─
  // Must mirror the exact same y-advance logic used when rendering.
  //   Topic header block : 6.5 mm  (tocY += 1.5 + 5)
  //   Entry no subtopic  : 6.0 mm  (tocY += 6)
  //   Entry with subtopic: 10.5 mm (tocY += 4.5 + 6)
  //   Topic gap          : 3.0 mm  (tocY += 3)
  //   Overflow threshold for topic header : H - 20
  //   Overflow threshold for entry        : H - 16
  function countTocPages() {
    let y = 38, pages = 1;
    for (const [, tms] of topicEntries) {
      if (y > H - 20) { pages++; y = 20; }
      y += 6.5;
      for (const m of tms) {
        if (y > H - 16) { pages++; y = 20; }
        y += m.subtopic ? 10.5 : 6;
      }
      y += 3;
    }
    return pages;
  }
  const tocPageCount = countTocPages();

  // ── Step 3: assign every page number before rendering anything ──
  // Layout: TOC (1..tocPageCount) → for each topic: 1 cover + N charts
  let pg = tocPageCount;
  const topicPageMap  = {};   // topic  → page number
  const chartPageMap  = {};   // id     → page number
  for (const [topic, tms] of topicEntries) {
    topicPageMap[topic] = ++pg;
    tms.forEach(m => { chartPageMap[m.id] = ++pg; });
  }
  const totalPages = pg;

  // ── Helpers ──────────────────────────────────────────────────────
  const drawFooter = (n) => {
    pdf.setFontSize(7);
    pdf.setTextColor(189, 189, 189);
    pdf.setFont('helvetica', 'normal');
    pdf.text(
      `MedEx — ${new Date().toLocaleDateString('es-ES')} — Pág. ${n} / ${totalPages}`,
      W / 2, H - 6, { align: 'center' }
    );
  };

  const drawBackLink = (targetPage) => {
    const label = '← Volver al índice';
    pdf.setFontSize(7.5);
    pdf.setTextColor(21, 101, 192);
    pdf.setFont('helvetica', 'normal');
    pdf.text(label, PAD, H - 12);
    pdf.link(PAD, H - 17, pdf.getTextWidth(label) + 2, 7, { pageNumber: targetPage });
    pdf.setDrawColor(21, 101, 192);
    pdf.setLineWidth(0.15);
    pdf.line(PAD, H - 11.2, PAD + pdf.getTextWidth(label), H - 11.2);
  };

  // Returns actual box height drawn
  const drawTextBox = (label, text, x, y, boxW) => {
    const lines = pdf.splitTextToSize(text, boxW - 10);
    const boxH  = lines.length * 4.8 + 14;
    pdf.setFillColor(227, 242, 253);
    pdf.setDrawColor(187, 222, 251);
    pdf.roundedRect(x, y, boxW, boxH, 3, 3, 'FD');
    pdf.setFontSize(7);
    pdf.setTextColor(21, 101, 192);
    pdf.setFont('helvetica', 'bold');
    pdf.text(label, x + 5, y + 6);
    pdf.setFontSize(8.5);
    pdf.setTextColor(33, 33, 33);
    pdf.setFont('helvetica', 'normal');
    pdf.text(lines, x + 5, y + 12);
    return boxH;
  };

  // ════════════════════════════════════════════════════════════════
  //  TOC  (pages 1 … tocPageCount)
  // ════════════════════════════════════════════════════════════════
  let tocPageNum = 1;

  pdf.setFontSize(18);
  pdf.setTextColor(21, 101, 192);
  pdf.setFont('helvetica', 'bold');
  pdf.text('MedEx — Índice de Resultados', W / 2, 20, { align: 'center' });

  pdf.setFontSize(8.5);
  pdf.setTextColor(117, 117, 117);
  pdf.setFont('helvetica', 'normal');
  pdf.text(
    `Generado el ${new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })}`,
    W / 2, 27, { align: 'center' }
  );
  pdf.setDrawColor(187, 222, 251);
  pdf.setLineWidth(0.5);
  pdf.line(PAD, 31, W - PAD, 31);

  let tocY       = 38;
  const colRight = W - PAD;

  for (const [topic, tms] of topicEntries) {
    // ── Topic group header ──
    if (tocY > H - 20) {
      drawFooter(tocPageNum++);
      pdf.addPage();
      tocY = 20;
    }
    // Topic label — also a link to the topic cover page
    pdf.setFontSize(9);
    pdf.setTextColor(21, 101, 192);
    pdf.setFont('helvetica', 'bold');
    pdf.text(topic, PAD, tocY);
    const topicLabelW = pdf.getTextWidth(topic);
    pdf.link(PAD, tocY - 5, topicLabelW + 2, 6.5, { pageNumber: topicPageMap[topic] });
    pdf.setDrawColor(21, 101, 192);
    pdf.setLineWidth(0.3);
    tocY += 1.5;
    pdf.line(PAD, tocY, W - PAD, tocY);
    tocY += 5;

    // ── Measure entries ──
    for (const m of tms) {
      if (tocY > H - 16) {
        drawFooter(tocPageNum++);
        pdf.addPage();
        tocY = 20;
      }

      const targetPage = chartPageMap[m.id];
      const pageLabel  = String(targetPage);

      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(33, 33, 33);
      pdf.text(m.name, PAD + 3, tocY);
      pdf.text(pageLabel, colRight, tocY, { align: 'right' });

      // Dotted leader
      const nameW    = pdf.getTextWidth(m.name);
      const numW     = pdf.getTextWidth(pageLabel);
      const dotStart = PAD + 3 + nameW + 2;
      const dotEnd   = colRight - numW - 2;
      pdf.setFontSize(7);
      pdf.setTextColor(189, 189, 189);
      for (let dx = dotStart; dx < dotEnd - 2; dx += 2.2) pdf.text('.', dx, tocY);

      // Underline + clickable link
      pdf.setDrawColor(21, 101, 192);
      pdf.setLineWidth(0.15);
      pdf.line(PAD + 3, tocY + 0.8, PAD + 3 + nameW, tocY + 0.8);
      pdf.link(PAD, tocY - 5, W - PAD * 2, 6.5, { pageNumber: targetPage });

      if (m.subtopic) {
        tocY += 4.5;
        pdf.setFontSize(7.5);
        pdf.setTextColor(117, 117, 117);
        pdf.text(m.subtopic, PAD + 3, tocY);
      }
      tocY += 6;
    }
    tocY += 3;
  }
  drawFooter(tocPageNum);

  // ════════════════════════════════════════════════════════════════
  //  TOPIC COVER PAGES + CHART PAGES
  // ════════════════════════════════════════════════════════════════
  for (const [topic, tms] of topicEntries) {

    // ── Topic cover ──────────────────────────────────────────────
    pdf.addPage();
    const topicPage = topicPageMap[topic];

    // Blue header band
    pdf.setFillColor(21, 101, 192);
    pdf.rect(0, 0, W, 70, 'F');

    // Topic name (white, centred in band)
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    const topicLines = pdf.splitTextToSize(topic, W - 30);
    const topicFontSz = topicLines.length > 1 ? 20 : 26;
    pdf.setFontSize(topicFontSz);
    const topicBlockH = topicLines.length * (topicFontSz * 0.3528 * 1.3);
    pdf.text(topicLines, W / 2, 35 - topicBlockH / 2 + topicFontSz * 0.3528, { align: 'center' });

    // Measure count badge
    pdf.setFontSize(9);
    pdf.setTextColor(179, 214, 255);
    pdf.text(`${tms.length} medida${tms.length !== 1 ? 's' : ''}`, W / 2, 62, { align: 'center' });

    // List of measures in this topic (below band)
    let listY = 82;
    const subtopicGroups = {};
    tms.forEach(m => {
      const s = m.subtopic || '';
      if (!subtopicGroups[s]) subtopicGroups[s] = [];
      subtopicGroups[s].push(m);
    });

    for (const [sub, sms] of Object.entries(subtopicGroups)) {
      if (sub) {
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(21, 101, 192);
        pdf.text(sub, PAD, listY);
        listY += 5;
        pdf.setDrawColor(187, 222, 251);
        pdf.setLineWidth(0.2);
        pdf.line(PAD, listY, W - PAD, listY);
        listY += 4;
      }
      for (const m of sms) {
        if (listY > H - 20) break;   // guard
        const cp = chartPageMap[m.id];
        pdf.setFontSize(8.5);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(33, 33, 33);
        pdf.text(m.name, PAD + 3, listY);
        pdf.setTextColor(117, 117, 117);
        pdf.text(`p. ${cp}`, W - PAD, listY, { align: 'right' });
        pdf.link(PAD, listY - 5, W - PAD * 2, 6, { pageNumber: cp });
        listY += 6.5;
      }
      listY += 2;
    }

    drawBackLink(1);
    drawFooter(topicPage);

    // ── Chart pages ──────────────────────────────────────────────
    for (const m of tms) {
      pdf.addPage();
      const chartPage = chartPageMap[m.id];

      // Title
      pdf.setFontSize(14);
      pdf.setTextColor(21, 101, 192);
      pdf.setFont('helvetica', 'bold');
      pdf.text(m.name, W / 2, 14, { align: 'center' });

      // Breadcrumb
      const crumb = [m.topic, m.subtopic].filter(Boolean).join(' › ');
      let cy = 19;
      if (crumb) {
        pdf.setFontSize(8);
        pdf.setTextColor(117, 117, 117);
        pdf.setFont('helvetica', 'normal');
        pdf.text(crumb, W / 2, cy, { align: 'center' });
        cy += 5;
      }

      // Chart image — preserve exact canvas aspect ratio (canvas is 3× DPR)
      const chart   = DB.charts[m.id];
      const canvas  = chart.canvas;
      const imgData = chart.toBase64Image('image/png', 1);
      const imgW    = W - PAD * 2;
      const imgH    = imgW * (canvas.height / canvas.width);

      pdf.addImage(imgData, 'PNG', PAD, cy, imgW, imgH, undefined, 'NONE');
      cy += imgH + 4;

      // Explanation boxes
      if (m.explanation) {
        cy += drawTextBox('EXPLICACIÓN', m.explanation, PAD, cy, W - PAD * 2) + 4;
      }
      if (m.explanation2) {
        drawTextBox('MÁS INFORMACIÓN', m.explanation2, PAD, cy, W - PAD * 2);
      }

      // Back links: index (p.1) and topic cover
      drawBackLink(1);
      const topicLabel = `← ${topic}`;
      const tlW = pdf.getTextWidth(topicLabel);
      pdf.setFontSize(7.5);
      pdf.setTextColor(21, 101, 192);
      pdf.setFont('helvetica', 'normal');
      pdf.text(topicLabel, W - PAD - tlW, H - 12);
      pdf.link(W - PAD - tlW - 1, H - 17, tlW + 2, 7, { pageNumber: topicPage });
      pdf.setDrawColor(21, 101, 192);
      pdf.setLineWidth(0.15);
      pdf.line(W - PAD - tlW, H - 11.2, W - PAD, H - 11.2);

      drawFooter(chartPage);
    }
  }

  pdf.save(`MedEx_${today()}.pdf`);
  if (prevTab && prevTab !== 'charts') showTab(prevTab);
  showToast('PDF generado correctamente');
}

// ----------------------------------------------------------------
//  FILTERS
// ----------------------------------------------------------------
function getFilteredMeasures() {
  const topic    = $('filter-topic').value;
  const subtopic = $('filter-subtopic').value;
  const recent   = $('filter-recent').value;

  let base = DB.measures.filter(m =>
    (!topic    || m.topic    === topic) &&
    (!subtopic || m.subtopic === subtopic)
  );

  if (recent === 'last10') {
    const top10ids = getTop10MeasureIds();
    base = base.filter(m => top10ids.has(m.id));
  } else if (recent === '3m' || recent === '6m' || recent === '12m') {
    const months  = recent === '3m' ? 3 : recent === '6m' ? 6 : 12;
    const cutoff  = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const active  = new Set(DB.observations.filter(o => o.date >= cutoffStr).map(o => o.measureId));
    base = base.filter(m => active.has(m.id));
  }

  return base;
}

function getTop10MeasureIds() {
  const sorted = [...DB.observations].sort((a, b) => b.date.localeCompare(a.date));
  const seen   = new Set();
  for (const o of sorted) {
    if (seen.size >= 10) break;
    seen.add(o.measureId);
  }
  return seen;
}

function updateFilters() {
  const topicSel    = $('filter-topic');
  const subtopicSel = $('filter-subtopic');
  const curTopic    = topicSel.value;
  const curSub      = subtopicSel.value;

  const topics = [...new Set(DB.measures.map(m => m.topic).filter(Boolean))].sort();
  topicSel.innerHTML = '<option value="">Todos los temas</option>';
  topics.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    if (t === curTopic) o.selected = true;
    topicSel.appendChild(o);
  });

  const subs = [...new Set(
    DB.measures
      .filter(m => !curTopic || m.topic === curTopic)
      .map(m => m.subtopic).filter(Boolean)
  )].sort();
  subtopicSel.innerHTML = '<option value="">Todos los subtemas</option>';
  subs.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    if (s === curSub) o.selected = true;
    subtopicSel.appendChild(o);
  });
}

// ----------------------------------------------------------------
//  CHART RENDERING
// ----------------------------------------------------------------
function destroyChart(id) {
  if (DB.charts[id]) { DB.charts[id].destroy(); delete DB.charts[id]; }
}

function destroyAllCharts() {
  Object.keys(DB.charts).forEach(destroyChart);
}

function renderAllCharts() {
  destroyAllCharts();
  const grid     = $('charts-grid');
  grid.innerHTML = '';
  const measures = getFilteredMeasures();

  if (DB.measures.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#128202;</div>
        <p>No hay datos cargados.</p>
        <p>Importa un archivo ZIP o crea medidas desde el <strong>Cat&#225;logo</strong>.</p>
        <button onclick="loadDemoData()" class="btn btn-outline" style="margin-top:18px">
          Cargar Datos de Ejemplo
        </button>
      </div>`;
    $('charts-count').textContent = '';
    return;
  }

  if (measures.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p>Ninguna medida coincide con el filtro.</p></div>`;
    $('charts-count').textContent = '';
    return;
  }

  const withData = measures.filter(m => getObs(m.id).length > 0).length;
  $('charts-count').textContent = `${withData} de ${measures.length} con datos`;

  measures.forEach(m => {
    const card     = document.createElement('div');
    card.className = 'chart-card';
    card.id        = `card-${m.id}`;

    const canvasId = `chart-${m.id}`;
    card.innerHTML = `
      <div class="chart-wrapper" id="wrap-${m.id}">
        <canvas id="${canvasId}"></canvas>
      </div>
      ${(m.explanation || m.explanation2) ? `
        <div class="explanation-box">
          ${m.explanation  ? `<strong>Explicaci&#243;n</strong>${escHtml(m.explanation)}`  : ''}
          ${m.explanation2 ? `<strong>M&#225;s informaci&#243;n</strong>${escHtml(m.explanation2)}` : ''}
        </div>` : ''}`;
    grid.appendChild(card);

    buildChart(m, canvasId);
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildChart(measure, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const obs = getObs(measure.id);

  if (obs.length === 0) {
    const wrap  = document.getElementById(`wrap-${measure.id}`);
    if (wrap) { wrap.innerHTML = '<div class="no-data-msg">Sin datos a&#250;n</div>'; }
    return;
  }

  const lowRef  = measure.lowRef  !== '' ? parseFloat(measure.lowRef)  : null;
  const highRef = measure.highRef !== '' ? parseFloat(measure.highRef) : null;

  const data   = obs.map(o => ({ x: o.date, y: parseFloat(o.value) }));
  const colors = obs.map(o =>
    isInRange(o.value, measure.lowRef, measure.highRef) ? '#2e7d32' : '#c62828'
  );

  // Y-axis padding
  const allVals = [
    ...data.map(d => d.y),
    ...(lowRef  !== null ? [lowRef]  : []),
    ...(highRef !== null ? [highRef] : [])
  ].filter(v => !isNaN(v));
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const pad  = (maxV - minV) * 0.25 || Math.abs(maxV) * 0.15 || 1;

  // Reference line annotations
  const annotations = {};
  if (lowRef !== null) {
    annotations.lowLine = {
      type: 'line', yMin: lowRef, yMax: lowRef,
      borderColor: '#ef6c00', borderWidth: 1.5, borderDash: [5, 4],
      label: {
        content: `Mín: ${lowRef}`, display: true, position: 'start',
        backgroundColor: 'rgba(239,108,0,0.1)', color: '#ef6c00',
        font: { size: 10, weight: '600' }, padding: { x: 5, y: 2 }
      }
    };
  }
  if (highRef !== null) {
    annotations.highLine = {
      type: 'line', yMin: highRef, yMax: highRef,
      borderColor: '#ef6c00', borderWidth: 1.5, borderDash: [5, 4],
      label: {
        content: `Máx: ${highRef}`, display: true, position: 'end',
        backgroundColor: 'rgba(239,108,0,0.1)', color: '#ef6c00',
        font: { size: 10, weight: '600' }, padding: { x: 5, y: 2 }
      }
    };
  }

  DB.charts[measure.id] = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        data,
        pointBackgroundColor: colors,
        pointBorderColor:     colors,
        pointBorderWidth:     2,
        pointRadius:          7,
        pointHoverRadius:     9,
        borderColor:          '#9e9e9e',
        borderDash:           [6, 5],
        borderWidth:          2,
        tension:              0,
        fill:                 false
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      devicePixelRatio:    3,
      layout: { padding: { bottom: 24, top: 8, left: 4, right: 8 } },
      scales: {
        x: {
          type: 'time',
          time: {
            parser: 'yyyy-MM-dd',
            displayFormats: {
              day:   'dd/MM',
              week:  'dd/MM',
              month: 'MM/yy',
              year:  'yyyy'
            },
            tooltipFormat: 'dd/MM/yyyy'
          },
          ticks:  { maxTicksLimit: 7, font: { size: 11 } },
          grid:   { color: '#f0f0f0' },
          title:  { display: false }
        },
        y: {
          min: minV - pad,
          max: maxV + pad,
          title: {
            display: !!(measure.unit),
            text:    measure.unit || '',
            font:    { size: 11 },
            color:   '#757575'
          },
          ticks: { font: { size: 11 } },
          grid:  { color: '#f0f0f0' }
        }
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text:    measure.name,
          font:    { size: 14, weight: '600' },
          color:   '#1565c0',
          padding: { bottom: 6, top: 2 }
        },
        tooltip: {
          callbacks: {
            label: ctx =>
              `${ctx.parsed.y}${measure.unit ? ' ' + measure.unit : ''}`
          }
        },
        datalabels: {
          display: true,
          anchor:  'center',
          align:   'bottom',
          offset:  10,
          formatter: val => val.y,
          font:    { size: 10, weight: '700' },
          color:   ctx => {
            const d = ctx.dataset.data[ctx.dataIndex];
            return isInRange(d.y, measure.lowRef, measure.highRef)
              ? '#2e7d32' : '#c62828';
          }
        },
        annotation: { annotations }
      }
    }
  });
}

// ----------------------------------------------------------------
//  CATALOG
// ----------------------------------------------------------------
function renderCatalog() {
  const container = $('catalog-container');

  if (DB.measures.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#128203;</div>
        <p>El cat&#225;logo est&#225; vac&#237;o. A&#241;ade tu primera medida.</p>
      </div>`;
    return;
  }

  const rows = DB.measures.map(m => {
    const count    = getObs(m.id).length;
    const refText  = [
      m.lowRef  !== '' ? `Mín: ${m.lowRef}`  : null,
      m.highRef !== '' ? `Máx: ${m.highRef}` : null
    ].filter(Boolean).join(' / ') || '—';

    return `
      <tr>
        <td>
          <div style="font-weight:600">${escHtml(m.name)}</div>
          <span class="measure-id-chip">${escHtml(m.id)}</span>
        </td>
        <td>${escHtml(m.unit) || '—'}</td>
        <td class="ref-text">${refText}</td>
        <td>
          ${m.topic    ? `<span class="badge badge-blue">${escHtml(m.topic)}</span>` : ''}
          ${m.subtopic ? `<span class="badge badge-green">${escHtml(m.subtopic)}</span>` : ''}
          ${(!m.topic && !m.subtopic) ? '—' : ''}
        </td>
        <td style="text-align:center">
          <span class="badge badge-grey">${count}</span>
        </td>
        <td>
          <div class="actions-cell">
            <button class="btn-icon edit"
              onclick="showMeasureModal('${m.id}')">Editar</button>
            <button class="btn-icon delete"
              onclick="confirmDeleteMeasure('${m.id}')">Borrar</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="catalog-table-wrapper">
      <table class="catalog-table">
        <thead>
          <tr>
            <th>Nombre / ID</th>
            <th>Unidad</th>
            <th>Referencia</th>
            <th>Tema / Subtema</th>
            <th>Obs.</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---- Modal: open ----
function showMeasureModal(id = null) {
  const isEdit = id !== null;
  $('modal-title').textContent = isEdit ? 'Editar Medida' : 'Nueva Medida';

  if (isEdit) {
    const m = getMeasure(id);
    $('m-id').value          = m.id;
    $('m-id').disabled       = true;        // ID is the primary key — immutable
    $('m-name').value        = m.name;
    $('m-unit').value        = m.unit;
    $('m-low').value         = m.lowRef;
    $('m-high').value        = m.highRef;
    $('m-topic').value       = m.topic;
    $('m-subtopic').value    = m.subtopic;
    $('m-explanation').value  = m.explanation;
    $('m-explanation2').value = m.explanation2;
  } else {
    ['m-id','m-name','m-unit','m-low','m-high','m-topic','m-subtopic','m-explanation','m-explanation2']
      .forEach(fid => { $(fid).value = ''; });
    $('m-id').disabled = false;
  }

  $('btn-save-modal').dataset.editId = isEdit ? id : '';
  $('modal-measure').classList.remove('hidden');
  setTimeout(() => $('m-name').focus(), 50);
}

// ---- Modal: close ----
function closeMeasureModal() {
  $('modal-measure').classList.add('hidden');
}

// ---- Modal: save ----
function saveMeasureFromModal() {
  const editId = $('btn-save-modal').dataset.editId || null;
  const rawId  = $('m-id').value.trim();
  const id     = editId || slugify(rawId) || slugify($('m-name').value);
  const name   = $('m-name').value.trim();
  const unit   = $('m-unit').value.trim();

  if (!id)   { showToast('El ID de medida es obligatorio', 'error'); return; }
  if (!name) { showToast('El nombre es obligatorio', 'error'); return; }
  if (!unit) { showToast('La unidad es obligatoria', 'error'); return; }

  if (!editId && getMeasure(id)) {
    showToast(`Ya existe una medida con ID "${id}"`, 'error'); return;
  }

  const measure = {
    id,
    name,
    unit,
    lowRef:      $('m-low').value.trim(),
    highRef:     $('m-high').value.trim(),
    topic:       $('m-topic').value.trim(),
    subtopic:    $('m-subtopic').value.trim(),
    explanation:  $('m-explanation').value.trim(),
    explanation2: $('m-explanation2').value.trim()
  };

  if (editId) {
    const idx = DB.measures.findIndex(m => m.id === editId);
    DB.measures[idx] = measure;
  } else {
    DB.measures.push(measure);
  }

  closeMeasureModal();
  renderAll();
  showToast(editId ? 'Medida actualizada' : 'Medida creada');
}

// ---- Delete measure (+ its observations) ----
function confirmDeleteMeasure(id) {
  const m     = getMeasure(id);
  const count = getObs(id).length;
  const msg   = count > 0
    ? `¿Borrar "${m.name}" y sus ${count} observaciones? Esta acción no se puede deshacer.`
    : `¿Borrar la medida "${m.name}"?`;

  if (!confirm(msg)) return;

  DB.measures     = DB.measures.filter(x => x.id !== id);
  DB.observations = DB.observations.filter(o => o.measureId !== id);
  destroyChart(id);
  renderAll();
  showToast('Medida eliminada');
}

// ----------------------------------------------------------------
//  OBSERVATIONS
// ----------------------------------------------------------------
function renderObsForm() {
  const sel     = $('obs-measure');
  const current = sel.value;
  sel.innerHTML = '<option value="">— Selecciona una medida —</option>';
  DB.measures.forEach(m => {
    const o = document.createElement('option');
    o.value       = m.id;
    o.textContent = m.name;
    if (m.id === current) o.selected = true;
    sel.appendChild(o);
  });
  // Re-trigger preview if a measure was already selected
  if (current) showMeasurePreview(current);

  // Always refresh the all-observations table
  renderAllObsTable();
}

// ----------------------------------------------------------------
//  ALL-OBSERVATIONS TABLE  (cross-measure, shown in Añadir tab)
// ----------------------------------------------------------------
function renderAllObsTable() {
  const container = $('all-obs-container');
  if (DB.observations.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  // Populate topic filter once (preserve current selection)
  const topicSel = $('all-obs-topic-filter');
  const curTopic = topicSel.value;
  const topics   = [...new Set(DB.measures.map(m => m.topic).filter(Boolean))].sort();
  topicSel.innerHTML = '<option value="">Todos los temas</option>';
  topics.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    if (t === curTopic) o.selected = true;
    topicSel.appendChild(o);
  });

  _filterAndRenderAllObs();
}

function _filterAndRenderAllObs() {
  const search = ($('all-obs-search').value || '').toLowerCase().trim();
  const topic  = $('all-obs-topic-filter').value;
  const sort   = $('all-obs-sort').value;

  // Build flat list enriched with measure metadata
  let rows = DB.observations
    .map(o => {
      const m = getMeasure(o.measureId);
      if (!m) return null;
      if (topic  && m.topic !== topic)                         return null;
      if (search && !m.name.toLowerCase().includes(search))   return null;
      return { o, m };
    })
    .filter(Boolean);

  if (sort === 'date-desc') rows.sort((a, b) => b.o.date.localeCompare(a.o.date));
  else if (sort === 'date-asc')  rows.sort((a, b) => a.o.date.localeCompare(b.o.date));
  else if (sort === 'name-asc')  rows.sort((a, b) => a.m.name.localeCompare(b.m.name));

  $('all-obs-count').textContent = `${rows.length} resultado${rows.length !== 1 ? 's' : ''}`;

  const tbody = $('all-obs-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="all-obs-empty">Sin resultados para el filtro aplicado.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(({ o, m }) => {
    const inRange  = isInRange(o.value, m.lowRef, m.highRef);
    const valClass = inRange ? 'val-in' : 'val-out';
    const refText  = [
      m.lowRef  ? `≥ ${m.lowRef}`  : null,
      m.highRef ? `≤ ${m.highRef}` : null
    ].filter(Boolean).join(' — ') || '—';
    const dKey = encodeURIComponent(`${o.measureId}|${o.date}|${o.value}`);

    return `<tr data-key="${dKey}">
      <td>
        <span class="measure-name"
          onclick="selectMeasureInForm('${escHtml(o.measureId)}')"
          title="Seleccionar en el formulario">${escHtml(m.name)}</span>
        <div class="measure-id-chip">${escHtml(m.id)}</div>
      </td>
      <td><span class="badge badge-blue">${escHtml(m.topic || '—')}</span></td>
      <td class="obs-cell-date" style="white-space:nowrap">${formatDate(o.date)}</td>
      <td class="obs-cell-value ${valClass}" style="white-space:nowrap">${escHtml(o.value)} ${escHtml(m.unit)}</td>
      <td class="ref-cell">${refText}</td>
      <td class="actions-cell" style="gap:4px">
        <button class="btn-icon edit"
          onclick="startEditObs('${dKey}')"
          title="Editar">✎</button>
        <button class="obs-delete"
          onclick="deleteObsByKeyAndRefresh('${dKey}')"
          title="Eliminar observación">&#10005;</button>
      </td>
    </tr>`;
  }).join('');
}

// Select a measure in the dropdown and show its preview
function selectMeasureInForm(measureId) {
  const sel = $('obs-measure');
  sel.value = measureId;
  showMeasurePreview(measureId);
  $('obs-value').focus();
  // Scroll to the form
  sel.closest('.add-form-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Delete and refresh the full table (used from all-obs table)
function deleteObsByKeyAndRefresh(encodedKey) {
  const [measureId, date, value] = decodeURIComponent(encodedKey).split('|');
  DB.observations = DB.observations.filter(
    o => !(o.measureId === measureId && o.date === date && o.value === value)
  );
  refreshChartForMeasure(measureId);
  _filterAndRenderAllObs();
  if ($('obs-measure').value === measureId) showRecentObs(measureId);
  showToast('Observación eliminada');
}

// ── Inline edit ───────────────────────────────────────────────────
function startEditObs(encodedKey) {
  const [measureId, date, value] = decodeURIComponent(encodedKey).split('|');
  const m   = getMeasure(measureId);
  const row = document.querySelector(`tr[data-key="${CSS.escape(encodedKey)}"]`);
  if (!row || !m) return;

  // Replace date and value cells with inputs; replace action cell with Save/Cancel
  row.querySelector('.obs-cell-date').innerHTML =
    `<input type="date" class="obs-inline-input" id="edit-date-input" value="${date}" style="width:130px">`;

  row.querySelector('.obs-cell-value').innerHTML =
    `<input type="number" class="obs-inline-input" id="edit-value-input"
      value="${value}" step="any" style="width:80px"> ${escHtml(m.unit)}`;

  row.querySelector('.actions-cell').innerHTML = `
    <button class="btn-icon edit"
      onclick="saveEditObs('${encodedKey}')"
      title="Guardar">&#10003;</button>
    <button class="btn-icon" style="color:var(--text-muted);border-color:var(--border)"
      onclick="_filterAndRenderAllObs()"
      title="Cancelar">&#10005;</button>`;

  row.querySelector('#edit-value-input').focus();
  row.querySelector('#edit-value-input').select();

  // Save on Enter, cancel on Escape
  row.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveEditObs(encodedKey); }
    if (e.key === 'Escape') { e.preventDefault(); _filterAndRenderAllObs(); }
  }, { once: false, capture: false });
}

function saveEditObs(encodedKey) {
  const [measureId, oldDate, oldValue] = decodeURIComponent(encodedKey).split('|');
  const newDate  = ($('edit-date-input')?.value  || '').trim();
  const newValue = ($('edit-value-input')?.value || '').trim();

  if (!newDate)                            { showToast('La fecha es obligatoria', 'error'); return; }
  if (newValue === '' || isNaN(+newValue)) { showToast('Introduce un valor numérico', 'error'); return; }

  // Check for duplicate on the new date (different from the original)
  if (newDate !== oldDate) {
    const dup = DB.observations.find(
      o => o.measureId === measureId && o.date === newDate
    );
    if (dup) {
      const m = getMeasure(measureId);
      if (!confirm(`Ya existe un valor para "${m.name}" en ${formatDate(newDate)}. ¿Sobreescribir?`)) return;
      DB.observations = DB.observations.filter(
        o => !(o.measureId === measureId && o.date === newDate)
      );
    }
  }

  // Update the observation in-place
  const obs = DB.observations.find(
    o => o.measureId === measureId && o.date === oldDate && o.value === oldValue
  );
  if (obs) {
    obs.date  = newDate;
    obs.value = newValue;
  }

  refreshChartForMeasure(measureId);
  _filterAndRenderAllObs();
  if ($('obs-measure').value === measureId) showRecentObs(measureId);
  showToast('Observación actualizada');
}

function showMeasurePreview(id) {
  const preview   = $('measure-preview');
  const recentBox = $('recent-obs-container');

  if (!id) {
    preview.classList.add('hidden');
    recentBox.classList.add('hidden');
    return;
  }

  const m = getMeasure(id);
  if (!m) return;

  const refs = [
    m.lowRef  !== '' ? `Mín: ${m.lowRef}`  : null,
    m.highRef !== '' ? `Máx: ${m.highRef}` : null
  ].filter(Boolean).join(' — ') || 'Sin referencia definida';

  preview.classList.remove('hidden');
  preview.innerHTML = `
    <div class="preview-row">
      <div class="preview-item">
        <span class="preview-label">Unidad</span>
        <span class="preview-value">${escHtml(m.unit) || '—'}</span>
      </div>
      <div class="preview-item">
        <span class="preview-label">Referencia</span>
        <span class="preview-value">${refs}</span>
      </div>
      ${m.topic ? `
      <div class="preview-item">
        <span class="preview-label">Tema</span>
        <span class="preview-value">${escHtml([m.topic, m.subtopic].filter(Boolean).join(' › '))}</span>
      </div>` : ''}
    </div>
    ${m.explanation  ? `<div class="preview-explanation">${escHtml(m.explanation)}</div>`  : ''}
    ${m.explanation2 ? `<div class="preview-explanation" style="margin-top:6px;border-top:1px solid #b2dfdb;padding-top:8px">${escHtml(m.explanation2)}</div>` : ''}`;

  showRecentObs(id);
}

function showRecentObs(id) {
  const container = $('recent-obs-container');
  const list      = $('recent-obs-list');
  const m         = getMeasure(id);
  const obs       = getObs(id).slice().reverse().slice(0, 10);

  if (obs.length === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  list.innerHTML = obs.map(o => {
    const ok = isInRange(o.value, m.lowRef, m.highRef);
    // Encode the delete key safely
    const dKey = encodeURIComponent(`${o.measureId}|${o.date}|${o.value}`);
    return `
      <div class="obs-item">
        <div class="obs-dot ${ok ? 'in-range' : 'out-range'}"></div>
        <span class="obs-date">${formatDate(o.date)}</span>
        <span class="obs-value">${escHtml(o.value)}${m.unit ? ' ' + escHtml(m.unit) : ''}</span>
        <button class="obs-delete" onclick="deleteObsByKey('${dKey}')" title="Eliminar">&#10005;</button>
      </div>`;
  }).join('');
}

function saveObservation() {
  const measureId = $('obs-measure').value;
  const date      = $('obs-date').value;
  const value     = $('obs-value').value.trim();

  if (!measureId) { showToast('Selecciona una medida', 'error'); return; }
  if (!date)      { showToast('Introduce la fecha', 'error'); return; }
  if (value === '' || isNaN(parseFloat(value))) {
    showToast('Introduce un valor numérico', 'error'); return;
  }

  // Check duplicate (same measure + same date)
  const dupIdx = DB.observations.findIndex(
    o => o.measureId === measureId && o.date === date
  );
  if (dupIdx !== -1) {
    const m = getMeasure(measureId);
    if (!confirm(`Ya existe un valor para "${m.name}" en ${formatDate(date)}. ¿Sobreescribir?`)) return;
    DB.observations.splice(dupIdx, 1);
  }

  DB.observations.push({ measureId, date, value });

  // Refresh only this chart, or full grid if it's the first data point
  refreshChartForMeasure(measureId);

  $('obs-value').value = '';
  showMeasurePreview(measureId);
  showToast('Resultado guardado');
}

// Delete by encoded composite key (measureId|date|value)
function deleteObsByKey(encodedKey) {
  const [measureId, date, value] = decodeURIComponent(encodedKey).split('|');
  DB.observations = DB.observations.filter(
    o => !(o.measureId === measureId && o.date === date && o.value === value)
  );
  refreshChartForMeasure(measureId);
  showRecentObs(measureId);
  showToast('Observación eliminada');
}

// Re-render only one chart card
function refreshChartForMeasure(measureId) {
  const canvasId = `chart-${measureId}`;
  const canvas   = document.getElementById(canvasId);
  const wrap     = document.getElementById(`wrap-${measureId}`);

  if (wrap) {
    // Card already exists — rebuild it
    destroyChart(measureId);

    // Restore canvas if it was replaced by no-data msg
    if (!canvas) {
      wrap.innerHTML = `<canvas id="${canvasId}"></canvas>`;
    }
    buildChart(getMeasure(measureId), canvasId);
  } else {
    // Card doesn't exist yet (first observation for this measure)
    renderAllCharts();
  }

  // Update count
  const measures  = getFilteredMeasures();
  const withData  = measures.filter(m => getObs(m.id).length > 0).length;
  $('charts-count').textContent =
    DB.measures.length ? `${withData} de ${measures.length} con datos` : '';
}

// ----------------------------------------------------------------
//  RENDER ALL (called after any data change)
// ----------------------------------------------------------------
function renderAll() {
  updateFilters();
  renderAllCharts();
  renderCatalog();
  renderObsForm();
}

// ----------------------------------------------------------------
//  UI HELPERS
// ----------------------------------------------------------------
function showTab(tabId) {
  document.querySelectorAll('.tab-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-pane')
    .forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));
}

let _toastTimer = null;
function showToast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = `toast ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ----------------------------------------------------------------
//  DEMO DATA
// ----------------------------------------------------------------
function loadDemoData() {
  DB.measures = [
    {
      id: 'glucosa_ayunas', name: 'Glucosa en Ayunas',
      unit: 'mg/dL', lowRef: '70', highRef: '100',
      topic: 'Metabolismo', subtopic: 'Carbohidratos',
      explanation: 'Mide el nivel de glucosa en sangre tras un ayuno mínimo de 8 horas. ' +
        'Valores entre 100-125 mg/dL indican prediabetes; ≥126 mg/dL pueden indicar diabetes. ' +
        'Valores normales: 70-100 mg/dL.'
    },
    {
      id: 'colesterol_total', name: 'Colesterol Total',
      unit: 'mg/dL', lowRef: '', highRef: '200',
      topic: 'Lípidos', subtopic: 'Colesterol',
      explanation: 'Suma de LDL, HDL y VLDL. Niveles elevados incrementan el riesgo cardiovascular. ' +
        'Deseable: <200 mg/dL. Límite alto: 200-239 mg/dL. Alto: ≥240 mg/dL.'
    },
    {
      id: 'trigliceridos', name: 'Triglicéridos',
      unit: 'mg/dL', lowRef: '', highRef: '150',
      topic: 'Lípidos', subtopic: 'Triglicéridos',
      explanation: 'Tipo de grasa en sangre relacionado con la dieta y el ejercicio. ' +
        'Normal: <150 mg/dL. Límite: 150-199 mg/dL. Alto: 200-499 mg/dL. Muy alto: ≥500 mg/dL.'
    },
    {
      id: 'hemoglobina', name: 'Hemoglobina',
      unit: 'g/dL', lowRef: '13.5', highRef: '17.5',
      topic: 'Hematología', subtopic: 'Serie Roja',
      explanation: 'Proteína de los glóbulos rojos que transporta oxígeno. ' +
        'Valores bajos pueden indicar anemia. Rango normal en hombres: 13.5-17.5 g/dL; ' +
        'en mujeres: 12.0-15.5 g/dL.'
    },
    {
      id: 'creatinina', name: 'Creatinina',
      unit: 'mg/dL', lowRef: '0.7', highRef: '1.2',
      topic: 'Función Renal', subtopic: 'Filtrado',
      explanation: 'Producto de desecho del metabolismo muscular eliminado por los riñones. ' +
        'Niveles elevados pueden indicar insuficiencia renal. Normal: 0.7-1.2 mg/dL en hombres.'
    }
  ];

  DB.observations = [
    { measureId: 'glucosa_ayunas',   date: '2024-03-10', value: '88'  },
    { measureId: 'glucosa_ayunas',   date: '2024-09-15', value: '95'  },
    { measureId: 'glucosa_ayunas',   date: '2025-03-20', value: '104' },
    { measureId: 'colesterol_total', date: '2024-03-10', value: '195' },
    { measureId: 'colesterol_total', date: '2024-09-15', value: '210' },
    { measureId: 'colesterol_total', date: '2025-03-20', value: '198' },
    { measureId: 'trigliceridos',    date: '2024-03-10', value: '130' },
    { measureId: 'trigliceridos',    date: '2024-09-15', value: '165' },
    { measureId: 'trigliceridos',    date: '2025-03-20', value: '142' },
    { measureId: 'hemoglobina',      date: '2024-03-10', value: '14.8' },
    { measureId: 'hemoglobina',      date: '2025-03-20', value: '13.1' },
    { measureId: 'creatinina',       date: '2024-03-10', value: '0.9' },
    { measureId: 'creatinina',       date: '2024-09-15', value: '1.1' },
    { measureId: 'creatinina',       date: '2025-03-20', value: '1.3' }
  ];

  renderAll();
  showToast('Datos de ejemplo cargados', 'info');
}

// ----------------------------------------------------------------
//  EVENT BINDING
// ----------------------------------------------------------------
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => showTab(btn.dataset.tab))
  );

  // Import
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => {
    if (e.target.files[0]) importZip(e.target.files[0]);
    e.target.value = '';
  });

  // Export ZIP
  $('btn-export-zip').addEventListener('click', () => {
    if (!DB.measures.length) { showToast('No hay datos para exportar', 'error'); return; }
    exportZip();
  });

  // Export PDF
  $('btn-export-pdf').addEventListener('click', () => {
    if (!DB.measures.length) { showToast('No hay datos para exportar', 'error'); return; }
    exportPDF();
  });

  // Filters
  $('filter-topic').addEventListener('change', () => {
    $('filter-subtopic').value = '';
    updateFilters();
    renderAllCharts();
  });
  $('filter-subtopic').addEventListener('change', renderAllCharts);
  $('filter-recent').addEventListener('change', renderAllCharts);

  // Catalog
  $('btn-new-measure').addEventListener('click', () => showMeasureModal(null));

  // Modal
  $('btn-save-modal').addEventListener('click', saveMeasureFromModal);
  $('btn-cancel-modal').addEventListener('click', closeMeasureModal);
  $('btn-close-modal').addEventListener('click', closeMeasureModal);
  $('modal-overlay').addEventListener('click', closeMeasureModal);

  // Auto-generate ID from name (new measures only)
  $('m-name').addEventListener('input', () => {
    if (!$('m-id').disabled) $('m-id').value = slugify($('m-name').value);
  });

  // Add observation
  $('obs-measure').addEventListener('change', e => showMeasurePreview(e.target.value));
  $('btn-save-obs').addEventListener('click', saveObservation);
  $('obs-value').addEventListener('keydown', e => { if (e.key === 'Enter') saveObservation(); });

  // All-observations table filters
  $('all-obs-search').addEventListener('input',  _filterAndRenderAllObs);
  $('all-obs-topic-filter').addEventListener('change', _filterAndRenderAllObs);
  $('all-obs-sort').addEventListener('change',   _filterAndRenderAllObs);

  // Close modal with Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMeasureModal();
  });
}

// ----------------------------------------------------------------
//  INIT
// ----------------------------------------------------------------
function init() {
  // Register Chart.js datalabels plugin globally
  Chart.register(ChartDataLabels);

  bindEvents();

  // Default date = today
  $('obs-date').value = today();

  // Show empty state
  renderAll();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  }
}

document.addEventListener('DOMContentLoaded', init);
