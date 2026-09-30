require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { readPages } = require('./pageReader');
const { categorize } = require('./ollama');
const { validate } = require('./validate');
const { createTransactionLog } = require('./transactionLog');
const { identifyReports, getTextForSection } = require('./sections');
const { REPORT_TYPES, OTHER_TYPE } = require('./reportCatalog');
const { parseDocument } = require('./documentParser');
const { normalizeReadingText } = require('./textNormalize');
const { parseHeader } = require('./headerParser');

const PORT = process.env.PORT || 8792;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB — same cap as the other OCR POCs, keeps a fair comparison

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// Backs the "select a report, then categorize only that one" flow (see
// sections.js/PROGRESS.md). Keyed by a per-upload session id so the
// categorize step doesn't have to re-run triage+reading — the expensive
// part — just to categorize one already-identified section. In-memory only,
// fine for this POC's single-process/single-user scope; a real deployment
// would need a shared store or to skip the two-step flow for a stateless API.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

// Shared by every flow. Reading is PER PAGE (pageReader.js): pages with a
// usable text layer are read directly; only the rest go to PaddleOCR
// (paddle_text_service.py, ~30 s/page on this CPU). OCR'd pages are cached in ./ocr-cache
// (gitignored — patient data), so a re-upload never re-OCRs a page.
const OCR_CACHE_DIR = path.join(__dirname, 'ocr-cache');

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
      : `Per page: text layer where usable, PaddleOCR for ${ocrPages} page(s) (self-hosted, CPU, ~30 s/page)`,
    pages: read.pages,
  };
  const ocrStage = {
    dump: read.fullText,
    pageCount: ocrPages,
    pageTimings: read.pages.filter((p) => p.seconds != null).map((p) => ({ pageNumber: p.page, elapsedSeconds: p.seconds })),
  };
  return { triageStage, ocrStage, ocrDump: read.fullText, timings };
}

app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return res.status(400).json({ error: `Unsupported file type "${req.file.mimetype}". Use PDF, JPG, or PNG.` });
  }

  // Every stage's real output is collected here and returned to the
  // client as-is, so the UI can show what actually happened at each step
  // instead of a simulated version of it. Same shape as ../paddleocr's
  // and ../deepseek-ocr's.
  const stages = {};
  const txLog = createTransactionLog(req.file.originalname);
  const categorizeModel = process.env.CATEGORIZE_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b';
  let timings = {};
  const t0 = Date.now();

  try {
    // ---- Stages 1-2: triage + reading (shared with /api/identify-reports) ----
    const { triageStage, ocrStage, ocrDump, timings: rtTimings } =
      await runTriageAndRead(req.file.buffer, req.file.mimetype, req.file.originalname);
    stages.triage = triageStage;
    stages.ocr = ocrStage;
    timings = rtTimings;
    txLog.writeJson('01_triage.json', { ...stages.triage, timeMs: timings.triageMs });
    txLog.writeText('02_extracted_text.txt', ocrDump);

    // ---- Stage 3: Categorization (local LLM) ----
    const t2 = Date.now();
    const categorized = await categorize(ocrDump);
    timings.categorizeMs = Date.now() - t2;
    stages.categorized = categorized;
    txLog.writeJson('03_categorized.json', categorized);

    // ---- Stage 4: Validation (deterministic code, not AI) ----
    const t3 = Date.now();
    const validated = validate(categorized);
    timings.validateMs = Date.now() - t3;
    stages.validated = validated;
    txLog.writeJson('04_validated.json', validated);

    const fullResponse = { fileName: req.file.originalname, llmModel: categorizeModel, stages, data: validated };
    txLog.writeJson('00_summary.json', {
      fileName: req.file.originalname,
      fileSizeKb: stages.triage.fileSizeKb,
      isDigital: stages.triage.isDigital,
      categorizeModel,
      timings,
      totalMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
    txLog.writeJson('05_full_response.json', fullResponse);
    console.log(`[transaction] ${req.file.originalname} → ${txLog.dir}`);

    res.json(fullResponse);
  } catch (err) {
    console.error('Extraction failed:', err.message, err.details ? JSON.stringify(err.details) : '');
    txLog.writeJson('ERROR.json', {
      message: err.message,
      status: err.status || 500,
      details: err.details || null,
      stagesCompleted: Object.keys(stages),
      timings,
    });
    console.log(`[transaction] ${req.file.originalname} FAILED → ${txLog.dir}`);
    res.status(err.status || 500).json({ error: err.message, stages });
  }
});

