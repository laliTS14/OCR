// CLI test: node test-extract.js "<path to a real report>"
// Calls the same extraction logic as the web UI, directly against a local
// file, and prints the result — useful for verifying a schema/prompt change
// works before going through the browser.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { callGemini } = require('./extractor');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test-extract.js "<path to PDF/JPG/PNG>"');
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    console.error(`Unsupported file extension "${ext}". Use .pdf, .jpg, or .png.`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  console.log(`Sending ${path.basename(filePath)} (${(buffer.length / 1024).toFixed(1)} KB) to ${GEMINI_MODEL}...`);

  try {
    const data = await callGemini(buffer, mimeType, { model: GEMINI_MODEL, apiKey: GEMINI_API_KEY });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Extraction failed:', err.message);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
}

main();
