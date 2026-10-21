'use strict';
/*
 * Gemeinsamer HTTP-Aufruf der Anbieter. "fetch" wird hereingereicht – die Tests geben eine Nachbildung hinein, es
 * geht nie eine echte Anfrage hinaus. Fehlertexte der Anbieter werden durchgereicht (ohne Zugangsdaten).
 */

class ProviderError extends Error {
  constructor(message, status, { retryAfter } = {}) {
    super(message);
    this.status = status === 429 ? 429 : status && status >= 400 && status < 500 ? (status === 401 || status === 403 ? 401 : 400) : 502;
    this.providerStatus = status;
    if (retryAfter) this.retryAfter = retryAfter; // Sekunden – der Abgleich wartet mindestens so lange
  }
}

/** Retry-After (Sekunden oder Datum) → Sekunden, höchstens 6 Stunden. */
function retryAfterSeconds(v) {
  if (!v) return 0;
  const n = Number(v);
  const s = Number.isFinite(n) ? n : Math.round((Date.parse(v) - Date.now()) / 1000);
  return Number.isFinite(s) && s > 0 ? Math.min(s, 6 * 3600) : 0;
}

/** JSON-Anfrage: liefert { status, body, headers }. Netzfehler und Zeitüberschreitung → ProviderError. */
async function request(fetchFn, method, url, { headers = {}, body, timeout = 20000 } = {}) {
  let res;
  try {
    res = await fetchFn(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new ProviderError(e && e.name === 'TimeoutError' ? 'The DNS provider did not answer in time.' : `The DNS provider cannot be reached: ${(e && e.message) || e}`);
  }
  // Zu viele Anfragen: einheitlich für alle Anbieter – mit der Wartezeit, die der Anbieter nennt
  if (res.status === 429) {
    const wait = retryAfterSeconds(res.headers && res.headers.get && res.headers.get('retry-after'));
    throw new ProviderError('The DNS provider limits requests right now – Hostwerk tries again later.', 429, { retryAfter: wait || 60 });
  }
  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed, headers: res.headers };
}

module.exports = { request, ProviderError, retryAfterSeconds };
