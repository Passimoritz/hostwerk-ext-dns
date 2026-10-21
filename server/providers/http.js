'use strict';
/*
 * Gemeinsamer HTTP-Aufruf der Anbieter. "fetch" wird hereingereicht – die Tests geben eine Nachbildung hinein, es
 * geht nie eine echte Anfrage hinaus. Fehlertexte der Anbieter werden durchgereicht (ohne Zugangsdaten).
 */

class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status && status >= 400 && status < 500 ? (status === 401 || status === 403 ? 401 : 400) : 502; this.providerStatus = status; }
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
  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed, headers: res.headers };
}

module.exports = { request, ProviderError };
