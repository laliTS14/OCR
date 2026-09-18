"""
Minimal PaddleOCR + PP-Structure microservice — plays the exact same role
as ../azure-llm/azure.js's analyzeDocument: turn a page (image or PDF) into
{ fullText, tables }, with zero understanding of what any of it means. Kept
as a separate Python process because PaddleOCR/PaddlePaddle have no
first-class Node bindings — the Node pipeline (server.js) calls this over
plain HTTP instead, exactly like it calls Azure's REST API in the other demo.

Run standalone: python paddle_service.py
Requires: pip install -r requirements.txt
"""

import io
import os

# Must be set before `paddle`/`paddleocr` is imported. On this machine (and
# apparently on some other Windows/CPU combinations with paddlepaddle 3.3.x),
# the default oneDNN-accelerated CPU execution path crashes on PP-Structure's
# layout-detection model with:
#   NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support
#   [pir::ArrayAttribute<pir::DoubleAttribute>]
# — a bug in paddlepaddle's newer PIR executor + oneDNN kernel combination,
# not anything in this script. Disabling oneDNN (slower, but correct) avoids
# it entirely; confirmed working via a standalone probe script before this
# was wired in. If a future paddlepaddle release fixes this upstream, both
# this env var and `enable_mkldnn=False` below can be removed.
os.environ.setdefault("FLAGS_use_mkldnn", "false")

from typing import List, Tuple

from flask import Flask, request, jsonify
from PIL import Image
from bs4 import BeautifulSoup
import numpy as np
from paddleocr import PPStructureV3
import pymupdf as fitz  # only used to rasterize PDF pages to images ("import fitz" is the deprecated alias)

app = Flask(__name__)

PORT = int(os.environ.get("PADDLE_PORT", "8791"))

# PPStructureV3 is the current (paddleocr>=3.x) pipeline class — the older
# `PPStructure` class this was originally written against no longer exists.
# use_doc_orientation_classify/use_doc_unwarping are turned off since DC
# report uploads are expected to already be right-side-up scans, not photos
# needing perspective correction — leaving them on only adds latency here.
# use_formula_recognition/use_chart_recognition/use_seal_recognition/
# use_region_detection are turned off because a DC lab report never has
# formulas, charts, or seals to detect — by default PPStructureV3 loads
# ~10 sub-models including a formula-recognition model, which is a lot of
# RAM for machines without much to spare (a crash was observed on a
# large/complex real-world page on a 7.7GB-RAM machine — this cuts the
# loaded model count roughly in half).
_engine = PPStructureV3(
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_formula_recognition=False,
    use_chart_recognition=False,
    use_seal_recognition=False,
    use_region_detection=False,
    enable_mkldnn=False,
)


def pdf_to_images(file_bytes: bytes) -> List[Image.Image]:
    """Rasterizes every page of a PDF to a PIL image at ~200 DPI — PP-Structure
    only operates on images, it doesn't read PDF files directly. 200 DPI is a
    balance between OCR accuracy (higher is better) and processing time."""
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    zoom = 200 / 72  # a PDF page's native resolution is 72 DPI
    matrix = fitz.Matrix(zoom, zoom)
    images = [
        Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        for pix in (page.get_pixmap(matrix=matrix) for page in doc)
    ]
    doc.close()
    return images


def html_table_to_grid(html: str) -> List[List[str]]:
    """PP-Structure's table model returns one HTML string per table, not a
    grid — this reconstructs the same 2D-array shape azure.js builds from
    Azure's rowIndex/columnIndex cells, so both OCR backends hand the
    categorization stage (ollama.js) an identical dump format and it never
    needs to know which backend produced it."""
    soup = BeautifulSoup(html, "html.parser")
    grid = []
    for tr in soup.find_all("tr"):
        row = [cell.get_text(strip=True) for cell in tr.find_all(["td", "th"])]
        if row:
            grid.append(row)
    return grid


def analyze_image(image: Image.Image) -> Tuple[str, List[List[List[str]]]]:
    """Runs one page through PP-Structure. `predict()` returns one result
    per input image; `result["parsing_res_list"]` is a list of LayoutBlock
    objects already ordered top-to-bottom / left-to-right by PP-Structure's
    own layout analysis (label + content per block — a "table" block's
    `.content` is itself an HTML string, same as `table_res_list` below, so
    it's skipped here to avoid duplicating table content into the plain-text
    dump). `result["table_res_list"]` is the authoritative per-table list —
    each entry's `["pred_html"]` is the table's HTML, converted to a grid."""
    results = list(_engine.predict(np.array(image)))
    if not results:
        return "", []
    result = results[0]

    text_lines = [
        block.content
        for block in result["parsing_res_list"]
        if block.label != "table" and block.content
    ]

    tables = []
    for table in result["table_res_list"]:
        grid = html_table_to_grid(table["pred_html"])
        if grid:
            tables.append(grid)

    return "\n".join(text_lines), tables


@app.route("/ocr", methods=["POST"])
def ocr():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded."}), 400

    upload = request.files["file"]
    file_bytes = upload.read()
    mimetype = upload.mimetype

    try:
        if mimetype == "application/pdf":
            images = pdf_to_images(file_bytes)
        else:
            images = [Image.open(io.BytesIO(file_bytes)).convert("RGB")]
    except Exception as exc:
        return jsonify({"error": f"Could not read the uploaded file: {exc}"}), 400

    full_text_parts = []
    tables = []
    try:
        for image in images:
            text, page_tables = analyze_image(image)
            full_text_parts.append(text)
            tables.extend(page_tables)
    except Exception as exc:
        return jsonify({"error": f"PaddleOCR analysis failed: {exc}"}), 500

    return jsonify({"fullText": "\n".join(full_text_parts), "tables": tables})


if __name__ == "__main__":
    print(f"PaddleOCR microservice running at http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT)
