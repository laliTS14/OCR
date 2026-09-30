// Calls DeepSeek-OCR (a vision-language OCR model, self-hosted via Ollama —
// `ollama pull deepseek-ocr`) to do the actual reading: it looks at the raw
// page image and returns a markdown transcription (text + tables), the same
// role PaddleOCR plays in ../paddleocr/. Unlike PaddleOCR, this needs no
// separate Python microservice — it's just another model Ollama serves —
// but it only accepts images, not PDFs, so PDF pages are rasterized first
// via pdf-parse's built-in renderer (`getScreenshot`), which bundles pdf.js
// + a native canvas and needs no external binary (poppler/ImageMagick
// aren't installed on this machine and weren't needed).
//
// CONFIRMED via live testing (Sept 2026) against a real 7-page lab report:
// - DeepSeek-OCR gets real numeric/text values right (spot-checked against
//   this project's other successful extractions of the same document), but
//   its output is NOT a clean table — it's a bullet-list-ish markdown where
//   each real test usually appears as its own line/short block ("Haemoglobin
//   ( Hb )" then "13.6" on the next line), while units and reference ranges
//   frequently get separated from their test entirely and dumped later in
//   jumbled, unlabeled fragments (e.g. a block starting "gm/dL 12-15 thou/uL
//   4-10..." with no indication which unit/range belongs to which test).
//   Administrative labels that are NOT tests also appear inline ("MAX LIFE",
//   "MAIN LAB", "Sample Tested In", "DLC Performed By", "Automated") and can
//   be mistaken for test names if not explicitly filtered. See ollama.js's
//   prompt, written specifically around this shape, not a clean grid.
// - CRITICAL, CONFIRMED TWICE, NOT FULLY SOLVED: at `temperature: 0` (this
//   model's hardcoded default — see `ollama show deepseek-ocr`), it can fall
//   into a repetition loop on real report pages, burning output budget
//   re-printing the same short block dozens of times instead of finishing
//   the page. First occurrence (no repeat_penalty at all): confirmed via a
//   manual API probe, `done_reason: "length"`, 20+ verbatim repeats. Adding
//   `repeat_penalty: 1.3` fixed that specific retry — but a SECOND,
//   independent occurrence happened on the very next real pipeline run,
//   same image, same prompt, same options, `repeat_penalty: 1.3` already
//   active — it looped anyway (a different block this time, "Sample Tested
//   In: Whole Blood" repeated ~20x) and directly corrupted the downstream
//   categorization (a bogus extra "report" got fabricated from the looped
//   text). **Conclusion: repeat_penalty reduces the loop's likelihood, it
//   does NOT reliably eliminate it** — likely CPU multi-threaded inference
//   nondeterminism, since temperature=0 alone doesn't guarantee bit-for-bit
//   reproducibility across runs. Mitigated two ways below, neither of which
//   is a guaranteed fix: (1) `repeat_penalty` raised further and
//   `repeat_last_n` widened, to reduce recurrence odds further; (2)
//   `dedupeRepeatedBlocks()`, deterministic code (not AI) that collapses any
//   block repeated 3+ times in a row down to one occurrence before the text
//   ever reaches the categorizer — this can't prevent a loop from starting,
//   but it stops a loop from corrupting the next stage the way it did here.
//   If real reports keep looping even with this in place, the deterministic
//   next step is capping `num_predict` much lower per page (trading
//   completeness for a faster, cheaper failure) — not attempted yet.
// - Cost: ~50s/page once past a one-time cold-start cost per unique image
//   (a first-ever call took 275s, almost entirely image/prompt encoding,
//   not generation — expect the first page of a real run to be much slower
//   than the rest). Model context is only 8192 tokens, so each page is a
//   separate call — there is no single-call "read the whole PDF" option
//   here the way there is with Gemini/Sarvam.
// - DeepSeek-OCR's own documented "Table Recognition:" prompt mode was
//   tried as an alternative to "Convert the document to markdown." and was
//   WORSE for a full page (header + patient info + table together) — it
//   returned only the letterhead text and nothing else, `done_reason:
//   "stop"` (i.e. it wasn't cut off, it just decided that was the whole
//   answer). Table Recognition mode is presumably meant for a pre-cropped
//   table-only image, not a whole page — do not switch to it without
//   cropping the table region out first.
// See PROGRESS.md "Alternative self-hosted OCR models explored" for the
// full comparison against glm-ocr (tried first, confirmed broken — do not
// swap back to it without checking whether the upstream Ollama bugs
// referenced there have been fixed).

const { PDFParse } = require('pdf-parse');
const { fetch: undiciFetch, Agent } = require('undici');

// Same reasoning as ../paddleocr/ollama.js: a single DeepSeek-OCR call can
// take minutes, and Node's global fetch has a silent 300s timeout that
// would otherwise kill a slow-but-working call.
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const PROMPT = 'Convert the document to markdown.';

