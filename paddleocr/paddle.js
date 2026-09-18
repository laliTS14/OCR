// Calls the local PaddleOCR/PP-Structure Python microservice (paddle_service.py)
// to do the actual reading: plain text plus table structure. Same contract as
// ../azure-llm/azure.js's analyzeDocument — that's deliberate, so the rest of
// this pipeline (ollama.js, validate.js) is a straight copy that never needed
// to change to support a different OCR backend.

// Node's global fetch (built on undici) applies a default 300-second
// headersTimeout/bodyTimeout — the same issue already found and fixed for
// the Ollama call in ollama.js. OCR'ing every page of a multi-page PDF
// through PPStructureV3 on CPU (layout detection + text recognition + table
// detection, per page) can take longer than 5 minutes, especially once
// every file is routed through PaddleOCR instead of skipping it for digital
// PDFs. Both timeouts are disabled outright (0 = no limit in undici).
//
// FormData must come from this same 'undici' package, not Node's global
// FormData — mixing the two silently produced a broken multipart body (the
// Python service saw no "file" field at all, despite Node's own multer
// parsing the incoming upload fine) even though both APIs look identical.
// Global Blob is fine to keep; it's plain binary data, not a stateful object.
const { fetch: undiciFetch, Agent, FormData: UndiciFormData } = require('undici');
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

async function analyzeDocument(fileBuffer, mimeType, fileName) {
  const url = `${(process.env.PADDLE_OCR_URL || 'http://localhost:8791').replace(/\/+$/, '')}/ocr`;

  const formData = new UndiciFormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName || 'upload');

  let res;
  try {
    res = await undiciFetch(url, { method: 'POST', body: formData, dispatcher: noTimeoutAgent });
  } catch (networkErr) {
    const err = new Error(
      `Could not reach the PaddleOCR service at ${url} (${networkErr.message}). ` +
      `Is "python paddle_service.py" running? See OCR/paddleocr/README.md.`,
    );
    err.status = 502;
    throw err;
  }

  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    const err = new Error(`PaddleOCR service returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(body.error || `PaddleOCR service returned an error (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }

  return { fullText: body.fullText || '', tables: body.tables || [] };
}

module.exports = { analyzeDocument };
