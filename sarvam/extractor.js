// Shared extraction logic — used by both server.js (the web UI) and
// test-extract.js (a direct CLI test against a local file), so the two
// never drift apart. Mirrors the shape of real/extractor.js (the Gemini
// POC) as closely as Sarvam's API allows, so the two are directly
// comparable — see OCR/README.md and the cost-comparison workbook.
//
// Sarvam AI's Document AI "Extract" endpoint (docs.sarvam.ai) takes a
// document plus a JSON Schema and returns only the defined fields as
// structured JSON — the same "one call does OCR + structuring" shape as
// Gemini's responseSchema, unlike Azure Document Intelligence (OCR only,
// needs a separate LLM/rules step). It also returns a per-field
// confidence score, which Gemini's response does not.
//
// CONFIRMED via a live test (Sept 2026): Sarvam requires a non-empty
// `description` on EVERY node in the schema, not just leaf fields — the
// `object`/`array` container nodes (root, and every `items` object) need
// one too, or the job fails with "field X: array items: each field
// requires a non-empty description". The schema below has been fixed to
// include one everywhere; if you add a new field or nesting level, give
// it a description immediately or expect the same error.
//
// CONFIRMED via a live test (Sept 2026): the original nested
// `reports[] -> rows[]` schema DOES exceed Sarvam's stated max-4-level
// nesting limit — the API rejected it with `field "reports": array
// items: field "rows": array items: field "test": schema nesting may
// not exceed 4 levels`. Counting confirmed: root(1) -> reports(2) ->
// reports.items(3) -> rows(4) -> rows.items(5) is already over the line
// before you even reach a leaf field.
//
// FIX APPLIED: the schema below asks Sarvam for a single FLAT `rows`
// array (root(1) -> rows(2) -> rows.items(3) -> leaf fields(4) — exactly
// 4), where every row repeats its own report-level fields
// (report_type/lab_name/referring_doctor/sample_collected_date/
// report_date) instead of being nested under a parent `reports` object.
// `callSarvam()` below re-groups that flat list back into the shared
// `{ patient, reports: [{ ..., rows: [...] }] }` contract (by grouping
// rows that share identical report-level fields) before returning, so
// server.js/test-extract.js/public/index.html — and the contract shared
// with real/azure-llm/paddleocr — don't need to know this happened.
// Not yet confirmed: whether Sarvam Vision actually repeats the
// report-level fields identically on every row of the same report (if
// it varies them slightly run-to-run, e.g. "CBC" vs "Complete Blood
// Count" for the same report, groupRowsIntoReports() below will
// incorrectly split what should be one report into several — check the
// real output for this before trusting the grouping).
//
// TWO MODES: 'lab' (LAB_SCHEMA, the original diagnostic-report shape
// above) and 'mer' (MER_SCHEMA, a Medical Examination Report
// questionnaire — question/answer pairs, not test rows). callSarvam()
// takes a `mode` option (default 'lab') and picks the matching entry in
// MODES below. server.js/public/index.html let the caller pick which
// one to use per upload — these are structurally different document
// types (lab report vs. underwriting questionnaire) with different
// schemas, not different settings on the same schema.

const LAB_SCHEMA = {
  type: 'object',
  description: 'Structured data extracted from a diagnostic lab report: the patient it belongs to, and every test row across every report bundled in the file.',
  properties: {
    patient: {
      type: 'object',
      description: "Demographic details of the patient, shared across every report in this file. Leave a field as an empty string if it is not printed anywhere.",
      properties: {
        name: { type: 'string', description: 'Patient full name, as printed.' },
        age: { type: 'string', description: 'Patient age as printed, e.g. "34" or "34 Years".' },
        sex: { type: 'string', description: 'Patient sex/gender as printed.' },
        patient_id: { type: 'string', description: 'Patient/UHID/registration number, if printed.' },
        contact_number: { type: 'string', description: 'Patient contact/phone number, if printed.' },
      },
    },
    rows: {
      type: 'array',
      description: 'One entry per test row, across every distinct report bundled in this file (e.g. a CBC and a Lipid Profile in the same file). Every row must repeat the report-level fields (report_type, lab_name, referring_doctor, sample_collected_date, report_date) of the report it belongs to, identically for every row of that same report, so rows can be grouped back by report afterward.',
      items: {
        type: 'object',
        description: 'One test row, tagged with which report it belongs to.',
        properties: {
          report_type: { type: 'string', description: 'Name of the report this row belongs to, e.g. "Complete Blood Count", "Lipid Profile". Use the exact same value for every row of the same report.' },
          lab_name: { type: 'string', description: 'Name of the diagnostic centre/lab printed on this report, if any. Same value for every row of the same report.' },
          referring_doctor: { type: 'string', description: 'Referring doctor name, if printed. Same value for every row of the same report.' },
          sample_collected_date: { type: 'string', description: 'Sample collection date, as printed. Same value for every row of the same report.' },
          report_date: { type: 'string', description: 'Report date, as printed. Same value for every row of the same report.' },
          test: { type: 'string', description: 'Test name, as printed.' },
          value: { type: 'string', description: 'Result value, as printed.' },
          unit: { type: 'string', description: 'Unit of measurement, as printed.' },
          range: { type: 'string', description: 'Reference range, as printed.' },
        },
      },
    },
  },
};

