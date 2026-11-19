// Human review store — step 1 of the "auto-improve" plan (PROGRESS.md):
// every correction a reviewer makes is saved with what the pipeline produced,
// so later steps (dictionary suggestions, a trained line/field model) learn
// only from human-checked answers, never from the pipeline's own output.
//
// ./review-data/ (gitignored — real patient data):
//   extractions/<docId>.json  what the pipeline produced for one upload, plus
//                             the document text (so nothing needs re-OCR)
//   corrections/<docId>.json  the reviewer's answer + a per-row diff
//                             (ok / edited / retyped / deleted / added)
//   gold/<fileHash>.json      "fully checked" reviews = the answer key that
//                             gold-eval.js scores the pipeline against
//                             (keyed by file hash: re-reviewing the same file
//                             replaces its answer, never duplicates it)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'review-data');
const DIRS = { extractions: 'extractions', corrections: 'corrections', gold: 'gold' };
const FIELDS = ['test', 'value', 'unit', 'range', 'report_type'];
const PATIENT_FIELDS = ['name', 'age', 'sex', 'patient_id', 'contact_number'];
const SAFE_ID = /^[a-f0-9-]{8,64}$/i;

const dir = (kind) => {
  const d = path.join(ROOT, DIRS[kind]);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const writeJson = (kind, id, data) => fs.writeFileSync(path.join(dir(kind), `${id}.json`), JSON.stringify(data, null, 2));
const readJson = (kind, id) => {
  if (!SAFE_ID.test(id)) return null;
  const f = path.join(dir(kind), `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
const listJson = (kind) => fs.readdirSync(dir(kind)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir(kind), f), 'utf8')));
const clean = (v) => String(v == null ? '' : v).trim();

// rows: validated report rows flattened, each with a stable rowId the review
// screen sends back. → the stored extraction
function saveExtraction({ docId, fileName, fileHash, engine, selected, sourceText, pages, patient, reports }) {
  const rows = [];
  for (const r of reports || []) {
    for (const row of r.rows || []) {
      rows.push({
        rowId: row.rowId, report_type: r.report_type, test: row.test, value: row.value, unit: row.unit, range: row.range,
        param_id: row.param_id || null, canonical: row.canonical || null, confidence: row.confidence || null,
      });
    }
  }
  const lab = (reports || []).map((r) => r.lab_name).find(Boolean) || '';
  const extraction = { docId, fileName, fileHash, engine, selected, extractedAt: new Date().toISOString(), lab, patient: patient || {}, rows, pages, sourceText };
  writeJson('extractions', docId, extraction);
  return extraction;
}

// review: { docId, dc, fullyChecked, notes, patient: {...}, rows: [{ rowId|null,
// deleted?, test, value, unit, range, report_type }] } → the saved correction
function saveReview(review) {
  const ex = readJson('extractions', clean(review.docId));
  if (!ex) {
    const err = new Error('Unknown document — it was not extracted on this server (or review-data/ was cleared). Re-upload it.');
    err.status = 404;
    throw err;
  }
  const dc = clean(review.dc);
  if (!dc) {
    const err = new Error('Enter the diagnostic centre (DC) name — corrections are only trusted once they recur across DCs.');
    err.status = 400;
    throw err;
  }
  const byId = new Map(ex.rows.map((r) => [r.rowId, r]));
  const seen = new Set();
  const rows = [];
  for (const r of review.rows || []) {
    const corrected = Object.fromEntries(FIELDS.map((f) => [f, clean(r[f])]));
    const orig = r.rowId && byId.get(r.rowId);
    if (orig) {
      seen.add(orig.rowId);
      const extracted = { ...Object.fromEntries(FIELDS.map((f) => [f, clean(orig[f])])), param_id: orig.param_id, confidence: orig.confidence };
      if (r.deleted) { rows.push({ rowId: orig.rowId, action: 'deleted', extracted }); continue; }
      const changed = FIELDS.filter((f) => corrected[f] !== extracted[f]);
      const action = !changed.length ? 'ok' : changed.length === 1 && changed[0] === 'report_type' ? 'retyped' : 'edited';
      rows.push({ rowId: orig.rowId, action, changed, extracted, corrected });
    } else if (!r.deleted && corrected.test) {
      rows.push({ rowId: null, action: 'added', corrected });
    }
  }
  // rows the client did not send back at all count as deleted
  for (const orig of ex.rows) {
    if (!seen.has(orig.rowId)) rows.push({ rowId: orig.rowId, action: 'deleted', extracted: Object.fromEntries(FIELDS.map((f) => [f, clean(orig[f])])) });
  }
  const patientIn = review.patient || {};
  const patient = PATIENT_FIELDS.map((f) => ({ field: f, extracted: clean(ex.patient[f]), corrected: clean(patientIn[f]) }))
    .map((p) => ({ ...p, action: p.extracted === p.corrected ? 'ok' : p.extracted ? (p.corrected ? 'edited' : 'deleted') : 'added' }));

  const counts = rows.reduce((a, r) => ({ ...a, [r.action]: (a[r.action] || 0) + 1 }), {});
  const correction = {
    docId: ex.docId, fileName: ex.fileName, fileHash: ex.fileHash, dc, engine: ex.engine, selected: ex.selected,
    fullyChecked: !!review.fullyChecked, notes: clean(review.notes),
    extractedAt: ex.extractedAt, reviewedAt: new Date().toISOString(), counts, patient, rows,
  };
  writeJson('corrections', ex.docId, correction);

  // Gold = the answer key: only reviews where the reviewer confirmed every
  // row AND added every missed test. It stores the document text, so
  // gold-eval.js can re-score any future parser version without the PDF.
  if (correction.fullyChecked) {
    writeJson('gold', ex.fileHash, {
      fileHash: ex.fileHash, fileName: ex.fileName, dc, selected: ex.selected, docId: ex.docId,
      reviewedAt: correction.reviewedAt, sourceText: ex.sourceText,
      patient: Object.fromEntries(patient.map((p) => [p.field, p.corrected])),
      rows: rows.filter((r) => r.action !== 'deleted').map((r) => ({ ...r.corrected, param_id: r.extracted && r.action !== 'edited' ? r.extracted.param_id : null })),
    });
  }
  return correction;
}

// Totals for the review screen: how much has been checked, and what kind of
// mistakes the pipeline makes (by action), per DC.
function stats() {
  const corrections = listJson('corrections');
  const gold = listJson('gold');
  const byAction = {};
  const byDc = {};
  for (const c of corrections) {
    const d = (byDc[c.dc] = byDc[c.dc] || { reviews: 0, rows: 0, ok: 0 });
    d.reviews++;
    for (const [a, n] of Object.entries(c.counts)) {
      byAction[a] = (byAction[a] || 0) + n;
      d.rows += n;
      if (a === 'ok') d.ok += n;
    }
  }
  const totalRows = Object.values(byAction).reduce((a, n) => a + n, 0);
  return {
    reviews: corrections.length, goldDocuments: gold.length, goldDcs: new Set(gold.map((g) => g.dc)).size,
    rowsReviewed: totalRows, byAction, byDc,
    rowsCorrectAsExtracted: totalRows ? +((byAction.ok || 0) / totalRows).toFixed(3) : null,
  };
}

module.exports = { saveExtraction, saveReview, stats, listJson, readJson, ROOT };
