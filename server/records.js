'use strict';
/*
 * DNS-Einträge in einer anbieterunabhängigen Form – alle Anbieter bilden ihre Antworten hierauf ab:
 *
 *   { id, name, type, content, ttl, priority? }
 *     name     vollständiger Name ohne Punkt am Ende, klein ("www.example.com", die Zone selbst = "example.com")
 *     content  A/AAAA: Adresse · CNAME/MX: Zielname ohne Punkt · TXT: reiner Text ohne Anführungszeichen
 *              SRV: "gewicht port ziel" (Priorität getrennt) · CAA: 'flags tag "wert"', z. B. 0 issue "letsencrypt.org"
 *     priority nur MX und SRV
 *
 * Dazu Prüfung (validate), Vergleich (same) und Umwandlung in/aus Zonendatei-Schreibweise (Hetzner).
 */
const net = require('net');

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const CAA_TAGS = ['issue', 'issuewild', 'iodef', 'issuemail'];
const HOST = /^(?=.{1,253}$)(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?$/i;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

// Englischer Text mit eingesetzten Werten – Hostwerk übersetzt ihn über "$patterns" in locales/de.json
const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s);
const bad = (text, vars) => Object.assign(new Error(fill(text, vars)), { status: 400 });
const strip = (s) => String(s || '').trim().replace(/\.+$/, '').toLowerCase();

/** Name in der Zone → vollständiger Name: "@" / "" → Zone, "www" → "www.example.com", vollständige Namen bleiben. */
function fqdn(name, zone) {
  const z = strip(zone);
  const n = String(name || '').trim();
  if (!n || n === '@') return z;
  if (n.endsWith('.') || !z) return strip(n);
  const s = n.toLowerCase();
  return s === z || s.endsWith(`.${z}`) ? s : `${s}.${z}`;
}

/** Vollständiger Name → Name in der Zone ("@" für die Zone selbst). */
function relative(full, zone) {
  const f = strip(full); const z = strip(zone);
  if (f === z) return '@';
  return f.endsWith(`.${z}`) ? f.slice(0, -(z.length + 1)) : f;
}

/** TXT in Zonendatei-Schreibweise: in Stücke zu 255 Zeichen, jedes in Anführungszeichen. */
function txtQuote(s) {
  const t = String(s);
  const parts = [];
  for (let i = 0; i < t.length || i === 0; i += 255) parts.push(t.slice(i, i + 255));
  return parts.map((p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
}

/** Gegenstück: '"a" "b"' → "ab"; Text ohne Anführungszeichen bleibt, wie er ist. */
function txtUnquote(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('"')) return t;
  let out = ''; let i = 0;
  while (i < t.length) {
    if (t[i] !== '"') { i++; continue; }
    i++;
    while (i < t.length && t[i] !== '"') { if (t[i] === '\\' && i + 1 < t.length) i++; out += t[i++]; }
    i++;
  }
  return out;
}

/** SRV-Inhalt "gewicht port ziel" → Teile. */
function parseSrv(content) {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+?)\.?\s*$/.exec(String(content || ''));
  return m ? { weight: Number(m[1]), port: Number(m[2]), target: m[3].toLowerCase() } : null;
}

/** CAA-Inhalt '0 issue "letsencrypt.org"' → Teile. */
function parseCaa(content) {
  const m = /^\s*(\d+)\s+([a-z]+)\s+"?(.*?)"?\s*$/i.exec(String(content || ''));
  return m ? { flags: Number(m[1]), tag: m[2].toLowerCase(), value: m[3] } : null;
}
const caa = (flags, tag, value) => `${Number(flags) || 0} ${String(tag).toLowerCase()} "${value}"`;

