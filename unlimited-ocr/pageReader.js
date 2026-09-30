// Per-page reading: every page of a PDF is read the cheapest way that
// works. Pages with a usable text layer (triage.pageTextUsable) are taken
// directly — free, instant, exact; ONLY pages without one (scanned pages,
// garbled embedded OCR layers) are sent to Unlimited-OCR (~4.5 min/page on
// this CPU). A mixed "scanned MER + digital lab report" PDF therefore only
// OCRs its scanned pages.
//
// Output uses one page-marker format for every page ("--- Page N of M ---",
// which sections.splitIntoPages understands), so downstream page
// classification / parsing doesn't care how each page was read.
//
// Optional per-page OCR cache (cacheDir): <cacheDir>/<file>.p<N>.txt — a
// page is never OCR'd twice.

const fs = require('fs');
const path = require('path');
const { triagePages, textQuality, MIN_CLEAN_WORD_RATIO } = require('./triage');
const { ocrPdfPages } = require('./unlimitedocr');
const { classifyPage } = require('./pageClassifier');
const { normalizeReadingText } = require('./textNormalize');

async function readPages(fileBuffer, mimeType, fileName, { ocr = true, cacheDir = null, onProgress = null } = {}) {
  const t0 = Date.now();
  if (mimeType !== 'application/pdf') {
    // image upload: one page, always OCR
    const { readDocument } = require('./unlimitedocr');
    if (!ocr) return { fullText: '', pages: [{ page: 1, source: 'needs-ocr', reason: 'image file' }], ocrPages: 0, totalPages: 1, ms: Date.now() - t0 };
    const r = await readDocument(fileBuffer, mimeType, fileName);
    return { fullText: r.fullText, pages: [{ page: 1, source: 'ocr', reason: 'image file', seconds: r.pageTimings[0] && r.pageTimings[0].elapsedSeconds }], ocrPages: 1, totalPages: 1, ms: Date.now() - t0 };
  }

  const tri = await triagePages(fileBuffer);
  const total = tri.length;
  const texts = new Map();
  // An embedded OCR layer comes from one scanner/engine for the whole file,
  // so its quality is a file-level property: if the whole file's text fails
  // the triage clean-word check (the same one triage() uses), every page's
  // text layer is treated as unusable.
  const docQuality = textQuality(tri.map((p) => p.text).join('\n'));
  if (docQuality.cleanWordRatio < MIN_CLEAN_WORD_RATIO) {
    for (const p of tri) {
      if (p.usable) { p.usable = false; p.reason = `low-quality embedded OCR layer (whole file clean-word ratio ${docQuality.cleanWordRatio})`; }
    }
  }
  // A text layer that passes the basic check can still be unreadable: if the
  // page LOOKS like a lab page (lab vocabulary) but the rules parser gets no
  // results out of it, the embedded text is treated as unusable → OCR.
  for (const p of tri) {
    if (!p.usable) continue;
    const c = classifyPage(normalizeReadingText(p.text));
    if (c.type !== 'mer' && c.signals.labWords >= 1 && c.signals.highRows === 0 && c.signals.rows < 2) {
      p.usable = false;
      p.reason = 'lab-like page, but its text layer gives no readable results';
    }
  }
  const pages = tri.map((p) => ({ page: p.page, source: p.usable ? 'text' : 'needs-ocr', reason: p.reason, quality: p.quality }));
  tri.filter((p) => p.usable).forEach((p) => texts.set(p.page, p.text));

  const cachePath = (n) => cacheDir && path.join(cacheDir, `${path.basename(fileName)}.p${n}.txt`);
  const toOcr = [];
  for (const p of pages.filter((x) => x.source === 'needs-ocr')) {
    const cp = cachePath(p.page);
    if (cp && fs.existsSync(cp)) { texts.set(p.page, fs.readFileSync(cp, 'utf8')); p.source = 'ocr-cached'; } else toOcr.push(p.page);
  }

  if (ocr && toOcr.length) {
    if (onProgress) onProgress(`OCR ${toOcr.length} of ${total} page(s): ${toOcr.join(', ')}`);
    // one page at a time, so each finished page is cached even if a later one fails
    for (const n of toOcr) {
      const [res] = await ocrPdfPages(fileBuffer, [n]);
      texts.set(n, res.markdown);
      const p = pages.find((x) => x.page === n);
      p.source = 'ocr';
      p.seconds = res.elapsedSeconds;
      const cp = cachePath(n);
      if (cp) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cp, res.markdown); }
      if (onProgress) onProgress(`  page ${n} OCR'd in ${Math.round(res.elapsedSeconds)}s`);
    }
  }

  const fullText = pages
    .map((p) => `--- Page ${p.page} of ${total} ---\n${texts.get(p.page) || ''}`)
    .join('\n\n');
  return {
    fullText,
    pages: pages.map(({ quality, ...p }) => ({ ...p, letters: quality ? quality.letters : undefined })),
    ocrPages: pages.filter((p) => p.source === 'ocr').length,
    totalPages: total,
    ms: Date.now() - t0,
  };
}

module.exports = { readPages };
