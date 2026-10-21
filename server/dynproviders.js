'use strict';
/*
 * Kostenlose DynDNS-Namen ohne eigene Domain – jeder Anbieter mit seiner offiziellen Update-Schnittstelle.
 *
 *   free         kostet nichts
 *   maintenance  'none'    keine regelmäßige Handlung nötig
 *                'monthly' der Anbieter verlangt eine Bestätigung (No-IP: alle 30 Tage) – deshalb nur als Alternative
 *   suffix       Endung des Namens (Eingabe „meinserver“ → „meinserver.duckdns.org“)
 *   records      true = der Anbieter kann auch weitere Einträge (TXT, CNAME …) – dann als Zugang unter „Anbieter“
 *
 * update({ name, creds, ip4, ip6 }, { fetch }) → { answer } oder wirft DynError:
 *   kind 'auth'   Token/Passwort falsch oder abgelaufen → nicht wiederholen, bis der Nutzer es ändert
 *   kind 'config' Name gehört nicht zum Konto o. Ä. → ebenso
 *   kind 'rate'   zu viele Anfragen → nach retryAfter Sekunden wieder
 *   kind 'down'   Anbieter/Netz gestört → später wieder (wachsende Pausen)
 * Geheimnisse landen nie in Fehlertexten.
 */
const { request, ProviderError } = require('./providers/http');

class DynError extends Error {
  constructor(message, kind, { retryAfter } = {}) { super(message); this.kind = kind; this.status = kind === 'rate' ? 429 : kind === 'auth' ? 401 : kind === 'config' ? 400 : 502; if (retryAfter) this.retryAfter = retryAfter; }
}

const enc = encodeURIComponent;
const UA = 'Hostwerk-DNS/1.1 (+https://github.com/Passimoritz/hostwerk-ext-dns)';
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

/** Text-Anfrage über den gemeinsamen Aufruf; Netzfehler → 'down', 429 → 'rate'. */
async function call(fetchFn, url, headers = {}) {
  try {
    const r = await request(fetchFn, 'GET', url, { headers: { 'User-Agent': UA, Accept: 'text/plain, */*', ...headers }, timeout: 15000 });
    return { status: r.status, text: String(typeof r.body === 'string' ? r.body : r.body === null ? '' : JSON.stringify(r.body)).trim().slice(0, 300) };
  } catch (e) {
    if (e instanceof ProviderError && e.status === 429) throw new DynError('The provider limits updates right now – Hostwerk tries again later.', 'rate', { retryAfter: e.retryAfter });
    throw new DynError(e.message, 'down');
  }
}
const server = (st) => st >= 500;

