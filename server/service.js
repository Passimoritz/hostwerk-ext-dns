'use strict';
/*
 * DNS-Verwaltung: Anbieter-Zugänge, Zonen, Einträge – und der Dienst "dns" für andere Erweiterungen.
 *
 * Zugänge liegen in data/dns/accounts.json; jedes geheime Feld ist mit Hostwerks Geheimschlüssel versiegelt
 * (core/secrets: AES-256-GCM, Schlüssel getrennt in config/secret.key). Die Oberfläche bekommt Geheimnisse nie zurück.
 *
 * Dienst (ctx.dns, host.use('dns')) – siehe README:
 *   accounts(), zones(), findZone(name)
 *   records(name)                      Einträge der Zone, in der "name" liegt
 *   set(record, { replace })           anlegen oder ändern (gleicher Eintrag → nichts tun)
 *   remove(record)                     genau diesen Eintrag löschen
 *   apply(records)                     viele Einträge auf einmal (Mailserver: MX, SPF, DKIM, DMARC)
 *   verify(record) / waitFor(record)   bei öffentlichen Resolvern prüfen
 *   acme.challengeCreateFn / challengeRemoveFn – dns-01 für acme-client (Let’s Encrypt, auch Wildcards)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./records');
const V = require('./verify');
const { PROVIDERS, catalog } = require('./providers');

const ZONE_CACHE_MS = 5 * 60 * 1000;
const bad = (status, text) => Object.assign(new Error(text), { status });

class DnsService {
  /**
   * @param {object} o
   *   dir      Datenordner (data/dns)
   *   secrets  { seal, open } – Hostwerks Geheimnis-Ablage
   *   fetch    für die Anbieter (Tests: Nachbildung)
   *   resolver { resolvers, makeResolver } für verify (Tests: Nachbildung)
   *   ctx      Hostwerk-Kontext (für mailserver/router), optional
   */
  constructor({ dir, secrets, fetch: fetchFn, resolver = {}, ctx = {}, log = () => {} }) {
    this.dir = dir; this.secrets = secrets; this.fetch = fetchFn || globalThis.fetch; this.resolver = resolver; this.ctx = ctx; this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    this.zoneCache = new Map(); // accountId → { t, zones }
    this.acme = {
      /** acme-client: challengeCreateFn(authz, challenge, keyAuthorization) – für dns-01 ist keyAuthorization schon der TXT-Wert. */
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (!challenge || challenge.type !== 'dns-01') return;
        const rec = { name: `_acme-challenge.${R.strip(authz.identifier.value).replace(/^\*\./, '')}`, type: 'TXT', content: keyAuthorization, ttl: 60 };
        await this.set(rec); // nichts ersetzen: Domain und Wildcard brauchen zwei Werte unter demselben Namen
        await V.waitFor(rec, { ...this.resolver, ...(this.acmeWait || {}) });
      },
      challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
        if (!challenge || challenge.type !== 'dns-01') return;
        try { await this.remove({ name: `_acme-challenge.${R.strip(authz.identifier.value).replace(/^\*\./, '')}`, type: 'TXT', content: keyAuthorization }); } catch (e) { this.log('acme cleanup:', e.message); }
      },
      /** Für eigene ACME-Umsetzungen: TXT-Wert aus der rohen Key-Authorization (base64url(SHA-256)). */
      txtValue: (rawKeyAuthorization) => crypto.createHash('sha256').update(String(rawKeyAuthorization)).digest('base64url'),
    };
  }

  /* ---------------- Speicher ---------------- */
  file() { return path.join(this.dir, 'accounts.json'); }
  load() { try { return JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch { return []; } }
  save(list) { const f = this.file(); fs.writeFileSync(`${f}.tmp`, JSON.stringify(list, null, 1), { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); }
  account(id) { const a = this.load().find((x) => x.id === id); if (!a) throw bad(404, 'DNS account not found'); return a; }

  /** Ohne Geheimnisse: { id, provider, name, created, fields: { user: 'x', token: true } } */
  pub(a) {
    const p = PROVIDERS[a.provider];
    const fields = {};
    for (const f of (p ? p.fields : [])) { const v = (a.creds || {})[f.key]; fields[f.key] = f.secret ? !!v : v === undefined ? null : v; }
    return { id: a.id, provider: a.provider, providerLabel: p ? p.label : a.provider, name: a.name, created: a.created, fields, zones: a.zones || null, lastError: a.lastError || null };
  }
  accounts() { return this.load().map((a) => this.pub(a)); }
  providers() { return catalog(); }

  /** Klartext-Zugangsdaten nur für den Anbieter-Aufruf. */
  open(a) { const p = PROVIDERS[a.provider]; const c = {}; for (const f of p.fields) { const v = (a.creds || {})[f.key]; c[f.key] = f.secret ? this.secrets.open(v) : v; } return c; }
  client(a) {
    const p = PROVIDERS[a.provider];
    if (!p) throw bad(400, 'Unknown DNS provider');
    return p.make(this.open(a), { fetch: this.fetch });
  }

  /** Zugang prüfen und speichern. Bei "id" werden leer gelassene Geheimnisse behalten. */
  async saveAccount(b, id = null) {
    const list = this.load();
    const old = id ? list.find((x) => x.id === id) : null;
    if (id && !old) throw bad(404, 'DNS account not found');
    const provider = old ? old.provider : String(b.provider || '');
    const p = PROVIDERS[provider];
    if (!p) throw bad(400, 'Unknown DNS provider');
    const creds = {};
    for (const f of p.fields) {
      let v = (b.creds || {})[f.key];
      if (f.type === 'switch') v = !!v;
      else if (f.type === 'select') v = (f.options.find((o) => o.id === v) || f.options.find((o) => o.id === f.default)).id;
      else v = v === undefined || v === null ? '' : String(v).trim();
      if (f.secret) creds[f.key] = v ? this.secrets.seal(v) : old ? (old.creds || {})[f.key] || '' : '';
      else creds[f.key] = v;
      if (f.required && !(f.secret ? creds[f.key] : v)) throw bad(400, `Please fill in “${f.label}”.`);
    }
    const name = String(b.name || '').trim().slice(0, 60) || p.label;
    const acc = { id: old ? old.id : `${provider}-${crypto.randomBytes(4).toString('hex')}`, provider, name, creds, created: old ? old.created : Date.now() };
    const info = await this.client(acc).test(); // wirft mit Text des Anbieters, wenn etwas nicht stimmt
    acc.zones = info.zones;
    this.save(old ? list.map((x) => (x.id === acc.id ? acc : x)) : [...list, acc]);
    this.zoneCache.delete(acc.id);
    return this.pub(acc);
  }
  removeAccount(id) { this.account(id); this.save(this.load().filter((x) => x.id !== id)); this.zoneCache.delete(id); }

  /* ---------------- Zonen ---------------- */
  async accountZones(a, force = false) {
    const c = this.zoneCache.get(a.id);
    if (!force && c && Date.now() - c.t < ZONE_CACHE_MS) return c.zones;
    const zones = (await this.client(a).zones()).map((z) => ({ ...z, account: a.id, provider: a.provider }));
    this.zoneCache.set(a.id, { t: Date.now(), zones });
    return zones;
  }
  /** Alle Zonen aller Zugänge. Ein Zugang mit Fehler hält die anderen nicht auf (errors). */
  async zones(force = false) {
    const out = []; const errors = [];
    const list = this.load();
    await Promise.all(list.map(async (a) => {
      try { out.push(...await this.accountZones(a, force)); } catch (e) { errors.push({ account: a.id, name: a.name, error: e.message }); }
    }));
    out.sort((x, y) => x.name.localeCompare(y.name));
    return { zones: out, errors };
  }
  /** Zone, in der ein Name liegt (längster Treffer), samt Zugang. */
  async findZone(name) {
    const { zones } = await this.zones();
    const z = R.bestZone(name, zones);
    if (!z) throw bad(404, `No DNS account manages ${R.strip(name)} – add the provider of this domain first.`);
    return { zone: z, account: this.account(z.account) };
  }
  async zoneById(accountId, zoneId) {
    const a = this.account(accountId);
    const z = (await this.accountZones(a)).find((x) => String(x.id) === String(zoneId));
    if (!z) throw bad(404, 'Zone not found');
    return { zone: z, account: a };
  }

  /* ---------------- Einträge ---------------- */
  async list(accountId, zoneId) {
    const { zone, account } = await this.zoneById(accountId, zoneId);
    const recs = await this.client(account).list(zone);
    return recs.sort((x, y) => (x.name === y.name ? x.type.localeCompare(y.type) : R.relative(x.name, zone.name).localeCompare(R.relative(y.name, zone.name))));
  }
  async create(accountId, zoneId, rec) {
    const { zone, account } = await this.zoneById(accountId, zoneId);
    return this.client(account).create(zone, R.validate(rec, zone.name));
  }
  async update(accountId, zoneId, id, rec) {
    const { zone, account } = await this.zoneById(accountId, zoneId);
    const c = this.client(account);
    const old = (await c.list(zone)).find((x) => String(x.id) === String(id));
    if (!old) throw bad(404, 'Record not found');
    return c.update(zone, id, R.validate(rec, zone.name), old);
  }
  async removeRecord(accountId, zoneId, id) {
    const { zone, account } = await this.zoneById(accountId, zoneId);
    await this.client(account).remove(zone, id);
  }

  /* ---------------- Dienst für andere Erweiterungen ---------------- */
  /** Einträge der Zone, in der "name" liegt. */
  async records(name) { const { zone, account } = await this.findZone(name); return this.client(account).list(zone); }

  /**
   * Eintrag setzen, ohne Doppelte. replace:
   *   false   nur anlegen, wenn es genau diesen Eintrag noch nicht gibt (Standard für A/AAAA/MX/SRV/CAA und dns-01)
   *   'tag'   TXT mit derselben Kennung (v=spf1, v=DMARC1, v=DKIM1 …) unter dem Namen ersetzen (Standard für solche TXT)
   *   'type'  alle Einträge dieses Typs unter dem Namen ersetzen (Standard für CNAME)
   * → { action: 'created' | 'updated' | 'unchanged', record }
   */
  async set(rec, { replace } = {}) {
    const { zone, account } = await this.findZone(rec.name);
    const want = R.validate(rec, zone.name);
    const c = this.client(account);
    const have = (await c.list(zone)).filter((x) => R.strip(x.name) === want.name && x.type === want.type);
    const mode = replace !== undefined ? replace : want.type === 'CNAME' ? 'type' : want.type === 'TXT' && R.txtTag(want.content) ? 'tag' : want.type === 'MX' ? 'target' : false;
    if (have.some((x) => R.same(x, want) && (x.ttl === want.ttl || mode === false))) return { action: 'unchanged', record: have.find((x) => R.same(x, want)) };
    let old = null;
    if (mode === 'type') old = have[0];
    else if (mode === 'tag') old = have.find((x) => R.txtTag(x.content) === R.txtTag(want.content));
    else if (mode === 'target') old = have.find((x) => R.contentKey(x) === R.contentKey(want));
    else old = have.find((x) => R.same(x, want));
    if (old) return { action: 'updated', record: await c.update(zone, old.id, want, old) };
    return { action: 'created', record: await c.create(zone, want) };
  }

  /** Genau diesen Eintrag löschen (Name, Typ, Inhalt). → { action: 'removed' | 'missing' } */
  async remove(rec) {
    const { zone, account } = await this.findZone(rec.name);
    const c = this.client(account);
    const hit = (await c.list(zone)).find((x) => R.same(x, { ...rec, name: R.strip(rec.name), type: String(rec.type).toUpperCase() }, { priority: rec.priority !== undefined }));
    if (!hit) return { action: 'missing' };
    await c.remove(zone, hit.id);
    return { action: 'removed', record: hit };
  }

  /** Viele Einträge setzen – jeder für sich, ein Fehler hält die anderen nicht auf. */
  async apply(records) {
    const out = [];
    for (const r of records || []) {
      try { out.push({ ...(await this.set(r)), input: r }); } catch (e) { out.push({ action: 'error', error: e.message, input: r }); }
    }
    return out;
  }

  verify(rec) { return V.verify(R.validate(rec), this.resolver); }
  waitFor(rec, opts = {}) { return V.waitFor(R.validate(rec), { ...this.resolver, ...opts }); }

  /* ---------------- Zusammenspiel ---------------- */
  /** Einträge, die der Mailserver (Erweiterung „Mailserver“) für seine Domains braucht – mit Stand beim Anbieter. */
  async mailRecords() {
    const ms = this.ctx.mailserver;
    if (!ms || typeof ms.configured !== 'function') return { available: false, servers: [] };
    const { zones } = await this.zones();
    const servers = [];
    for (const inst of ms.configured()) {
      let domains = [];
      try { domains = await ms.domains(inst.id); } catch (e) { servers.push({ id: inst.id, name: (inst.cfg && inst.cfg.name) || inst.id, error: e.message, domains: [] }); continue; }
      const out = [];
      for (const d of domains) {
        const z = R.bestZone(d.name, zones);
        let have = [];
        if (z) { try { have = await this.client(this.account(z.account)).list(z); } catch { have = []; } }
        const records = (d.records || []).map((r) => {
          const pr = r.type === 'MX' ? /^(\d+)\s+(\S+)$/.exec(String(r.value).trim()) : null;
          const rec = { name: R.strip(r.name), type: r.type, content: pr ? R.strip(pr[2]) : r.type === 'TXT' ? R.txtUnquote(r.value) : r.value, ...(pr ? { priority: Number(pr[1]) } : {}), ttl: 3600 };
          return { ...rec, purpose: r.purpose || '', present: have.some((h) => R.same(h, rec)) };
        });
        out.push({ name: d.name, zone: z ? { id: z.id, account: z.account, name: z.name } : null, records });
      }
      servers.push({ id: inst.id, name: (inst.cfg && inst.cfg.name) || inst.id, domains: out });
    }
    return { available: true, servers };
  }

  /** Öffentliche Adressen über die Erweiterung „Router & Portfreigaben“ (für A/AAAA). */
  async publicAddress() {
    const r = this.ctx.router;
    if (!r || typeof r.net !== 'function') return { available: false };
    try { const n = await r.net(); return { available: true, v4: n.v4public || null, v6: (n.v6 && (n.v6.stable || n.v6.public)) || null }; } catch (e) { return { available: true, error: e.message }; }
  }
}

module.exports = { DnsService };
