# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Standalone proof-of-concept area for turning a DC-uploaded diagnostic
report (PDF/scanned image) into structured JSON (patient details +
one or more reports, each with test/value/unit/range rows). Lives as a
subfolder of the larger `alphonsol-PIMS` TPA PIMS platform but is **not
wired into its backend or frontend** — nine independent Node demos
exist purely to compare extraction approaches (six LLM-based, one pure
regex with no LLM at all — see `regex-based/` — one hybrid of the
two — see `hybrid-ocr/` — and `tesseract-ocr/`, the `paddleocr/` pipeline
on Tesseract, which is also the second engine for double OCR).

**Read `PROGRESS.md` before doing any work here** — it's the running
history (decisions, confirmed accuracy/timing numbers, bugs found and
reverted, open issues, next steps) and is more current than anything
below. `README.md` covers architecture/how-to-run per demo.
`OCR_for_DC_Report_Extraction.pptx` has the original pitch/rationale.

## Repo identity — important

This folder is its **own standalone git repo**
(`github.com/laliTS14/OCR`, private), independent of the parent
`alphonsol-PIMS` repo it physically sits inside. The parent repo used
to also track a copy of these files; that was deliberately undone
(`git rm -r --cached` + added to the parent's `.gitignore`). **Only
commit and push from inside this `OCR/` folder** — never expect changes
here to show up in the parent repo's history going forward.

## The nine demos

None share an npm workspace — each has its own `package.json`,
installed and run independently.

| Demo | Approach | Port | Status |
|---|---|---|---|
| `real/` | Single Gemini call (reads + structures in one shot) | 8787 | Comparison baseline |
| `sarvam/` | Single Sarvam AI Document AI Extract call, **two selectable modes** — `lab` (diagnostic report) / `mer` (medical questionnaire) — reads + structures in one shot, async job | 8790 | **One successful real run per mode** (lab: 9/9 panels; MER: 66 then 56 Q&A pairs across 2 runs) — promising but unconfirmed across repeat runs; see `PROGRESS.md` |
| `azure-llm/` | Azure Document Intelligence (OCR) → Ollama (categorize) → deterministic validate | 8788 | Comparison baseline |
| `paddleocr/` | **Default pipeline (rebuilt Sept 30, 2026):** per-page reading (text layer where usable, **RapidOCR (default, ONNX, ~6.6 s/page) or PaddleOCR** text OCR only for pages without one) → page classification (lab / mer / other / no_text) → whole-document rules parser (every test, 28 report types + Other, 217-test dictionary) → source check → validate; Ollama only as per-section fallback. Pipeline files copied from `unlimited-ocr/` — keep both copies identical | 8792 (+ `paddle_text_service.py` on 8794 — `OCR_ENGINE=rapid` in `.venv-rapid` / `paddle` in `.venv`; old PP-Structure `paddle_service.py` on 8791 unused) | **Active development** — same results as Unlimited-OCR on 15 scanned pages; RapidOCR ~6.6 s/page vs ~3.5 min for Unlimited-OCR on this CPU. Old version in `paddleocr/legacy/`. See `PROGRESS.md` |
| `deepseek-ocr/` | Self-hosted DeepSeek-OCR via Ollama (OCR) → Ollama (categorize) → deterministic validate | 8793, no separate Python process | **Built, runs end-to-end — reading-stage reliability is the open problem**, not categorization: 3 identical repeated calls on the same image gave 3 different failure modes (clean, repetition loop, garbled/concatenated). Categorization prompt already rewritten and a dedup safety net added; see `PROGRESS.md` |
| `unlimited-ocr/` | Self-hosted Unlimited-OCR, **forced onto CPU** (OCR) → Ollama (categorize) → deterministic validate | 8795 (+ Python service on 8796) | **Built, runs end-to-end — best raw reading quality of any free approach here**, confirmed twice (all 24/24 test values correct both times, real HTML tables). The split units/range table is now zipped deterministically (`textNormalize.js`). **Also has a select-first flow (`/select.html`, `/api/extract-selected`): every test in the whole report is parsed by a template-free rules engine and grouped into 28 report types + Other (nothing dropped); report-type selection only filters (`rowParser.js` + `labVocabulary.js` + `paramDictionary.js` + `headerParser.js`), LLM only as per-section fallback — ~200ms per document, 0 LLM calls on all 4 real lab reports tested**; see `PROGRESS.md`. Officially a CUDA-only model; this machine has no GPU, so 2 dependency/code patches were required to run it at all — see `unlimited_ocr_service.py`'s file header. Also has a **selective per-report categorization flow** (`/api/identify-reports` + `/api/categorize-report`) that avoids Ollama's context-window truncation by categorizing one picked report's page(s) at a time instead of the whole document |
| `regex-based/` | Same reading stage as `unlimited-ocr/` (shares its Python microservice, not a copy) → **pure regex categorization, no LLM call at all** (Tier A: exact template match; Tier B: a looser cross-template fallback) → deterministic validate | 8797 | **Built, runs end-to-end — >1000x faster than `unlimited-ocr/`'s categorization** (~130ms total pipeline vs. several minutes). Tier A: 14/14 panels on its home template. Tier B (added later, Sept 2026): recovered real data on 2 previously-unrecognized documents from different labs, but noisier (duplicate/empty sections, some unit/range field swaps). **Deliberately no LLM fallback**, by explicit instruction — a document neither tier can parse returns empty, not a guess; see `PROGRESS.md` |
| `tesseract-ocr/` | `paddleocr/`'s pipeline unchanged (every `.js` file + `public/` copied, kept identical), scanned pages read by **Tesseract 5** (`tesseract_text_service.py`, same `/ocr` contract as `paddle_text_service.py`). Also the **second engine for double OCR** driven from `paddleocr/` (`ocrEngines.js` flags, `doubleOcr.js`; comparison only — its result is saved separately, never merged) | 8800 (+ `tesseract_text_service.py` on 8799) | **Built and run Oct 22, 2026** (Tesseract 5.5.3 at `C:\tesseract-ocr`): 1.2 s/page; alone weaker than RapidOCR on bordered/handwritten table cells (903 vs 987 coded rows over 26 files); the two engines read the same value for 72 % of OCR'd tests. Nov 2: double OCR redone as comparison only (`tbl_ocr_data_tesseract`); tested end to end on `health360_dev` (125 reports, Nov 5–6). Nov 18: UAT rollout prepared (SQL script + Tesseract boot task), not applied yet. See `tesseract-ocr/README.md`, `PROGRESS.md` "Double OCR" |
| `hybrid-ocr/` | Same reading stage, shared → `regexCategorize.js` (copy of `regex-based/`'s) always runs first → `confidence.js` scores the result → **Ollama LLM fallback (`unlimited-ocr/ollama.js`'s `categorize()`) only if confidence < 0.6** → deterministic validate | 8798 | **Built, runs end-to-end — confirmed on 3 documents to route correctly**: stayed on the fast regex path for 2 (including a noisy-but-actually-good Tier B case, confidence 0.65) and correctly escalated to the LLM only for the 1 genuinely bad case (confidence 0.00). Does not improve the LLM fallback's own known accuracy issues — only decides when to trust the fast path vs. pay for the slow one; see `PROGRESS.md` |

`paddleocr/` is structurally a fork of `azure-llm/` with only the OCR
stage swapped (`triage.js`/`ollama.js`/`validate.js` are copied, not
shared, between the two). `sarvam/` is structurally a fork of `real/`
(same single-call shape, files copied not shared) with Gemini's
synchronous call replaced by Sarvam's submit/poll/fetch async job.
`deepseek-ocr/` and `unlimited-ocr/` are both structurally forks of
`paddleocr/` with only the OCR stage swapped — DeepSeek-OCR runs through
the same Ollama instance (no Python needed at all), while Unlimited-OCR
needs its own Python microservice (`unlimited_ocr_service.py`, a plain
Hugging Face Transformers model, not Ollama-servable) mirroring
`paddle_service.py`'s role exactly, just a different backend. `regex-based/`
is structurally a fork of `unlimited-ocr/` with only the categorization
stage swapped — it reuses `unlimited-ocr/`'s own running Python
microservice over the network rather than copying the 6.67GB model, and
replaces `ollama.js` entirely with a synchronous `regexCategorize.js`.
`hybrid-ocr/` is a fork combining `regex-based/` and `unlimited-ocr/` —
both `regexCategorize.js` (unchanged, plus it now also returns which tier
matched) and `ollama.js` are copied in, alongside one genuinely new file,
`confidence.js`, that decides which one's output to trust per document.

### Commands

```bash
# real/ — Gemini POC
cd real
npm install
npm start                    # http://localhost:8787
node test-extract.js <file>  # CLI test against extractor.js directly

# sarvam/ — Sarvam AI Document AI Extract POC
cd sarvam
npm install
npm start                        # http://localhost:8790 — pick lab/MER mode in the UI
node test-extract.js <file>          # CLI test, lab mode (default)
node test-extract.js <file> mer      # CLI test, MER questionnaire mode

# azure-llm/ — Azure + Ollama POC
cd azure-llm
npm install
npm start                    # http://localhost:8788
node test-extract.js <file>

# paddleocr/ — self-hosted POC (two processes, both required)
cd paddleocr
py -3.12 -m venv .venv && .venv\Scripts\activate   # 3.9-3.13 only, not 3.14+
pip install -r requirements.txt
python paddle_service.py     # http://localhost:8791 — leave running

cd paddleocr                 # separate terminal
npm install
npm run dev                  # http://localhost:8792, auto-restarts on file change

# deepseek-ocr/ — DeepSeek-OCR (via Ollama) + local LLM POC, no Python needed
cd deepseek-ocr
npm install
npm start                            # http://localhost:8793
node test-extract.js <file>          # CLI test against the full pipeline

# unlimited-ocr/ — Unlimited-OCR (forced CPU) + local LLM POC (two processes)
cd unlimited-ocr
py -3.12 -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
python unlimited_ocr_service.py      # http://localhost:8796 — leave running, ~2-3s model load, then idle
                                      # requires ./model/ populated — see README.md for the huggingface_hub
                                      # download command and the .cuda() patch that must be re-applied if
                                      # the model is ever re-downloaded

cd unlimited-ocr                     # separate terminal
npm install
npm start                            # http://localhost:8795
node test-extract.js <file>          # CLI test — confirmed ~4.5 min/page, see PROGRESS.md

# regex-based/ — same reading stage as unlimited-ocr/, zero-LLM categorization
# Reuses unlimited-ocr/'s Python microservice over the network — only start it
# separately (see above) if uploading a real scan; a digital PDF never needs it.
cd regex-based
npm install
npm start                            # http://localhost:8797
node test-extract.js <file>          # CLI test — confirmed ~130ms end-to-end on a digital PDF

# hybrid-ocr/ — regex first, confidence-scored Ollama fallback only if needed
# Needs both unlimited-ocr/'s Python microservice (real scans only) and
# Ollama running (ollama pull llama3.2:3b) for the fallback path.
cd hybrid-ocr
npm install
npm start                            # http://localhost:8798
node test-extract.js <file>          # CLI test — prints the confidence score and which path was taken
```

Each demo needs its own `.env` (gitignored, not committed) — see that
demo's section in `README.md` for the exact keys
(`GEMINI_API_KEY`/`GEMINI_MODEL`, `SARVAM_API_KEY`/`SARVAM_BASE_URL`/
`SARVAM_LANGUAGE`, `AZURE_DOCINTEL_ENDPOINT`/`_KEY`,
`OLLAMA_URL`/`OLLAMA_MODEL`, `DEEPSEEK_OCR_MODEL`/`CATEGORIZE_MODEL`/
`PAGE_RENDER_WIDTH`, `UNLIMITED_OCR_URL`/`CATEGORIZE_MODEL`/
`PAGE_RENDER_WIDTH`). `paddleocr/`, `deepseek-ocr/`, and `unlimited-ocr/`
all need Ollama installed and running for their categorization step
(`ollama pull llama3.2:3b`; `deepseek-ocr/` additionally needs
`ollama pull deepseek-ocr`) — it runs as a persistent background Windows
app, not something you `ollama serve` manually. `unlimited-ocr/`
additionally needs its own Python microservice running (no Ollama
involved for its reading step — see the Commands section above).

## Architecture notes worth knowing before editing

- **Shared output contract across all six demos**: `{ patient: {...},
  reports: [{ report_type, lab_name, referring_doctor,
  sample_collected_date, report_date, rows: [{ test, value, unit,
  range }] }] }`. Keep this schema in sync if you touch more than one
  demo — they're meant to stay comparable. `sarvam/` can't send this
  shape directly to Sarvam's API (confirmed: it exceeds their max-4-level
  schema nesting limit) — it sends a flattened schema instead and
  re-groups the response back into this exact contract client-side, via
  `groupRowsIntoReports()` in `sarvam/extractor.js`. That re-grouping
  assumes Sarvam repeats each report's fields identically across all its
  rows; confirmed true on one real run so far, not yet stress-tested.
