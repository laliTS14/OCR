// CLI test: node test-extract.js "<path to a real report>" [lab|mer]
// Calls the same extraction logic as the web UI, directly against a local
// file, and prints the result — useful for verifying a schema/prompt change
// works before going through the browser. Mirrors real/test-extract.js.
// mode defaults to "lab" (diagnostic report: test/value/unit/range) —
// pass "mer" for a Medical Examination Report questionnaire (question/
// answer pairs) instead. See extractor.js's MODES.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { callSarvam, MODES } = require('./extractor');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE_URL = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const SARVAM_LANGUAGE = process.env.SARVAM_LANGUAGE || 'en-IN';

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

async function main() {
  const filePath = process.argv[2];
  const mode = process.argv[3] || 'lab';
  if (!filePath) {
    console.error('Usage: node test-extract.js "<path to PDF/JPG/PNG>" [lab|mer]');
    process.exit(1);
  }
  if (!MODES[mode]) {
    console.error(`Unknown mode "${mode}" — expected one of: ${Object.keys(MODES).join(', ')}.`);
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    console.error(`Unsupported file extension "${ext}". Use .pdf, .jpg, or .png.`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  console.log(`Sending ${filename} (${(buffer.length / 1024).toFixed(1)} KB) to Sarvam AI Document AI Extract [mode: ${mode}] (${SARVAM_BASE_URL})...`);
  console.log('Sarvam max is 10 pages/job — if this file is longer, expect a rejected/partially_completed job.');

  try {
    const data = await callSarvam(buffer, mimeType, filename, {
      apiKey: SARVAM_API_KEY,
      baseUrl: SARVAM_BASE_URL,
      language: SARVAM_LANGUAGE,
      mode,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Extraction failed:', err.message);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
}

main();