// ---- Selective-categorization flow: identify → pick → categorize just that one ----
// See sections.js's file header. Splits the reading stage's output into
// pages and asks Ollama a cheap per-page question to list report names,
// instead of sending the whole document into one categorize() call — this
// sidesteps the context-window truncation bug without a slower num_ctx bump.
app.post('/api/identify-reports', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return res.status(400).json({ error: `Unsupported file type "${req.file.mimetype}". Use PDF, JPG, or PNG.` });
  }

  const stages = {};
  const txLog = createTransactionLog(`${req.file.originalname}_identify`);

  try {
    const { triageStage, ocrStage, ocrDump, timings } =
      await runTriageAndRead(req.file.buffer, req.file.mimetype, req.file.originalname);
    stages.triage = triageStage;
    stages.ocr = ocrStage;
    txLog.writeJson('01_triage.json', { ...stages.triage, timeMs: timings.triageMs });
    txLog.writeText('02_extracted_text.txt', ocrDump);

    const t2 = Date.now();
    const { pages, sections, perPage } = await identifyReports(ocrDump);
    timings.identifyMs = Date.now() - t2;
    txLog.writeJson('02b_identified_sections.json', { sections, perPage });

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      fileName: req.file.originalname,
      pages,
      sections,
      createdAt: Date.now(),
    });

    res.json({ sessionId, fileName: req.file.originalname, stages, sections, timings });
  } catch (err) {
    console.error('Identify-reports failed:', err.message, err.details ? JSON.stringify(err.details) : '');
    txLog.writeJson('ERROR.json', { message: err.message, status: err.status || 500, details: err.details || null });
    res.status(err.status || 500).json({ error: err.message, stages });
  }
});

