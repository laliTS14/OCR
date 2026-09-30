// Calls the Unlimited-OCR microservice (unlimited_ocr_service.py) to do the
// actual reading: it looks at the raw page image and returns clean markdown
// (real HTML <table> markup for tabular content), the same role PaddleOCR
// plays in ../paddleocr/ and DeepSeek-OCR plays in ../deepseek-ocr/. Unlike
// both of those, Unlimited-OCR is NOT servable through Ollama (it's a plain
// Hugging Face Transformers model) — hence the separate Python microservice,
// same architectural shape as ../paddleocr/paddle.js talking to
// paddle_service.py, just a different backend.
//
// It also only accepts one image at a time, not a PDF, so PDF pages are
// rasterized first — same approach as ../deepseek-ocr/deepseek.js, via
// pdf-parse's built-in `getScreenshot` (bundles pdf.js + a native canvas,
// no external binary needed).
//
// CONFIRMED via ONE live test (Sept 2026) against page 1 of a real 7-page
// lab report — see PROGRESS.md "Unlimited-OCR" section for the full story,
// including what it took to get a CUDA-only model running on this CPU-only
// machine at all (two dependency fixes, patching 14 hardcoded .cuda() calls
// in the model's own code):
// - Result quality was dramatically better than every other free/self-hosted
//   approach tried in this project: all 24 test/value pairs in the main
//   panel came back correct with a proper HTML <table>, including a test
//   ("Absolute Lymphocyte Count") every other approach here has dropped or
//   merged into an adjacent row. Units/reference-ranges came back as a
//   SEPARATE table, not merged into the main one, but in the same row
//   order — see ollama.js's prompt for how the categorization step is
//   instructed to positionally zip the two tables back together.
// - Cost: ~2s one-time model load (done once at the microservice's startup,
//   not per page) + ~268s (~4.5 min) per page for inference. Slow, but the
//   quality on this one sample was worth it.
// - NOT YET STRESS-TESTED. DeepSeek-OCR also looked flawless on its first
//   run before repeat testing found a ~50% failure rate on the exact same
//   image — the same discipline needs to be applied here (re-run the same
//   page several times) before trusting this quality as representative
//   rather than a lucky first attempt.

const { PDFParse } = require('pdf-parse');
const { fetch: undiciFetch, Agent, FormData: UndiciFormData } = require('undici');

// A single page can take ~4.5 minutes — Node's global fetch has a silent
// 300s timeout that would otherwise kill a slow-but-working call, same
// reasoning as every other demo here that talks to a local model.
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// CONFIRMED bug, same one already documented in ../paddleocr/PROGRESS.md
// (bug #2): FormData MUST come from this same 'undici' package, not Node's
// global FormData — mixing the two silently produces a broken multipart
// body. Reproduced here: Flask reported "No file uploaded" even though
// this code looked correct, because it used the global FormData/Blob
// alongside undici's fetch. Global Blob is fine to keep.

async function rasterizePdfPages(fileBuffer, desiredWidth) {
  const parser = new PDFParse({ data: fileBuffer });
  try {
    const result = await parser.getScreenshot({ imageDataUrl: false, desiredWidth });
    return result.pages.map((p) => ({ pageNumber: p.pageNumber, buffer: Buffer.from(p.data) }));
  } finally {
    await parser.destroy();
  }
}

async function callUnlimitedOcrOnImage(imageBuffer, { serviceUrl }) {
  const form = new UndiciFormData();
  form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'page.png');

  let res;
  try {
    res = await undiciFetch(`${serviceUrl}/ocr`, {
      method: 'POST',
      body: form,
      dispatcher: noTimeoutAgent,
    });
  } catch (networkErr) {
    const err = new Error(
      `Could not reach the Unlimited-OCR microservice at ${serviceUrl} (${networkErr.message}). ` +
      `Is it running? Try: python unlimited_ocr_service.py (see README.md).`,
    );
    err.status = 502;
    throw err;
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error(`Unlimited-OCR service returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(parsed?.error || `Unlimited-OCR service returned an error (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (typeof parsed.markdown !== 'string') {
    const err = new Error('Unlimited-OCR service response did not contain the expected "markdown" field.');
    err.status = 502;
    err.details = parsed;
    throw err;
  }
  return { markdown: parsed.markdown, elapsedSeconds: parsed.elapsedSeconds };
}

// Returns { fullText, pageCount, pageTimings } — fullText is page-labeled
// markdown, ready to hand to ollama.js's categorization prompt the same way
// PaddleOCR's dump is in ../paddleocr/server.js.
async function readDocument(fileBuffer, mimeType, filename) {
  const serviceUrl = (process.env.UNLIMITED_OCR_URL || 'http://localhost:8796').replace(/\/+$/, '');
  const desiredWidth = Number(process.env.PAGE_RENDER_WIDTH) || 1600;

  let pageImages;
  if (mimeType === 'application/pdf') {
    pageImages = await rasterizePdfPages(fileBuffer, desiredWidth);
  } else {
    pageImages = [{ pageNumber: 1, buffer: fileBuffer }];
  }

  const pageTexts = [];
  const pageTimings = [];
  for (const page of pageImages) {
    const { markdown, elapsedSeconds } = await callUnlimitedOcrOnImage(page.buffer, { serviceUrl });
    pageTimings.push({ pageNumber: page.pageNumber, elapsedSeconds });
    pageTexts.push(`--- Page ${page.pageNumber} of ${pageImages.length} ---\n${markdown}`);
  }

  return {
    fullText: pageTexts.join('\n\n'),
    pageCount: pageImages.length,
    pageTimings,
  };
}

module.exports = { readDocument };
