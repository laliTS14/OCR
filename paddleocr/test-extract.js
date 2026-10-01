// CLI test of this demo's pipeline on one file:
//   node test-extract.js "<path to PDF/JPG/PNG>" [--show-text] [--no-ocr]
// per-page reading (text layer where usable, OCR service for the rest) →
// page classification (only lab pages parsed) → whole-document rules parser
// (every test, grouped by report type, "Other" never dropped) → validate.
// No LLM. paddle_text_service.py must be running for pages that need OCR
// (--no-ocr skips them). OCR'd pages are cached in ./ocr-cache/<OCR_ENGINE>.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { readPages } = require('./pageReader');
const { parseDocument } = require('./documentParser');
const { parseHeader } = require('./headerParser');
const { validate } = require('./validate');

const MIME_BY_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test-extract.js "<path to PDF/JPG/PNG>" [--show-text] [--no-ocr]');
    process.exit(1);
  }
  const mimeType = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    console.error('Unsupported file type. Use .pdf, .jpg or .png.');
    process.exit(1);
  }
  const t0 = Date.now();
  const read = await readPages(fs.readFileSync(filePath), mimeType, path.basename(filePath), {
    ocr: !process.argv.includes('--no-ocr'),
    cacheDir: require('./paddleText').ocrCacheDir(__dirname),
    onProgress: (m) => console.log(`  … ${m}`),
  });
  const t1 = Date.now();
  console.log(`--- Reading: ${read.totalPages} page(s) in ${t1 - t0}ms`);
  for (const p of read.pages) console.log(`   p${p.page}: ${p.source}${p.seconds != null ? ` (${Math.round(p.seconds)}s)` : ''} — ${p.reason}`);
  if (process.argv.includes('--show-text')) console.log(read.fullText);

  const doc = parseDocument(read.fullText);
  const header = parseHeader(doc.headerText);
  const validated = validate({ patient: header.patient, reports: doc.reports.map((r) => ({ report_type: r.report_type, rows: r.rows })) });
  const t2 = Date.now();
  console.log(`--- Pages: ${doc.pageTypes.map((p) => `p${p.page}=${p.type}`).join(' ')}`);
  console.log(`--- Patient: ${JSON.stringify(header.patient)}  ${JSON.stringify(header.meta)}`);
  for (const r of validated.reports) {
    console.log(`\n## ${r.report_type} (${r.rows.length})`);
    for (const x of r.rows) {
      console.log(`   ${x.confidence ? x.confidence[0].toUpperCase() : ' '} ${x.test} = ${x.value} ${x.unit || ''} | ${x.range || ''}  [${x.validation.status}]${x.canonical ? `  <${x.canonical}>` : ''}${x.flags ? `  !! ${x.flags.join('; ')}` : ''}`);
    }
  }
  const rows = validated.reports.reduce((a, r) => a + r.rows.length, 0);
  console.log(`\n${rows} tests | ${JSON.stringify(validated.validationSummary)} | parse+validate ${t2 - t1}ms, total ${t2 - t0}ms`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
