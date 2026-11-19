// Double OCR, for comparison only: a report whose double-OCR flag is set is
// read by the primary engine (its result is THE result — saved to
// tbl_ocr_data, used by digitization) and ALSO by the second engine
// (Tesseract), whose full result is kept separately, as that engine read it
// (saved to tbl_ocr_tesseract_report / tbl_ocr_data_tesseract). The two are
// never merged. Every other report is read by the primary engine only.
//
// Only pages that needed OCR differ between the readings: pages with a usable
// PDF text layer are read directly in both. So a fully digital file never
// runs the second engine (ocr.skipReason says why).
//
// The second engine is optional: if it fails, the primary result stands and
// ocr.secondaryError says why — a comparison engine never blocks a report.
//
// Every row of either result carries:
//   ocr_engine      lookup code (tbl_lookup_master 'OcrEngine'): the engine
//                   that read the row's page — PADDLE / TESSERACT / GEMINI —
//                   or TEXT_LAYER (PDF text layer, no OCR involved)
//   ocr_confidence  the rules parser's own row confidence: HIGH / MEDIUM / LOW
//   ocr_note        null (kept for the save format)
const { extractDocument } = require('./pipeline');
const { engineCode, TEXT_LAYER_CODE } = require('./ocrEngines');

const rowPage = (row, report) => (row.page != null ? row.page : (report.page_numbers || [])[0]);
const ocrPagesOf = (result) => result.triageStage.pages.filter((p) => String(p.source).startsWith('ocr')).map((p) => p.page);

// Tag every row with the engine that read its page and the parser's confidence.
function tagRows(validated, engineName, ocrPages) {
  const ocrSet = new Set(ocrPages);
  const reports = (validated.reports || []).map((report) => ({
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      ocr_engine: ocrSet.has(rowPage(row, report)) ? engineCode(engineName) : TEXT_LAYER_CODE,
      ocr_confidence: String(row.confidence || 'low').toUpperCase(),
      ocr_note: null,
    })),
  }));
  return { ...validated, reports };
}

// The pipeline with the primary engine, plus the second engine when asked.
// secondEngine: an engine name from ocrEngines.doubleOcrFor(...), or null.
// Returns the primary run's result object (triageStage, doc, ocrDump,
// validated …, rows tagged) plus:
//   ocr       { primary, secondary, doubleOcrRequested, doubleOcrRan,
//               ocrPages, skipReason?, secondaryError? }
//   secondary null, or the second engine's own result: { engine, validated
//             (rows tagged), triageStage, doc, ocrDump, timings, ms }
async function extractWithOcrEngines(buffer, mimetype, fileName, { primaryEngine, secondEngine = null, typeIds = ['ALL'], engine = 'rules', txLog = null } = {}) {
  const a = await extractDocument(buffer, mimetype, fileName, { typeIds, engine, txLog, ocrEngine: primaryEngine });
  const ocrPages = ocrPagesOf(a);
  const ocr = {
    primary: engineCode(primaryEngine),
    secondary: secondEngine ? engineCode(secondEngine) : null,
    doubleOcrRequested: Boolean(secondEngine),
    doubleOcrRan: false,
    ocrPages,
  };
  const result = { ...a, validated: tagRows(a.validated, primaryEngine, ocrPages), ocr, secondary: null };
  if (!secondEngine) return result;
  if (!ocrPages.length) {
    ocr.skipReason = 'no page needed OCR (all pages read from the PDF text layer) — the second engine had nothing to read';
    return result;
  }

  // the second engine's stages go to the same transaction log, prefixed
  const subLog = txLog && {
    writeJson: (name, data) => txLog.writeJson(`${secondEngine}_${name}`, data),
    writeText: (name, data) => txLog.writeText(`${secondEngine}_${name}`, data),
  };
  const t0 = Date.now();
  try {
    const b = await extractDocument(buffer, mimetype, fileName, { typeIds, engine, txLog: subLog, ocrEngine: secondEngine });
    ocr.doubleOcrRan = true;
    result.secondary = {
      engine: engineCode(secondEngine),
      validated: tagRows(b.validated, secondEngine, ocrPagesOf(b)),
      triageStage: b.triageStage,
      doc: b.doc,
      ocrDump: b.ocrDump,
      timings: b.timings,
      ms: Date.now() - t0,
    };
  } catch (err) {
    ocr.secondaryError = err.message;
    ocr.secondaryMs = Date.now() - t0;
    if (txLog) txLog.writeJson(`${secondEngine}_ERROR.json`, { message: err.message });
  }
  return result;
}

module.exports = { extractWithOcrEngines, tagRows };
