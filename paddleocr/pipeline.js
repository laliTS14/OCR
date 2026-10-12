// The whole-document extraction pipeline, shared by the web demo
// (server.js → /api/extract-selected) and the DB worker (worker.js), so
// both always produce identical output for the same file:
//
//   read (text layer per page, OCR only where needed)
//   → parseDocument (rules, every test, 28 report types + OTHER)
//   → LLM per-section fallback (engine auto/llm only)
//   → source check (mergeCategorized) → validate
const { readPages } = require('./pageReader');
const { ocrCacheDir, OCR_ENGINE } = require('./paddleText');
const { categorize } = require('./ollama');
const { validate } = require('./validate');
const { REPORT_TYPES } = require('./reportCatalog');
const { parseDocument } = require('./documentParser');
const { normalizeReadingText } = require('./textNormalize');
const { parseHeader } = require('./headerParser');

// Reading is PER PAGE (pageReader.js): pages with a usable text layer are
// read directly; only the rest go to PaddleOCR (paddle_text_service.py —
// RapidOCR by default, ~7.5 s/page on this CPU). OCR'd pages are cached in
// ./ocr-cache/<engine> (gitignored — patient data), so a re-upload never
// re-OCRs a page.
const OCR_CACHE_DIR = ocrCacheDir(__dirname); // ./ocr-cache/<OCR_ENGINE>

async function runTriageAndRead(fileBuffer, mimetype, originalname) {
  const timings = {};
  const t0 = Date.now();
  const read = await readPages(fileBuffer, mimetype, originalname, {
    cacheDir: OCR_CACHE_DIR,
    onProgress: (m) => console.log(`[read] ${originalname}: ${m}`),
  });
  timings.triageMs = 0;
  timings.readingMs = Date.now() - t0;
  const textPages = read.pages.filter((p) => p.source === 'text').length;
  const ocrPages = read.pages.filter((p) => p.source.startsWith('ocr')).length;
  const triageStage = {
    fileName: originalname,
    fileSizeKb: Math.round(fileBuffer.length / 1024),
    isDigital: ocrPages === 0,
    reason: `${read.totalPages} page(s): ${textPages} read from the text layer, ${ocrPages} via OCR` +
      (read.pages.some((p) => p.source === 'ocr-cached') ? ' (some from the OCR cache)' : ''),
    engine: ocrPages === 0
      ? 'Direct PDF text layer (free, no OCR call)'
      : `Per page: text layer where usable, OCR (${OCR_ENGINE}) for ${ocrPages} page(s) (self-hosted, CPU)`,
    pages: read.pages,
  };
  const ocrStage = {
    dump: read.fullText,
    pageCount: ocrPages,
    pageTimings: read.pages.filter((p) => p.seconds != null).map((p) => ({ pageNumber: p.page, elapsedSeconds: p.seconds })),
  };
  return { triageStage, ocrStage, ocrDump: read.fullText, timings };
}

// "4.8 4.2 - 6.5" in value with an empty range → value "4.8", range
// "4.2 - 6.5". The model sometimes leaves a row's range glued to its value
// (seen on HbA1c; same family as PROGRESS.md's "Oh 0.51 0.2-1.2" bug).
const VALUE_WITH_RANGE_RE = /^([<>]?\d+(?:\.\d+)?)\s+([<>]?\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?)$/;

// Source check: a value or patient field the model returned must literally
// appear in the text that call was given. Anything else is a hallucination
// (confirmed Sept 29: another patient's Reg No and Hb value, copied from
// prompt examples, appeared in a Redcliffe extraction) — it is blanked and
// flagged rather than passed through looking like a real result.
const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
function inSource(value, source) {
  const v = squash(value);
  return !v || source.includes(v);
}

