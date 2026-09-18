# OCR — DC Report Extraction POCs

> Reference doc for what's in this folder and how each approach works.
> For the running history of what's been tried, found, and what's next,
> see `PROGRESS.md` — read that first if you're picking this up fresh.

## What this is

Standalone proof-of-concept area, independent of the main TPA PIMS
backend/frontend — not wired into either. Three demos exploring how to
turn a DC-uploaded diagnostic report (PDF or scanned image) into
structured data: patient details + one or more reports, each with
test/value/unit/range rows. All three exist to compare approaches — see
`OCR_for_DC_Report_Extraction.pptx` for the pitch/rationale.

This folder is its own git repo (separate from the parent `alphonsol-PIMS`
repo it lives inside) — see `PROGRESS.md` for details on that split and
why it matters if you're editing files here.

None of the three demos share an npm workspace/root — each is its own
`package.json`, run and `npm install`ed independently.

## `real/` — single-call Gemini approach

- **Stack:** Express (`server.js`, port `8787` default) + `multer`
  (in-memory upload, 15MB max, `application/pdf`/`image/jpeg`/`image/png`
  only) + a single shared module `extractor.js`.
- **How it works:** the raw file (PDF or image) is sent directly to
  Google's Gemini (`gemini-3.6-flash` default, via
  `GEMINI_API_KEY`/`GEMINI_MODEL` in `real/.env`) as inline base64
  data with `responseMimeType: 'application/json'` and a fixed
  `responseSchema` — one model call does reading (OCR) and structuring
  together. Retries on `429`/`503`/network errors, up to 4 attempts with
  exponential backoff (1s, 2s, ...).
- **Output schema:** `{ patient: { name, age, sex, patient_id,
  contact_number }, reports: [{ report_type, lab_name,
  referring_doctor, sample_collected_date, report_date, rows: [{ test,
  value, unit, range }] } ] }`. Splits multiple bundled reports (e.g. CBC
  + Lipid Profile in one PDF) into separate entries. Missing fields come
  back as empty strings, never guessed.
- **`test-extract.js`** — CLI script hitting the same `extractor.js`
  logic directly against a local file, so the web path and the CLI test
  never drift apart.
- **No validation step** — `server.js` returns Gemini's structured
  output as-is (`data`), unlike `azure-llm` below.
- **Cost:** per-call Gemini API fee. Not free.

## `paddleocr/` — 4-stage pipeline (self-hosted PaddleOCR + local LLM)

Built to answer a specific ask: a fully **free** (no per-page API cost)
pipeline targeting a modest ~60-70% accuracy bar, as an alternative to
Tesseract (which has no table-structure understanding, a poor fit for the
tabular test/value/unit/range layout of a lab report). Structurally an
exact mirror of `azure-llm/`'s 4-stage pipeline — same
triage/categorize/validate code (`triage.js`/`ollama.js`/`validate.js`,
copied not shared) — with only the OCR stage swapped out.

- **Two processes, not one:** PaddleOCR/PaddlePaddle has no first-class
  Node bindings, so the OCR stage is a separate Python/Flask microservice
  (`paddle_service.py`, port `8791` default) using **`PPStructureV3`** —
  table detection and general text OCR in one pass. PDFs are rasterized
  page-by-page via PyMuPDF at ~200 DPI, since PP-Structure only accepts
  images. The Node app (`server.js`, port `8792` default) calls this
  service over plain HTTP via `paddle.js` (mirrors `azure.js`'s interface
  exactly). Both processes must be running for `/api/extract` to work —
  see "Running this locally" below.
- **4 stages:** Triage (`triage.js`, digital-PDF-vs-scan check, copy of
  `azure-llm/pdfText.js`) → Reading (direct text-layer pull for digital
  PDFs, else PaddleOCR) → Categorization (`ollama.js`, a local LLM via
  Ollama) → Validation (`validate.js`, deterministic code, not AI).
- **Cost trade-off, by design:** no Azure/Gemini API bill, but CPU-only
  PaddleOCR/Ollama inference is slower per page, and accuracy on messy
  scans, regional-language text, or unusual layouts is expected to be
  weaker than Azure Document Intelligence's out-of-the-box robustness —
  acceptable here because the accuracy target is intentionally modest,
  not best-in-class. See `PROGRESS.md` for how this has actually played
  out against real reports.

### Running this locally

```bash
# 1. Python OCR service
cd paddleocr
py -3.12 -m venv .venv         # paddlepaddle needs Python 3.9-3.13, not 3.14+
.venv\Scripts\activate          # Windows; `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
python paddle_service.py        # http://localhost:8791 — leave running

