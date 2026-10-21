'use strict';
/*
 * Zonendatei (RFC 1035, BIND-Schreibweise) – Export aller Einträge einer Zone und Import von Einträgen.
 *
 *   exportZone(zone, records)  → Text mit $ORIGIN/$TTL, Namen relativ zur Zone, Werte wie in records.toZoneValue
 *   parseZone(text, zone)      → { records: [{ name, type, content, ttl, priority? }], errors: [{ line, text }] }
 *
 * Der Leser versteht, was Anbieter beim Export liefern: Kommentare (;), $ORIGIN, $TTL, leere Namen (= wie die Zeile
 * davor), @, Klassen IN, TTL vor oder nach der Klasse, Klammern über mehrere Zeilen (lange DKIM-Schlüssel), TXT in
 * mehreren Stücken. SOA und NS verwaltet der Anbieter – sie werden still übersprungen, andere Typen gemeldet.
 */
const R = require('./records');

const SKIP = ['SOA', 'NS', 'DNSKEY', 'RRSIG', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'CDS', 'CDNSKEY', 'DS'];

/** Export. */
function exportZone(zone, records) {
  const z = R.strip(zone.name);
  const lines = [`; Zone ${z} – exported by Hostwerk ${new Date().toISOString()}`, `$ORIGIN ${z}.`, '$TTL 3600', ''];
  const sorted = [...records].sort((a, b) => (a.name === b.name ? a.type.localeCompare(b.type) : R.relative(a.name, z).localeCompare(R.relative(b.name, z))));
  for (const r of sorted) {
    const rel = R.relative(r.name, z);
    const value = r.type === 'CAA' ? r.content : R.toZoneValue(r);
    lines.push(`${rel.padEnd(24)} ${String(r.ttl || 3600).padEnd(6)} IN ${r.type.padEnd(5)} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Zeile in Wörter teilen – Anführungszeichen halten Leerzeichen zusammen, ; beginnt einen Kommentar. */
function tokens(line) {
  const out = []; let cur = ''; let q = false; let had = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { cur += c; if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; } if (c === '"') q = false; continue; }
    if (c === ';') break;
    if (c === '"') { q = true; cur += c; had = true; continue; }
    if (c === '(' || c === ')') { if (cur) { out.push(cur); cur = ''; } continue; }
    if (/\s/.test(c)) { if (cur || had) { out.push(cur); cur = ''; had = false; } continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

/** Klammern über mehrere Zeilen zu logischen Zeilen zusammenfassen (Zeilennummer der ersten bleibt). */
function logicalLines(text) {
  const out = []; let buf = null; let depth = 0;
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    let q = false; let opened = 0;
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k];
      if (q) { if (c === '\\') k++; else if (c === '"') q = false; continue; }
      if (c === ';') break;
      if (c === '"') q = true; else if (c === '(') opened++; else if (c === ')') opened--;
    }
    if (buf) { buf.text += ` ${raw}`; } else buf = { line: i + 1, text: raw, blank: /^\s/.test(raw) };
    depth += opened;
    if (depth <= 0) { out.push(buf); buf = null; depth = 0; }
  });
  if (buf) out.push(buf);
  return out;
}

const isTtl = (s) => /^\d+[smhdw]?$/i.test(s);
const ttlSec = (s) => { const m = /^(\d+)([smhdw]?)$/i.exec(s); const f = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()]; return Number(m[1]) * f; };

/** Import lesen. */
function parseZone(text, zone) {
  let origin = R.strip(zone);
  let defTtl = 3600;
  let last = origin;
  const records = []; const errors = [];
  const abs = (n) => (n === '@' ? origin : n.endsWith('.') ? R.strip(n) : `${n.toLowerCase()}.${origin}`);
  for (const { line, text: l, blank } of logicalLines(text)) {
    const t = tokens(l);
    if (!t.length) continue;
    if (/^\$ORIGIN$/i.test(t[0])) { origin = R.strip(t[1]); continue; }
    if (/^\$TTL$/i.test(t[0])) { if (t[1] && isTtl(t[1])) defTtl = ttlSec(t[1]); continue; }
    if (/^\$/.test(t[0])) { errors.push({ line, text: `${t[0]} is not supported.` }); continue; }
    let i = 0;
    let name = last;
    if (!blank) { name = abs(t[0]); i = 1; }
    let ttl = defTtl;
    // TTL und Klasse in beliebiger Reihenfolge
    for (let k = 0; k < 2 && i < t.length; k++) {
      if (isTtl(t[i])) { ttl = ttlSec(t[i]); i++; } else if (/^(IN|CH|HS)$/i.test(t[i])) i++;
    }
    const type = String(t[i] || '').toUpperCase(); i++;
    const rest = t.slice(i);
    last = name;
    if (!type) { errors.push({ line, text: 'No record type.' }); continue; }
    if (SKIP.includes(type)) continue;
    if (!R.TYPES.includes(type)) { errors.push({ line, text: `${type} records are not supported.` }); continue; }
    try {
      let rec;
      if (type === 'CAA') rec = { name, type, ttl, content: rest.join(' ') };
      else {
        const v = R.fromZoneValue(type, rest.join(' '));
        rec = { name, type, ttl, ...v };
        // Ziele ohne Punkt am Ende sind relativ zur Zone
        const rel = (h) => (h === '@' ? origin : String(rest[rest.length - 1]).endsWith('.') || !h ? h : `${h}.${origin}`);
        if (type === 'CNAME' || type === 'MX') rec.content = rel(rec.content);
        if (type === 'SRV') { const s = R.parseSrv(rec.content); if (s) rec.content = `${s.weight} ${s.port} ${rel(s.target)}`; }
      }
      records.push(R.validate(rec, zone));
    } catch (e) { errors.push({ line, text: e.message }); }
  }
  return { records, errors };
}

module.exports = { exportZone, parseZone, tokens, logicalLines };
