# paddleocr/legacy — the previous PaddleOCR demo (reference only)

Snapshot (Sept 30, 2026) of this folder's original pipeline, moved here when
`paddleocr/` was rebuilt on the per-page / rules-based pipeline from
`../unlimited-ocr/` with PaddleOCR as the OCR engine (see `../README.md` and
`../../PROGRESS.md`).

Original flow: triage (whole file) → PP-Structure via `../paddle_service.py`
(port 8791) → one full-document Ollama `categorize()` call → validate.
Kept only for reference/diffing; paths inside these files assume they sit in
`paddleocr/`, so they won't run from this subfolder as-is.
