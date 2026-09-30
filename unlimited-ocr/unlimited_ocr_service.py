"""
Minimal Unlimited-OCR microservice — plays the same role as
../paddleocr/paddle_service.py: turn ONE page image into clean markdown,
with zero understanding of what any of it means (structuring is
../unlimited-ocr/ollama.js's job, same as every other demo here). Kept as
a separate Python process because Unlimited-OCR is a Hugging Face
Transformers model with no Node bindings.

Unlike paddleocr/, this service takes ONE page image per request, not a
whole PDF — PDF rasterization happens in Node (unlimitedocr.js, reusing
the same pdf-parse-based approach ../deepseek-ocr/deepseek.js uses), so
the Node side can log per-page progress. That matters here specifically
because each page takes minutes, not seconds (see below) — a whole
multi-page PDF handled entirely inside one Python call would leave a CLI
user staring at silence for 20-30+ minutes with zero feedback.

CONFIRMED (Sept 2026): Unlimited-OCR is officially CUDA-only (the model
card's own example does `model.eval().cuda()`, `device_map: "auto"`,
and this repo's own README documents no CPU-only path) — this service
only exists because this specific project's machine has no NVIDIA GPU
(confirmed via `Get-CimInstance Win32_VideoController` — Intel Iris Xe
integrated graphics only) and CPU execution was attempted anyway at the
user's explicit request, accepting the risk. Two changes were required to
make that work, both documented in PROGRESS.md's "Unlimited-OCR" section:
1. `model/modeling_unlimitedocr.py` has 14 hardcoded `.cuda()` calls in
   its `infer()` method — patched to `.to(self.device)` (see
   `model/modeling_unlimitedocr.py.orig` for the untouched original).
   Re-downloading this model from Hugging Face will restore the broken
   `.cuda()` calls — re-apply the same sed/patch if that ever happens:
   sed -i 's/[.]cuda()/[.]to(self.device)/g' model/modeling_unlimitedocr.py
2. `transformers` MUST be pinned to exactly `4.57.1` (see
   requirements.txt) — a newer version (confirmed broken: 5.17.0) removed
   `is_torch_fx_available`, which `model/modeling_deepseekv2.py` imports
   at module load time. This isn't a version preference, it's a hard
   compatibility requirement confirmed by a real crash.

CONFIRMED cost, one real run: model load ~2s (fast — safetensors mmap),
inference ~268s (~4.5 min) for one page. Only tested ONCE as of writing
— see PROGRESS.md for why this needs repeat-testing (same page, same
document, multiple runs) before its accuracy can be trusted, the same
discipline applied to every other model in this project after DeepSeek-OCR
looked perfect on its first run and then failed ~50% of the time on repeats.

Run standalone: python unlimited_ocr_service.py
Requires: .venv/Scripts/python.exe -m pip install -r requirements.txt
"""

import os
import tempfile
import time

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from flask import Flask, request, jsonify
import torch
from transformers import AutoModel, AutoTokenizer

app = Flask(__name__)

PORT = int(os.environ.get("UNLIMITED_OCR_PORT", "8796"))
MODEL_DIR = os.environ.get("UNLIMITED_OCR_MODEL_DIR", "./model")

print(f"torch {torch.__version__}, cuda available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print("NOTE: a CUDA GPU was detected — this service still forces CPU-oriented loading "
          "(no device_map) since it was written for a CPU-only machine. Remove the CPU-only "
          "assumptions below if you actually have a GPU to use.")

print("Loading Unlimited-OCR tokenizer + model (this happens once, at startup)...")
_t0 = time.time()
_tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
_model = AutoModel.from_pretrained(
    MODEL_DIR,
    trust_remote_code=True,
    use_safetensors=True,
    torch_dtype=torch.bfloat16,
    low_cpu_mem_usage=True,
)
_model = _model.eval()
print(f"Model loaded in {time.time() - _t0:.1f}s, device={next(_model.parameters()).device}")


def run_inference(image_path: str, output_dir: str) -> str:
    """Runs Unlimited-OCR on one page image, returns the clean markdown
    `infer()` saves to `{output_dir}/result.md` (no bounding-box `<|det|>`
    tags — those only appear in the raw stdout the model prints during
    generation, not in the saved file). Settings match the model card's
    own example exactly except `max_length` (32768 -> 8192): the model
    card's value assumes a much longer generation budget than a single
    lab-report page needs, and keeping it lower reduces worst-case time
    if the model ever runs long on a denser page — not yet confirmed
    necessary, just precautionary, revisit if pages get truncated."""
    _model.infer(
        _tokenizer,
        prompt='<image>document parsing.',
        image_file=image_path,
        output_path=output_dir,
        base_size=1024,
        image_size=640,
        crop_mode=True,
        max_length=8192,
        no_repeat_ngram_size=35,
        ngram_window=128,
        save_results=True,
    )
    result_path = os.path.join(output_dir, "result.md")
    if not os.path.exists(result_path):
        raise RuntimeError("Unlimited-OCR ran but did not produce result.md — check its stdout in this service's console.")
    with open(result_path, "r", encoding="utf-8") as f:
        return f.read()


@app.route("/ocr", methods=["POST"])
def ocr():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded."}), 400

    upload = request.files["file"]
    file_bytes = upload.read()
    ext = os.path.splitext(upload.filename or "")[1] or ".png"

    # Ephemeral temp dir per request — this will contain real patient data
    # (a rasterized page image, a full markdown transcription) for the
    # duration of one request only; TemporaryDirectory guarantees cleanup
    # even if inference raises, so nothing lingers on disk afterward.
    with tempfile.TemporaryDirectory(prefix="unlimited_ocr_") as tmp_dir:
        image_path = os.path.join(tmp_dir, f"page{ext}")
        with open(image_path, "wb") as f:
            f.write(file_bytes)
        output_dir = os.path.join(tmp_dir, "output")

        t0 = time.time()
        try:
            markdown = run_inference(image_path, output_dir)
        except Exception as exc:
            return jsonify({"error": f"Unlimited-OCR inference failed: {exc}"}), 500
        elapsed = time.time() - t0

    return jsonify({"markdown": markdown, "elapsedSeconds": round(elapsed, 1)})


if __name__ == "__main__":
    print(f"Unlimited-OCR microservice running at http://localhost:{PORT}")
    print("Each request is one page and can take several minutes — see this file's header comment for confirmed timing.")
    app.run(host="0.0.0.0", port=PORT)
