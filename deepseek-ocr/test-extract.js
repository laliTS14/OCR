// CLI test: node test-extract.js "<path to a real report>" [--show-ocr]
// Runs the full staged pipeline (triage -> read -> categorize -> validate)
// against a local file and prints each stage, same as the web UI does.
// Mirrors ../paddleocr/test-extract.js, swapping in DeepSeek-OCR (via
// Ollama) as the reader — no separate Python service to start first.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { readDocument } = require('./deepseek');
const { categorize } = require('./ollama');
const { triage } = require('./triage');
const { validate } = require('./validate');
const { createTransactionLog } = require('./transactionLog');

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test-extract.js "<path to PDF/JPG/PNG>" [--show-ocr]');
    process.exit(1);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    console.error(`Unsupported file extension "${ext}". Use .pdf, .jpg, or .png.`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  console.log(`--- Stage 1: Triage — ${path.basename(filePath)} (${(buffer.length / 1024).toFixed(1)} KB) ---`);

  const categorizeModel = process.env.CATEGORIZE_MODEL || 'llama3.2:3b';
  const deepseekModel = process.env.DEEPSEEK_OCR_MODEL || 'deepseek-ocr';
  const txLog = createTransactionLog(path.basename(filePath));
  console.log(`(Logging this transaction to ${txLog.dir})`);

  const t0 = Date.now();
  try {
    const triageResult = await triage(buffer, mimeType);
    const t1 = Date.now();
    console.log(`isDigital: ${triageResult.isDigital}  |  ${triageResult.reason}  (${t1 - t0}ms)`);
    txLog.writeJson('01_triage.json', {
      fileName: path.basename(filePath),
      fileSizeKb: Math.round(buffer.length / 1024),
      isDigital: triageResult.isDigital,
      reason: triageResult.reason,
      timeMs: t1 - t0,
    });

    console.log(`\n--- Stage 2: Reading (${triageResult.isDigital ? 'direct text layer, no OCR' : `DeepSeek-OCR via Ollama, model=${deepseekModel}`}) ---`);
    let ocrDump;
    if (triageResult.isDigital) {
      ocrDump = `=== TEXT LAYER (extracted directly, no OCR) ===\n${triageResult.text}`;
    } else {
      console.log('Rasterizing PDF pages and calling DeepSeek-OCR per page — this can take 1-5 minutes per page on CPU, see deepseek.js for why.');
      const readResult = await readDocument(buffer, mimeType, path.basename(filePath));
      console.log(`Read ${readResult.pageCount} page(s), ${readResult.fullText.length} chars of text.`);
      if (readResult.truncatedPages.length) {
        console.log(`WARNING: page(s) ${readResult.truncatedPages.join(', ')} hit the output token limit (done_reason: "length") — content on those pages is incomplete. Consider raising num_predict in deepseek.js.`);
      }
      if (readResult.dedupedPages.length) {
        readResult.dedupedPages.forEach((d) => {
          console.log(`NOTE: page ${d.pageNumber} had a repetition loop — ${d.collapsedSections} repeated section(s) were collapsed before categorization. See deepseek.js's file header for why this happens.`);
        });
      }
      ocrDump = readResult.fullText;
    }
    const t2 = Date.now();
    console.log(`(Reading stage: ${t2 - t1}ms)`);
    if (process.argv.includes('--show-ocr')) {
      console.log('\n' + ocrDump + '\n');
    }
    txLog.writeText('02_extracted_text.txt', ocrDump);

    console.log(`--- Stage 3: Categorization (${categorizeModel}) ---`);
    const categorized = await categorize(ocrDump);
    const t3 = Date.now();
    console.log(`(Categorization stage: ${t3 - t2}ms)`);
    console.log(JSON.stringify(categorized, null, 2));
    txLog.writeJson('03_categorized.json', categorized);

    console.log(`\n--- Stage 4: Validation (deterministic code, not AI) ---`);
    const validated = validate(categorized);
    const t4 = Date.now();
    console.log(`Summary: ${JSON.stringify(validated.validationSummary)}`);
    console.log(JSON.stringify(validated, null, 2));
    console.log(`\n--- Total: ${t4 - t0}ms (triage ${t1 - t0}ms, reading ${t2 - t1}ms, categorize ${t3 - t2}ms, validate ${t4 - t3}ms) ---`);
    txLog.writeJson('04_validated.json', validated);

    const timings = { triageMs: t1 - t0, readingMs: t2 - t1, categorizeMs: t3 - t2, validateMs: t4 - t3 };
    txLog.writeJson('00_summary.json', {
      fileName: path.basename(filePath),
      fileSizeKb: Math.round(buffer.length / 1024),
      isDigital: triageResult.isDigital,
      categorizeModel,
      deepseekModel,
      timings,
      totalMs: t4 - t0,
      timestamp: new Date().toISOString(),
    });
    txLog.writeJson('05_full_response.json', { fileName: path.basename(filePath), llmModel: categorizeModel, data: validated });
  } catch (err) {
    console.error('Extraction failed:', err.message);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    txLog.writeJson('ERROR.json', { message: err.message, status: err.status || 500, details: err.details || null });
    process.exit(1);
  }
}

main();
