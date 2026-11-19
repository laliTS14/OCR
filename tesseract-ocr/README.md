# `tesseract-ocr/` — the paddleocr pipeline with Tesseract as the OCR engine, and the second engine for double OCR

Same pipeline as `../paddleocr/` — per-page reading (PDF text layer where
usable, OCR only for the other pages) → page classification → whole-document
rules parser → validate — with **Tesseract** reading the scanned pages
instead of RapidOCR/PaddleOCR. Two jobs:

1. **A standalone demo** (`npm start`, port 8800) to compare Tesseract with
   PaddleOCR on the same files (`batch-eval.js`, `page-eval.js`).
2. **The second engine for double OCR**: for a report flagged for double
   OCR, `../paddleocr/worker.js` also sends its scanned pages to *this
   folder's* `tesseract_text_service.py` and saves Tesseract's result
   separately, for comparison (`doubleOcr.js` — not merged). That is why the
   service exists here and not inside `paddleocr/`.

## Files

- `tesseract_text_service.py` — Flask OCR service, port **8799**. Same HTTP
  contract as `../paddleocr/paddle_text_service.py`
  (`POST /ocr` → `{ text, markdown, elapsedSeconds, skewDeg, boxes, engine }`),
  so the Node side treats both engines alike. Tesseract 5 LSTM, English,
  page segmentation mode 6 (one block, so a table row's name / value / unit /
  range stay on one line), pages scaled up to 2400 px wide (~300 dpi), gaps
  wider than ~2.5 characters become tabs (same rule as the paddle service).
  `GET /health` reports the Tesseract version.
- Every `.js` file and `public/` — **copied from `../paddleocr/`, kept
  identical** (same rule as `paddleocr/` ↔ `unlimited-ocr/`): change them in
  `paddleocr/` and copy them here. Only `.env` differs: `OCR_PRIMARY_ENGINE`
  defaults to `tesseract` in this folder (`ocrEngines.js` picks the default
  from the folder name), `PORT=8800`.
- No `worker.js` here: the PIMS worker is `../paddleocr/worker.js`; set
  `OCR_PRIMARY_ENGINE=tesseract` in *its* `.env` to read with Tesseract.

## Engine flags (`ocrEngines.js`, in `.env`)

| Flag | Default | Meaning |
|---|---|---|
| `OCR_PRIMARY_ENGINE` | `tesseract` here, `paddle` in paddleocr/ | engine for pages without a text layer: `paddle` / `tesseract` / `gemini` |
| `OCR_ENGINE_PADDLE_ENABLED` | `true` | PaddleOCR (paddle_text_service.py) usable |
| `OCR_ENGINE_TESSERACT_ENABLED` | `true` | Tesseract usable (also needed for double OCR) |
| `OCR_ENGINE_GEMINI_ENABLED` | `false` | reserved — Gemini is **not built yet**; turning it on and choosing it is refused |
| `OCR_DOUBLE_ENABLED` | `false` | master switch for double OCR |
| `TESSERACT_TEXT_URL` / `PADDLE_TEXT_URL` | `:8799` / `:8794` | service addresses |