- **`azure-llm/` and `paddleocr/` both branch on triage**: a digital PDF
  (real embedded text layer, checked via `pdf-parse`) skips OCR
  entirely and pulls text directly for free; only genuine scans hit
  Azure/PaddleOCR. Every real-report test so far has hit the digital
  shortcut — the actual scanned-image path through PaddleOCR has never
  been validated end-to-end (see `PROGRESS.md` open issue #4).
- **`paddleocr/`'s Ollama/PaddleOCR HTTP calls go through `undici`'s
  `fetch` with an unbounded timeout** (`headersTimeout: 0, bodyTimeout:
  0`), not Node's global `fetch` — Node's global fetch has a silent
  300s timeout that was killing long local-model calls. If you touch
  `ollama.js` or `paddle.js`, keep using `undici`'s `FormData` too, not
  the global one — mixing the two silently breaks multipart uploads
  (this already happened once; see `PROGRESS.md` bug #2).
- **Validation (`validate.js`) is deterministic code, not AI** — it
  parses numeric values/ranges and flags normal/high/low/unchecked. It
  runs in `azure-llm/` and `paddleocr/` but not `real/` or `sarvam/`,
  which both trust their model/API output as-is. Sarvam's Extract
  response does include a per-field confidence score that `sarvam/`
  doesn't currently surface — a possible future validation signal.
- **`paddleocr/`'s categorization LLM (`llama3.2:3b`) runs at Ollama's
  default 2048-token context window**, not the model's real 131072
  limit — this is a known, currently-accepted trade-off (fixing it via
  `num_ctx: 8192` roughly triples processing time; see `PROGRESS.md`
  "The context-window bug" for the full numbers before touching this).

## Current focus

`paddleocr/` is the demo under active iteration (zero per-call API cost is
the hard constraint). Its pipeline is rules-first and template-free — read
PROGRESS.md's "Design rule for the rules-based parser" before changing any
parsing rule: only universal lab-report knowledge, never per-report fixes;
judge changes over a batch (`batch-eval.js`), not one file. MER
questionnaires are parked (page classification skips them). Human review
(`/select.html` "Review & correct" → `review-data/`, gitignored) builds the
answer key; `node gold-eval.js --compare` is the regression gate — run it
before keeping any parser/dictionary change (no `review-data/gold/` keys
exist yet, so until they do, compare every row over a batch of real files
before/after the change — PROGRESS.md "Oct 16"). Page classification has
its own hand-checked key: `node page-eval.js` (`review-data/page-key.json`).
OCR engines are flags (`paddleocr/ocrEngines.js`: `OCR_PRIMARY_ENGINE`,
`OCR_ENGINE_*_ENABLED`, `OCR_DOUBLE_ENABLED`); double OCR (second engine
always Tesseract, `doubleOcr.js`) runs only when the master switch is on and
the report's `double_ocr` flag is set, and is **comparison only**: RapidOCR's
result stays the one in `tbl_ocr_data`; Tesseract's is saved separately
(`tbl_ocr_data_tesseract`), never merged. `paddleocr/`'s `.js` files
are copied identically into `tesseract-ocr/` — change them in `paddleocr/`
and copy. Open items:
double-OCR rollout on UAT (prepared: `PROGRESS.md` "UAT go-live"), Tesseract on
bordered/handwritten tables, more sample reports from more
DCs, MER pipeline, per-insurer templates, how digitization consumes
`tbl_ocr_data`. PIMS integration exists only as
`paddleocr/worker.js`, which processes the OCR queue through a separate
ASP.NET API in the parent repo (`backend/Health_360_OCR`, client
`paddleocr/ocrApiClient.js`; see PROGRESS.md "PIMS integration") — the
main PIMS backend has no OCR controller.

## Keeping docs current

`README.md` (architecture/how-to-run) and `PROGRESS.md` (narrative/
history/current config) are actively maintained and treated as more
trustworthy than memory of past sessions. When you change a pipeline
stage, a config default, or find/fix/revert something non-trivial,
update the relevant file **in the same turn** — overwrite stale
sections rather than appending.
