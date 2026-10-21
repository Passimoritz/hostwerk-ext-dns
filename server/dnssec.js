'use strict';
/*
 * DNSSEC-Stand einer Zone – über DNS-over-HTTPS (JSON) bei einem prüfenden Resolver (Cloudflare, sonst Google),
 * weil Nodes eigener Resolver weder DS-Einträge noch das „geprüft“-Kennzeichen (AD) liefert. Nur lesend, ohne Schlüssel.
 *
 *   status  'secure'    signiert und von der übergeordneten Zone bestätigt (DS vorhanden, AD gesetzt)
 *           'unsigned'  ohne DNSSEC
 *           'no-ds'     der Anbieter signiert (DNSKEY da), beim Registrar fehlt aber der DS-Eintrag
 *           'broken'    Signatur passt nicht (Resolver antwortet SERVFAIL) – Namen sind dann nicht erreichbar!
 *           'unknown'   kein Resolver erreichbar
 */
const { request } = require('./providers/http');

const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

async function query(fetchFn, name, type) {
  let last = null;
  for (const base of DOH) {
    try {
      const r = await request(fetchFn, 'GET', `${base}?name=${encodeURIComponent(name)}&type=${type}&do=1`, { headers: { Accept: 'application/dns-json' }, timeout: 8000 });
      if (r.status === 200 && r.body && typeof r.body === 'object') return r.body;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last || new Error('no DNS-over-HTTPS resolver reachable');
}

/** → { status, ds: [...], keys: n } */
async function dnssecStatus(zone, { fetch: fetchFn = globalThis.fetch } = {}) {
  const name = String(zone).replace(/\.+$/, '');
  try {
    const [ds, key] = await Promise.all([query(fetchFn, name, 'DS'), query(fetchFn, name, 'DNSKEY')]);
    if (key.Status === 2 || ds.Status === 2) return { status: 'broken', ds: [], keys: 0 };
    const dsList = (ds.Answer || []).filter((a) => a.type === 43).map((a) => a.data);
    const keys = (key.Answer || []).filter((a) => a.type === 48).length;
    if (dsList.length && key.AD) return { status: 'secure', ds: dsList, keys };
    if (keys && !dsList.length) return { status: 'no-ds', ds: [], keys };
    if (dsList.length && !key.AD) return { status: 'broken', ds: dsList, keys };
    return { status: 'unsigned', ds: [], keys: 0 };
  } catch (e) {
    return { status: 'unknown', error: e.message, ds: [], keys: 0 };
  }
}

module.exports = { dnssecStatus, DOH };
