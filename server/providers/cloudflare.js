'use strict';
/*
 * Cloudflare – API v4 (https://developers.cloudflare.com/api/), Anmeldung mit einem API-Token (Bearer).
 * Rechte des Tokens: Zone → DNS → Bearbeiten und Zone → Zone → Lesen (für alle oder ausgewählte Zonen).
 * Namen sind vollständig; MX/SRV/CAA kommen als priority bzw. data { … }.
 */
const { request, ProviderError } = require('./http');
const R = require('../records');

const BASE = 'https://api.cloudflare.com/client/v4';

class Cloudflare {
  constructor(creds, { fetch: fetchFn = globalThis.fetch } = {}) { this.token = String(creds.token || '').trim(); this.fetch = fetchFn; }

  async call(method, p, body) {
    const r = await request(this.fetch, method, BASE + p, { headers: { Authorization: `Bearer ${this.token}` }, body });
    const b = r.body || {};
    if (r.status >= 400 || b.success === false) {
      const msg = Array.isArray(b.errors) && b.errors.length ? b.errors.map((e) => e.message).join('; ') : `HTTP ${r.status}`;
      throw new ProviderError(`Cloudflare: ${msg}`, r.status >= 400 ? r.status : 400);
    }
    return b;
  }

  /** Alle Seiten einer Liste holen (höchstens 50 Seiten à 100). */
  async all(p) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const b = await this.call('GET', `${p}${p.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...(b.result || []));
      const info = b.result_info || {};
      if (!info.total_pages || page >= info.total_pages) break;
    }
    return out;
  }

  async test() {
    try { const b = await this.call('GET', '/user/tokens/verify'); if (b.result && b.result.status && b.result.status !== 'active') throw new ProviderError('Cloudflare: the token is not active.', 401); } catch (e) {
      // Konto-Tokens kennen /user/tokens/verify nicht – dann reicht es, wenn die Zonen lesbar sind
      if (e.providerStatus !== 401 && e.providerStatus !== 403 && e.providerStatus !== 404 && e.providerStatus !== 400) throw e;
    }
    const zones = await this.zones();
    return { zones: zones.length };
  }

  async zones() { return (await this.all('/zones')).map((z) => ({ id: z.id, name: R.strip(z.name) })); }

  fromApi(x) {
    const r = { id: x.id, name: R.strip(x.name), type: x.type, ttl: x.ttl, content: x.content };
    if (x.type === 'MX') { r.content = R.strip(x.content); r.priority = x.priority; }
    if (x.type === 'CNAME') r.content = R.strip(x.content);
    if (x.type === 'TXT') r.content = R.txtUnquote(x.content);
    if (x.type === 'SRV') { const d = x.data || {}; r.priority = d.priority; r.content = `${d.weight} ${d.port} ${R.strip(d.target)}`; }
    if (x.type === 'CAA') { const d = x.data || {}; r.content = `${Number(d.flags) || 0} ${d.tag} "${d.value}"`; }
    if (x.proxied !== undefined) r.proxied = !!x.proxied;
    return r;
  }

  toApi(r) {
    const o = { type: r.type, name: r.name, ttl: r.ttl };
    if (r.type === 'SRV') { const s = R.parseSrv(r.content); o.data = { priority: r.priority, weight: s.weight, port: s.port, target: s.target }; }
    else if (r.type === 'CAA') { const c = R.parseCaa(r.content); o.data = { flags: c.flags, tag: c.tag, value: c.value }; }
    else o.content = r.type === 'TXT' ? R.txtQuote(r.content) : r.content;
    if (r.type === 'MX') o.priority = r.priority;
    if (['A', 'AAAA', 'CNAME'].includes(r.type)) o.proxied = !!r.proxied;
    return o;
  }

  async list(zone) { return (await this.all(`/zones/${encodeURIComponent(zone.id)}/dns_records`)).filter((x) => R.TYPES.includes(x.type)).map((x) => this.fromApi(x)); }
  async create(zone, r) { return this.fromApi((await this.call('POST', `/zones/${encodeURIComponent(zone.id)}/dns_records`, this.toApi(r))).result); }
  async update(zone, id, r) { return this.fromApi((await this.call('PUT', `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(id)}`, this.toApi(r))).result); }
  async remove(zone, id) { await this.call('DELETE', `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(id)}`); }
}

module.exports = { Cloudflare, BASE };
