require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { readDocument } = require('./unlimitedocr');
const { categorize: regexCategorize } = require('./regexCategorize');
const { categorize: llmCategorize } = require('./ollama');
const { scoreConfidence } = require('./confidence');
const { triage } = require('./triage');
const { validate } = require('./validate');
const { createTransactionLog } = require('./transactionLog');

const PORT = process.env.PORT || 8798;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 15 * 1024 * 1024;

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

  // Same triage->read->categorize->validate shape as every other demo here,
  // except stage 3 is now TWO steps: a fast regex attempt, always run, plus
  // a confidence check that decides whether an LLM fallback (slow, general)
  // is also needed. See confidence.js for the scoring and ../PROGRESS.md
  // for the real documents this was calibrated against.
  const stages = {};
  const txLog = createTransactionLog(req.file.originalname);
  const timings = {};
  const t0 = Date.now();

  try {
    // ---- Stage 1: Triage ----
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

    // ---- Stage 2: Reading ----
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

    // ---- Stage 3a: fast regex attempt (always runs — it's ~free) ----
    const t2 = Date.now();
    const { tier, ...regexResult } = regexCategorize(ocrDump);
    timings.regexCategorizeMs = Date.now() - t2;
    txLog.writeJson('03a_regex_categorized.json', { tier, ...regexResult });

    // ---- Stage 3b: confidence check ----
    const confidence = scoreConfidence(regexResult, tier);
    stages.confidence = confidence;
    txLog.writeJson('03b_confidence.json', confidence);

    // ---- Stage 3c: LLM fallback, ONLY when confidence says the regex
    // result isn't trustworthy enough to use as-is ----
    let categorized = regexResult;
    let pathTaken = 'regex';
    if (confidence.recommendFallback) {
      const t3 = Date.now();
      categorized = await llmCategorize(ocrDump);
      timings.llmCategorizeMs = Date.now() - t3;
      pathTaken = 'llm-fallback';
      txLog.writeJson('03c_llm_categorized.json', categorized);
    }
    stages.pathTaken = pathTaken;
    stages.categorized = categorized;

    // ---- Stage 4: Validation ----
    const t4 = Date.now();
    const validated = validate(categorized);
    timings.validateMs = Date.now() - t4;
    stages.validated = validated;
    txLog.writeJson('04_validated.json', validated);

    const fullResponse = {
      fileName: req.file.originalname,
      pathTaken,
      confidence,
      stages,
      data: validated,
    };
    txLog.writeJson('00_summary.json', {
      fileName: req.file.originalname,
      fileSizeKb: stages.triage.fileSizeKb,
      isDigital: stages.triage.isDigital,
      pathTaken,
      confidenceScore: confidence.score,
      regexTier: tier,
      timings,
      totalMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
    txLog.writeJson('05_full_response.json', fullResponse);
    console.log(`[transaction] ${req.file.originalname} → path=${pathTaken} confidence=${confidence.score} → ${txLog.dir}`);

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
  console.log(`PIMS Hybrid (regex-first, confidence-scored LLM fallback) OCR demo running at http://localhost:${PORT}`);
  console.log(`Unlimited-OCR service (scanned files only) expected at ${process.env.UNLIMITED_OCR_URL || 'http://localhost:8796'}`);
  console.log(`Ollama fallback: ${process.env.OLLAMA_URL || 'http://localhost:11434'}  categorize=${process.env.CATEGORIZE_MODEL || 'llama3.2:3b'} — only called when the regex path's confidence score is below threshold`);
});
