'use strict';
/*
 * „Prüfen“: Kommt ein Eintrag draußen an? Fragt mehrere öffentliche Resolver direkt (nicht den Zwischenspeicher dieses
 * PCs) und vergleicht mit dem erwarteten Wert. Der Resolver wird hereingereicht – die Tests bilden ihn nach.
 */
const dns = require('dns');
const R = require('./records');

const RESOLVERS = [
  { id: 'cloudflare', label: 'Cloudflare 1.1.1.1', servers: ['1.1.1.1', '1.0.0.1'] },
  { id: 'google', label: 'Google 8.8.8.8', servers: ['8.8.8.8', '8.8.4.4'] },
  { id: 'quad9', label: 'Quad9 9.9.9.9', servers: ['9.9.9.9', '149.112.112.112'] },
];

/** Echter Resolver mit festen Servern und kurzer Wartezeit. */
function realResolver(servers) {
  const r = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  r.setServers(servers);
  return r;
}

/** Antwort des Resolvers → Einträge in unserer Form (nur Inhalt + Priorität). */
async function lookup(resolver, name, type) {
  try {
    switch (type) {
      case 'A': return (await resolver.resolve4(name)).map((content) => ({ content }));
      case 'AAAA': return (await resolver.resolve6(name)).map((content) => ({ content: content.toLowerCase() }));
      case 'CNAME': return (await resolver.resolveCname(name)).map((c) => ({ content: R.strip(c) }));
      case 'MX': return (await resolver.resolveMx(name)).map((m) => ({ content: R.strip(m.exchange), priority: m.priority }));
      case 'TXT': return (await resolver.resolveTxt(name)).map((parts) => ({ content: parts.join('') }));
      case 'SRV': return (await resolver.resolveSrv(name)).map((s) => ({ content: `${s.weight} ${s.port} ${R.strip(s.name)}`, priority: s.priority }));
      case 'CAA': return (await resolver.resolveCaa(name)).map((c) => {
        const tag = ['issue', 'issuewild', 'iodef', 'issuemail'].find((k) => c[k] !== undefined) || 'issue';
        return { content: `${c.critical ? 128 : 0} ${tag} "${c[tag]}"` };
      });
      default: return [];
    }
  } catch (e) {
    if (['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(e.code)) return [];
    throw e;
  }
}

/**
 * Eintrag bei allen Resolvern prüfen.
 * → { ok, results: [{ resolver, label, ok, values, error }] } – ok = jeder Resolver kennt genau diesen Wert.
 */
async function verify(rec, { resolvers = RESOLVERS, makeResolver = realResolver, zone = null } = {}) {
  const want = { ...rec, type: String(rec.type).toUpperCase(), name: R.strip(rec.name) };
  const list = [...resolvers];
  // Ausbreitung: zusätzlich direkt beim Namensserver des Anbieters fragen – kennt er den Wert, fehlt nur noch Zeit
  if (zone) { const auth = await authoritative(zone, resolvers[0], makeResolver); if (auth) list.unshift(auth); }
  const results = await Promise.all(list.map(async (rv) => {
    try {
      const found = await lookup(makeResolver(rv.servers), want.name, want.type);
      const values = found.map((f) => (f.priority !== undefined ? `${f.priority} ${f.content}` : f.content));
      const ok = found.some((f) => R.same({ ...f, name: want.name, type: want.type }, want));
      return { resolver: rv.id, label: rv.label, ok, values, ...(rv.authoritative ? { authoritative: true } : {}) };
    } catch (e) {
      return { resolver: rv.id, label: rv.label, ok: false, values: [], error: e.code || e.message, ...(rv.authoritative ? { authoritative: true } : {}) };
    }
  }));
  const pub = results.filter((r) => !r.authoritative);
  const auth = results.find((r) => r.authoritative);
  return { ok: pub.every((r) => r.ok), some: pub.some((r) => r.ok), ...(auth ? { atProvider: auth.ok } : {}), results };
}

/** Namensserver der Zone (über einen öffentlichen Resolver) → Resolver-Eintrag, der direkt dort fragt. */
async function authoritative(zone, via, makeResolver) {
  try {
    const r = makeResolver(via.servers);
    if (typeof r.resolveNs !== 'function') return null;
    const ns = (await r.resolveNs(R.strip(zone))).map(R.strip).sort();
    for (const host of ns.slice(0, 2)) {
      try { const ips = await r.resolve4(host); if (ips.length) return { id: 'authoritative', label: host, servers: ips.slice(0, 2), authoritative: true }; } catch { /* nächster */ }
    }
  } catch { /* ohne Namensserver-Zeile */ }
  return null;
}

/** Warten, bis alle Resolver den Eintrag kennen (z. B. vor der dns-01-Prüfung von Let’s Encrypt). */
async function waitFor(rec, { timeout = 180000, every = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await verify(rec, opts);
    if (v.ok || Date.now() + every > until) return v;
    await sleep(every);
  }
}

module.exports = { RESOLVERS, verify, waitFor, lookup, realResolver, authoritative };
