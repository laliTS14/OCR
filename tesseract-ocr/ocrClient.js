// Node client for the text-OCR services. Every engine's service speaks the
// same contract — POST /ocr (multipart "file" = one page image) →
// { text, markdown, elapsedSeconds, skewDeg, engine } — so one client
// serves them all; ocrEngines.js says which URL belongs to which engine:
//   paddle    paddle_text_service.py (this folder; RapidOCR by default), port 8794
//   tesseract ../tesseract-ocr/tesseract_text_service.py, port 8799
// Same functions as ../unlimited-ocr/unlimitedocr.js (readDocument,
// ocrPdfPages), so pageReader.js treats every engine alike.
//
// undici's fetch + FormData with no timeouts: Node's global fetch has a
// silent 300s limit, and mixing the global FormData with undici's fetch
// breaks multipart uploads (both happened before in this folder — see
// PROGRESS.md).
const { PDFParse } = require('pdf-parse');
const { fetch: undiciFetch, Agent, FormData: UndiciFormData } = require('undici');

const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const renderWidth = () => Number(process.env.PAGE_RENDER_WIDTH) || 1600;

async function rasterizePdfPages(fileBuffer, onlyPages) {
  const parser = new PDFParse({ data: fileBuffer });
  try {
    const result = await parser.getScreenshot({ imageDataUrl: false, desiredWidth: renderWidth(), ...(onlyPages ? { partial: onlyPages } : {}) });
    return result.pages.map((p) => ({ pageNumber: p.pageNumber, buffer: Buffer.from(p.data) }));
  } finally {
    await parser.destroy();
  }
}

// url: the service's base URL; label: engine name for error messages;
// startHint: how to start the service (shown when it can't be reached).
function createOcrClient({ url, label, startHint }) {
  const serviceUrl = () => String(typeof url === 'function' ? url() : url).replace(/\/+$/, '');

  async function ocrImage(imageBuffer, mimeType = 'image/png') {
    const form = new UndiciFormData();
    form.append('file', new Blob([imageBuffer], { type: mimeType }), mimeType === 'image/png' ? 'page.png' : 'page.jpg');
    let res;
    try {
      res = await undiciFetch(`${serviceUrl()}/ocr`, { method: 'POST', body: form, dispatcher: noTimeoutAgent });
    } catch (networkErr) {
      const err = new Error(`Could not reach the ${label} OCR service at ${serviceUrl()} (${networkErr.message}). Is it running?${startHint ? ` Try: ${startHint}` : ''}`);
      err.status = 502;
      throw err;
    }
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const err = new Error(`${label} OCR service returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
      err.status = 502;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(parsed.error || `${label} OCR service error (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return { markdown: parsed.text || '', elapsedSeconds: parsed.elapsedSeconds, skewDeg: parsed.skewDeg };
  }

  // OCR specific pages of a PDF → [{ pageNumber, markdown, elapsedSeconds }]
  async function ocrPdfPages(fileBuffer, pageNumbers) {
    const images = await rasterizePdfPages(fileBuffer, pageNumbers);
    const out = [];
    for (const img of images) out.push({ pageNumber: img.pageNumber, ...(await ocrImage(img.buffer)) });
    return out;
  }

  // Whole document (every page, or an image upload) → { fullText, pageCount, pageTimings }
  async function readDocument(fileBuffer, mimeType) {
    const pages = mimeType === 'application/pdf'
      ? await rasterizePdfPages(fileBuffer)
      : [{ pageNumber: 1, buffer: fileBuffer }];
    const texts = [];
    const pageTimings = [];
    for (const p of pages) {
      const r = await ocrImage(p.buffer, mimeType === 'application/pdf' ? 'image/png' : mimeType);
      pageTimings.push({ pageNumber: p.pageNumber, elapsedSeconds: r.elapsedSeconds });
      texts.push(`--- Page ${p.pageNumber} of ${pages.length} ---\n${r.markdown}`);
    }
    return { fullText: texts.join('\n\n'), pageCount: pages.length, pageTimings };
  }

  return { serviceUrl, ocrImage, ocrPdfPages, readDocument };
}

module.exports = { createOcrClient, rasterizePdfPages };
