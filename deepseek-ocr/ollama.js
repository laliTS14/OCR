// Calls a small, locally self-hosted model (via Ollama) to do the ONLY thing
// it needs to do here: take the OCR stage's already-correct reading of the
// page (DeepSeek-OCR here, PaddleOCR in ../paddleocr, Azure in ../azure-llm)
// and organize it into our schema. It never re-reads the image — it only
// reasons over plain text already extracted, which is exactly the "easy"
// half of the job small models are good at.
//
// UNLIKE ../paddleocr/ollama.js and ../azure-llm/ollama.js, this prompt is
// NOT a straight copy — it's written specifically for DeepSeek-OCR's actual
// output shape, confirmed via real testing (see deepseek.js's file header
// for the full evidence): DeepSeek-OCR does NOT produce a clean
// pipe-separated grid the way PaddleOCR/Azure do. It produces markdown
// where each test is usually its own short block ("Haemoglobin ( Hb )"
// then "13.6" on the next line), while units and reference ranges are
// frequently separated from their test entirely and dumped later as
// unlabeled fragments (e.g. "gm/dL 12-15 thou/uL 4-10 million/uL..." with
// no indication which unit/range belongs to which test above it) —
// reusing the grid-oriented prompt from the other demos on this input
// measurably made things worse (confirmed: every unit/range came back
// blank, and administrative labels like "Sample Tested In" got
// mis-classified as fake report sections). The schema/JSON contract below
// is identical to every other demo's — only the instructions describing
// the INPUT shape differ.

// See ../paddleocr/ollama.js for why both undici timeouts are disabled —
// identical reasoning applies here.
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
  return `You are given the OCR output of a diagnostic lab report, produced by a vision model reading the page image directly — the reading is usually correct on individual values, but the LAYOUT is messy, not a clean table. Your job is to organize it despite that.

WHAT THE INPUT LOOKS LIKE (read this carefully, it is not a grid):
- Section headings look like "### HAEMATOLOGY" or "### BIOCHEMISTRY" — these mark the start of a new distinct report. Use them to split the file into separate report entries.
- Some headings are NOT report types, they are metadata about the sample or patient — e.g. "### Sample Tested In : Whole Blood" or "### Test Description". Do not treat these as a new report; the content under them (if any real test data) belongs to whichever real report section it's physically closest to, or can be skipped if it's just administrative text.
- Most real tests appear as a short block: the test name on one line (sometimes prefixed with "*"), followed by its result value on the same or the next line — e.g. "Haemoglobin ( Hb )" then "13.6" right after. Extract these as (test, value) pairs even when the formatting around them is inconsistent (extra spaces, line breaks mid-word like "Abs olute Lymphocyte Count").
- CRITICAL — units and reference ranges are frequently SEPARATED from their test and dumped later as an unlabeled, jumbled list (e.g. a block like "gm/dL 12-15 thou/uL 4-10 million/uL 3.8-4.8% 36-46 fL ..."). There is often NO reliable way to tell which fragment belongs to which test above it. Only fill in a test's unit or range when it appears immediately next to that specific test's value with no ambiguity. If a unit or range cannot be confidently attached to one specific test, leave that field as an empty string — do NOT guess by position or order, and do NOT invent a plausible-looking unit or range.
- Ignore administrative/non-test text: lab or branch names (e.g. "MAX LIFE", "MAIN LAB"), field labels like "DLC Performed By", "Automated", "Lab Serial No", collection/report timestamps (capture these separately as sample_collected_date/report_date if clearly labeled, otherwise leave blank) — none of these are test rows.
- A repeating block of text that looks like it copy-pasted the same few lines many times in a row is a known OCR glitch (a model decoding loop), not real repeated data — treat it as a single occurrence, not as one test per repetition.

Organize this into patient details (name, age, sex, patient id, contact number) and a list of reports, each with its lab name, referring doctor, sample collected date, and report date if present, and its list of test rows (test, value, unit, range).

If a field is not present anywhere in the text, or cannot be confidently determined per the rules above, use an empty string — never guess or invent a value.
Return only the structured data.

--- OCR OUTPUT ---
${ocrDump}`;
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

module.exports = { categorize };
