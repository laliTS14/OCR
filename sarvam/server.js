require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { callSarvam, MODES } = require('./extractor');

const PORT = process.env.PORT || 8790;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE_URL = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const SARVAM_LANGUAGE = process.env.SARVAM_LANGUAGE || 'en-IN';

// Same limits as real/ and azure-llm/, kept equal for a fair comparison —
// Sarvam's own hard cap is 10 pages per job, tighter than this byte limit
// in practice for most scanned reports.
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return res.status(400).json({ error: `Unsupported file type "${req.file.mimetype}". Use PDF, JPG, or PNG.` });
  }
  const mode = req.body.mode || 'lab';
  if (!MODES[mode]) {
    return res.status(400).json({ error: `Unknown mode "${mode}" — expected one of: ${Object.keys(MODES).join(', ')}.` });
  }

  try {
    const data = await callSarvam(req.file.buffer, req.file.mimetype, req.file.originalname, {
      apiKey: SARVAM_API_KEY,
      baseUrl: SARVAM_BASE_URL,
      language: SARVAM_LANGUAGE,
      mode,
    });
    res.json({ fileName: req.file.originalname, model: 'sarvam-doc-ai-extract', mode, data });
  } catch (err) {
    console.error('Extraction failed:', err.message, err.details ? JSON.stringify(err.details) : '');
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `File is too large — max ${MAX_BYTES / (1024 * 1024)}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  const keyStatus = SARVAM_API_KEY ? 'loaded' : 'MISSING — set it in OCR/sarvam/.env';
  console.log(`PIMS Sarvam-OCR demo running at http://localhost:${PORT}`);
  console.log(`Base URL: ${SARVAM_BASE_URL}  |  Language: ${SARVAM_LANGUAGE}  |  API key: ${keyStatus}`);
});
