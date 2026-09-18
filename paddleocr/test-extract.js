// CLI test: node test-extract.js "<path to a real report>" [--show-ocr]
// Runs the full staged pipeline (triage -> read -> categorize -> validate)
// against a local file and prints each stage, same as the web UI does.
// Mirrors ../azure-llm/test-extract.js, swapping in PaddleOCR as the reader.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { analyzeDocument } = require('./paddle');
const { categorize } = require('./ollama');
const { triage } = require('./triage');
const { validate } = require('./validate');

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function buildOcrDumpFromPaddle({ fullText, tables }) {
  let dump = `=== FULL TEXT ===\n${fullText}\n`;
  tables.forEach((grid, i) => {
    dump += `\n=== TABLE ${i + 1} ===\n${grid.map((row) => row.join(' | ')).join('\n')}\n`;
  });
  return dump;
}

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

  const t0 = Date.now();
  try {
    const triageResult = await triage(buffer, mimeType);
    const t1 = Date.now();
    console.log(`isDigital: ${triageResult.isDigital}  |  ${triageResult.reason}  (${t1 - t0}ms)`);

    console.log(`\n--- Stage 2: Reading (${triageResult.isDigital ? 'direct text layer, no OCR' : 'PaddleOCR + PP-Structure'}) ---`);
    let ocrDump;
    if (triageResult.isDigital) {
      ocrDump = `=== TEXT LAYER (extracted directly, no OCR) ===\n${triageResult.text}`;
    } else {
      const paddleResult = await analyzeDocument(buffer, mimeType, path.basename(filePath));
      console.log(`PaddleOCR found ${paddleResult.tables.length} table(s), ${paddleResult.fullText.length} chars of text.`);
      ocrDump = buildOcrDumpFromPaddle(paddleResult);
    }
    const t2 = Date.now();
    console.log(`(Reading stage: ${t2 - t1}ms)`);
    if (process.argv.includes('--show-ocr')) {
      console.log('\n' + ocrDump + '\n');
    }

    console.log(`--- Stage 3: Categorization (${process.env.OLLAMA_MODEL || 'llama3.2:3b'}) ---`);
    const categorized = await categorize(ocrDump);
    const t3 = Date.now();
    console.log(`(Categorization stage: ${t3 - t2}ms)`);
    console.log(JSON.stringify(categorized, null, 2));

    console.log(`\n--- Stage 4: Validation (deterministic code, not AI) ---`);
    const validated = validate(categorized);
    const t4 = Date.now();
    console.log(`Summary: ${JSON.stringify(validated.validationSummary)}`);
    console.log(JSON.stringify(validated, null, 2));
    console.log(`\n--- Total: ${t4 - t0}ms (triage ${t1 - t0}ms, reading ${t2 - t1}ms, categorize ${t3 - t2}ms, validate ${t4 - t3}ms) ---`);
  } catch (err) {
    console.error('Extraction failed:', err.message);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
}

main();
