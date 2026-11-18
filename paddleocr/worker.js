// OCR worker — processes the OCR queue through the OCR insertion API
// (backend/Health_360_OCR, ASP.NET; client: ocrApiClient.js). The worker
// never touches the database itself.
//
// The database fills the queue: report QC (sp_update_qc_remark) queues each
// case's pathology files, and the MySQL event ev_queue_ocr_reports (every
// 10 min) queues anything QC missed and re-queues reports stuck in
// PROCESSING (database/stored_procedures/ocr_queue_job.sql). This worker
// only consumes it: claim the next QUEUED report (POST api/Ocr/ClaimReport)
// → fetch the file → run the same pipeline as the web demo (pipeline.js) →
// save the result (api/Ocr/SaveOcrResult) or record the failure
// (api/Ocr/MarkReportFailed, retried up to 3 times).
//
//   node worker.js                 run continuously (Ctrl+C finishes the current report, then exits)
//   node worker.js --once          process at most one queued report, then exit
//   node worker.js --file <pdf>    dry run on a local file: extract and print what
//                                  would be saved — no API / DB at all
//   node worker.js --file <pdf> --case <case_id>
//                                  TEST: queue a local file for that case (as if
//                                  uploaded + QC passed) and save it now (api/Ocr/QueueManualReport)
//   add --double to either --file mode: the report asks for double OCR (as
//                                  tbl_ocr_report_details.double_ocr = 1 would)
//
// OCR engines (ocrEngines.js): OCR_PRIMARY_ENGINE (RapidOCR) reads the
// scanned pages — that result is THE result (api/Ocr/SaveOcrResult →
// tbl_ocr_data). A report is double-OCR'd only when OCR_DOUBLE_ENABLED is on
// AND its double_ocr flag is set: Tesseract then also reads it, and its own
// result is saved separately for comparison (api/Ocr/SaveTesseractResult →
// tbl_ocr_tesseract_report / tbl_ocr_data_tesseract; no merge — doubleOcr.js).
// A Tesseract failure is recorded there and never fails the report.
//
// Needs the OCR API running, the primary engine's OCR service for scanned
// pages (paddle_text_service.py by default; tesseract_text_service.py too
// for double OCR), and Ollama only if OCR_WORKER_ENGINE=auto/llm. Config:
// .env (see README.md).
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { extractWithOcrEngines } = require('./doubleOcr');
const { getEngine, ocrConfig, doubleOcrFor, primaryName } = require('./ocrEngines');
const { createTransactionLog } = require('./transactionLog');
const { createClientFromEnv, OcrApiError } = require('./ocrApiClient');

const ENGINE = ['rules', 'auto', 'llm'].includes(process.env.OCR_WORKER_ENGINE) ? process.env.OCR_WORKER_ENGINE : 'rules';
const CONCURRENCY = Math.max(1, parseInt(process.env.OCR_WORKER_CONCURRENCY || '1', 10));
const POLL_MS = parseInt(process.env.OCR_WORKER_POLL_MS || '5000', 10);
const MAX_BYTES = 15 * 1024 * 1024; // same cap as the web demo
const MAX_TEXT_CHARS = 250 * 1024;  // raw_text / result_json each — the UAT server (MySQL 5.5) has a 1MB max_allowed_packet per CALL

// .webp too: the DC upload screen accepts it, and the OCR service (Pillow) reads it.
const MIME_BY_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const PIPELINE_VERSION = (() => {
  if (process.env.PIPELINE_VERSION) return process.env.PIPELINE_VERSION.slice(0, 20);
  try {
    return `${ENGINE}-${execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}`.slice(0, 20);
  } catch {
    return `${ENGINE}-${require('./package.json').version}`.slice(0, 20);
  }
})();

// ---------- value helpers ----------