app.post('/api/categorize-report', async (req, res) => {
  const { sessionId, sectionId } = req.body || {};
  if (!sessionId || !sectionId) {
    return res.status(400).json({ error: 'sessionId and sectionId are required.' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(410).json({ error: 'This session has expired (or the server restarted) — please re-upload the file.' });
  }
  const section = session.sections.find((s) => s.id === sectionId);
  if (!section) {
    return res.status(404).json({ error: `Unknown section "${sectionId}" for this file.` });
  }

  const txLog = createTransactionLog(`${session.fileName}_${section.id}`);
  const categorizeModel = process.env.CATEGORIZE_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b';
  const timings = {};

  try {
    const sectionText = getTextForSection(session.pages, section);
    txLog.writeText('02c_section_text.txt', sectionText);

    const t0 = Date.now();
    const categorized = await categorize(sectionText);
    timings.categorizeMs = Date.now() - t0;
    txLog.writeJson('03_categorized.json', categorized);

    const t1 = Date.now();
    const validated = validate(categorized);
    timings.validateMs = Date.now() - t1;
    txLog.writeJson('04_validated.json', validated);

    const fullResponse = {
      fileName: session.fileName,
      section: { id: section.id, name: section.name },
      llmModel: categorizeModel,
      stages: { categorized, validated },
      data: validated,
      timings,
    };
    txLog.writeJson('05_full_response.json', fullResponse);
    console.log(`[transaction] ${session.fileName} (${section.name}) → ${txLog.dir}`);

    res.json(fullResponse);
  } catch (err) {
    console.error('Categorize-report failed:', err.message, err.details ? JSON.stringify(err.details) : '');
    txLog.writeJson('ERROR.json', { message: err.message, status: err.status || 500, details: err.details || null, timings });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- "Select first" flow: user picks report types BEFORE upload is processed ----
// See selectReports.js's file header. No per-page LLM identify pass at all:
// the selected types' sections are cut out of the text by plain heading
// matching (milliseconds), and each found section gets its own small
// categorize() call. Types not present in the file come back found:false
// instead of being guessed at.
app.get('/api/report-types', (req, res) => {
  res.json([...REPORT_TYPES, OTHER_TYPE].map((t) => ({ id: t.id, label: t.label })));
});

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

app.post('/api/extract-selected', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return res.status(400).json({ error: `Unsupported file type "${req.file.mimetype}". Use PDF, JPG, or PNG.` });
  }
  let typeIds;
  try {
    typeIds = JSON.parse(req.body.reportTypes || '[]');
  } catch {
    typeIds = String(req.body.reportTypes || '').split(',');
  }
  const known = new Set([...REPORT_TYPES.map((t) => t.id), 'OTHER', 'ALL']);
  typeIds = [...new Set(typeIds.map((s) => String(s).trim()).filter((s) => known.has(s)))];
  if (!typeIds.length) {
    return res.status(400).json({ error: 'Select at least one report type.' });
  }
  const engine = ['auto', 'rules', 'llm'].includes(req.body.engine) ? req.body.engine : 'auto';

  const stages = {};
  const txLog = createTransactionLog(`${req.file.originalname}_selected`);
  const categorizeModel = process.env.CATEGORIZE_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b';
  let timings = {};
  const t0 = Date.now();

  try {
    const { triageStage, ocrStage, ocrDump, timings: rtTimings } =
      await runTriageAndRead(req.file.buffer, req.file.mimetype, req.file.originalname);
    stages.triage = triageStage;
    stages.ocr = ocrStage;
    timings = rtTimings;
    txLog.writeJson('01_triage.json', { ...stages.triage, timeMs: timings.triageMs });
    txLog.writeText('02_extracted_text.txt', ocrDump);

    // ---- Stage 3: parse the WHOLE document (rules, no LLM) ----
    // Every test is extracted and labelled with a report type (or OTHER);
    // the user's selection only filters the output — see documentParser.js.
    const t2 = Date.now();
    const doc = parseDocument(ocrDump);
    timings.selectMs = Date.now() - t2;
    const wantAll = typeIds.includes('ALL');
    const wanted = (id) => wantAll || typeIds.includes(id);
    const shownTypes = wantAll ? [...new Set(doc.reports.map((r) => r.typeId))] : typeIds;
    stages.selection = shownTypes.map((id) => {
      const reports = doc.reports.filter((r) => r.typeId === id);
      const blocks = doc.blocks.filter((b) => b.typeId === id);
      const type = id === 'OTHER' ? OTHER_TYPE : REPORT_TYPES.find((t) => t.id === id);
      const rows = reports.reduce((a, r) => a + r.rows.length, 0);
      return {
        typeId: id, label: type ? type.label : id, found: rows > 0 || blocks.length > 0, rows,
        heading: [...new Set([...reports.flatMap((r) => r.headings), ...blocks.map((b) => b.heading)])].filter(Boolean).join(' / '),
        pageNumbers: [...new Set([...reports.flatMap((r) => r.pageNumbers), ...blocks.flatMap((b) => b.pageNumbers)])].sort((a, b) => a - b),
        lineCount: blocks.reduce((a, b) => a + b.text.split('\n').length, 0),
        text: blocks.map((b) => b.text).join('\n\n'),
        hasHeader: false,
      };
    });
    txLog.writeJson('02b_document_blocks.json', doc.blocks);
    // page classes: lab | mer | other | no_text (only lab pages are parsed)
    stages.pages = doc.pageTypes.map(({ page, type }) => ({ page, type }));

    // ---- Stage 4: build the output ----
    // engine=rules: rules only (no LLM, milliseconds).
    // engine=auto (default): rules; the LLM runs only for a block with a
    //   recognized, selected report-type heading that the rules couldn't parse.
    // engine=llm: one categorize() call per selected report-type block.
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
          reports: doc.reports.filter((r) => wanted(r.typeId)).map((r) => ({ report_type: r.report_type, heading: r.headings.join(' / '), ...meta, rows: r.rows })),
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
      const ps = perSection.find((p) => p.typeId === b.typeId);
      if (ps) Object.assign(ps, { method, ms: Date.now() - ts, tokenUsage: categorized.tokenUsage || null });
      else perSection.push({ typeId: b.typeId, method, ms: Date.now() - ts, tokenUsage: categorized.tokenUsage || null });
      parts.push({ categorized, source: input });
      txLog.writeJson(`03_llm_${b.typeId}_p${b.pageNumbers[0]}.json`, categorized);
    }
    timings.categorizeMs = Date.now() - t3;
    timings.perSection = perSection;
    const { categorized, removed } = mergeCategorized(parts);
    stages.categorized = categorized;
    stages.sourceCheck = { removed };
    if (removed.length) console.log(`[source-check] removed ${removed.length} value(s) not present in the source text:`, JSON.stringify(removed));

    // ---- Stage 5: Validation (deterministic code, not AI) ----
    const t4 = Date.now();
    const validated = validate(categorized);
    timings.validateMs = Date.now() - t4;
    stages.validated = validated;
    txLog.writeJson('04_validated.json', validated);

    const fullResponse = { fileName: req.file.originalname, llmModel: categorizeModel, engine, selected: typeIds, stages, data: validated, timings };
    txLog.writeJson('00_summary.json', {
      fileName: req.file.originalname,
      selected: typeIds,
      found: stages.selection.filter((s) => s.found).map((s) => s.typeId),
      categorizeModel,
      timings,
      totalMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
    txLog.writeJson('05_full_response.json', fullResponse);
    console.log(`[transaction] ${req.file.originalname} [${typeIds.join(',')}] → ${txLog.dir}`);

    res.json(fullResponse);
  } catch (err) {
    console.error('Extract-selected failed:', err.message, err.details ? JSON.stringify(err.details) : '');
    txLog.writeJson('ERROR.json', { message: err.message, status: err.status || 500, details: err.details || null, stagesCompleted: Object.keys(stages), timings });
    res.status(err.status || 500).json({ error: err.message, stages });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `File is too large — max ${MAX_BYTES / (1024 * 1024)}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  const paddleUrl = process.env.PADDLE_TEXT_URL || 'http://localhost:8794';
  console.log(`PIMS PaddleOCR + rules OCR demo running at http://localhost:${PORT}  (main flow: /select.html)`);
  console.log(`PaddleOCR text service expected at ${paddleUrl} — run "python paddle_text_service.py" separately (see README.md); only pages without a usable text layer are OCR'd, ~30 s/page`);
  console.log(`Ollama: ${process.env.OLLAMA_URL || 'http://localhost:11434'}  categorize=${process.env.CATEGORIZE_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b'}`);
});
