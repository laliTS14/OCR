require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { readDocument } = require('./unlimitedocr');
const { categorize } = require('./regexCategorize');
const { triage } = require('./triage');
const { validate } = require('./validate');
const { createTransactionLog } = require('./transactionLog');

const PORT = process.env.PORT || 8797;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB — same cap as the other OCR POCs, keeps a fair comparison

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return res.status(400).json({ error: `Unsupported file type "${req.file.mimetype}". Use PDF, JPG, or PNG.` });
  }

  // Same 4-stage shape as ../unlimited-ocr/'s response — the only real
  // difference is stage 3 below never touches Ollama, so it's ms not
  // minutes. Every stage's real output is returned as-is so the UI can show
  // what actually happened, not a simulated version of it.
  const stages = {};
  const txLog = createTransactionLog(req.file.originalname);
  const timings = {};
  const t0 = Date.now();

  try {
    // ---- Stage 1: Ingestion & triage ----
    const triageResult = await triage(req.file.buffer, req.file.mimetype);
    timings.triageMs = Date.now() - t0;
    stages.triage = {
      fileName: req.file.originalname,
      fileSizeKb: Math.round(req.file.buffer.length / 1024),
      isDigital: triageResult.isDigital,
      reason: triageResult.reason,
      engine: triageResult.isDigital
        ? 'Direct PDF text layer (free, no OCR call)'
        : 'Unlimited-OCR, forced CPU (self-hosted, no GPU on this machine — see PROGRESS.md), ~4.5 min/page',
    };
    txLog.writeJson('01_triage.json', { ...stages.triage, timeMs: timings.triageMs });

    // ---- Stage 2: Reading (branches on triage) ----
    const t1 = Date.now();
    let ocrDump, pageCount, pageTimings;
    if (triageResult.isDigital) {
      ocrDump = `=== TEXT LAYER (extracted directly, no OCR) ===\n${triageResult.text}`;
      pageCount = 0;
      pageTimings = [];
    } else {
      const readResult = await readDocument(req.file.buffer, req.file.mimetype, req.file.originalname);
      ocrDump = readResult.fullText;
      pageCount = readResult.pageCount;
      pageTimings = readResult.pageTimings;
    }
    timings.readingMs = Date.now() - t1;
    stages.ocr = { dump: ocrDump, pageCount, pageTimings };
    txLog.writeText('02_extracted_text.txt', ocrDump);

    // ---- Stage 3: Categorization — pure regex, no LLM call at all ----
    const t2 = Date.now();
    const categorized = categorize(ocrDump);
    timings.categorizeMs = Date.now() - t2;
    stages.categorized = categorized;
    txLog.writeJson('03_categorized.json', categorized);

    // ---- Stage 4: Validation (deterministic code, not AI) ----
    const t3 = Date.now();
    const validated = validate(categorized);
    timings.validateMs = Date.now() - t3;
    stages.validated = validated;
    txLog.writeJson('04_validated.json', validated);

    const fullResponse = { fileName: req.file.originalname, llmModel: 'none (regex-based, no LLM)', stages, data: validated };
    txLog.writeJson('00_summary.json', {
      fileName: req.file.originalname,
      fileSizeKb: stages.triage.fileSizeKb,
      isDigital: stages.triage.isDigital,
      categorizeModel: 'none (regex-based, no LLM)',
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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `File is too large — max ${MAX_BYTES / (1024 * 1024)}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  const unlimitedOcrUrl = process.env.UNLIMITED_OCR_URL || 'http://localhost:8796';
  console.log(`PIMS Regex-based (no-LLM) OCR demo running at http://localhost:${PORT}`);
  console.log(`Unlimited-OCR service expected at ${unlimitedOcrUrl} for scanned (non-digital) pages only — run "python unlimited_ocr_service.py" from ../unlimited-ocr/ separately if a scanned file is uploaded here`);
  console.log('Categorization is pure regex (regexCategorize.js) — no Ollama, no LLM call anywhere in this demo.');
});