/** Eintrag prüfen und vereinheitlichen. Wirft Fehler mit status 400 und englischem Text (übersetzt in host.t). */
function validate(rec, zone) {
  const r = rec || {};
  const type = String(r.type || '').toUpperCase();
  if (!TYPES.includes(type)) throw bad('Unknown record type – allowed: {types}.', { types: TYPES.join(', ') });
  const name = fqdn(r.name, zone);
  if (!HOST.test(name)) throw bad('The name “{name}” is not a valid host name.', { name });
  if (zone && name !== strip(zone) && !name.endsWith(`.${strip(zone)}`)) throw bad('The name “{name}” is not inside the zone {zone}.', { name, zone: strip(zone) });
  let content = String(r.content === undefined ? '' : r.content).trim();
  let priority = r.priority === undefined || r.priority === '' || r.priority === null ? undefined : Number(r.priority);
  const ttl = r.ttl === undefined || r.ttl === '' || r.ttl === null ? 3600 : Number(r.ttl);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800) throw bad('The TTL must be between 60 and 604800 seconds.');
  const host = (v, what) => { const h = strip(v); if (!HOST.test(h) || h.startsWith('*.')) throw bad('{what} needs a host name, e.g. mail.example.com.', { what }); return h; };
  switch (type) {
    case 'A': if (net.isIPv4(content) !== true) throw bad('An A record needs an IPv4 address like 203.0.113.10.'); break;
    case 'AAAA': if (net.isIPv6(content) !== true) throw bad('An AAAA record needs an IPv6 address like 2001:db8::10.'); content = content.toLowerCase(); break;
    case 'CNAME':
      content = host(content, 'CNAME');
      if (name === strip(zone)) throw bad('A CNAME cannot sit on the domain itself – use A/AAAA there.');
      break;
    case 'MX':
      content = host(content, 'MX');
      if (priority === undefined) priority = 10;
      break;
    case 'TXT':
      content = txtUnquote(content);
      if (!content) throw bad('The TXT text is empty.');
      if (content.length > 4000) throw bad('The TXT text is too long (at most 4000 characters).');
      break;
    case 'SRV': {
      const s = parseSrv(content);
      if (!s || s.port < 1 || s.port > 65535 || s.weight > 65535) throw bad('SRV needs “weight port target”, e.g. 5 25565 mc.example.com.');
      if (!/^_[a-z0-9-]+\._(tcp|udp|tls)\./i.test(name)) throw bad('A SRV name starts with _service._protocol, e.g. _minecraft._tcp.');
      content = `${s.weight} ${s.port} ${host(s.target, 'SRV')}`;
      if (priority === undefined) priority = 0;
      break;
    }
    case 'CAA': {
      const c = parseCaa(content);
      if (!c || !CAA_TAGS.includes(c.tag) || c.flags > 255 || !c.value) throw bad('CAA needs “flags tag value”, e.g. 0 issue "letsencrypt.org".');
      content = caa(c.flags, c.tag, c.value);
      break;
    }
    default: break;
  }
  if (type === 'MX' || type === 'SRV') { if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw bad('The priority must be between 0 and 65535.'); } else priority = undefined;
  const out = { name, type, content, ttl };
  if (priority !== undefined) out.priority = priority;
  if (r.id !== undefined) out.id = r.id;
  if (r.proxied !== undefined) out.proxied = !!r.proxied;
  return out;
}

/** Vergleichsschlüssel für den Inhalt (Groß-/Kleinschreibung und Punkte bei Namen egal). */
function contentKey(r) {
  const t = String(r.type || '').toUpperCase();
  const c = String(r.content || '');
  if (t === 'TXT') return txtUnquote(c);
  if (t === 'CAA') { const p = parseCaa(c); return p ? caa(p.flags, p.tag, p.value) : c; }
  return strip(c);
}
/** Gleicher Eintrag? (Name, Typ, Inhalt und – bei MX/SRV – Priorität) */
function same(a, b, { priority = true } = {}) {
  if (!a || !b) return false;
  if (strip(a.name) !== strip(b.name) || String(a.type).toUpperCase() !== String(b.type).toUpperCase()) return false;
  if (contentKey(a) !== contentKey(b)) return false;
  if (priority && ['MX', 'SRV'].includes(String(a.type).toUpperCase()) && Number(a.priority || 0) !== Number(b.priority || 0)) return false;
  return true;
}

/** Kennung eines TXT-Eintrags, der nur einmal je Name vorkommen darf ("v=spf1", "v=DMARC1", "v=DKIM1" …). */
function txtTag(content) { const m = /^\s*(v=[a-z0-9]+)\b/i.exec(txtUnquote(content)); return m ? m[1].toLowerCase() : null; }

/** In Zonendatei-Schreibweise (rdata), wie Hetzner sie erwartet. */
function toZoneValue(r) {
  switch (r.type) {
    case 'CNAME': return `${r.content}.`;
    case 'MX': return `${r.priority} ${r.content}.`;
    case 'SRV': { const s = parseSrv(r.content); return `${r.priority} ${s.weight} ${s.port} ${s.target}.`; }
    case 'TXT': return txtQuote(r.content);
    default: return r.content;
  }
}

/** Gegenstück zu toZoneValue: { content, priority }. */
function fromZoneValue(type, value) {
  const v = String(value || '').trim();
  switch (String(type).toUpperCase()) {
    case 'CNAME': return { content: strip(v) };
    case 'MX': { const m = /^(\d+)\s+(\S+)$/.exec(v); return m ? { content: strip(m[2]), priority: Number(m[1]) } : { content: strip(v) }; }
    case 'SRV': { const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/.exec(v); return m ? { content: `${m[2]} ${m[3]} ${strip(m[4])}`, priority: Number(m[1]) } : { content: v }; }
    case 'TXT': return { content: txtUnquote(v) };
    case 'CAA': { const p = parseCaa(v); return { content: p ? caa(p.flags, p.tag, p.value) : v }; }
    default: return { content: v };
  }
}

/** Passt ein Name zu einer Zone? Längster Treffer gewinnt (sub.example.co.uk vor co.uk). */
function bestZone(name, zones) {
  const n = strip(name);
  let best = null;
  for (const z of zones || []) {
    const zn = strip(z.name);
    if ((n === zn || n.endsWith(`.${zn}`)) && (!best || zn.length > strip(best.name).length)) best = z;
  }
  return best;
}

module.exports = { TYPES, CAA_TAGS, DOMAIN, fqdn, relative, txtQuote, txtUnquote, parseSrv, parseCaa, validate, same, contentKey, txtTag, toZoneValue, fromZoneValue, bestZone, strip };
