// Calls a small, locally self-hosted model (via Ollama) to do the ONLY thing
// it needs to do here: take the OCR stage's already-correct reading of the
// page (Unlimited-OCR here) and organize it into our schema. It never
// re-reads the image — it only reasons over plain text already extracted.
//
// LIKE ../deepseek-ocr/ollama.js and UNLIKE ../paddleocr/ollama.js /
// ../azure-llm/ollama.js, this prompt is written specifically for this
// reading stage's actual output shape — confirmed via one real test (see
// unlimitedocr.js's file header / PROGRESS.md): Unlimited-OCR produces
// genuinely clean markdown with real HTML <table> tags, a real improvement
// over every other free reading stage tried here. The one real quirk: the
// main test-panel table (test name + value) and the units/reference-range
// table come back as TWO SEPARATE tables, not one four-column table — but
// in matching row order, so they need to be zipped together positionally,
// not treated as independent data.

const { fetch: undiciFetch, Agent } = require('undici');
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    patient: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'string' },
        sex: { type: 'string' },
        patient_id: { type: 'string' },
        contact_number: { type: 'string' },
      },
      required: ['name', 'age', 'sex', 'patient_id', 'contact_number'],
    },
    reports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          report_type: { type: 'string' },
          lab_name: { type: 'string' },
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
                range: { type: 'string' },
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

function buildPrompt(ocrDump) {
  return `You are given the OCR output of a diagnostic lab report, produced by a document-parsing model that already reconstructed real tables as HTML <table> markup. Your only job is to reorganize this into the target schema — the reading itself is already correct.

WHAT THE INPUT LOOKS LIKE:
- A patient-info table near the top with TWO field/value pairs per row (4 cells per <tr>: field name, value, field name, value) — e.g. one row might contain both "Name: Mrs. X" and "Reg No: R-002301". Read both pairs from each row.
- Section headings in plain text (e.g. "HAEMATOLOGY", "BIOCHEMISTRY") mark the start of a new distinct report — split the file into separate report entries at these headings.
- The main test-panel table: each row is a test name (sometimes prefixed with "* ", strip that prefix) and its result value — e.g. <tr><td>* Haemoglobin ( Hb )</td><td>13.6</td></tr>.
- CRITICAL: immediately after (or near) the main test-panel table, there is USUALLY A SEPARATE table containing ONLY units and reference ranges, in the SAME ROW ORDER as the main table's tests — e.g. row 1 of that table is the unit/range for row 1 of the main table, row 2 for row 2, and so on. This second table's first row may instead be a "Sample Tested In : <specimen type>" label rather than a real unit/range — if so, skip that one row and start the positional match from the next row. Match unit/range to test ONLY by this row-position alignment, never by guessing from context. If the two tables don't have a clean matching row count (after accounting for a possible leading label row), leave unit and range as empty strings for the rows you can't confidently align — do not guess.
- A row whose value is a placeholder like "----" (e.g. a sub-heading such as "DLC ( Differential Leucocyte Count )" that has no value of its own, just labels a group of tests below it) should still be included as a row with an empty value, not dropped and not treated as a real result.

Organize this into patient details (name, age, sex, patient id, contact number) and a list of reports, each with its lab name, referring doctor, sample collected date, and report date if present, and its list of test rows (test, value, unit, range).

If a field is not present anywhere in the text, or cannot be confidently determined per the rules above, use an empty string — never guess or invent a value.
Return only the structured data.

--- OCR OUTPUT ---
${ocrDump}`;
}

// Used by sections.js's per-page report-identification pass (the
// "selective categorization" flow — see PROGRESS.md): a much cheaper call
// than full categorize() above, since it only lists names, never values. It
// runs on ONE PAGE at a time, which is small enough to stay well inside
// Ollama's default 2048-token context — this is what actually fixes the
// context-truncation bug for identification, not a bigger num_ctx: each
// call's input is naturally short, so nothing gets truncated.
const SECTION_LIST_SCHEMA = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: { type: 'string' } },
  },
  required: ['sections'],
};

function buildIdentifyPrompt(pageText) {
  return `You are looking at ONE PAGE of a diagnostic lab report. List the distinct test/report panel names that appear on this page (e.g. "CBC (Complete Blood Count)", "HIV Antibody", "Total Cholesterol", "Urine Routine & Examination").

Ignore page headers/footers, patient-info fields (name, age, reg no, etc.), disclaimers, and clinical-significance explanation paragraphs — only list actual named test/report sections that have their own result row(s). If this page has no such section (e.g. a pure disclaimer or cover page), return an empty list. Return short section names only, one per section, no descriptions.

--- PAGE TEXT ---
${pageText}`;
}

async function identifySections(pageText) {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.CATEGORIZE_MODEL || 'llama3.2:3b';

  let res;
  try {
    res = await undiciFetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: buildIdentifyPrompt(pageText),
        stream: false,
        format: SECTION_LIST_SCHEMA,
        think: false,
      }),
      dispatcher: noTimeoutAgent,
    });
  } catch (networkErr) {
    const err = new Error(
      `Could not reach Ollama at ${url} (${networkErr.message}). Is it installed and running? ` +
      `Try: ollama serve — and make sure you've run "ollama pull ${model}" at least once.`,
    );
    err.status = 502;
    throw err;
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error(`Ollama returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(parsed?.error || `Ollama returned an error (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }

  const text = parsed.response;
  if (!text) return [];

  try {
    const body = JSON.parse(text);
    return Array.isArray(body.sections) ? body.sections.filter((s) => typeof s === 'string' && s.trim()) : [];
  } catch {
    return [];
  }
}

async function categorize(ocrDump) {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.CATEGORIZE_MODEL || 'llama3.2:3b';

  let res;
  try {
    res = await undiciFetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: buildPrompt(ocrDump),
        stream: false,
        format: RESPONSE_SCHEMA,
        think: false,
      }),
      dispatcher: noTimeoutAgent,
    });
  } catch (networkErr) {
    const err = new Error(
      `Could not reach Ollama at ${url} (${networkErr.message}). Is it installed and running? ` +
      `Try: ollama serve — and make sure you've run "ollama pull ${model}" at least once.`,
    );
    err.status = 502;
    throw err;
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error(`Ollama returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(parsed?.error || `Ollama returned an error (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }

  const text = parsed.response;
  if (!text) {
    const err = new Error('Ollama response did not contain the expected "response" field.');
    err.status = 502;
    err.details = parsed;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('The local model returned output that was not valid JSON, even with schema-constrained decoding.');
    err.status = 502;
    err.details = { text };
    throw err;
  }
}

module.exports = { categorize, identifySections };
