// Persists every pipeline run (one uploaded file = one "transaction") to
// its own folder under logs/, with one file per pipeline stage — so a
// past extraction can be inspected/debugged after the fact instead of
// only living in server console output or the browser response. Identical
// to ../paddleocr/transactionLog.js and ../deepseek-ocr/transactionLog.js
// — copied, not shared.
//
// These folders will contain real patient data (names, IDs, lab values)
// once run against real reports — never committed, see .gitignore.
const fs = require('fs');
const path = require('path');

const LOG_ROOT = path.join(__dirname, 'logs');

function sanitizeForPath(name) {
  const base = (name || 'upload').replace(/\.[^/.]+$/, ''); // strip extension
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
  return cleaned || 'upload';
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe (Windows disallows ':')
}

// Creates logs/<timestamp>_<sanitized-filename>/ and returns helpers scoped
// to that one transaction's folder.
function createTransactionLog(fileName) {
  const dirName = `${timestampForPath()}_${sanitizeForPath(fileName)}`;
  const dir = path.join(LOG_ROOT, dirName);
  fs.mkdirSync(dir, { recursive: true });

  function writeText(filename, content) {
    fs.writeFileSync(path.join(dir, filename), content ?? '', 'utf8');
  }

  function writeJson(filename, value) {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(value, null, 2), 'utf8');
  }

  return { dir, writeText, writeJson };
}

module.exports = { createTransactionLog };
