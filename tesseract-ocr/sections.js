// Splits a full document's OCR dump into per-page chunks, then asks Ollama
// a cheap, per-page "what report sections are on this page" question so the
// frontend can offer a picker — and, crucially, so the LATER categorize()
// call only ever has to look at the 1-2 pages that actually contain the
// report the user picked, never the whole document.
//
// This exists specifically to sidestep the context-window truncation bug
// documented at length in PROGRESS.md (Ollama's default 2048-token context
// silently drops the front of any long prompt) WITHOUT paying the 3x+
// slowdown of feeding the whole document through one call: every call this
// module makes is scoped to one page, which is naturally small. A page's
// prompt alone fits in 2048, but prompt + JSON output measured up to ~2800
// tokens (CBC page), so ollama.js sets num_ctx 4096 explicitly — cheap,
// since cost scales with tokens actually processed, not the window size.

const { identifySections } = require('./ollama');

// Handles both page-marker shapes produced by this project's two reading
// paths:
//  - Digital-text-layer shortcut (triage.js): pdf-parse emits "-- N of M --"
//    AFTER each page's own text.
//  - Real OCR (unlimitedocr.js): "--- Page N of M ---" is prefixed BEFORE
//    each page's markdown.
// Falls back to treating the whole dump as one page when neither is found
// (a single image upload, or a one-page document).
function splitIntoPages(ocrDump) {
  const ocrPageRe = /---\s*Page\s+(\d+)\s+of\s+(\d+)\s*---/gi;
  const ocrMatches = [...ocrDump.matchAll(ocrPageRe)];
  if (ocrMatches.length > 0) {
    return ocrMatches.map((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < ocrMatches.length ? ocrMatches[i + 1].index : ocrDump.length;
      return { pageNumber: Number(m[1]), text: ocrDump.slice(start, end).trim() };
    });
  }

  const digitalPageRe = /--\s*(\d+)\s+of\s+(\d+)\s*--/g;
  const digitalMatches = [...ocrDump.matchAll(digitalPageRe)];
  if (digitalMatches.length > 0) {
    const pages = [];
    let prevEnd = 0;
    for (const m of digitalMatches) {
      pages.push({ pageNumber: Number(m[1]), text: ocrDump.slice(prevEnd, m.index).trim() });
      prevEnd = m.index + m[0].length;
    }
    const trailing = ocrDump.slice(prevEnd).trim();
    if (trailing) pages.push({ pageNumber: pages.length + 1, text: trailing });
    return pages;
  }

  return [{ pageNumber: 1, text: ocrDump.trim() }];
}

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'section';
}

// Returns { pages, sections, perPage } — sections is what the frontend
// renders as a picker; perPage is kept for logging/debugging (which page(s)
// each name came from, and any per-page identify failures).
async function identifyReports(ocrDump) {
  const pages = splitIntoPages(ocrDump);
  const byName = new Map();
  const perPage = [];
  const usedIds = new Set();

  for (const page of pages) {
    let names = [];
    try {
      names = await identifySections(page.text);
    } catch (err) {
      perPage.push({ pageNumber: page.pageNumber, names: [], error: err.message });
      continue;
    }
    perPage.push({ pageNumber: page.pageNumber, names });

    for (const rawName of names) {
      const name = rawName.trim();
      const key = normalizeName(name);
      if (!key) continue;
      if (!byName.has(key)) {
        let id = slugify(name);
        while (usedIds.has(id)) id = `${id}-2`;
        usedIds.add(id);
        byName.set(key, { id, name, pageNumbers: new Set() });
      }
      byName.get(key).pageNumbers.add(page.pageNumber);
    }
  }

  const sections = Array.from(byName.values()).map((s) => ({
    id: s.id,
    name: s.name,
    pageNumbers: Array.from(s.pageNumbers).sort((a, b) => a - b),
  }));

  return { pages, sections, perPage };
}

// Rebuilds a reduced OCR dump containing only the page(s) a chosen section
// actually appeared on — this, not the full document, is what gets sent to
// categorize().
function getTextForSection(pages, section) {
  const wanted = new Set(section.pageNumbers);
  return pages
    .filter((p) => wanted.has(p.pageNumber))
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
    .join('\n\n');
}

module.exports = { splitIntoPages, identifyReports, getTextForSection };
