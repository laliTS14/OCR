r"""
Text-OCR microservice on Tesseract — the second OCR engine next to
../paddleocr/paddle_text_service.py, with the SAME HTTP contract, so the Node
pipeline (ocrClient.js / ocrEngines.js) treats both alike:

  POST /ocr  (multipart "file" = one page image, PNG/JPG/…)
       → { markdown, text, skewDeg, boxes, elapsedSeconds, engine: "tesseract" }

Engine: Tesseract 5 (LSTM, English) through pytesseract; Tesseract itself is
a separate Windows program (UB Mannheim build) — see README.md.

What it returns per page image is PLAIN TEXT IN READING ORDER, shaped like a
PDF text layer (same shape as the paddle service):
  - Tesseract finds the text lines itself (its layout analysis follows a
    slightly tilted line, so no separate skew step);
  - page segmentation mode 6 (one uniform block) by default: a lab table's
    test name, value, unit and range stay on ONE line — the automatic mode
    (3) tends to split columns into separate blocks, which separates a test
    name from its value;
  - columns: a horizontal gap between two words wider than ~2.5 character
    widths becomes a tab, same rule as the paddle service;
  - pages are scaled up to ~TESSERACT_TARGET_WIDTH px first: Tesseract reads
    best at ~300 dpi and pages are rendered at 1600 px (~190 dpi).

Run (Windows; UTF-8 console needed or it crashes printing non-ASCII):
  .venv\Scripts\python tesseract_text_service.py   (with PYTHONIOENCODING=utf-8 PYTHONUTF8=1)
Config (env):
  TESSERACT_TEXT_PORT    default 8799
  TESSERACT_CMD          default C:\Program Files\Tesseract-OCR\tesseract.exe or C:\tesseract-ocr\tesseract.exe
                         if present, else "tesseract" on PATH
  TESSERACT_LANG         default eng
  TESSERACT_PSM          default 6
  TESSERACT_TARGET_WIDTH default 2400 (0 = never rescale)
  TESSERACT_MIN_CONF     default 0 — words Tesseract scores below this are dropped
"""

import io
import os
import shutil
import time

from flask import Flask, jsonify, request
from PIL import Image
import pytesseract

PORT = int(os.environ.get("TESSERACT_TEXT_PORT", "8799"))
LANG = os.environ.get("TESSERACT_LANG", "eng")
PSM = int(os.environ.get("TESSERACT_PSM", "6"))
TARGET_WIDTH = int(os.environ.get("TESSERACT_TARGET_WIDTH", "2400"))
MIN_CONF = float(os.environ.get("TESSERACT_MIN_CONF", "0"))

# installer default, then the folder chosen on this dev machine, then PATH
_default_cmds = [r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\tesseract-ocr\tesseract.exe"]
pytesseract.pytesseract.tesseract_cmd = os.environ.get("TESSERACT_CMD") or next(
    (c for c in _default_cmds if os.path.exists(c)), shutil.which("tesseract") or "tesseract")
try:
    VERSION = str(pytesseract.get_tesseract_version())
except Exception as exc:  # noqa: BLE001
    raise SystemExit(
        f"Tesseract not found ({pytesseract.pytesseract.tesseract_cmd}): {exc}\n"
        "Install the UB Mannheim Windows build (see README.md) or set TESSERACT_CMD.")
if LANG not in pytesseract.get_languages(config=""):
    raise SystemExit(f"Tesseract language '{LANG}' is not installed (have: {pytesseract.get_languages(config='')}).")
CONFIG = f"--oem 1 --psm {PSM} -c preserve_interword_spaces=1"
print(f"Tesseract {VERSION} ({pytesseract.pytesseract.tesseract_cmd}), lang={LANG}, psm={PSM}", flush=True)

app = Flask(__name__)


def prepare(image):
    """Grayscale, scaled up to TARGET_WIDTH (never down)."""
    img = image.convert("L")
    if TARGET_WIDTH and img.width < TARGET_WIDTH:
        f = TARGET_WIDTH / img.width
        img = img.resize((TARGET_WIDTH, round(img.height * f)), Image.LANCZOS)
    return img


def lines_from(data):
    """pytesseract.image_to_data dict → text lines; wide gaps become tabs."""
    words = []
    for i, t in enumerate(data["text"]):
        t = (t or "").strip()
        conf = float(data["conf"][i])
        if not t or conf < 0 or conf < MIN_CONF:
            continue
        words.append({
            "t": t,
            "line": (data["block_num"][i], data["par_num"][i], data["line_num"][i]),
            "x1": data["left"][i], "x2": data["left"][i] + data["width"][i],
            "top": data["top"][i], "h": max(1, data["height"][i]),
        })
    if not words:
        return "", 0
    hs = sorted(w["h"] for w in words)
    med_h = hs[len(hs) // 2]
    lines = {}
    for w in words:
        lines.setdefault(w["line"], []).append(w)
    # lines in reading order: by their vertical position on the page
    ordered = sorted(lines.values(), key=lambda ws: sum(w["top"] + w["h"] / 2 for w in ws) / len(ws))
    out = []
    for ws in ordered:
        ws.sort(key=lambda w: w["x1"])
        s = ws[0]["t"]
        for prev, nxt in zip(ws, ws[1:]):
            char_w = (prev["x2"] - prev["x1"]) / max(1, len(prev["t"]))
            gap = nxt["x1"] - prev["x2"]
            s += ("\t" if gap > max(2.5 * char_w, med_h * 1.2) else " ") + nxt["t"]
        out.append(s)
    return "\n".join(out), len(words)


@app.route("/ocr", methods=["POST"])
def ocr():
    f = request.files.get("file")
    if f is None:
        return jsonify({"error": "No file uploaded."}), 400
    try:
        image = Image.open(io.BytesIO(f.read()))
        image.load()
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not read the uploaded image: {exc}"}), 400
    t0 = time.time()
    try:
        data = pytesseract.image_to_data(prepare(image), lang=LANG, config=CONFIG, output_type=pytesseract.Output.DICT)
        text, n = lines_from(data)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"OCR (tesseract) failed: {exc}"}), 500
    return jsonify({
        "markdown": text,
        "text": text,
        "skewDeg": 0,
        "boxes": n,
        "elapsedSeconds": round(time.time() - t0, 2),
        "engine": "tesseract",
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "engine": "tesseract", "version": VERSION, "lang": LANG, "psm": PSM})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT)
