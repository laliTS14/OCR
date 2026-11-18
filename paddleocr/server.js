require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { getEngine, primaryName, ocrConfig, doubleOcrFor } = require('./ocrEngines');
const { extractWithOcrEngines } = require('./doubleOcr');
const { categorize } = require('./ollama');
const { validate } = require('./validate');
const { createTransactionLog } = require('./transactionLog');
const { identifyReports, getTextForSection } = require('./sections');
const { REPORT_TYPES, OTHER_TYPE } = require('./reportCatalog');
const reviewStore = require('./reviewStore');
const { runTriageAndRead } = require('./pipeline');

const PORT = process.env.PORT || 8792;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB — same cap as the other OCR POCs, keeps a fair comparison

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

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
  // doubleOcr=1: also read the scanned pages with Tesseract, for comparison
  // (doubleOcr.js; returned separately as stages.tesseract, never merged) —
  // only when OCR_DOUBLE_ENABLED allows it.
  const secondEngine = doubleOcrFor(/^(1|true|on)$/i.test(String(req.body.doubleOcr || '')));

  const stages = {};
  const txLog = createTransactionLog(`${req.file.originalname}_selected`);
  const categorizeModel = process.env.CATEGORIZE_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b';
  let timings = {};
  const t0 = Date.now();

  try {
    // Read → whole-document rules parse → LLM fallback (engine) → source
    // check → validate: pipeline.js, shared with the DB worker (worker.js).
    // engine=rules: rules only (no LLM, milliseconds).
    // engine=auto (default): rules; the LLM runs only for a block with a
    //   recognized, selected report-type heading that the rules couldn't parse.
    // engine=llm: one categorize() call per selected report-type block.
    const result = await extractWithOcrEngines(req.file.buffer, req.file.mimetype, req.file.originalname, { primaryEngine: primaryName(), secondEngine, typeIds, engine, txLog });
    const { doc, shownTypes, categorized, removed, validated, ocrDump } = result;
    timings = result.timings;
    stages.triage = result.triageStage;
    stages.ocr = result.ocrStage;
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
    // page classes: lab | mer | other | no_text (only lab pages are parsed)
    stages.pages = doc.pageTypes.map(({ page, type }) => ({ page, type }));
    stages.categorized = categorized;
    stages.sourceCheck = { removed };
    stages.validated = validated;
    stages.ocrEngines = result.ocr; // which engine(s) read the scanned pages
    // double OCR: Tesseract's own result, as it read the file (comparison only)
    if (result.secondary) stages.tesseract = { pages: result.secondary.doc.pageTypes.map(({ page, type }) => ({ page, type })), validated: result.secondary.validated };

    // ---- Review: saved so a reviewer can correct it (reviewStore.js) ----
    // Each row gets a stable rowId the review screen sends back with its edits.
    const docId = crypto.randomUUID();
    let n = 0;
    for (const r of validated.reports || []) for (const row of r.rows || []) row.rowId = `r${n++}`;
    reviewStore.saveExtraction({
      docId, fileName: req.file.originalname,
      fileHash: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
      engine, selected: typeIds, sourceText: ocrDump, pages: stages.pages,
      patient: validated.patient, reports: validated.reports,
    });

    const fullResponse = { docId, fileName: req.file.originalname, llmModel: categorizeModel, engine, selected: typeIds, stages, data: validated, timings };
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

// ---- Human review (step 1 of the auto-improve plan — see reviewStore.js) ----
app.post('/api/review', (req, res) => {
  try {
    const c = reviewStore.saveReview(req.body || {});
    console.log(`[review] ${c.fileName} (${c.dc}) ${JSON.stringify(c.counts)}${c.fullyChecked ? ' → gold' : ''}`);
    res.json({ saved: true, counts: c.counts, fullyChecked: c.fullyChecked, stats: reviewStore.stats() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/review-stats', (req, res) => res.json(reviewStore.stats()));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `File is too large — max ${MAX_BYTES / (1024 * 1024)}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  const cfg = ocrConfig();
  const primary = getEngine(cfg.primary);
  console.log(`PIMS ${primary.label} + rules OCR demo running at http://localhost:${PORT}  (main flow: /select.html)`);
  console.log(`OCR service (${primary.label}) expected at ${primary.client.serviceUrl()} — start it separately (see README.md); only pages without a usable text layer are OCR'd`);
  console.log(`Double OCR: ${cfg.secondary ? `available per upload (second engine ${getEngine(cfg.secondary).label} at ${getEngine(cfg.secondary).client.serviceUrl()})` : 'off'}${cfg.problems.length ? `  — ${cfg.problems.join(' ')}` : ''}`);
  console.log(`Ollama: ${process.env.OLLAMA_URL || 'http://localhost:11434'}  categorize=${process.env.CATEGORIZE_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b'}`);
});
