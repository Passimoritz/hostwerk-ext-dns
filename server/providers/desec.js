'use strict';
/*
 * deSEC – kostenloser DNS-Betrieb mit DNSSEC (https://desec.readthedocs.io/), Anmeldung mit einem API-Token
 * (Kopfzeile "Authorization: Token …"). Funktioniert für eigene Domains UND für kostenlose Namen unter dedyn.io.
 * Einträge sind RRsets (Name + Typ mit mehreren Werten in Zonendatei-Schreibweise) – hier wie bei Hetzner in einzelne
 * Einträge aufgeteilt; die Kennung eines Eintrags ist "name/typ/wert". Die Zone selbst heißt in Adressen "@".
 * Jede Domain hat eine kleinste TTL (minimum_ttl, bei dedyn.io meist 3600) – kleinere Werte werden angehoben.
 */
const { request, ProviderError } = require('./http');
const R = require('../records');

const BASE = 'https://desec.io/api/v1';

class Desec {
  constructor(creds, { fetch: fetchFn = globalThis.fetch } = {}) { this.token = String(creds.token || '').trim(); this.fetch = fetchFn; }

  async call(method, p, body, okStatus = []) {
    const r = await request(this.fetch, method, BASE + p, { headers: { Authorization: `Token ${this.token}` }, body });
    if (r.status >= 400 && !okStatus.includes(r.status)) {
      const b = r.body;
      const msg = (b && typeof b === 'object' && !Array.isArray(b) && (b.detail || Object.values(b).flat().join('; '))) || (Array.isArray(b) ? JSON.stringify(b).slice(0, 200) : `HTTP ${r.status}`);
      throw new ProviderError(`deSEC: ${msg}`, r.status);
    }
    return r;
  }

  async test() { return { zones: (await this.zones()).length }; }

  /** Domains des Kontos – mit kleinster TTL und den DS-Einträgen, die beim Registrar hinterlegt sein müssen. */
  async zones() {
    const b = (await this.call('GET', '/domains/')).body || [];
    return (Array.isArray(b) ? b : []).map((d) => ({
      id: R.strip(d.name), name: R.strip(d.name), minTtl: Number(d.minimum_ttl) || 3600,
      dnssec: { ds: (d.keys || []).flatMap((k) => k.ds || []) },
    }));
  }

  rrId(rel, type, value) { return `${rel}/${type}/${value}`; }
  splitId(id) { const [rel, type, ...rest] = String(id).split('/'); return { rel, type, value: rest.join('/') }; }
  sub(rel) { return rel === '@' ? '' : rel; }
  url(zone, rel, type) { return `/domains/${encodeURIComponent(zone.id)}/rrsets/${rel === '@' || rel === '' ? '@' : encodeURIComponent(rel)}/${type}/`; }
  ttl(zone, ttl) { return Math.min(86400, Math.max(Number(zone.minTtl) || 3600, Number(ttl) || 3600)); }

  async rrsets(zone) {
    const out = [];
    let p = `/domains/${encodeURIComponent(zone.id)}/rrsets/`;
    for (let i = 0; i < 20 && p; i++) {
      const r = await this.call('GET', p);
      out.push(...(Array.isArray(r.body) ? r.body : []));
      // weitere Seiten über Link-Kopfzeile (cursor) – bei kleinen Zonen gibt es keine
      const link = r.headers && r.headers.get ? r.headers.get('link') : null;
      const next = link && /<([^>]+)>;\s*rel="next"/.exec(link);
      p = next ? next[1].replace(BASE, '') : null;
    }
    return out;
  }
  async rrset(zone, rel, type) {
    const r = await this.call('GET', this.url(zone, rel, type), undefined, [404]);
    return r.status === 404 ? null : r.body || null;
  }
  async setValues(zone, rel, type, values, ttl) {
    if (!values.length) { await this.call('DELETE', this.url(zone, rel, type), undefined, [404]); return; }
    const have = await this.rrset(zone, rel, type);
    if (!have) { await this.call('POST', `/domains/${encodeURIComponent(zone.id)}/rrsets/`, { subname: this.sub(rel), type, ttl: this.ttl(zone, ttl), records: values }); return; }
    await this.call('PATCH', this.url(zone, rel, type), { records: values, ttl: this.ttl(zone, ttl || have.ttl) });
  }

  async list(zone) {
    const out = [];
    for (const rr of await this.rrsets(zone)) {
      if (!R.TYPES.includes(rr.type)) continue;
      const rel = rr.subname || '@';
      for (const value of rr.records || []) out.push({ id: this.rrId(rel, rr.type, value), name: R.fqdn(rel, zone.name), type: rr.type, ttl: rr.ttl, ...R.fromZoneValue(rr.type, value) });
    }
    return out;
  }

  async create(zone, r) {
    const rel = R.relative(r.name, zone.name);
    const value = R.toZoneValue(r);
    const have = await this.rrset(zone, rel, r.type);
    const values = have ? [...(have.records || [])] : [];
    if (!values.includes(value)) values.push(value);
    await this.setValues(zone, rel, r.type, values, r.ttl);
    return { ...r, ttl: this.ttl(zone, r.ttl), id: this.rrId(rel, r.type, value) };
  }

  async update(zone, id, r) {
    const old = this.splitId(id);
    const rel = R.relative(r.name, zone.name);
    const value = R.toZoneValue(r);
    if (old.rel === rel && old.type === r.type) {
      const have = await this.rrset(zone, rel, r.type);
      const values = (have ? have.records || [] : []).map((x) => (x === old.value ? value : x));
      if (!values.includes(value)) values.push(value);
      await this.setValues(zone, rel, r.type, [...new Set(values)], r.ttl);
      return { ...r, ttl: this.ttl(zone, r.ttl), id: this.rrId(rel, r.type, value) };
    }
    await this.remove(zone, id);
    return this.create(zone, r);
  }

  async remove(zone, id) {
    const { rel, type, value } = this.splitId(id);
    const have = await this.rrset(zone, rel, type);
    if (!have) return;
    await this.setValues(zone, rel, type, (have.records || []).filter((v) => v !== value), have.ttl);
  }
}

module.exports = { Desec, BASE };
