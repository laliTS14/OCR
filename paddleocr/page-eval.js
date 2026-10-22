// Page-classification accuracy against the hand-checked answer key
// (review-data/page-key.json — gitignored: file names are patient names).
//
//   node page-eval.js            score the current classifier
//   node page-eval.js --verbose  …and list every wrong page
//
// What matters for OCR is lab vs not-lab: a pathology page called
// something else loses its results; a non-pathology page called lab gets
// parsed into junk rows. "lab_notes" pages (part of a lab report, but no
// results: interpretation text, blank body) count as right either way.
// Reads every file through the OCR page cache (./ocr-cache) — run it after
// the files have been processed once; uncached scanned pages need
// paddle_text_service.py running.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });
const { readPages } = require('./pageReader');
const { parseDocument } = require('./documentParser');
const cacheDir = require('./paddleText').ocrCacheDir(__dirname);

const KEY = path.join(__dirname, 'review-data', 'page-key.json');

(async () => {
  if (!fs.existsSync(KEY)) { console.error(`No answer key at ${KEY}`); process.exit(1); }
  const key = JSON.parse(fs.readFileSync(KEY, 'utf8'));
  const verbose = process.argv.includes('--verbose');
  const t = { labPages: 0, labFound: 0, nonLabPages: 0, nonLabKept: 0, notes: 0 };
  const wrong = [];
  for (const [name, { path: file, pages }] of Object.entries(key.files)) {
    if (!fs.existsSync(file)) { console.log(`skip (missing): ${name}`); continue; }
    const r = await readPages(fs.readFileSync(file), 'application/pdf', name, { ocr: true, cacheDir });
    const got = Object.fromEntries(parseDocument(r.fullText).pageTypes.map((p) => [p.page, p.type]));
    for (const [page, want] of Object.entries(pages)) {
      const isLab = got[page] === 'lab';
      if (want === 'lab_notes') { t.notes++; continue; }
      if (want === 'lab') { t.labPages++; if (isLab) t.labFound++; else wrong.push(`${name} p${page}: pathology page classified ${got[page]}`); }
      else { t.nonLabPages++; if (!isLab) t.nonLabKept++; else wrong.push(`${name} p${page}: ${want} page classified lab`); }
    }
  }
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
  console.log(`pathology pages found:      ${t.labFound}/${t.labPages} (${pct(t.labFound, t.labPages)})`);
  console.log(`non-pathology pages kept out: ${t.nonLabKept}/${t.nonLabPages} (${pct(t.nonLabKept, t.nonLabPages)})`);
  console.log(`lab_notes pages (either ok):  ${t.notes}`);
  console.log(`wrong: ${wrong.length}`);
  if (verbose) wrong.forEach((w) => console.log(`  ${w}`));
})().catch((e) => { console.error(e); process.exit(1); });