// 4-byte characters a utf8 (3-byte) column rejects are dropped; trimmed to
// the column size (the API trims/cleans again before the SP).
function clean(value, maxLen) {
  if (value == null) return '';
  const s = String(value).replace(/[\x1e\x1f]/g, ' ').replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();
  return maxLen ? s.slice(0, maxLen) : s;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// Report dates as printed → 'YYYY-MM-DD HH:MM:SS', or null when unsure.
// Day-first (Indian reports): "24-Mar-2024 / 10:43:27 am", "24/03/2024 10:43",
// "24.03.24", "2024-03-24". The raw string is kept in result_json either way.
function toDbDateTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let y; let m; let d;
  let mt = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (mt) [, y, m, d] = mt.map(Number);
  else if ((mt = s.match(/\b(\d{1,2})[-/. ]([A-Za-z]{3,4})[A-Za-z]*[-/., ]+(\d{2,4})\b/)) && MONTHS[mt[2].toLowerCase()]) {
    d = Number(mt[1]); m = MONTHS[mt[2].toLowerCase()]; y = Number(mt[3]);
  } else if ((mt = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) {
    d = Number(mt[1]); m = Number(mt[2]); y = Number(mt[3]);
  } else return null;
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1990 || y > 2100 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  let hh = 0; let mi = 0; let ss = 0;
  const tm = s.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (tm) {
    hh = Number(tm[1]); mi = Number(tm[2]); ss = Number(tm[3] || 0);
    const ap = (tm[4] || '').toLowerCase()[0];
    if (ap === 'p' && hh < 12) hh += 12;
    if (ap === 'a' && hh === 12) hh = 0;
    if (hh > 23 || mi > 59 || ss > 59) { hh = 0; mi = 0; ss = 0; }
  }
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mi)}:${pad(ss)}`;
}

// Does the name printed on the report match the case's client name?
// Titles and punctuation ignored; every word of the shorter name must appear
// in the longer one ("BABITA KHANDELWAL" vs "Mrs. Babita Devi Khandelwal" → yes).
// null when either name is missing — "unknown", not "mismatch".
function nameMatches(reportName, caseName) {
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter((w) => w && !['mr', 'mrs', 'ms', 'miss', 'master', 'dr', 'smt', 'shri', 'kumari', 'baby'].includes(w));
  const a = words(reportName); const b = words(caseName);
  if (!a.length || !b.length) return null;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w) => long.includes(w)) ? 1 : 0;
}

// validated pipeline output → the API's Rows (one per test, in report
// order). Value and the range are stored as printed; min / max come split
// by the pipeline (validate.js range_min / range_max — each number exactly
// as printed, null = open end or no numeric range). OcrEngine / Confidence /
// ConfidenceNote come from doubleOcr.js (engine lookup code, HIGH/MEDIUM/LOW).
function buildRows(validated) {
  const rows = [];
  for (const report of validated.reports || []) {
    for (const row of report.rows || []) {
      const pageNo = row.page != null ? row.page : (report.page_numbers || [])[0];
      rows.push({
        ReportTypeCode: clean(report.type_id, 30),
        ReportTypeName: clean(report.report_type, 150),
        ReportHeading: clean(report.heading, 255),
        ParamCode: clean(row.param_id, 30),
        CanonicalName: clean(row.canonical, 150),
        TestNameRaw: clean(row.test, 255),
        Value: clean(row.value, 3000),
        Unit: clean(row.unit, 50),
        RangeRaw: clean(row.range, 150),
        MinRange: row.range_min == null ? null : clean(row.range_min, 50),
        MaxRange: row.range_max == null ? null : clean(row.range_max, 50),
        PageNo: pageNo == null ? null : pageNo,
        OcrEngine: clean(row.ocr_engine, 30) || null,
        Confidence: clean(row.ocr_confidence, 10) || null,
        ConfidenceNote: clean(row.ocr_note, 500) || null,
      });
    }
  }
  return rows;
}

// ---------- file access ----------

function fileMime(job) {
  const ext = (String(job.FileExtension || '').trim() || path.extname(String(job.FileName || ''))).toLowerCase();
  return MIME_BY_EXT[ext.startsWith('.') ? ext : `.${ext}`] || null;
}

// tbl_report_upload_document.file_path is relative to the report-upload
// store: read from REPORT_UPLOAD_BASE_FOLDER when set (worker on the file
// server), else download from REPORT_UPLOAD_BASE_URL.
async function fetchFile(job) {
  const rel = String(job.FilePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) throw new Error('Empty file_path.');
  const folder = process.env.REPORT_UPLOAD_BASE_FOLDER;
  if (folder) {
    const full = path.join(folder, rel);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${full}`);
    return fs.readFileSync(full);
  }
  const base = String(process.env.REPORT_UPLOAD_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('Set REPORT_UPLOAD_BASE_URL or REPORT_UPLOAD_BASE_FOLDER in .env.');
  const url = /^https?:\/\//i.test(rel) ? rel : `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`File is ${Math.round(buf.length / 1048576)}MB — over the ${MAX_BYTES / 1048576}MB cap.`);
  return buf;
}

