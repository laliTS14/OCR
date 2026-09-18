// Calls Azure Document Intelligence's prebuilt-layout model to do the actual
// reading: plain text plus table structure (rows/cells). It has zero
// understanding of what the text means — that's the local LLM's job
// (see ollama.js). This module's only output is "here's what's on the page,"
// never "here's what it means."

const API_VERSION = '2024-11-30';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = new Set([429, 503]);

async function fetchWithRetry(url, options, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      if (attempt === maxAttempts) {
        const err = new Error(`Network error calling Azure Document Intelligence: ${networkErr.message}`);
        err.status = 502;
        throw err;
      }
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    return res;
  }
}

// Submits the document and polls until Azure finishes analyzing it. Returns
// { fullText, tables } where tables is an array of 2D string arrays
// (already reconstructed from Azure's rowIndex/columnIndex cell data) —
// ready to hand to the LLM as plain text, no further parsing needed.
async function analyzeDocument(fileBuffer) {
  const endpoint = process.env.AZURE_DOCINTEL_ENDPOINT;
  const key = process.env.AZURE_DOCINTEL_KEY;
  if (!endpoint || !key) {
    const err = new Error('AZURE_DOCINTEL_ENDPOINT / AZURE_DOCINTEL_KEY are not set. Add them to OCR/azure-llm/.env and restart.');
    err.status = 500;
    throw err;
  }

  const baseUrl = endpoint.replace(/\/+$/, '');
  const analyzeUrl = `${baseUrl}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${API_VERSION}`;

  const submitRes = await fetchWithRetry(analyzeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': key,
    },
    body: JSON.stringify({ base64Source: fileBuffer.toString('base64') }),
  });

  if (submitRes.status !== 202) {
    const body = await submitRes.text();
    const err = new Error(`Azure Document Intelligence rejected the request (HTTP ${submitRes.status}): ${body.slice(0, 500)}`);
    err.status = submitRes.status;
    throw err;
  }

  const operationLocation = submitRes.headers.get('operation-location');
  if (!operationLocation) {
    const err = new Error('Azure accepted the request but did not return an Operation-Location header to poll.');
    err.status = 502;
    throw err;
  }

  // Poll until the async analysis finishes. Typical documents take a few
  // seconds; cap the wait so a stuck job doesn't hang the request forever.
  const POLL_INTERVAL_MS = 1200;
  const MAX_POLLS = 40; // ~48s ceiling
  let result;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetchWithRetry(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });
    const pollBody = await pollRes.json();
    if (pollBody.status === 'succeeded') {
      result = pollBody;
      break;
    }
    if (pollBody.status === 'failed') {
      const err = new Error(`Azure Document Intelligence analysis failed: ${JSON.stringify(pollBody.error || pollBody)}`);
      err.status = 502;
      throw err;
    }
    // status is "running" or "notStarted" — keep polling
  }

  if (!result) {
    const err = new Error('Azure Document Intelligence did not finish analyzing the document in time.');
    err.status = 504;
    throw err;
  }

  const analyzeResult = result.analyzeResult || {};
  const fullText = analyzeResult.content || '';

  const tables = (analyzeResult.tables || []).map((table) => {
    const grid = Array.from({ length: table.rowCount }, () => Array(table.columnCount).fill(''));
    (table.cells || []).forEach((cell) => {
      if (cell.rowIndex < table.rowCount && cell.columnIndex < table.columnCount) {
        grid[cell.rowIndex][cell.columnIndex] = (cell.content || '').replace(/\s+/g, ' ').trim();
      }
    });
    return grid;
  });

  return { fullText, tables };
}

module.exports = { analyzeDocument };
