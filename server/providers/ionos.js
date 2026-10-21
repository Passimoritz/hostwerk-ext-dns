'use strict';
/*
 * IONOS – Hosting DNS API (https://developer.hosting.ionos.de/docs/dns). Anmeldung mit dem API-Schlüssel aus
 * "präfix.geheimnis" (Kopfzeile X-API-Key). Namen sind vollständig; Name und Typ eines Eintrags lassen sich nicht
 * ändern – dann wird er gelöscht und neu angelegt.
 */
const { request, ProviderError } = require('./http');
const R = require('../records');

const BASE = 'https://api.hosting.ionos.com/dns/v1';

class Ionos {
  constructor(creds, { fetch: fetchFn = globalThis.fetch } = {}) { this.key = String(creds.key || '').trim(); this.fetch = fetchFn; }

  async call(method, p, body) {
    const r = await request(this.fetch, method, BASE + p, { headers: { 'X-API-Key': this.key }, body });
    if (r.status >= 400) {
      const b = r.body;
      const list = Array.isArray(b) ? b : b && Array.isArray(b.errors) ? b.errors : [];
      const msg = list.length ? list.map((e) => e.message || e.code).join('; ') : (b && b.message) || `HTTP ${r.status}`;
      throw new ProviderError(`IONOS: ${msg}`, r.status);
    }
    return r.body;
  }

  async test() { return { zones: (await this.zones()).length }; }
  async zones() { return ((await this.call('GET', '/zones')) || []).map((z) => ({ id: z.id, name: R.strip(z.name) })); }

  fromApi(x) {
    const r = { id: x.id, name: R.strip(x.name), type: x.type, ttl: x.ttl || 3600, content: x.content };
    if (x.type === 'MX' || x.type === 'CNAME') r.content = R.strip(x.content);
    if (x.type === 'MX' || x.type === 'SRV') r.priority = Number(x.prio) || 0;
    if (x.type === 'TXT') r.content = R.txtUnquote(x.content);
    if (x.type === 'SRV') { const s = R.parseSrv(x.content); if (s) r.content = `${s.weight} ${s.port} ${s.target}`; }
    if (x.type === 'CAA') { const c = R.parseCaa(x.content); if (c) r.content = `${c.flags} ${c.tag} "${c.value}"`; }
    return r;
  }
  toApi(r) {
    const o = { name: r.name, type: r.type, content: r.content, ttl: r.ttl, disabled: false };
    if (r.priority !== undefined) o.prio = r.priority;
    return o;
  }

  async list(zone) {
    const z = (await this.call('GET', `/zones/${encodeURIComponent(zone.id)}`)) || {};
    return (z.records || []).filter((x) => R.TYPES.includes(x.type)).map((x) => this.fromApi(x));
  }
  async create(zone, r) {
    const res = await this.call('POST', `/zones/${encodeURIComponent(zone.id)}/records`, [this.toApi(r)]);
    const x = Array.isArray(res) ? res[0] : res;
    return x && x.id ? this.fromApi({ ...this.toApi(r), ...x }) : { ...r };
  }
  async update(zone, id, r, old) {
    if (old && (R.strip(old.name) !== r.name || old.type !== r.type)) { await this.remove(zone, id); return this.create(zone, r); }
    const { name, type, ...body } = this.toApi(r); // eslint-disable-line no-unused-vars
    await this.call('PUT', `/zones/${encodeURIComponent(zone.id)}/records/${encodeURIComponent(id)}`, body);
    return { ...r, id };
  }
  async remove(zone, id) { await this.call('DELETE', `/zones/${encodeURIComponent(zone.id)}/records/${encodeURIComponent(id)}`); }
}

module.exports = { Ionos, BASE };
