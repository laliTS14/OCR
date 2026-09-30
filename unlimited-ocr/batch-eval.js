// Batch evaluation of the whole-document rules pipeline over a folder of
// real reports: node batch-eval.js "<folder>" [--ocr] [--only a,b] [--save <out.json>]
//
// Purpose: judge the parser on MANY reports at once, and look for gaps that
// recur across labs — never tune it to one file (see PROGRESS.md's "Design
// rule for the rules-based parser"). No LLM. Scanned files are skipped
// unless --ocr is given (Unlimited-OCR, ~4.5 min/page on CPU, cached).
//
// Per file it reports every test found (whole-document parsing), grouped by
// report type (OTHER = fits no category), their confidence mix, and
// recognized report-type blocks that would fall back to the LLM. The aggregate at the end is what matters.
const fs = require('fs');
const path = require('path');
const { readPages } = require('./pageReader');
const { parseDocument } = require('./documentParser');
const { parseHeader } = require('./headerParser');

// --ocr: scanned files are read with Unlimited-OCR (microservice must be
// running) and the OCR text is cached in ./ocr-cache/<file>.txt, so later
// runs re-parse from the cache in milliseconds instead of re-OCRing.
const OCR_CACHE = path.join(__dirname, 'ocr-cache');

// Per-page reading (pageReader.js): text layer where usable, OCR only for
// the other pages (with --ocr; per-page cache in ./ocr-cache). Without
// --ocr, pages that need OCR are left empty and reported.
async function evalFile(file, useOcr) {
  const buf = fs.readFileSync(file);
  const t0 = Date.now();
  const read = await readPages(buf, 'application/pdf', path.basename(file), {
    ocr: useOcr, cacheDir: OCR_CACHE, onProgress: (m) => console.log(`   … ${m}`),
  });
  const textPages = read.pages.filter((p) => p.source === 'text').length;
  const ocrDone = read.pages.filter((p) => p.source.startsWith('ocr')).length;
  const missing = read.pages.filter((p) => p.source === 'needs-ocr').length;
  if (!textPages && !ocrDone) return { file: path.basename(file), digital: false, reason: `${missing} page(s) need OCR` };
  const source = `${textPages} text` + (ocrDone ? ` + ${ocrDone} OCR` : '') + (missing ? ` (${missing} need OCR, skipped)` : '');
  const text = read.fullText;
  const doc = parseDocument(text);
  const header = parseHeader(doc.headerText);
  // One "section" per report type found (OTHER split by printed heading);
  // fallback = a recognized report-type block the rules got no rows from.
  const sections = doc.reports.map((r) => {
    const conf = { high: 0, medium: 0, low: 0 };
    r.rows.forEach((x) => { conf[x.confidence]++; });
    return { typeId: r.typeId, heading: r.headings.join(' / ') || r.report_type, rows: r.rows, conf, fallback: false };
  });
  for (const b of doc.blocks.filter((x) => x.typeId && x.needsFallback && !x.rows.length)) {
    if (!sections.some((s) => s.typeId === b.typeId)) sections.push({ typeId: b.typeId, heading: b.heading, rows: [], conf: { high: 0, medium: 0, low: 0 }, fallback: true });
  }
  const pages = doc.pageTypes.map((p) => ({ lab: 'L', mer: 'M', other: 'O', no_text: '_' })[p.type]).join('');
  return { file: path.basename(file), digital: true, source, pages, ms: Date.now() - t0, textChars: text.length, patient: header.patient, sections };
}

(async () => {
  const dir = process.argv[2];
  const saveIdx = process.argv.indexOf('--save');
  const useOcr = process.argv.includes('--ocr');
  const onlyIdx = process.argv.indexOf('--only'); // --only "<substring>,<substring>"
  const only = onlyIdx > 0 ? process.argv[onlyIdx + 1].toLowerCase().split(',') : null;
  const files = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f))
    .filter((f) => !only || only.some((o) => f.toLowerCase().includes(o)))
    .map((f) => path.join(dir, f));
  const out = [];
  for (const f of files) {
    try { out.push(await evalFile(f, useOcr)); } catch (e) { out.push({ file: path.basename(f), error: e.message }); }
  }

  let rows = 0; const conf = { high: 0, medium: 0, low: 0 }; let secs = 0; let fb = 0;
  for (const r of out) {
    if (r.error) { console.log(`✗ ${r.file}: ERROR ${r.error}`); continue; }
    if (!r.digital) { console.log(`○ ${r.file}: scan — needs OCR (skipped)`); continue; }
    const n = r.sections.reduce((a, s) => a + s.rows.length, 0);
    rows += n; secs += r.sections.length; fb += r.sections.filter((s) => s.fallback).length;
    r.sections.forEach((s) => { conf.high += s.conf.high; conf.medium += s.conf.medium; conf.low += s.conf.low; });
    console.log(`● ${r.file}  [${r.source}]  pages=${r.pages}  (${r.ms}ms)  rows=${n}  patient=${JSON.stringify(r.patient)}`);
    for (const s of r.sections) {
      console.log(`    ${s.typeId.padEnd(8)} rows=${String(s.rows.length).padEnd(3)} H/M/L=${s.conf.high}/${s.conf.medium}/${s.conf.low}${s.fallback ? '  → LLM fallback' : ''}   [${String(s.heading).slice(0, 60)}]`);
    }
  }
  const digital = out.filter((r) => r.digital).length;
  console.log(`\nTOTAL: ${out.length} files, ${digital} digital, ${out.length - digital} scans/errors | ${secs} sections, ${fb} would fall back | ${rows} rows, confidence H/M/L = ${conf.high}/${conf.medium}/${conf.low}`);
  if (saveIdx > 0) fs.writeFileSync(process.argv[saveIdx + 1], JSON.stringify(out, null, 2));
})();
