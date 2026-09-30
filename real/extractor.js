// Shared extraction logic — used by both server.js (the web UI) and
// test-extract.js (a direct CLI test against a local file), so the two
// never drift apart.

// The shape we ask Gemini to return.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    patient: {
      type: 'object',
      description: 'Demographic details of the patient, shared across every report in this file — leave a field as an empty string if it is not printed anywhere.',
      properties: {
        name: { type: 'string' },
        age: { type: 'string', description: 'As printed, e.g. "34" or "34 Years".' },
        sex: { type: 'string' },
        patient_id: { type: 'string', description: 'Patient/UHID/registration number, if printed.' },
        contact_number: { type: 'string' },
      },
      required: ['name', 'age', 'sex', 'patient_id', 'contact_number'],
    },
    reports: {
      type: 'array',
      description: 'One entry per distinct diagnostic report found in the file, even if several are bundled into one PDF.',
      items: {
        type: 'object',
        properties: {
          report_type: { type: 'string', description: 'e.g. "Complete Blood Count", "Lipid Profile"' },
          lab_name: { type: 'string', description: 'Name of the diagnostic centre/lab printed on this report, if any.' },
          referring_doctor: { type: 'string' },
          sample_collected_date: { type: 'string' },
          report_date: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                test: { type: 'string' },
                value: { type: 'string' },
                unit: { type: 'string' },
                range: { type: 'string', description: 'The reference range as printed on the report.' },
              },
              required: ['test', 'value', 'unit', 'range'],
            },
          },
        },
        required: ['report_type', 'lab_name', 'referring_doctor', 'sample_collected_date', 'report_date', 'rows'],
      },
    },
  },
  required: ['patient', 'reports'],
};

const PROMPT = `You are extracting structured data from a diagnostic lab report (a scanned PDF or image).

First, extract the patient's demographic details (name, age, sex, patient/UHID id, contact number) — these usually appear once near the top and apply to every report in the file.

The file may contain more than one distinct report bundled together (for example, a CBC and a Lipid Profile in the same PDF) — detect and separate each one into its own entry, and for each one also extract the lab/diagnostic centre name, the referring doctor, the sample collection date, and the report date, exactly as printed.

For every test row in every report, extract: the test name, the result value, the unit, and the reference range exactly as printed.

If any field (patient or report-level) is not printed anywhere in the document, return it as an empty string rather than guessing or omitting it.
Return only the structured data — no extra commentary.`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// On a 429 quota error, Google tells us exactly how long to wait via a
// RetryInfo entry in error.details (retryDelay, e.g. "34s") — reading
// that instead of guessing matters here: our own exponential backoff was
// consistently too short against real quota resets, and blindly retrying
// on a quota error just burns more of the same limited request budget
// instead of waiting it out. Falls back to null if Google didn't send one
// (e.g. on a plain 503 overload, which has no quota window to report).
function extractRetryDelayMs(details) {
  const retryInfo = details?.error?.details?.find((d) => d['@type']?.includes('RetryInfo'));
  const match = /^([\d.]+)s$/.exec(retryInfo?.retryDelay || '');
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

// 429 (rate limited) and 503 (model overloaded) are both transient on
// Google's side — retrying after a short backoff usually succeeds without
// the caller having to manually retry. Anything else (bad key, bad
// request, model not found) fails immediately since retrying won't help.
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 16000;

async function callGeminiOnce(fileBuffer, mimeType, { model, apiKey }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: fileBuffer.toString('base64') } },
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    // fetch() itself throws (not an HTTP error response) on a dropped
    // connection, DNS hiccup, or timeout — just as transient as a 503, so
    // mark it retryable the same way instead of letting it bubble up raw.
    const err = new Error(`Network error calling Gemini: ${networkErr.message}`);
    err.status = 503;
    throw err;
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error(`Gemini returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const message = parsed?.error?.message || `Gemini API error (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.details = parsed;
    throw err;
  }

  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const err = new Error('Gemini response did not contain the expected output — see raw response in server logs.');
    err.status = 502;
    err.details = parsed;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Gemini returned output that was not valid JSON, even though JSON mode was requested.');
    err.status = 502;
    err.details = { text };
    throw err;
  }
}

async function callGemini(fileBuffer, mimeType, { model, apiKey }) {
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not set. Add it to OCR/real/.env and restart.');
    err.status = 500;
    throw err;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGeminiOnce(fileBuffer, mimeType, { model, apiKey });
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (!RETRYABLE_STATUS.has(err.status) || isLastAttempt) throw err;
      const googleRetryDelayMs = extractRetryDelayMs(err.details);
      const backoffMs = googleRetryDelayMs ?? Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS); // 1s, 2s, 4s, 8s, 16s
      console.warn(`Gemini call failed (${err.message}) — retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS}${googleRetryDelayMs ? ', delay from Google' : ''})`);
      await sleep(backoffMs);
    }
  }
}

module.exports = { callGemini };
