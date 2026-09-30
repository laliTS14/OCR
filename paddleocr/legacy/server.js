require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { analyzeDocument } = require('./paddle');
const { categorize } = require('./ollama');
const { triage } = require('./triage');
const { validate } = require('./validate');
const { createTransactionLog } = require('./transactionLog');

const PORT = process.env.PORT || 8792;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB — same cap as the other two OCR POCs, keeps a fair comparison

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// Turns PaddleOCR/PP-Structure's structured read into a plain-text dump the
// small local model can reason over — identical shape to ../azure-llm's
// dump, so ollama.js's prompt/schema is a straight copy that never needed to
// change to support a different OCR backend.
function buildOcrDumpFromPaddle({ fullText, tables }) {
  let dump = `=== FULL TEXT ===\n${fullText}\n`;
  tables.forEach((grid, i) => {
    dump += `\n=== TABLE ${i + 1} (${grid.length} rows x ${grid[0]?.length || 0} cols) ===\n`;
    dump += grid.map((row) => row.join(' | ')).join('\n');
    dump += '\n';
  });
  return dump;
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
  // instead of a simulated version of it.
  const stages = {};
  // One folder per upload under logs/, one file per pipeline stage — see
  // transactionLog.js. Written as each stage completes so a mid-pipeline
  // failure still leaves whatever stages did finish on disk.
  const txLog = createTransactionLog(req.file.originalname);
  const llmModel = process.env.OLLAMA_MODEL || 'llama3.2:3b';
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
        : 'PaddleOCR + PP-Structure (self-hosted, free, runs on your own machine)',
    };
    txLog.writeJson('01_triage.json', { ...stages.triage, timeMs: timings.triageMs });

    // ---- Stage 2: Reading (branches on triage) ----
    const t1 = Date.now();
    let ocrDump, tableCount;
    if (triageResult.isDigital) {
      ocrDump = `=== TEXT LAYER (extracted directly, no OCR) ===\n${triageResult.text}`;
      tableCount = 0;
    } else {
      const paddleResult = await analyzeDocument(req.file.buffer, req.file.mimetype, req.file.originalname);
      ocrDump = buildOcrDumpFromPaddle(paddleResult);
      tableCount = paddleResult.tables.length;
    }
    timings.readingMs = Date.now() - t1;
    stages.ocr = { dump: ocrDump, tableCount };
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

    const fullResponse = { fileName: req.file.originalname, llmModel, stages, data: validated };
    txLog.writeJson('00_summary.json', {
      fileName: req.file.originalname,
      fileSizeKb: stages.triage.fileSizeKb,
      isDigital: stages.triage.isDigital,
      llmModel,
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
  console.log(`PIMS PaddleOCR+LLM OCR demo running at http://localhost:${PORT}`);
  console.log(`PaddleOCR service expected at ${process.env.PADDLE_OCR_URL || 'http://localhost:8791'} — run "python paddle_service.py" separately (see README.md)`);
  console.log(`Local LLM (Ollama): ${process.env.OLLAMA_URL || 'http://localhost:11434'}  model=${process.env.OLLAMA_MODEL || 'llama3.2:3b'}`);
});
