// Calls a small, locally self-hosted model (via Ollama) to do the ONLY thing
// it needs to do here: take the OCR stage's already-correct reading of the
// page (PaddleOCR here, Azure in ../azure-llm) and organize it into our
// schema. It never re-reads the image — it only reasons over plain text
// already extracted, which is exactly the "easy" half of the job small
// models are good at. Identical to ../azure-llm/ollama.js — copied, not
// shared, so this OCR demo stays fully standalone.

// Node's global fetch (built on undici) applies a default 300-second
// headersTimeout/bodyTimeout. Ollama's `stream:false` response only arrives
// once generation is fully done, so that whole wait counts against it —
// confirmed by a real request failing at ~303s with a generic "fetch failed"
// (misleadingly reported below as "could not reach Ollama", when Ollama was
// never actually unreachable). A CPU-only local model's categorization time
// varies a lot by report size/model, so rather than picking another guessed
// limit, both timeouts are disabled outright (0 = no limit in undici) —
// this call is expected to sometimes take several minutes and should never
// be killed by an arbitrary client-side clock.
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
  return `You are given the OCR output of a diagnostic lab report — the reading has already been done correctly, your only job is to organize it.

Below is the full extracted text, followed by any tables that were detected (rows separated by newlines, columns separated by " | ").

Organize this into patient details (name, age, sex, patient id, contact number) and a list of reports. The file may contain more than one distinct report bundled together — split them into separate entries by their section headings (e.g. "HAEMATOLOGY", "BIOCHEMISTRY"). For each report, also pull the lab name, referring doctor, sample collected date, and report date if present. For every test row, extract the test name, value, unit, and reference range exactly as given.

If a field is not present anywhere in the text, use an empty string — never guess or invent a value.
Return only the structured data.

--- OCR OUTPUT ---
${ocrDump}`;
}

async function categorize(ocrDump) {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

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
        // No-op for llama3.2 (not a thinking model) but kept so a future
        // hybrid-thinking model (e.g. qwen3, tried and reverted — see
        // PROGRESS.md) doesn't burn time on a reasoning trace this
        // extraction-only task doesn't need.
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
