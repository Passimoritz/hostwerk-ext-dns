'use strict';
/*
 * Hetzner – zwei offizielle Schnittstellen:
 *   cloud   Hetzner Console / Cloud-API (https://docs.hetzner.cloud/reference/cloud#dns), Bearer-Token eines Projekts
 *           mit Lese- und Schreibrecht. Einträge sind RRSets (Name + Typ mit mehreren Werten) – hier in einzelne
 *           Einträge aufgeteilt; die Kennung eines Eintrags ist "name/typ/wert".
 *   legacy  die ältere DNS-Konsole (https://dns.hetzner.com/api-docs), Kopfzeile Auth-API-Token – für Zonen, die noch
 *           nicht in die Console umgezogen sind.
 * Werte stehen in Zonendatei-Schreibweise ("10 mail.example.com.", TXT in Anführungszeichen) – siehe records.js.
 */
const { request, ProviderError } = require('./http');
const R = require('../records');

const CLOUD = 'https://api.hetzner.cloud/v1';
const LEGACY = 'https://dns.hetzner.com/api/v1';

class Hetzner {
  constructor(creds, { fetch: fetchFn = globalThis.fetch } = {}) {
    this.token = String(creds.token || '').trim();
    this.legacy = creds.api === 'legacy';
    this.fetch = fetchFn;
  }

  async call(method, p, body, okStatus = []) {
    const headers = this.legacy ? { 'Auth-API-Token': this.token } : { Authorization: `Bearer ${this.token}` };
    const r = await request(this.fetch, method, (this.legacy ? LEGACY : CLOUD) + p, { headers, body });
    if (r.status >= 400 && !okStatus.includes(r.status)) {
      const b = r.body || {};
      const msg = (b.error && (b.error.message || b.error.code)) || b.message || `HTTP ${r.status}`;
      throw new ProviderError(`Hetzner: ${msg}`, r.status);
    }
    return r;
  }

  async test() { return { zones: (await this.zones()).length }; }

  async zones() {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const b = (await this.call('GET', `/zones?per_page=100&page=${page}`)).body || {};
      out.push(...(b.zones || []).map((z) => ({ id: String(z.id), name: R.strip(z.name) })));
      const pg = (b.meta && b.meta.pagination) || {};
      if (!pg.next_page && !(pg.last_page && page < pg.last_page)) break;
    }
    return out;
  }

  /* ---------------- Cloud-API: RRSets ---------------- */
  rrId(rel, type, value) { return `${rel}/${type}/${value}`; }
  splitId(id) { const [rel, type, ...rest] = String(id).split('/'); return { rel, type, value: rest.join('/') }; }

  async rrsets(zone) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const b = (await this.call('GET', `/zones/${encodeURIComponent(zone.id)}/rrsets?per_page=100&page=${page}`)).body || {};
      out.push(...(b.rrsets || []));
      const pg = (b.meta && b.meta.pagination) || {};
      if (!pg.next_page) break;
    }
    return out;
  }
  async rrset(zone, rel, type) {
    const r = await this.call('GET', `/zones/${encodeURIComponent(zone.id)}/rrsets/${encodeURIComponent(rel)}/${type}`, undefined, [404]);
    return r.status === 404 ? null : (r.body && r.body.rrset) || null;
  }
  async setValues(zone, rel, type, values, ttl) {
    const base = `/zones/${encodeURIComponent(zone.id)}/rrsets`;
    if (!values.length) { await this.call('DELETE', `${base}/${encodeURIComponent(rel)}/${type}`, undefined, [404]); return; }
    const have = await this.rrset(zone, rel, type);
    const records = values.map((value) => ({ value }));
    if (!have) { await this.call('POST', base, { name: rel, type, ttl, records }); return; }
    await this.call('POST', `${base}/${encodeURIComponent(rel)}/${type}/actions/set_records`, { records });
    if (ttl && have.ttl !== ttl) await this.call('POST', `${base}/${encodeURIComponent(rel)}/${type}/actions/change_ttl`, { ttl });
  }

  /* ---------------- Gemeinsam ---------------- */
  fromValue(zone, rel, type, value, ttl, id) {
    return { id, name: R.fqdn(rel, zone.name), type, ttl: ttl || 3600, ...R.fromZoneValue(type, value) };
  }

  async list(zone) {
    if (this.legacy) {
      const b = (await this.call('GET', `/records?zone_id=${encodeURIComponent(zone.id)}`)).body || {};
      return (b.records || []).filter((x) => R.TYPES.includes(x.type)).map((x) => this.fromValue(zone, x.name, x.type, x.value, x.ttl, String(x.id)));
    }
    const out = [];
    for (const rr of await this.rrsets(zone)) {
      if (!R.TYPES.includes(rr.type)) continue;
      for (const rec of rr.records || []) out.push(this.fromValue(zone, rr.name, rr.type, rec.value, rr.ttl, this.rrId(rr.name, rr.type, rec.value)));
    }
    return out;
  }

  async create(zone, r) {
    const rel = R.relative(r.name, zone.name);
    const value = R.toZoneValue(r);
    if (this.legacy) {
      const b = (await this.call('POST', '/records', { zone_id: zone.id, type: r.type, name: rel, value, ttl: r.ttl })).body || {};
      const x = b.record || {};
      return { ...r, id: String(x.id || '') };
    }
    const have = await this.rrset(zone, rel, r.type);
    const values = have ? (have.records || []).map((x) => x.value) : [];
    if (!values.includes(value)) values.push(value);
    await this.setValues(zone, rel, r.type, values, r.ttl);
    return { ...r, id: this.rrId(rel, r.type, value) };
  }

  async update(zone, id, r) {
    if (this.legacy) {
      await this.call('PUT', `/records/${encodeURIComponent(id)}`, { zone_id: zone.id, type: r.type, name: R.relative(r.name, zone.name), value: R.toZoneValue(r), ttl: r.ttl });
      return { ...r, id };
    }
    const old = this.splitId(id);
    const rel = R.relative(r.name, zone.name);
    const value = R.toZoneValue(r);
    if (old.rel === rel && old.type === r.type) {
      const have = await this.rrset(zone, rel, r.type);
      const values = (have ? have.records || [] : []).map((x) => (x.value === old.value ? value : x.value));
      if (!values.includes(value)) values.push(value);
      await this.setValues(zone, rel, r.type, [...new Set(values)], r.ttl);
      return { ...r, id: this.rrId(rel, r.type, value) };
    }
    await this.remove(zone, id);
    return this.create(zone, r);
  }

  async remove(zone, id) {
    if (this.legacy) { await this.call('DELETE', `/records/${encodeURIComponent(id)}`); return; }
    const { rel, type, value } = this.splitId(id);
    const have = await this.rrset(zone, rel, type);
    if (!have) return;
    await this.setValues(zone, rel, type, (have.records || []).map((x) => x.value).filter((v) => v !== value), have.ttl);
  }
}

module.exports = { Hetzner, CLOUD, LEGACY };
