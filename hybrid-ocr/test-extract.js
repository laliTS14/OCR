// CLI test: node test-extract.js "<path to a real report>" [--show-ocr]
// Runs triage -> read -> regex categorize -> confidence check -> (LLM
// fallback only if needed) -> validate, same as the web UI.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { readDocument } = require('./unlimitedocr');
const { categorize: regexCategorize } = require('./regexCategorize');
const { categorize: llmCategorize } = require('./ollama');
const { scoreConfidence } = require('./confidence');
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

  const txLog = createTransactionLog(path.basename(filePath));
  console.log(`(Logging this transaction to ${txLog.dir})`);

  const t0 = Date.now();
  try {
    const triageResult = await triage(buffer, mimeType);
    const t1 = Date.now();
    console.log(`isDigital: ${triageResult.isDigital}  |  ${triageResult.reason}  (${t1 - t0}ms)`);

    console.log(`\n--- Stage 2: Reading ---`);
    let ocrDump;
    if (triageResult.isDigital) {
      ocrDump = `=== TEXT LAYER (extracted directly, no OCR) ===\n${triageResult.text}`;
    } else {
      const readResult = await readDocument(buffer, mimeType, path.basename(filePath));
      ocrDump = readResult.fullText;
      readResult.pageTimings.forEach((p) => console.log(`  page ${p.pageNumber}: ${p.elapsedSeconds}s`));
    }
    const t2 = Date.now();
    console.log(`(Reading stage: ${t2 - t1}ms)`);
    if (process.argv.includes('--show-ocr')) console.log('\n' + ocrDump + '\n');
    txLog.writeText('02_extracted_text.txt', ocrDump);

    console.log(`\n--- Stage 3a: Regex categorize (fast path, always tried) ---`);
    const t3 = Date.now();
    const { tier, ...regexResult } = regexCategorize(ocrDump);
    const t4 = Date.now();
    console.log(`(Regex categorize: ${t4 - t3}ms, tier ${tier})`);
    txLog.writeJson('03a_regex_categorized.json', { tier, ...regexResult });

    console.log(`\n--- Stage 3b: Confidence check ---`);
    const confidence = scoreConfidence(regexResult, tier);
    console.log(`Score: ${confidence.score}  |  recommendFallback: ${confidence.recommendFallback}`);
    confidence.reasons.forEach((r) => console.log(`  - ${r}`));
    txLog.writeJson('03b_confidence.json', confidence);

    let categorized = regexResult;
    let pathTaken = 'regex';
    let llmMs = 0;
    if (confidence.recommendFallback) {
      console.log(`\n--- Stage 3c: LLM fallback (confidence below threshold) ---`);
      const t5 = Date.now();
      categorized = await llmCategorize(ocrDump);
      llmMs = Date.now() - t5;
      pathTaken = 'llm-fallback';
      console.log(`(LLM categorize: ${llmMs}ms)`);
      txLog.writeJson('03c_llm_categorized.json', categorized);
    } else {
      console.log('\n(Confidence high enough — keeping the regex result, no LLM call made.)');
    }
    console.log(JSON.stringify(categorized, null, 2));

    console.log(`\n--- Stage 4: Validation ---`);
    const validated = validate(categorized);
    const t6 = Date.now();
    console.log(`Summary: ${JSON.stringify(validated.validationSummary)}`);
    txLog.writeJson('04_validated.json', validated);

    const validateStartMs = pathTaken === 'llm-fallback' ? t4 + llmMs : t4;
    const timings = { triageMs: t1 - t0, readingMs: t2 - t1, regexCategorizeMs: t4 - t3, llmCategorizeMs: llmMs, validateMs: t6 - validateStartMs };
    console.log(`\n--- Path taken: ${pathTaken} (confidence ${confidence.score}) — Total: ${t6 - t0}ms ---`);
    txLog.writeJson('00_summary.json', {
      fileName: path.basename(filePath),
      fileSizeKb: Math.round(buffer.length / 1024),
      isDigital: triageResult.isDigital,
      pathTaken,
      confidenceScore: confidence.score,
      regexTier: tier,
      timings,
      totalMs: t6 - t0,
      timestamp: new Date().toISOString(),
    });
    txLog.writeJson('05_full_response.json', { fileName: path.basename(filePath), pathTaken, confidence, data: validated });
  } catch (err) {
    console.error('Extraction failed:', err.message);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    txLog.writeJson('ERROR.json', { message: err.message, status: err.status || 500, details: err.details || null });
    process.exit(1);
  }
}

main();
