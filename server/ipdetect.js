'use strict';
/*
 * Öffentliche Adressen dieses Anschlusses – ohne Schlüssel, aus mehreren unabhängigen Quellen.
 *
 *   IPv4  mehrere „Wie ist meine IP?“-Dienste (ipify, icanhazip, ident.me, Cloudflare) – gezielt über IPv4 gefragt.
 *         Eine Adresse gilt erst, wenn zwei Quellen dasselbe sagen (antwortet nur eine, gilt sie, solange keine
 *         widerspricht). So setzt ein einzelner gestörter Dienst nie eine falsche Adresse.
 *   IPv6  Für AAAA zählt die FESTE Adresse dieses PCs, nicht die wechselnde Datenschutz-Adresse, mit der er ins Netz
 *         geht. Vorrang: Erweiterung „Router & Portfreigaben“ (router.net().v6.stable) → eigene Erkennung (netsh/ip).
 *         Die Dienste prüfen nur, ob IPv6 überhaupt nach draußen geht (gleiches /64-Netz).
 *
 * Alles hereinreichbar (getText, localV6) – die Tests fragen nie das echte Netz.
 */
const https = require('https');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

const SOURCES = [
  { id: 'ipify', v4: 'https://api.ipify.org/', v6: 'https://api6.ipify.org/' },
  { id: 'icanhazip', v4: 'https://icanhazip.com/', v6: 'https://icanhazip.com/' },
  { id: 'ident', v4: 'https://ident.me/', v6: 'https://ident.me/' },
  { id: 'cloudflare', v4: 'https://one.one.one.one/cdn-cgi/trace', v6: 'https://one.one.one.one/cdn-cgi/trace' },
];

/** GET über eine bestimmte Adressfamilie (4 oder 6) – so antwortet ein Dienst mit beiden Familien gezielt. */
function getText(url, family, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family, timeout, headers: { 'User-Agent': 'Hostwerk-DNS' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(new Error('answer too long')); });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Antwort eines Dienstes → Adresse (Cloudflare liefert "ip=…" in mehreren Zeilen). */
function parseIp(text, family) {
  const t = String(text || '');
  const m = /^ip=(.+)$/m.exec(t);
  const ip = (m ? m[1] : t).trim().toLowerCase();
  return net.isIP(ip) === family ? ip : null;
}

/** Mehrheit der Antworten: { ip, agree, answers }. */
function majority(answers) {
  const count = new Map();
  for (const a of answers) if (a.ip) count.set(a.ip, (count.get(a.ip) || 0) + 1);
  const ranked = [...count.entries()].sort((x, y) => y[1] - x[1]);
  if (!ranked.length) return { ip: null, agree: 0, answers };
  const [ip, n] = ranked[0];
  // Eine einzelne Antwort zählt nur, wenn keine andere widerspricht
  if (n < 2 && ranked.length > 1) return { ip: null, agree: n, answers, conflict: true };
  return { ip, agree: n, answers };
}

/** Öffentliche IPv4 über mehrere Quellen. Fragt nacheinander, bis zwei übereinstimmen. */
async function publicV4({ get = getText, sources = SOURCES } = {}) {
  const answers = [];
  for (const s of sources) {
    try { answers.push({ source: s.id, ip: parseIp(await get(s.v4, 4), 4) }); } catch (e) { answers.push({ source: s.id, ip: null, error: e.message }); }
    const m = majority(answers);
    if (m.agree >= 2) return m;
  }
  return majority(answers);
}

/** Öffentliche IPv6, mit der dieser PC hinausgeht (erste Quelle, die antwortet) – nur als „IPv6 geht nach draußen“. */
async function outsideV6({ get = getText, sources = SOURCES } = {}) {
  for (const s of sources) {
    try { const ip = parseIp(await get(s.v6, 6), 6); if (ip) return ip; } catch { /* nächste Quelle */ }
  }
  return null;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, out) => resolve(String(out || ''))));

/** Globale IPv6-Adressen der Netzwerkkarten (ohne Link-Local, ULA, Loopback). */
function globalV6() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv6' && n.family !== 6) continue;
      const a = String(n.address).toLowerCase();
      if (n.internal || /^(fe80|fc|fd)/.test(a) || a === '::1' || a.startsWith('::ffff:')) continue;
      if (/^[23]/.test(a)) out.push(a);
    }
  }
  return out;
}

/** Feste (nicht temporäre) globale IPv6 dieses PCs – Windows über netsh, sonst ip -6 addr (ohne "temporary"). */
async function stableV6Local() {
  const all = globalV6();
  if (!all.length) return null;
  if (process.platform === 'win32') {
    // netsh hängt von der Sprache ab: temporäre Adressen heißen „Temporär“ oder „Temporary“
    const out = await run('netsh', ['interface', 'ipv6', 'show', 'addresses']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+([0-9a-f:]+)\s*$/i);
      if (m && !/^temp/i.test(m[1]) && all.includes(m[2].toLowerCase())) return m[2].toLowerCase();
    }
  } else {
    const out = await run('ip', ['-6', 'addr', 'show', 'scope', 'global']);
    for (const line of out.split('\n')) {
      const m = line.match(/inet6\s+([0-9a-f:]+)\/\d+/i);
      if (m && !/temporary|deprecated/.test(line) && all.includes(m[1].toLowerCase())) return m[1].toLowerCase();
    }
  }
  return all[0];
}

/** Die ersten 64 Bit einer IPv6 (Netz) – zum Vergleich „liegt im selben Netz“. */
function prefix64(ip) {
  if (net.isIP(ip) !== 6) return null;
  let [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const full = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(':');
}

/**
 * Beide Adressen auf einmal: { v4, v6, v6Reachable, sources: { v4: [...] }, t }.
 * router = ctx.router (optional) – seine Erkennung hat Vorrang für IPv6.
 */
async function detect({ get = getText, router = null, localV6 = stableV6Local, sources = SOURCES } = {}) {
  const [v4r, out6] = await Promise.all([publicV4({ get, sources }), outsideV6({ get, sources })]);
  let v6 = null;
  if (router && typeof router.net === 'function') { try { const n = await router.net(); v6 = (n && n.v6 && n.v6.stable) || null; } catch { /* eigene Erkennung */ } }
  if (!v6) { try { v6 = await localV6(); } catch { v6 = null; } }
  // Ohne IPv6 nach draußen hilft ein AAAA-Eintrag niemandem
  const v6Reachable = !!(v6 && out6 && prefix64(v6) === prefix64(out6));
  return { v4: v4r.ip, v4Agree: v4r.agree, v4Conflict: !!v4r.conflict, v6: v6Reachable ? v6 : null, v6Local: v6, v6Outside: out6, sources: { v4: v4r.answers }, t: Date.now() };
}

module.exports = { SOURCES, getText, parseIp, majority, publicV4, outsideV6, stableV6Local, globalV6, prefix64, detect };