// Decides the file type from its bytes, not its name: DCs upload JPEG photos
// named .png (seen on UAT, Oct 13), and the report-upload site answers a
// missing file with HTTP 200 and the frontend's index.html (SPA fallback), so
// neither the extension nor the status code can be trusted. Any PDF or image
// the OCR service can open is processed (it decodes images with Pillow by
// content); the extension is ignored. Returns the real mimetype, or null.
// Multi-page TIFF / animated GIF: only the first frame is read.
function sniffMime(buf) {
  const head = buf.subarray(0, 12);
  const ascii = (a, b) => head.toString('latin1', a, b);
  if (buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'application/pdf'; // some PDFs carry junk before the header
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'image/tiff';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  return null;
}

function checkFileBytes(buf, claimedMime) {
  const actual = sniffMime(buf);
  if (actual) return actual;
  const looksHtml = /^\s*<(!doctype|html)/i.test(buf.subarray(0, 64).toString('utf8'));
  throw new Error(looksHtml
    ? 'File not found on the report-upload server (got the website\'s HTML page instead of the file).'
    : `Not a PDF or image file (${claimedMime || 'unknown extension'}) — nothing to OCR.`);
}

// ---------- one report ----------

// Runs the pipeline and maps it to the API's SaveOcrResult body (minus the
// claim fields — OcrReportId / WorkerName are added by the caller).
// doubleOcr: the report's own double-OCR flag (double_ocr); it runs only if
// the .env flags allow it too (ocrEngines.doubleOcrFor).
// → { body: SaveOcrResult body, tesseract: SaveTesseractResult body | null }
async function extractForApi(buffer, mimetype, fileName, clientName, txLog, { doubleOcr = false } = {}) {
  // The OCR page cache is keyed by file name (pageReader.js); DC uploads
  // often share names ("report.pdf"), so prefix the content hash — two
  // different files can then never share cached OCR text.
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const cacheSafeName = `${fileHash.slice(0, 16)}_${path.basename(fileName || 'report')}`;
  const t0 = Date.now();
  const result = await extractWithOcrEngines(buffer, mimetype, cacheSafeName, {
    primaryEngine: primaryName(), secondEngine: doubleOcrFor(doubleOcr), typeIds: ['ALL'], engine: ENGINE, txLog,
  });
  const { validated, triageStage } = result;
  const patient = validated.patient || {};
  const first = (validated.reports || [])[0] || {};
  const resultJson = JSON.stringify({
    pipelineVersion: PIPELINE_VERSION, engine: ENGINE, ocr: result.ocr,
    pages: result.doc.pageTypes.map(({ page, type }) => ({ page, type })),
    sourceCheckRemoved: result.removed, timings: result.timings, data: validated,
  });
  const body = {
    FileHash: fileHash,
    PipelineVersion: PIPELINE_VERSION,
    PageCount: triageStage.pages.length,
    OcrPageCount: triageStage.pages.filter((p) => String(p.source).startsWith('ocr')).length,
    // pages classified as pathology (lab report) — tests come only from these
    PathologyPages: result.doc.pageTypes.filter((p) => p.type === 'lab').map((p) => p.page).join(',') || null,
    ProcessingMs: Date.now() - t0,
    // engine that read the scanned pages (second_ocr_engine_id is set by SaveTesseractResult)
    OcrEngine: result.ocr.primary,
    SecondOcrEngine: null,
    PatientName: clean(patient.name, 150) || null,
    PatientAge: clean(patient.age, 20) || null,
    PatientSex: clean(patient.sex, 20) || null,
    LabPatientId: clean(patient.patient_id, 50) || null,
    LabName: clean(first.lab_name, 200) || null,
    ReferringDoctor: clean(first.referring_doctor, 200) || null,
    SampleCollectedDate: toDbDateTime(first.sample_collected_date),
    ReportDate: toDbDateTime(first.report_date),
    NameMatchFlag: nameMatches(patient.name, clientName),
    RawText: result.ocrDump.slice(0, MAX_TEXT_CHARS),
    ResultJson: resultJson.length > MAX_TEXT_CHARS ? JSON.stringify({ truncated: true, pipelineVersion: PIPELINE_VERSION }) : resultJson,
    Rows: buildRows(validated),
  };
  return { body, tesseract: tesseractBody(result) };
}

// The double-OCR comparison result → SaveTesseractResult body (minus the
// claim fields), or null when the report wasn't double-OCR'd. Tesseract's
// result is saved as it read the report — its own pages, patient, tests.
function tesseractBody(result) {
  const o = result.ocr;
  if (!o.doubleOcrRequested) return null;
  if (o.secondaryError) return { Status: 'FAILED', ErrorMessage: clean(o.secondaryError, 2000), ProcessingMs: o.secondaryMs, PipelineVersion: PIPELINE_VERSION, Rows: [] };
  if (!result.secondary) {
    return { Status: 'DONE', Remark: clean(o.skipReason, 500), PipelineVersion: PIPELINE_VERSION, PageCount: result.triageStage.pages.length, OcrPageCount: 0, Rows: [] };
  }
  const s = result.secondary;
  const patient = s.validated.patient || {};
  const json = JSON.stringify({
    pipelineVersion: PIPELINE_VERSION, engine: ENGINE, ocrEngine: s.engine,
    pages: s.doc.pageTypes.map(({ page, type }) => ({ page, type })), timings: s.timings, data: s.validated,
  });
  return {
    Status: 'DONE',
    PipelineVersion: PIPELINE_VERSION,
    PageCount: s.triageStage.pages.length,
    OcrPageCount: s.triageStage.pages.filter((p) => String(p.source).startsWith('ocr')).length,
    PathologyPages: s.doc.pageTypes.filter((p) => p.type === 'lab').map((p) => p.page).join(',') || null,
    ProcessingMs: s.ms,
    PatientName: clean(patient.name, 150) || null,
    PatientAge: clean(patient.age, 20) || null,
    PatientSex: clean(patient.sex, 20) || null,
    LabPatientId: clean(patient.patient_id, 50) || null,
    RawText: s.ocrDump.slice(0, MAX_TEXT_CHARS),
    ResultJson: json.length > MAX_TEXT_CHARS ? JSON.stringify({ truncated: true, pipelineVersion: PIPELINE_VERSION }) : json,
    Rows: buildRows(s.validated),
  };
}

// Extract one claimed report from its file bytes and save it through the
// API (sp_save_ocr_result — also maps tests and updates case progress).
// Throws on any failure; the caller records it.
async function extractAndSave(api, workerName, job, buffer, mimetype, txLog) {
  const label = `report ${job.OcrReportId} (case ${job.CaseId}, ${job.FileName})`;
  const t0 = Date.now();
  mimetype = checkFileBytes(buffer, mimetype); // the real type, whatever the extension says
  const { body, tesseract } = await extractForApi(buffer, mimetype, job.FileName, job.ClientName, txLog, { doubleOcr: Number(job.DoubleOcr) === 1 });
  const saved = await api.call('/api/Ocr/SaveOcrResult', {
    OcrReportId: job.OcrReportId, WorkerName: workerName, ...body, ProcessingMs: Date.now() - t0,
  });
  console.log(`[${workerName}] saved ${label}: ${saved.RowsSaved} row(s)${saved.RowsSkipped ? `, ${saved.RowsSkipped} skipped` : ''}, ` +
    `${body.PageCount} page(s) (${body.OcrPageCount} OCR, ${body.OcrEngine}), ${Math.round((Date.now() - t0) / 1000)}s`);
  // double OCR: Tesseract's own result, for comparison — saved after the
  // primary result; a problem here is logged, never fails the report
  let tessSaved = null;
  if (tesseract) {
    try {
      tessSaved = await api.call('/api/Ocr/SaveTesseractResult', { OcrReportId: job.OcrReportId, WorkerName: workerName, ...tesseract });
      console.log(`[${workerName}]   Tesseract ${tesseract.Status}: ${tessSaved.RowsSaved} row(s)` +
        `${tesseract.ErrorMessage ? ` — ${tesseract.ErrorMessage}` : ''}${tesseract.Remark ? ` — ${tesseract.Remark}` : ''}`);
    } catch (err) {
      console.error(`[${workerName}]   could not save the Tesseract result of ${label}: ${err.message}`);
    }
  }
  if (txLog) txLog.writeJson('00_summary.json', { ocrReportId: job.OcrReportId, caseId: job.CaseId, rows: saved.RowsSaved, tesseract: tesseract ? { status: tesseract.Status, rows: tessSaved ? tessSaved.RowsSaved : null } : null, pipelineVersion: PIPELINE_VERSION, totalMs: Date.now() - t0 });
  return { saved, body, tesseract };
}

async function recordFailure(api, workerName, job, err, t0) {
  try {
    const f = await api.call('/api/Ocr/MarkReportFailed', {
      OcrReportId: job.OcrReportId, WorkerName: workerName, ErrorMessage: clean(err.message, 2000), ProcessingMs: Date.now() - t0,
    });
    console.log(`[${workerName}] ${f.Message}`);
  } catch (apiErr) {
    // left PROCESSING — RequeueStuckReports picks it up later
    console.error(`[${workerName}] could not record the failure: ${apiErr.message}`);
  }
}

async function processOne(api, workerName) {
  let claim;
  try {
    claim = await api.call('/api/Ocr/ClaimReport', { WorkerName: workerName });
  } catch (err) {
    if (err instanceof OcrApiError && err.status === 404) return false; // queue empty
    throw err;
  }
  const job = claim.Report;
  if (!job) return false;

  const label = `report ${job.OcrReportId} (case ${job.CaseId}, ${job.FileName})`;
  console.log(`[${workerName}] claimed ${label} — attempt ${job.AttemptCount}${Number(job.DoubleOcr) === 1 ? ', double OCR requested' : ''}`);
  const t0 = Date.now();
  const txLog = createTransactionLog(`ocr${job.OcrReportId}_${job.FileName || 'report'}`);
  try {
    const buffer = await fetchFile(job);
    await extractAndSave(api, workerName, job, buffer, fileMime(job), txLog); // type is checked from the bytes
  } catch (err) {
    console.error(`[${workerName}] FAILED ${label}: ${err.message}`);
    txLog.writeJson('ERROR.json', { ocrReportId: job.OcrReportId, message: err.message, details: err.details || null });
    await recordFailure(api, workerName, job, err, t0);
  }
  return true;
}

// ---------- modes ----------

async function dryRun(file, doubleOcr) {
  const buffer = fs.readFileSync(file);
  const { body, tesseract } = await extractForApi(buffer, checkFileBytes(buffer, null), path.basename(file), process.env.DRY_RUN_CLIENT_NAME || '', null, { doubleOcr });
  const show = (label, b) => {
    const { Rows, RawText, ResultJson, ...header } = b;
    console.log(`===== ${label}`);
    console.log(JSON.stringify({ ...header, Engine: ENGINE, RawTextChars: (RawText || '').length, ResultJsonChars: (ResultJson || '').length, RowCount: Rows.length }, null, 2));
    if (Rows.length) {
      console.table(Rows.map((x) => ({
        type: x.ReportTypeCode, test: x.TestNameRaw, value: x.Value, unit: x.Unit,
        range: x.RangeRaw, min: x.MinRange, max: x.MaxRange, page: x.PageNo,
        engine: x.OcrEngine, conf: x.Confidence,
      })));
    }
  };
  show('SaveOcrResult (tbl_ocr_data)', body);
  if (tesseract) show('SaveTesseractResult (tbl_ocr_data_tesseract) — comparison only', tesseract);
}

// TEST TOOL — `node worker.js --file <report> --case <case_id>`: treat a
// local file as if the DC had uploaded it and report QC had passed — queue
// it for that case (api/Ocr/QueueManualReport → sp_insert_ocr_manual_report,
// already claimed by this process, one attempt) and save it right away.
// Everything after the queue rows (OCR, SaveOcrResult, test mapping, case
// progress) is the real path. The case needs a digitization record.
async function manualUpload(file, caseId, doubleOcr) {
  const ext = path.extname(file).toLowerCase();
  const buffer = fs.readFileSync(file);
  checkFileBytes(buffer, null); // fail before queueing anything if it isn't a PDF / image
  const api = createClientFromEnv();
  const workerName = `${os.hostname()}-${process.pid}-manual`.slice(0, 50);
  const fileName = path.basename(file, ext).slice(0, 255);
  try {
    const q = await api.call('/api/Ocr/QueueManualReport', { CaseId: caseId, FileName: fileName, FileExtension: ext, WorkerName: workerName, DoubleOcr: doubleOcr ? 1 : 0 });
    const job = { OcrReportId: q.OcrReportId, CaseId: caseId, FileName: fileName, ClientName: q.ClientName, DoubleOcr: doubleOcr ? 1 : 0 };
    console.log(`Queued manual upload: case ${caseId} (${q.ClientName}), ocr_case_id ${q.OcrCaseId}, ocr_report_id ${q.OcrReportId}`);

    const t0 = Date.now();
    try {
      const { body } = await extractAndSave(api, workerName, job, buffer, null, createTransactionLog(`ocr${q.OcrReportId}_manual_${fileName}`));
      console.table(body.Rows.map((x) => ({
        type: x.ReportTypeCode, test: x.TestNameRaw, value: x.Value, unit: x.Unit, range: x.RangeRaw, min: x.MinRange, max: x.MaxRange,
        engine: x.OcrEngine, conf: x.Confidence,
      })));
      console.log(`Saved. Mapping (test_id / sub_test_id) is filled in the DB — check with:\n` +
        `  SELECT * FROM tbl_ocr_data WHERE ocr_report_id = ${q.OcrReportId} AND is_active = 1;`);
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      await recordFailure(api, workerName, job, err, t0);
      process.exitCode = 1;
    }
  } finally {
    await api.close();
  }
}

async function run({ once }) {
  const api = createClientFromEnv();
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('Stopping after the current report(s)… (Ctrl+C again to force)');
  });

  const cfg = ocrConfig();
  console.log(`OCR worker: engine=${ENGINE}, version=${PIPELINE_VERSION}, concurrency=${CONCURRENCY}, api=${process.env.OCR_API_URL}`);
  console.log(`OCR engines: primary=${cfg.primary}, double OCR=${cfg.secondary ? `on for reports with double_ocr = 1 (second: ${cfg.secondary})` : 'off'}` +
    `, enabled: ${Object.entries(cfg.enabled).filter(([, on]) => on).map(([n]) => n).join(', ')}`);
  cfg.problems.forEach((p) => console.log(`  !! ${p}`));
  const loop = async (i) => {
    const name = `${os.hostname()}-${process.pid}-${i}`.slice(0, 50);
    while (!stopping) {
      let worked = false;
      try {
        worked = await processOne(api, name);
      } catch (err) {
        console.error(`[${name}] ${err.message}`); // API unreachable etc. — back off and retry
      }
      if (once) return;
      if (!worked && !stopping) await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  await Promise.all(Array.from({ length: once ? 1 : CONCURRENCY }, (_, i) => loop(i + 1)));
  await api.close();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const caseIdx = args.indexOf('--case');
  const caseId = caseIdx >= 0 ? parseInt(args[caseIdx + 1], 10) : null;
  if (caseIdx >= 0 && !Number.isInteger(caseId)) { console.error('--case needs a numeric case_id'); process.exit(1); }
  // the primary engine must be usable before any report is claimed
  try { getEngine(primaryName()); } catch (err) { console.error(err.message); process.exit(1); }
  const doubleOcr = args.includes('--double');
  if (doubleOcr && !doubleOcrFor(true)) console.log(`!! --double: double OCR cannot run with these flags — ${ocrConfig().problems.join(' ') || 'OCR_DOUBLE_ENABLED is off'}.`);
  (fileIdx >= 0 && caseId ? manualUpload(args[fileIdx + 1], caseId, doubleOcr)
    : fileIdx >= 0 ? dryRun(args[fileIdx + 1], doubleOcr)
      : run({ once: args.includes('--once') }))
    .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { toDbDateTime, nameMatches, buildRows };
