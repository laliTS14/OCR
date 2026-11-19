// Client for the OCR insertion API (backend/Health_360_OCR, ASP.NET).
// Plain JSON over HTTPS; the worker authenticates with one shared secret in
// the X-Api-Key header (OCR_API_KEY in .env = OcrApi:ApiKey in the API's
// appsettings.json). A success is 200 + the SP result; a failure is
// { Success:false, Message } with an HTTP status (404 from ClaimReport =
// queue empty, 409 = report not claimed by this worker).
const { fetch, Agent } = require('undici');

class OcrApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class OcrApiClient {
  // insecureTls: accept a self-signed certificate (local dev https only)
  constructor({ baseUrl, apiKey, insecureTls = false }) {
    if (!baseUrl) throw new Error('Set OCR_API_URL in .env (see README.md).');
    if (!apiKey) throw new Error('Set OCR_API_KEY in .env — the same value as OcrApi:ApiKey in the API\'s appsettings.json.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.dispatcher = new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: insecureTls ? { rejectUnauthorized: false } : {},
    });
  }

  // POST a JSON payload; returns the response object or throws OcrApiError(status, message).
  async call(path, payload) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      let message = (parsed && (parsed.Message || parsed.message || parsed.title)) || text.slice(0, 300) || `HTTP ${res.status}`;
      // ASP.NET model-validation errors: name the fields
      if (parsed && parsed.errors) message += ` ${JSON.stringify(parsed.errors).slice(0, 500)}`;
      throw new OcrApiError(res.status, message);
    }
    return parsed;
  }

  async close() {
    await this.dispatcher.close();
  }
}

function createClientFromEnv() {
  return new OcrApiClient({
    baseUrl: process.env.OCR_API_URL,
    apiKey: process.env.OCR_API_KEY,
    insecureTls: /^(1|true|yes)$/i.test(process.env.OCR_API_INSECURE_TLS || ''),
  });
}

module.exports = { OcrApiClient, OcrApiError, createClientFromEnv };
