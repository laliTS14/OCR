// CLI test of this demo's pipeline on one file:
//   node test-extract.js "<path to PDF/JPG/PNG>" [--show-text] [--no-ocr] [--engine paddle|tesseract] [--double]
// per-page reading (text layer where usable, OCR service for the rest) →
// page classification (only lab pages parsed) → whole-document rules parser
// (every test, grouped by report type, "Other" never dropped) → validate.
// No LLM. The OCR engine's service must be running for pages that need OCR
// (--no-ocr skips them). OCR'd pages are cached in ./ocr-cache/<engine>.
//   --engine   OCR engine (default OCR_PRIMARY_ENGINE in .env, else paddle)
//   --double   double OCR (doubleOcr.js): the file is also read by Tesseract,
//              for comparison — needs OCR_DOUBLE_ENABLED=true; both results
//              are printed, one after the other (never merged)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { readPages } = require('./pageReader');
const { parseDocument } = require('./documentParser');
const { parseHeader } = require('./headerParser');
const { validate } = require('./validate');
const { getEngine, primaryName, ocrConfig, doubleOcrFor } = require('./ocrEngines');
const { extractWithOcrEngines } = require('./doubleOcr');

const MIME_BY_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

function printRows(reports, withEngine) {
  for (const r of reports) {
    console.log(`\n## ${r.report_type} (${r.rows.length})`);
    for (const x of r.rows) {
      const tag = withEngine
        ? `${String(x.ocr_confidence || '').padEnd(6)} ${String(x.ocr_engine || '').padEnd(16)}`
        : (x.confidence ? x.confidence[0].toUpperCase() : ' ');
      console.log(`   ${tag} ${x.test} = ${x.value} ${x.unit || ''} | ${x.range || ''}  [${x.validation.status}]${x.canonical ? `  <${x.canonical}>` : ''}` +
        `${x.flags ? `  !! ${x.flags.join('; ')}` : ''}`);
    }
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test-extract.js "<path to PDF/JPG/PNG>" [--show-text] [--no-ocr] [--engine paddle|tesseract] [--double]');
    process.exit(1);
  }
  const mimeType = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    console.error('Unsupported file type. Use .pdf, .jpg or .png.');
    process.exit(1);
  }
  const engIdx = process.argv.indexOf('--engine');
  const engineName = engIdx > 0 ? process.argv[engIdx + 1] : primaryName();
  const engine = getEngine(engineName);

  if (process.argv.includes('--double')) {
    // the worker's path: pipeline.js (+ source check) per engine, then the merge
    const second = engineName === primaryName() ? doubleOcrFor(true) : null;
    if (!second) console.log(`!! double OCR not possible with these flags: ${ocrConfig().problems.join(' ') || 'OCR_DOUBLE_ENABLED is off.'} Running ${engine.label} only.`);
    const t0 = Date.now();
    const r = await extractWithOcrEngines(fs.readFileSync(filePath), mimeType, path.basename(filePath), { primaryEngine: engineName, secondEngine: second, engine: 'rules' });
    console.log(`--- Reading: ${r.triageStage.reason}`);
    console.log(`--- OCR: ${JSON.stringify(r.ocr)}`);
    const runs = [[`${engine.label} (the result)`, r]].concat(r.secondary ? [[`${r.secondary.engine} (comparison only)`, r.secondary]] : []);
    for (const [label, x] of runs) {
      console.log(`\n===================== ${label}`);
      if (process.argv.includes('--show-text')) console.log(x.ocrDump);
      console.log(`--- Pages: ${x.doc.pageTypes.map((p) => `p${p.page}=${p.type}`).join(' ')}`);
      console.log(`--- Patient: ${JSON.stringify(x.validated.patient)}`);
      printRows(x.validated.reports, true);
      const rows = x.validated.reports.reduce((a, y) => a + y.rows.length, 0);
      console.log(`\n${rows} tests | ${JSON.stringify(x.validated.validationSummary)}`);
    }
    if (r.ocr.skipReason || r.ocr.secondaryError) console.log(`\n!! second engine: ${r.ocr.skipReason || r.ocr.secondaryError}`);
    console.log(`total ${Date.now() - t0}ms`);
    return;
  }

  const t0 = Date.now();
  const read = await readPages(fs.readFileSync(filePath), mimeType, path.basename(filePath), {
    ocr: !process.argv.includes('--no-ocr'),
    cacheDir: engine.cacheDir(__dirname),
    ocrClient: engine.client,
    onProgress: (m) => console.log(`  … ${m}`),
  });
  const t1 = Date.now();
  console.log(`--- Reading (${engine.label}): ${read.totalPages} page(s) in ${t1 - t0}ms`);
  for (const p of read.pages) console.log(`   p${p.page}: ${p.source}${p.seconds != null ? ` (${Math.round(p.seconds)}s)` : ''} — ${p.reason}`);
  if (process.argv.includes('--show-text')) console.log(read.fullText);

  const doc = parseDocument(read.fullText);
  const header = parseHeader(doc.headerText);
  const validated = validate({ patient: header.patient, reports: doc.reports.map((r) => ({ report_type: r.report_type, rows: r.rows })) });
  const t2 = Date.now();
  console.log(`--- Pages: ${doc.pageTypes.map((p) => `p${p.page}=${p.type}`).join(' ')}`);
  console.log(`--- Patient: ${JSON.stringify(header.patient)}  ${JSON.stringify(header.meta)}`);
  printRows(validated.reports, false);
  const rows = validated.reports.reduce((a, r) => a + r.rows.length, 0);
  console.log(`\n${rows} tests | ${JSON.stringify(validated.validationSummary)} | parse+validate ${t2 - t1}ms, total ${t2 - t0}ms`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
