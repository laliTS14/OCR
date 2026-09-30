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

// Context window, set explicitly instead of relying on Ollama's 2048-token
// default (which silently drops the FRONT of any longer prompt — including
// the instructions, since they come first; see PROGRESS.md bug #3). 4096 is
// sized for the per-section flow: one page (~500-1500 prompt tokens) plus
// its JSON output fits comfortably. A whole multi-page document does NOT fit
// — the truncation warning below will say so. Keep this one fixed value:
// changing num_ctx between calls forces Ollama to reload the model.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 4096;

// Ollama reports exactly how many tokens it read (prompt_eval_count) and
// wrote (eval_count). A prompt_eval_count at/near NUM_CTX means the input
// was truncated — the tell-tale sign of the missing-panels bug.
function logTokenUsage(label, model, parsed) {
  const promptTokens = parsed.prompt_eval_count ?? 0;
  const outputTokens = parsed.eval_count ?? 0;
  const seconds = ((parsed.total_duration ?? 0) / 1e9).toFixed(1);
  const truncated = promptTokens >= NUM_CTX - 8;
  console.log(
    `[ollama] ${label} model=${model} num_ctx=${NUM_CTX} prompt_tokens=${promptTokens} ` +
    `output_tokens=${outputTokens} total=${promptTokens + outputTokens} time=${seconds}s` +
    (truncated ? '  ⚠ PROMPT TRUNCATED — input exceeded num_ctx' : ''),
  );
  return { promptTokens, outputTokens, numCtx: NUM_CTX, truncated };
}

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
- A patient-info table near the top with TWO field/value pairs per row (4 cells per <tr>: field name, value, field name, value) — e.g. one row might contain both "Name: <name>" and "Reg No: <id>". Read both pairs from each row.
- Section headings in plain text (e.g. "HAEMATOLOGY", "BIOCHEMISTRY") mark the start of a new distinct report — split the file into separate report entries at these headings.
- The main test-panel table: each row is a test name (sometimes prefixed with "* ", strip that prefix) and its result value — e.g. <tr><td>* <test name></td><td><value></td></tr>.
- CRITICAL: immediately after (or near) the main test-panel table, there is USUALLY A SEPARATE table containing ONLY units and reference ranges, in the SAME ROW ORDER as the main table's tests — e.g. row 1 of that table is the unit/range for row 1 of the main table, row 2 for row 2, and so on. This second table's first row may instead be a "Sample Tested In : <specimen type>" label rather than a real unit/range — if so, skip that one row and start the positional match from the next row. Match unit/range to test ONLY by this row-position alignment, never by guessing from context. If the two tables don't have a clean matching row count (after accounting for a possible leading label row), leave unit and range as empty strings for the rows you can't confidently align — do not guess.
- A row whose value is a placeholder like "----" (e.g. a sub-heading such as "DLC ( Differential Leucocyte Count )" that has no value of its own, just labels a group of tests below it) should still be included as a row with an empty value, not dropped and not treated as a real result.

Organize this into patient details (name, age, sex, patient id, contact number) and a list of reports, each with its lab name, referring doctor, sample collected date, and report date if present, and its list of test rows (test, value, unit, range).

If a field is not present anywhere in the text, or cannot be confidently determined per the rules above, use an empty string — never guess or invent a value.
Return only the structured data.

--- OCR OUTPUT ---
${ocrDump}`;
}

// Prompt for the select-first flow (selectReports.js): input is ONE
// already-located report section as plain text (text layer or OCR), not
// HTML tables. Deliberately contains NO real example values — the HTML
// prompt above used to quote real values from one patient's report, and the
// model copied them into a different patient's output (Sept 29: another
// patient's Reg No and Hb value appeared in a Redcliffe extraction).
function buildSectionPrompt(sectionText, reportLabel) {
  return `Below is ONE section of a diagnostic lab report — the "${reportLabel}" section — already cut out of the full document. It may start with the page's patient header block. Your only job is to organize it into the target schema.

The text comes from a PDF text layer, so rows can appear in different shapes. Common ones:
- One line per test: test name, then value, reference range and unit (tabs or spaces between them, in any order).
- A test name on one line, optionally a method line below it (e.g. "Calculated", "Flow cytometry"), then a line with the value, unit and range.
- Qualitative results written as words (e.g. "Non Reactive", "Not Detected", "Negative").
Lines of explanation, interpretation tables, notes and method descriptions are NOT test rows — skip them.

Return patient details (name, age, sex, patient id, contact number) if they appear in this text, and the report(s) with their test rows (test, value, unit, range) plus lab name, referring doctor, sample collected date and report date if present.

STRICT RULES:
- Copy every value exactly as it appears in the text below. Never use a value that is not literally in the text.
- If a field is missing, use an empty string. Never guess, never fill in typical or example values.
- Keep value, unit and range in their own fields — do not put the range inside the value.

--- SECTION TEXT ---
${sectionText}`;
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
        options: { num_ctx: NUM_CTX },
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

  logTokenUsage('identify', model, parsed);

  const text = parsed.response;
  if (!text) return [];

  try {
    const body = JSON.parse(text);
    return Array.isArray(body.sections) ? body.sections.filter((s) => typeof s === 'string' && s.trim()) : [];
  } catch {
    return [];
  }
}

// opts.sectionLabel set → select-first flow: one plain-text section, using
// buildSectionPrompt(). Unset → the original HTML-table prompt (unchanged
// behaviour for /api/extract and /api/categorize-report).
async function categorize(ocrDump, opts = {}) {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.CATEGORIZE_MODEL || 'llama3.2:3b';

  let res;
  try {
    res = await undiciFetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: opts.sectionLabel ? buildSectionPrompt(ocrDump, opts.sectionLabel) : buildPrompt(ocrDump),
        stream: false,
        format: RESPONSE_SCHEMA,
        think: false,
        options: { num_ctx: NUM_CTX },
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

  const usage = logTokenUsage('categorize', model, parsed);

  const text = parsed.response;
  if (!text) {
    const err = new Error('Ollama response did not contain the expected "response" field.');
    err.status = 502;
    err.details = parsed;
    throw err;
  }

  try {
    const result = JSON.parse(text);
    // Non-enumerable so it never leaks into the categorized/validated JSON
    // output contract, but callers can still read it for logging.
    Object.defineProperty(result, 'tokenUsage', { value: usage, enumerable: false });
    return result;
  } catch {
    const err = new Error('The local model returned output that was not valid JSON, even with schema-constrained decoding.');
    err.status = 502;
    err.details = { text };
    throw err;
  }
}

module.exports = { categorize, identifySections };