const DYN = {
  duckdns: {
    label: 'DuckDNS', free: true, maintenance: 'none', suffix: 'duckdns.org', ipv6: true,
    fields: [{ key: 'token', label: 'Token', secret: true, required: true }],
    signup: 'https://www.duckdns.org/',
    steps: ['Open duckdns.org and sign in (GitHub, Google, Reddit or X).', 'Enter a sub domain and click “add domain”.', 'Copy the token shown at the top and paste it here.'],
    note: 'Free, no confirmation needed. Only A/AAAA (plus one TXT) – no MX or SRV.',
    async update({ name, creds, ip4, ip6 }, { fetch }) {
      const sub = name.replace(/\.duckdns\.org$/, '');
      const r = await call(fetch, `https://www.duckdns.org/update?domains=${enc(sub)}&token=${enc(creds.token)}${ip4 ? `&ip=${enc(ip4)}` : ''}${ip6 ? `&ipv6=${enc(ip6)}` : ''}&verbose=true`);
      if (server(r.status)) throw new DynError(`DuckDNS answers with HTTP ${r.status}.`, 'down');
      if (/^OK/.test(r.text)) return { answer: /NOCHANGE/.test(r.text) ? 'unchanged' : 'updated' };
      throw new DynError('DuckDNS rejects the update – check the token and the name.', 'auth');
    },
  },
  desec: {
    label: 'deSEC (dedyn.io)', free: true, maintenance: 'none', suffix: 'dedyn.io', ipv6: true, records: true, dnssec: true,
    fields: [{ key: 'token', label: 'Token', secret: true, required: true }],
    signup: 'https://desec.io/signup',
    steps: ['Open desec.io → “Sign up” and choose “dynDNS account” with a name under dedyn.io.', 'Confirm the e-mail – deSEC shows the token once.', 'Paste the token here.'],
    note: 'Free, run by a non-profit, with DNSSEC. Also allows TXT, CNAME, MX, SRV – Hostwerk adds the name under Providers too.',
    async update({ name, creds, ip4, ip6 }, { fetch }) {
      const r = await call(fetch, `https://update.dedyn.io/?hostname=${enc(name)}&myipv4=${ip4 ? enc(ip4) : 'preserve'}&myipv6=${ip6 ? enc(ip6) : 'preserve'}`, { Authorization: basic(name, creds.token) });
      if (r.status === 401 || r.status === 403) throw new DynError('deSEC does not accept the token.', 'auth');
      if (r.status === 404 || r.status === 400) throw new DynError('deSEC does not know this name in your account.', 'config');
      if (server(r.status) || r.status !== 200) throw new DynError(`deSEC answers with HTTP ${r.status}.`, 'down');
      if (/^good/.test(r.text)) return { answer: 'updated' };
      throw new DynError(`deSEC: ${r.text || 'unexpected answer'}`, 'config');
    },
  },
  dynv6: {
    label: 'dynv6', free: true, maintenance: 'none', suffix: 'dynv6.net', ipv6: true,
    fields: [{ key: 'token', label: 'HTTP token', secret: true, required: true }],
    signup: 'https://dynv6.com/users/sign_up',
    steps: ['Sign up at dynv6.com and create a zone, e.g. myserver.dynv6.net.', 'Open “Keys” → copy the HTTP token.', 'Paste the token here.'],
    note: 'Free, good with IPv6. Records beyond A/AAAA are edited on dynv6.com.',
    async update({ name, creds, ip4, ip6 }, { fetch }) {
      const r = await call(fetch, `https://dynv6.com/api/update?hostname=${enc(name)}&token=${enc(creds.token)}${ip4 ? `&ipv4=${enc(ip4)}` : ''}${ip6 ? `&ipv6=${enc(ip6)}` : ''}`);
      if (r.status === 401 || r.status === 403) throw new DynError('dynv6 does not accept the token.', 'auth');
      if (r.status === 404) throw new DynError('dynv6 does not know this zone in your account.', 'config');
      if (server(r.status) || r.status !== 200) throw new DynError(`dynv6 answers with HTTP ${r.status}.`, 'down');
      return { answer: /unchanged/.test(r.text) ? 'unchanged' : 'updated' };
    },
  },
  freedns: {
    label: 'FreeDNS (afraid.org)', free: true, maintenance: 'none', suffix: '', ipv6: true,
    fields: [{ key: 'token', label: 'Update token (A record)', secret: true, required: true }, { key: 'token6', label: 'Update token (AAAA record, optional)', secret: true }],
    signup: 'https://freedns.afraid.org/signup/',
    steps: ['Sign up at freedns.afraid.org and add a sub domain under one of the shared domains.', 'Open “Dynamic DNS” → “Dynamic Update Candidates” → version 2 – copy the token from the update link (the part after /u/).', 'Paste the token here. For IPv6 add an AAAA sub domain and its token too.'],
    note: 'Free with many shared domains. Each record (A, AAAA) has its own update token.',
    async update({ creds, ip4, ip6 }, { fetch }) {
      const one = async (host, token, ip) => {
        const r = await call(fetch, `https://${host}/u/${enc(token)}/${ip ? `?ip=${enc(ip)}` : ''}`);
        if (server(r.status)) throw new DynError(`FreeDNS answers with HTTP ${r.status}.`, 'down');
        if (/^ERROR/i.test(r.text) || r.status !== 200) throw new DynError('FreeDNS does not accept the update token.', 'auth');
        return /No IP change/i.test(r.text) ? 'unchanged' : 'updated';
      };
      const a = [];
      if (ip4) a.push(await one('sync.afraid.org', creds.token, ip4));
      if (ip6 && creds.token6) a.push(await one('v6.sync.afraid.org', creds.token6, ip6));
      return { answer: a.includes('updated') ? 'updated' : 'unchanged' };
    },
  },
  noip: {
    label: 'No-IP', free: true, maintenance: 'monthly', suffix: 'ddns.net', ipv6: true,
    fields: [{ key: 'user', label: 'User name or e-mail', required: true }, { key: 'pass', label: 'Password or DDNS key', secret: true, required: true }],
    signup: 'https://www.noip.com/sign-up',
    steps: ['Sign up at noip.com and create a hostname.', 'Best: create a DDNS key (user + password only for updates).', 'Enter both here.'],
    note: 'Free hostnames must be confirmed by e-mail every 30 days – otherwise No-IP deletes them. Not maintenance-free.',
    async update({ name, creds, ip4, ip6 }, { fetch }) {
      const ips = [ip4, ip6].filter(Boolean).join(',');
      const r = await call(fetch, `https://dynupdate.no-ip.com/nic/update?hostname=${enc(name)}${ips ? `&myip=${enc(ips)}` : ''}`, { Authorization: basic(creds.user, creds.pass) });
      const code = (r.text.split(/\s/)[0] || '').toLowerCase();
      if (code === 'good') return { answer: 'updated' };
      if (code === 'nochg') return { answer: 'unchanged' };
      if (code === '911' || server(r.status)) throw new DynError('No-IP has a problem on its side – Hostwerk tries again in 30 minutes.', 'down', { retryAfter: 1800 });
      if (code === 'badauth' || r.status === 401) throw new DynError('No-IP does not accept user name and password.', 'auth');
      if (code === 'nohost') throw new DynError('No-IP does not know this hostname in your account (expired? confirm it every 30 days).', 'config');
      throw new DynError(`No-IP stops updates: ${code || r.status} – please check the account on noip.com.`, 'config');
    },
  },
};

/** Für die Oberfläche: ohne update(). */
function dynCatalog() {
  return Object.entries(DYN).map(([id, p]) => ({ id, label: p.label, free: p.free, maintenance: p.maintenance, suffix: p.suffix, ipv6: p.ipv6, records: !!p.records, dnssec: !!p.dnssec, fields: p.fields, signup: p.signup, steps: p.steps, note: p.note }));
}

/** Name vervollständigen: „meinserver“ + duckdns → „meinserver.duckdns.org“. */
function fullName(kind, name) {
  const n = String(name || '').trim().toLowerCase().replace(/\.+$/, '');
  const p = DYN[kind];
  if (!p || !p.suffix || !n || n.includes('.')) return n;
  return `${n}.${p.suffix}`;
}

module.exports = { DYN, DynError, dynCatalog, fullName, UA };