// Deterministic safety net against the repetition loop described above.
// Confirmed real example: an entire "### Sample Tested In : Whole Blood"
// section (heading + several lines of body) repeated ~20 times verbatim —
// a single blank-line-separated paragraph is too small a unit to catch
// this (there are blank lines *inside* one repeated section too), so this
// splits on DeepSeek-OCR's own "### heading" section markers instead, and
// collapses any run of 3+ consecutive matching sections down to one.
// "Matching" is whitespace-normalized, not exact-byte, and treats a
// section that's a strict prefix of its neighbor as matching too —
// confirmed necessary on real output: the FIRST occurrence in a loop is
// sometimes reflowed slightly differently ("gm/dL 12 -15" on one line vs.
// "gm/dL\n12 - 15" on two, same content) and the LAST is often cut off
// mid-repeat by num_predict — neither is byte-identical to the run of
// verbatim repeats in between, but both are the same loop, not real data.
// Never touches content that isn't part of a 3+ run, so it can only remove
// genuine loop garbage, never a real, non-repeating section. Returns
// { text, collapsedSections } so the caller can log/flag when this fired.
function normalizeForCompare(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function sectionsMatch(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return true;
  // Treat a truncated (shorter) section as matching if it's a prefix of
  // the other — catches a repeat cut off mid-way by num_predict.
  return na.length !== nb.length && (nb.startsWith(na) || na.startsWith(nb));
}

function dedupeRepeatedBlocks(text) {
  const sections = text.split(/(?=^###\s)/m).filter(Boolean);
  if (sections.length < 3) return { text, collapsedSections: 0 };
  const output = [];
  let collapsedSections = 0;
  let i = 0;
  while (i < sections.length) {
    const section = sections[i];
    let runLength = 1;
    // Compare against the longest section seen in the run so far, so a
    // short truncated tail doesn't reset what "matches" for the next one.
    let representative = section;
    while (i + runLength < sections.length && sectionsMatch(representative, sections[i + runLength])) {
      if (sections[i + runLength].length > representative.length) representative = sections[i + runLength];
      runLength++;
    }
    output.push(representative);
    if (runLength >= 3) collapsedSections += runLength - 1;
    i += runLength;
  }
  return { text: output.join(''), collapsedSections };
}

async function rasterizePdfPages(fileBuffer, desiredWidth) {
  const parser = new PDFParse({ data: fileBuffer });
  try {
    const result = await parser.getScreenshot({ imageDataUrl: false, desiredWidth });
    return result.pages.map((p) => ({ pageNumber: p.pageNumber, buffer: Buffer.from(p.data) }));
  } finally {
    await parser.destroy();
  }
}

async function callDeepseekOcrOnImage(imageBuffer, { ollamaUrl, model }) {
  const base64 = imageBuffer.toString('base64');
  let res;
  try {
    res = await undiciFetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: PROMPT,
        images: [base64],
        stream: false,
        // repeat_penalty/repeat_last_n reduce the repetition-loop's odds —
        // see the file header comment for why this is NOT a guaranteed fix
        // (confirmed to still loop occasionally even with these set) and
        // why dedupeRepeatedBlocks() below exists as a second line of
        // defense. num_predict is generous since a dense page of test rows
        // can genuinely need 1000+ tokens; raise further if real reports
        // get cut off mid-page (done_reason: "length" in the response).
        options: { num_predict: 3000, repeat_penalty: 1.5, repeat_last_n: 256 },
      }),
      dispatcher: noTimeoutAgent,
    });
  } catch (networkErr) {
    const err = new Error(
      `Could not reach Ollama at ${ollamaUrl} (${networkErr.message}). Is it installed and running? ` +
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
  if (typeof parsed.response !== 'string') {
    const err = new Error('DeepSeek-OCR response did not contain the expected "response" field.');
    err.status = 502;
    err.details = parsed;
    throw err;
  }
  return { text: parsed.response, doneReason: parsed.done_reason };
}

// Returns { fullText, pageCount, truncatedPages, dedupedPages } — fullText
// is page-labeled markdown, ready to hand to ollama.js's categorization
// prompt the same way PaddleOCR's dump is in ../paddleocr/server.js.
async function readDocument(fileBuffer, mimeType, filename) {
  const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_OCR_MODEL || 'deepseek-ocr';
  const desiredWidth = Number(process.env.PAGE_RENDER_WIDTH) || 1600;

  let pageImages;
  if (mimeType === 'application/pdf') {
    pageImages = await rasterizePdfPages(fileBuffer, desiredWidth);
  } else {
    pageImages = [{ pageNumber: 1, buffer: fileBuffer }];
  }

  const pageTexts = [];
  const truncatedPages = [];
  const dedupedPages = [];
  for (const page of pageImages) {
    const { text: rawText, doneReason } = await callDeepseekOcrOnImage(page.buffer, { ollamaUrl, model });
    if (doneReason === 'length') truncatedPages.push(page.pageNumber);
    const { text, collapsedSections } = dedupeRepeatedBlocks(rawText);
    if (collapsedSections > 0) dedupedPages.push({ pageNumber: page.pageNumber, collapsedSections });
    pageTexts.push(`--- Page ${page.pageNumber} of ${pageImages.length} ---\n${text}`);
  }

  return {
    fullText: pageTexts.join('\n\n'),
    dedupedPages,
    pageCount: pageImages.length,
    truncatedPages,
  };
}

module.exports = { readDocument };
 