// Added after a real MER (Medical Examination Report) PDF was tested with
// a one-off script — confirmed working (66/66 Q&A pairs, high confidence,
// correctly caught the one non-trivial "Yes" answer in the form) before
// being folded into the real demo here. See PROGRESS.md "MER questionnaire
// extraction — second schema, confirmed working" for the full result.
const MER_SCHEMA = {
  type: 'object',
  description: 'Structured data extracted from a Medical Examination Report (MER) questionnaire: the patient/proposer it belongs to, and every question/answer pair in the form.',
  properties: {
    patient: {
      type: 'object',
      description: 'Demographic details of the patient/proposer named on this form. Leave a field as an empty string if not printed anywhere.',
      properties: {
        name: { type: 'string', description: 'Full name, as printed.' },
        age: { type: 'string', description: 'Age as printed.' },
        sex: { type: 'string', description: 'Sex/gender as printed.' },
      },
    },
    qa_pairs: {
      type: 'array',
      description: 'Every question printed on this form and its corresponding answer, in the order printed on the page — including Yes/No questions, checkbox selections, and free-text/numeric answers (e.g. height, weight, blood pressure readings).',
      items: {
        type: 'object',
        description: 'One question and its answer.',
        properties: {
          question: { type: 'string', description: 'The question text, exactly as printed.' },
          answer: { type: 'string', description: 'The answer given — e.g. "Yes", "No", a checked option, a written or numeric response. Empty string if left unanswered.' },
        },
      },
    },
  },
};

// One entry per document type this demo can extract. `normalize` turns
// Sarvam's raw `result` object into the shape server.js/public/index.html
// render — lab mode needs groupRowsIntoReports() (see the big comment
// above); mer mode's `qa_pairs` is already flat and within the depth
// limit, so no re-grouping is needed.
const MODES = {
  lab: {
    schema: LAB_SCHEMA,
    normalize: (data) => ({
      patient: data.patient || {},
      reports: groupRowsIntoReports(Array.isArray(data.rows) ? data.rows : []),
    }),
  },
  mer: {
    schema: MER_SCHEMA,
    normalize: (data) => ({
      patient: data.patient || {},
      qa_pairs: Array.isArray(data.qa_pairs) ? data.qa_pairs : [],
    }),
  },
};

// Re-groups the flat rows[] Sarvam returns back into the shared
// { report_type, lab_name, ..., rows: [...] }[] shape, by grouping
// consecutive/identical report-level fields. Order-preserving: reports
// appear in the order their first row appeared.
function groupRowsIntoReports(flatRows) {
  const order = [];
  const byKey = new Map();
  for (const row of flatRows) {
    const reportFields = {
      report_type: row.report_type || '',
      lab_name: row.lab_name || '',
      referring_doctor: row.referring_doctor || '',
      sample_collected_date: row.sample_collected_date || '',
      report_date: row.report_date || '',
    };
    const key = JSON.stringify(reportFields);
    if (!byKey.has(key)) {
      byKey.set(key, { ...reportFields, rows: [] });
      order.push(key);
    }
    byKey.get(key).rows.push({
      test: row.test || '',
      value: row.value || '',
      unit: row.unit || '',
      range: row.range || '',
    });
  }
  return order.map((key) => byKey.get(key));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url, options, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      if (attempt === maxAttempts) {
        const err = new Error(`Network error calling Sarvam AI: ${networkErr.message}`);
        err.status = 502;
        throw err;
      }
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    return res;
  }
}