# 2. Node pipeline (separate terminal)
cd paddleocr
npm install
copy .env.example .env          # defaults point at localhost:8791/11434
npm run dev                     # http://localhost:8792, auto-restarts on file changes
```

You'll also need [Ollama](https://ollama.com) installed and running with
a categorization model pulled: `ollama pull llama3.2:3b`. Full setup
detail, environment gotchas (Python version pinning, an oneDNN CPU crash
workaround, a RAM-pressure crash on large scanned images), and known
limitations are in `paddleocr/README.md` — read that before assuming a
result is trustworthy.

## `azure-llm/` — 4-stage pipeline (Azure OCR + local LLM)

- **Stack:** Express (`server.js`, port `8788` default) + `multer` (same
  15MB/PDF+JPEG+PNG limits, explicitly kept equal to the Gemini POC "for
  a fair comparison"). Four modules, one per pipeline stage:

  1. **Triage** (`pdfText.js`) — for PDFs only, checks whether the file
     already has an embedded text layer (`pdf-parse`, ≥200 non-whitespace
     chars = "digital") vs. is a scan with no real text. A digital PDF's
     text is pulled directly — free, instant, no OCR call at all. Images
     always go to OCR. Known trade-off: direct text extraction does
     **not** reconstruct table structure, so rows/columns can come out
     jumbled — messier input for the LLM stage than Azure's table-aware
     path would give.
  2. **OCR** (`azure.js`) — for anything not "digital": Azure Document
     Intelligence's `prebuilt-layout` model (`AZURE_DOCINTEL_ENDPOINT`/
     `AZURE_DOCINTEL_KEY` in `azure-llm/.env`), submit-then-poll async
     API (~1.2s interval, ~48s cap), retries `429`/`503`. Returns plain
     text plus tables reconstructed as 2D arrays from cell
     rowIndex/columnIndex data. Deliberately has *zero* understanding of
     meaning — purely "what's on the page."
  3. **Categorization** (`ollama.js`) — a small **locally self-hosted**
     LLM via Ollama (`llama3.2:3b` default, `OLLAMA_URL`/`OLLAMA_MODEL`),
     schema-constrained JSON output (`format` param), same
     patient/reports/rows schema as the Gemini POC. Only reasons over the
     already-extracted plain text/table dump — never re-reads the
     image/PDF itself.
  4. **Validation** (`validate.js`) — deterministic code, not AI. Parses
     each row's numeric value and reference range (handles messy
     real-world formats: `"12 - 15"`, `"Up to 40"`, `"> 40"`, `"Adults: 44
     - 147"`) and flags `normal`/`high`/`low`/`unchecked` (non-numeric or
     unparseable range — routed to a human either way, not treated as an
     error). Runs after categorization as a cheap first-pass filter
     before any human review.

- **Response shape:** `server.js` returns every stage's real
  intermediate output (`stages: { triage, ocr, categorized, validated }`)
  alongside the final `data` — built so the UI can show what actually
  happened at each step rather than a simulated version of it.
- **`test-extract.js`** — CLI equivalent, same pattern as `real/`'s.
- **Cost:** per-page Azure Document Intelligence fee (free tier: ~500
  pages/month) + your own hosting for Ollama.

## Comparison

| | `real/` (Gemini) | `azure-llm/` | `paddleocr/` |
|---|---|---|---|
| Reading | Gemini reads the file directly | Azure Document Intelligence (or free direct text-layer pull for digital PDFs) | PaddleOCR + PP-Structure, self-hosted (or free direct text-layer pull for digital PDFs) |
| Structuring | Same Gemini call, via `responseSchema` | Separate local LLM call (Ollama), reasoning over Azure's text | Separate local LLM call (Ollama), reasoning over PaddleOCR's text — same prompt/schema as azure-llm |
| Validation | None — trusts model output as-is | Deterministic post-pass (`validate.js`) | Deterministic post-pass (`validate.js`, copy of azure-llm's) |
| Cost | Per-call Gemini API fee | Per-page Azure Document Intelligence fee | $0 API cost — just your own compute (CPU/GPU) |
| External dependencies | Gemini API only | Azure Document Intelligence API + a locally-running Ollama instance | A locally-running Python/PaddleOCR process + a locally-running Ollama instance |
| Visibility into intermediate steps | No — one opaque call | Yes — every stage's raw output is returned to the caller | Yes — same stage-by-stage response shape as azure-llm |
| Target accuracy | Best-in-class (frontier model) | High (commercial OCR + small LLM) | Modest, ~60-70% by design — free-first, not accuracy-first |

`paddleocr/` is the one under active iteration — free/self-hosted is the
current direction (see `PROGRESS.md` for why).

## Known gaps / not yet done

- Not integrated with the main backend (`backend/Health_360_Backend`) or
  frontend (`Frontend_Health_360/main`) in any way — no controller, no
  service, no route references any of the three demos. Purely standalone
  Node apps today.
- No shared `.env.example` — each demo's `.env` (gitignored) must be
  created by hand with the keys referenced above.
- `index.html` exists at this folder's root (outside all three
  subfolders) — not yet traced against any demo's `public/` folder;
  unclear if it's a third variant, an older combined page, or shared
  scaffolding.
- No decision recorded yet on which approach (or a hybrid) will actually
  be adopted for real DC Report Upload processing (see the main repo's
  `backend.md` Report Upload section, which today has no OCR/extraction
  step at all — `UploadReportDocument` only saves the raw file).