**Double OCR** runs only when `OCR_DOUBLE_ENABLED=true` **and** the report
asks for it — `tbl_ocr_report_details.double_ocr = 1` in PIMS, `--double` on
`worker.js --file` / `test-extract.js`, or the "Double OCR" checkbox on
`/select.html`. The second engine is always Tesseract, so a run whose primary
engine is Tesseract is never doubled. Fully digital PDFs never run a second
engine (nothing was OCR'd).

## Double OCR — Tesseract's result kept separately, for comparison (`doubleOcr.js`)

Decided Nov 2, 2026 (replaces the Oct 22 merge): double OCR is **for
comparison only**. The primary engine's result (RapidOCR) is *the* result —
saved to `tbl_ocr_data`, used by digitization — exactly as for a single-OCR
report. Tesseract's result is saved **as Tesseract read it, into its own
tables**, and never merged or compared in code:

| | Primary (RapidOCR) | Tesseract (double OCR only) |
|---|---|---|
| Runs | every report | only when `OCR_DOUBLE_ENABLED=true` **and** the report's `double_ocr = 1` |
| Saved by | `api/Ocr/SaveOcrResult` → `sp_save_ocr_result` | `api/Ocr/SaveTesseractResult` → `sp_save_ocr_tesseract_result` (called after the primary save) |
| Tables | `tbl_ocr_report_details` + `tbl_ocr_data` | `tbl_ocr_tesseract_report` + `tbl_ocr_data_tesseract` |
| Row engine (`ocr_engine_id`) | `PADDLE` (or `TEXT_LAYER`) | `TESSERACT` (or `TEXT_LAYER`) |
| Used by digitization | yes | no |

- **Tesseract fails** (service down, error): the primary result is saved and
  the report is DONE as usual; `tbl_ocr_tesseract_report` gets a FAILED row
  with the error. Re-run by re-queueing the report (the new Tesseract result
  replaces the old one).
- **Digital PDF** (no page needed OCR): Tesseract has nothing to read — a DONE
  row with 0 tests and a remark saying so.
- On success, when at least one page was OCR'd,
  `tbl_ocr_report_details.second_ocr_engine_id` = TESSERACT (NULL for a
  digital PDF).
- Parent repo SQL: on `health360_dev` since Nov 3; for UAT,
  `database/stored_procedures/ocr_double_ocr_uat_rollout.sql` (Nov 18 — all
  double-OCR columns, tables and procedures). Worker machine: the
  "Health360 OCR Tesseract Service" task from
  `../paddleocr/deploy/install-tasks.ps1`.
- Comparing the two is a query for now, e.g. per test on one report:
  `tbl_ocr_data` vs `tbl_ocr_data_tesseract` on `ocr_report_id` +
  `param_code` (both `is_active = 1`).

## Running this locally

```bash
# 0. Tesseract itself (once): UB Mannheim Windows build
#    https://github.com/UB-Mannheim/tesseract/wiki → installs to
#    C:\Program Files\Tesseract-OCR (English is included). Elsewhere: set TESSERACT_CMD.

# 1. OCR service (Python 3.12 venv)
cd tesseract-ocr
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
set PYTHONIOENCODING=utf-8 & set PYTHONUTF8=1 & .venv\Scripts\python tesseract_text_service.py   # :8799

# 2. Node demo (separate terminal)
cd tesseract-ocr
npm install
copy .env.example .env
npm start                                   # http://localhost:8800/select.html
node test-extract.js <file>                 # CLI, Tesseract
node batch-eval.js <folder> --ocr           # batch, Tesseract (cache: ocr-cache/tesseract)

# Double OCR from paddleocr/ (both services running):
#   paddleocr/.env: OCR_DOUBLE_ENABLED=true
cd paddleocr
node test-extract.js <file> --double        # prints RapidOCR's result, then Tesseract's
node worker.js --file <file> --double       # dry run: SaveOcrResult body, then SaveTesseractResult body
```

Service settings (env): `TESSERACT_TEXT_PORT` (8799), `TESSERACT_CMD`,
`TESSERACT_LANG` (eng), `TESSERACT_PSM` (6), `TESSERACT_TARGET_WIDTH` (2400,
0 = no rescale), `TESSERACT_MIN_CONF` (0).

## Status

Built Oct 22, 2026; first real run the same day over the 26 page-key files
(189 scanned pages): Tesseract **1.2 s/page** (RapidOCR ~6.6); alone 903
dictionary-coded rows vs PaddleOCR's 987 — weak on values in bordered table
cells and handwriting; the two engines read the same value for 72 % of the
OCR'd tests. psm 4 vs 6: same agreement, less junk, mixed per file → psm 6
kept. Nov 2: double OCR redone as comparison-only (separate tables, no
merge). Tested end to end on `health360_dev` (Nov 5) with 71 reports, all
double OCR: 71/71 Tesseract DONE; the two engines gave the same value for
96 % of the tests both found. The API endpoint is not deployed and the SQL
is not on UAT yet. Full numbers:
`../PROGRESS.md` "Double OCR".