async function parseJsonResponse(res, contextLabel) {
  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    const err = new Error(`Sarvam ${contextLabel} returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const message = parsed?.error?.message || parsed?.message || `Sarvam ${contextLabel} failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.details = parsed;
    throw err;
  }
  return parsed;
}

// Submits the document + schema, polls until the job finishes, and
// returns the extracted { patient, reports } shape. Sarvam's Extract API
// is an async job (submit -> poll status -> fetch results), unlike
// Gemini's single synchronous call — see azure-llm/azure.js for the same
// submit/poll pattern against a different vendor.
//
// No timeout on the poll loop, by request — PROGRESS.md records two real
// jobs that sat in `pending` far longer than the old 3-minute ceiling
// (and never progressed at all, as far as those tests watched). This
// polls indefinitely and logs a heartbeat periodically so a long wait is
// visible instead of silent; stop it yourself (Ctrl+C) if you conclude a
// job is genuinely stuck rather than just slow — see PROGRESS.md for how
// to check a job's status directly.
const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_EVERY_N_POLLS = 8; // ~every 16s at the interval above

async function callSarvam(fileBuffer, mimeType, filename, { apiKey, baseUrl, language, mode }) {
  if (!apiKey) {
    const err = new Error('SARVAM_API_KEY is not set. Add it to OCR/sarvam/.env and restart.');
    err.status = 500;
    throw err;
  }

  const modeKey = mode || 'lab';
  const modeConfig = MODES[modeKey];
  if (!modeConfig) {
    const err = new Error(`Unknown mode "${modeKey}" — expected one of: ${Object.keys(MODES).join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const base = (baseUrl || 'https://api.sarvam.ai').replace(/\/+$/, '');
  const headers = { 'api-subscription-key': apiKey };

  // --- 1. Create the job ---
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename || 'report');
  form.append('schema', JSON.stringify(modeConfig.schema));
  form.append('language', language || 'en-IN');
  form.append('output_format', 'json');

  const createRes = await fetchWithRetry(`${base}/doc-ai/v1/job/extract`, {
    method: 'POST',
    headers,
    body: form,
  });
  const created = await parseJsonResponse(createRes, 'job creation');

  const jobId = created.job_id;
  if (!jobId) {
    const err = new Error('Sarvam accepted the request but did not return a job_id to poll.');
    err.status = 502;
    err.details = created;
    throw err;
  }

  // --- 2. Poll until it finishes — no timeout, see comment above ---
  let lastStatus = created.status;
  let pollCount = 0;
  if (lastStatus === 'failed' || lastStatus === 'rejected') {
    const err = new Error(`Sarvam job ${lastStatus}: ${JSON.stringify(created)}`);
    err.status = 502;
    throw err;
  }
  while (lastStatus !== 'completed' && lastStatus !== 'partially_completed') {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;
    const pollRes = await fetchWithRetry(`${base}/doc-ai/v1/job/${jobId}/status`, { headers });
    const pollBody = await parseJsonResponse(pollRes, 'status poll');
    lastStatus = pollBody.status;
    if (lastStatus === 'failed' || lastStatus === 'rejected') {
      const err = new Error(`Sarvam job ${lastStatus}: ${JSON.stringify(pollBody)}`);
      err.status = 502;
      err.details = pollBody;
      throw err;
    }
    if (pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
      const elapsedS = Math.round((pollCount * POLL_INTERVAL_MS) / 1000);
      const pages = pollBody.usage ? `${pollBody.usage.pages_processed ?? 0}/${pollBody.usage.pages_total ?? '?'} pages` : 'no usage info yet';
      console.log(`Sarvam job ${jobId} still "${lastStatus}" after ${elapsedS}s (${pages}). Still waiting — no timeout, Ctrl+C to give up.`);
    }
  }

  // --- 3. Fetch the results ---
  const resultsRes = await fetchWithRetry(`${base}/doc-ai/v1/job/${jobId}/results`, { headers });
  const resultsBody = await parseJsonResponse(resultsRes, 'results fetch');

  const data = resultsBody.result;
  if (!data) {
    const err = new Error('Sarvam job completed but the results response had no `result` field — see raw response in server logs.');
    err.status = 502;
    err.details = resultsBody;
    throw err;
  }

  // Normalize per-mode — see MODES above. Guards against a missing
  // patient/rows/qa_pairs key (e.g. on a partially_completed job) rather
  // than letting the caller crash on undefined.
  return modeConfig.normalize(data);
}

module.exports = { callSarvam, LAB_SCHEMA, MER_SCHEMA, MODES, groupRowsIntoReports };
