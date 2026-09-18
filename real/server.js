require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { callGemini } = require('./extractor');

const PORT = process.env.PORT || 8787;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

  try {
    const data = await callGemini(req.file.buffer, req.file.mimetype, { model: GEMINI_MODEL, apiKey: GEMINI_API_KEY });
    res.json({ fileName: req.file.originalname, model: GEMINI_MODEL, data });
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
  const keyStatus = GEMINI_API_KEY ? 'loaded' : 'MISSING — set it in OCR/real/.env';
  console.log(`PIMS real-OCR demo running at http://localhost:${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}  |  API key: ${keyStatus}`);
});