// parts: [{ categorized, source }]. Patient fields come from whichever
// section's call returns them first (only one section is sent with the page
// header — see selectReports.js). Rows repeated verbatim (test + value)
// across reports are dropped — the model occasionally emits a stray second
// report echoing a row it already returned — and reports left empty by
// that are removed.
function mergeCategorized(parts) {
  const patient = {};
  const reports = [];
  const seen = new Set();
  const removed = [];
  for (const { categorized: p, source: rawSource } of parts) {
    const source = squash(rawSource);
    for (const [k, v] of Object.entries(p.patient || {})) {
      if (!v || !String(v).trim()) continue;
      // sex is normalized ("M" → "Male"): check the raw letter/word instead
      const present = k === 'sex'
        ? new RegExp(`\\b(${String(v)[0]}|${v})\\b`, 'i').test(rawSource || '')
        : inSource(v, source);
      if (!present) { removed.push({ field: `patient.${k}`, value: v }); continue; }
      if (!patient[k]) patient[k] = v;
    }
    for (const report of p.reports || []) {
      const rows = [];
      for (const row of report.rows || []) {
        const m = !String(row.range || '').trim() && String(row.value || '').trim().match(VALUE_WITH_RANGE_RE);
        let fixed = m ? { ...row, value: m[1], range: m[2] } : row;
        if (!inSource(fixed.value, source)) {
          removed.push({ field: `${report.report_type} / ${fixed.test}`, value: fixed.value });
          fixed = { ...fixed, value: '', source_check: 'value not found in source text — removed' };
        }
        const key = `${String(fixed.test || '').toLowerCase().replace(/\s+/g, ' ').trim()}|${String(fixed.value || '').trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(fixed);
      }
      if (rows.length) reports.push({ ...report, rows });
    }
  }
  return { categorized: { patient, reports }, removed };
}

// Runs the full pipeline on one file.
//   typeIds: report-type ids to keep ('ALL' = everything, incl. OTHER)
//   engine:  'rules' — rules only, no LLM (milliseconds after reading)
//            'auto'  — rules; LLM only for a recognized, selected report-type
//                      block the rules couldn't parse
//            'llm'   — one categorize() call per selected report-type block
//   txLog:   optional transactionLog to write each stage to
// Every output report carries type_id, page_numbers and method
// ('rules' / 'llm' / 'llm-fallback') next to the shared output contract.
async function extractDocument(fileBuffer, mimetype, originalname, { typeIds = ['ALL'], engine = 'auto', txLog = null } = {}) {
  const { triageStage, ocrStage, ocrDump, timings } = await runTriageAndRead(fileBuffer, mimetype, originalname);
  if (txLog) {
    txLog.writeJson('01_triage.json', { ...triageStage, timeMs: timings.triageMs });
    txLog.writeText('02_extracted_text.txt', ocrDump);
  }

  // ---- parse the WHOLE document (rules, no LLM) ----
  // Every test is extracted and labelled with a report type (or OTHER);
  // the selection only filters the output — see documentParser.js.
  const t2 = Date.now();
  const doc = parseDocument(ocrDump);
  timings.selectMs = Date.now() - t2;
  if (txLog) txLog.writeJson('02b_document_blocks.json', doc.blocks);
  const wantAll = typeIds.includes('ALL');
  const wanted = (id) => wantAll || typeIds.includes(id);
  const shownTypes = wantAll ? [...new Set(doc.reports.map((r) => r.typeId))] : typeIds;

  // ---- build the output ----
  const t3 = Date.now();
  const parts = [];
  const perSection = [];
  const header = parseHeader(doc.headerText);
  const meta = { lab_name: '', referring_doctor: header.meta.referring_doctor || '', sample_collected_date: header.meta.sample_collected_date || '', report_date: header.meta.report_date || '' };
  const source = `${doc.headerText}\n${normalizeReadingText(ocrDump)}`;
  if (engine !== 'llm') {
    parts.push({
      categorized: {
        patient: header.patient,
        reports: doc.reports.filter((r) => wanted(r.typeId)).map((r) => ({
          report_type: r.report_type, heading: r.headings.join(' / '), ...meta,
          type_id: r.typeId, page_numbers: r.pageNumbers, method: 'rules', rows: r.rows,
        })),
      },
      source,
    });
    shownTypes.forEach((id) => perSection.push({ typeId: id, method: 'rules', ms: timings.selectMs }));
  }
  const llmBlocks = doc.blocks.filter((b) => b.typeId && wanted(b.typeId)
    && (engine === 'llm' || (engine === 'auto' && b.needsFallback && b.rows.length === 0)));
  for (const b of llmBlocks) {
    const label = REPORT_TYPES.find((t) => t.id === b.typeId).label;
    const input = `${doc.headerText}\n\n${b.text}`;
    const ts = Date.now();
    const categorized = await categorize(input, { sectionLabel: label });
    const method = engine === 'llm' ? 'llm' : 'llm-fallback';
    for (const r of categorized.reports || []) Object.assign(r, { type_id: b.typeId, page_numbers: b.pageNumbers, method });
    const ps = perSection.find((p) => p.typeId === b.typeId);
    if (ps) Object.assign(ps, { method, ms: Date.now() - ts, tokenUsage: categorized.tokenUsage || null });
    else perSection.push({ typeId: b.typeId, method, ms: Date.now() - ts, tokenUsage: categorized.tokenUsage || null });
    parts.push({ categorized, source: input });
    if (txLog) txLog.writeJson(`03_llm_${b.typeId}_p${b.pageNumbers[0]}.json`, categorized);
  }
  timings.categorizeMs = Date.now() - t3;
  timings.perSection = perSection;
  const { categorized, removed } = mergeCategorized(parts);
  if (removed.length) console.log(`[source-check] removed ${removed.length} value(s) not present in the source text:`, JSON.stringify(removed));

  // ---- validation (deterministic code, not AI) ----
  const t4 = Date.now();
  const validated = validate(categorized);
  timings.validateMs = Date.now() - t4;
  if (txLog) txLog.writeJson('04_validated.json', validated);

  return { triageStage, ocrStage, ocrDump, doc, shownTypes, categorized, removed, validated, timings };
}

module.exports = { runTriageAndRead, mergeCategorized, extractDocument };
