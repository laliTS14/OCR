// OCR engines and their flags. Which engine reads the pages that have no
// usable text layer, and whether a second engine double-checks it, is
// configuration only — the classification / parsing / validation after
// reading is the same code for every engine.
//
//   OCR_PRIMARY_ENGINE            paddle | tesseract | gemini — default: tesseract
//                                 in the tesseract-ocr/ folder, paddle anywhere else
//   OCR_ENGINE_PADDLE_ENABLED     true (default)  — paddle_text_service.py
//   OCR_ENGINE_TESSERACT_ENABLED  true (default)  — ../tesseract-ocr/tesseract_text_service.py
//   OCR_ENGINE_GEMINI_ENABLED     false (default) — not built yet; turning it on is refused
//   OCR_DOUBLE_ENABLED            false (default) — master switch for double OCR
//
// Double OCR runs only when OCR_DOUBLE_ENABLED is on AND the report asks for
// it (tbl_ocr_report_details.double_ocr, or --double on the CLI tools). The
// second engine is always Tesseract, so a report read by Tesseract as the
// primary engine is never double-OCR'd. See doubleOcr.js for the merge.
//
// Each engine's `code` is its tbl_lookup_master value (lookup_type
// 'OcrEngine'); pairs such as PADDLE_TESSERACT mark rows both engines read
// the same, TEXT_LAYER rows that came from a PDF text layer (no OCR at all).
const path = require('path');
const { createOcrClient } = require('./ocrClient');

const ENGINES = {
  paddle: {
    code: 'PADDLE',
    label: 'PaddleOCR',
    built: true,
    enabledVar: 'OCR_ENGINE_PADDLE_ENABLED',
    defaultEnabled: true,
    url: () => process.env.PADDLE_TEXT_URL || 'http://localhost:8794',
    // the paddle service runs RapidOCR or PaddleOCR (its own OCR_ENGINE);
    // each keeps its own page cache so results never mix
    cacheName: () => (process.env.OCR_ENGINE || 'rapid').toLowerCase(),
    startHint: 'python paddle_text_service.py in paddleocr/ (see paddleocr/README.md)',
  },
  tesseract: {
    code: 'TESSERACT',
    label: 'Tesseract',
    built: true,
    enabledVar: 'OCR_ENGINE_TESSERACT_ENABLED',
    defaultEnabled: true,
    url: () => process.env.TESSERACT_TEXT_URL || 'http://localhost:8799',
    cacheName: () => 'tesseract',
    startHint: 'python tesseract_text_service.py in tesseract-ocr/ (see tesseract-ocr/README.md)',
  },
  gemini: {
    code: 'GEMINI',
    label: 'Gemini',
    built: false, // reserved: the flag and lookup value exist, the engine does not yet
    enabledVar: 'OCR_ENGINE_GEMINI_ENABLED',
    defaultEnabled: false,
  },
};

const SECOND_ENGINE = 'tesseract';
const TEXT_LAYER_CODE = 'TEXT_LAYER';

const isOn = (v, def) => (v == null || String(v).trim() === '' ? def : /^(1|true|yes|on)$/i.test(String(v).trim()));
const isEnabled = (name) => isOn(process.env[ENGINES[name].enabledVar], ENGINES[name].defaultEnabled);
// this file is identical in paddleocr/ and tesseract-ocr/; each folder's
// demo reads with its own engine unless .env says otherwise
const FOLDER_DEFAULT = path.basename(__dirname) === 'tesseract-ocr' ? 'tesseract' : 'paddle';
const primaryName = () => String(process.env.OCR_PRIMARY_ENGINE || FOLDER_DEFAULT).trim().toLowerCase();

// → { name, code, label, client, cacheDir(baseDir) }; throws when the engine
// is unknown, switched off, or not built yet.
function getEngine(name) {
  const e = ENGINES[name];
  if (!e) throw new Error(`Unknown OCR engine '${name}' — use ${Object.keys(ENGINES).join(' / ')}.`);
  if (!isEnabled(name)) throw new Error(`OCR engine '${name}' is switched off (${e.enabledVar}).`);
  if (!e.built) throw new Error(`OCR engine '${name}' is not built yet — set ${e.enabledVar}=false and pick another OCR_PRIMARY_ENGINE.`);
  return {
    name,
    code: e.code,
    label: e.label,
    client: createOcrClient({ url: e.url, label: e.label, startHint: e.startHint }),
    cacheDir: (baseDir) => path.join(baseDir, 'ocr-cache', e.cacheName()),
  };
}

// The whole configuration, checked: { primary, doubleEnabled, secondary,
// enabled: { paddle, tesseract, gemini }, problems: [] }. `secondary` is
// null when double OCR can never run with these flags (and problems says why).
function ocrConfig() {
  const primary = primaryName();
  const enabled = Object.fromEntries(Object.keys(ENGINES).map((n) => [n, isEnabled(n)]));
  const doubleEnabled = isOn(process.env.OCR_DOUBLE_ENABLED, false);
  const problems = [];
  try { getEngine(primary); } catch (err) { problems.push(err.message); }
  let secondary = null;
  if (doubleEnabled) {
    if (primary === SECOND_ENGINE) problems.push('OCR_DOUBLE_ENABLED is on, but the primary engine is already Tesseract — double OCR is skipped.');
    else if (!enabled[SECOND_ENGINE]) problems.push(`OCR_DOUBLE_ENABLED is on, but ${ENGINES[SECOND_ENGINE].enabledVar} is off — double OCR is skipped.`);
    else secondary = SECOND_ENGINE;
  }
  return { primary, doubleEnabled, secondary, enabled, problems };
}

// Should this report be double-OCR'd? reportFlag = the report's own flag.
function doubleOcrFor(reportFlag) {
  const cfg = ocrConfig();
  return Boolean(reportFlag) && cfg.secondary ? cfg.secondary : null;
}

// Engine name → lookup code; a pair of names → their agreement code.
const engineCode = (name) => ENGINES[name].code;
const pairCode = (a, b) => `${ENGINES[a].code}_${ENGINES[b].code}`;

module.exports = { ENGINES, SECOND_ENGINE, TEXT_LAYER_CODE, getEngine, ocrConfig, doubleOcrFor, engineCode, pairCode, primaryName };
