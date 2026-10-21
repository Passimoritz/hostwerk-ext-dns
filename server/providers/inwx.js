'use strict';
/*
 * INWX – DomRobot JSON-RPC (https://www.inwx.de/de/help/apidoc). Anmeldung mit Benutzername und Passwort, optional
 * Zwei-Faktor-Code: Hostwerk rechnet ihn aus dem TOTP-Geheimnis selbst aus (wie die Authenticator-App).
 * Die Sitzung hängt an einem Cookie; nach jeder Arbeit meldet sich Hostwerk wieder ab.
 * Antwortcodes 1000–1999 bedeuten Erfolg. Namen kommen vollständig zurück, angelegt wird relativ zur Domain.
 */
const crypto = require('crypto');
const { request, ProviderError } = require('./http');
const R = require('../records');

const LIVE = 'https://api.domrobot.com/jsonrpc/';
const OTE = 'https://api.ote.domrobot.com/jsonrpc/';

/** TOTP nach RFC 6238 (30 s, 6 Stellen, SHA-1) aus einem Base32-Geheimnis. */
function totp(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}

class Inwx {
  constructor(creds, { fetch: fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
    this.user = String(creds.user || '').trim();
    this.pass = String(creds.pass || '');
    this.totpSecret = String(creds.totp || '').trim();
    this.url = creds.sandbox ? OTE : LIVE;
    this.fetch = fetchFn; this.now = now;
    this.cookie = null;
  }

  async rpc(method, params = {}) {
    const r = await request(this.fetch, 'POST', this.url, { headers: this.cookie ? { Cookie: this.cookie } : {}, body: { method, params } });
    const setCookie = r.headers && typeof r.headers.get === 'function' ? r.headers.get('set-cookie') : null;
    if (setCookie) this.cookie = setCookie.split(/,(?=\s*\w+=)/).map((c) => c.split(';')[0].trim()).join('; ');
    const b = r.body || {};
    if (r.status >= 400) throw new ProviderError(`INWX: HTTP ${r.status}`, r.status);
    if (!(b.code >= 1000 && b.code < 2000)) {
      const auth = [2200, 2201, 2202].includes(b.code) || method === 'account.login';
      throw new ProviderError(`INWX: ${b.msg || 'error'}${b.reason ? ` (${b.reason})` : ''} [${b.code}]`, auth ? 401 : 400);
    }
    return b.resData || {};
  }

  async login() {
    if (this.cookie) return;
    const res = await this.rpc('account.login', { user: this.user, pass: this.pass, lang: 'en' });
    if (res.tfa && res.tfa !== '0' && res.tfa !== 0) {
      if (!this.totpSecret) { this.cookie = null; throw new ProviderError('INWX: this account uses two-factor sign-in – enter the TOTP secret (the text behind the QR code).', 401); }
      await this.rpc('account.unlock', { tan: totp(this.totpSecret, this.now()) });
    }
  }
  async logout() { if (!this.cookie) return; try { await this.rpc('account.logout'); } catch { /* egal */ } this.cookie = null; }
  /** Angemeldet arbeiten, danach abmelden – auch bei Fehlern. */
  async session(fn) { await this.login(); try { return await fn(); } finally { await this.logout(); } }

  async test() { return this.session(async () => ({ zones: (await this.zoneList()).length })); }
  async zoneList() { const r = await this.rpc('nameserver.list', { pagelimit: 1000 }); return (r.domains || []).map((d) => ({ id: R.strip(d.domain), name: R.strip(d.domain) })); }
  async zones() { return this.session(() => this.zoneList()); }

  fromApi(zone, x) {
    const r = { id: String(x.id), name: R.strip(x.name || zone.name), type: x.type, ttl: Number(x.ttl) || 3600, content: x.content };
    if (x.type === 'MX' || x.type === 'CNAME') r.content = R.strip(x.content);
    if (x.type === 'MX' || x.type === 'SRV') r.priority = Number(x.prio) || 0;
    if (x.type === 'TXT') r.content = R.txtUnquote(x.content);
    if (x.type === 'SRV') { const s = R.parseSrv(x.content); if (s) r.content = `${s.weight} ${s.port} ${s.target}`; }
    return r;
  }
  toApi(zone, r) {
    const rel = R.relative(r.name, zone.name);
    const o = { name: rel === '@' ? '' : rel, type: r.type, content: r.content, ttl: Math.max(300, r.ttl) };
    if (r.priority !== undefined) o.prio = r.priority;
    return o;
  }

  async list(zone) {
    return this.session(async () => {
      const res = await this.rpc('nameserver.info', { domain: zone.name });
      return (res.record || []).filter((x) => R.TYPES.includes(x.type)).map((x) => this.fromApi(zone, x));
    });
  }
  async create(zone, r) { return this.session(async () => { const res = await this.rpc('nameserver.createRecord', { domain: zone.name, ...this.toApi(zone, r) }); return { ...r, id: String(res.id) }; }); }
  async update(zone, id, r) { return this.session(async () => { await this.rpc('nameserver.updateRecord', { id: Number(id), ...this.toApi(zone, r) }); return { ...r, id: String(id) }; }); }
  async remove(zone, id) { return this.session(async () => { await this.rpc('nameserver.deleteRecord', { id: Number(id) }); }); }
}

module.exports = { Inwx, totp, LIVE, OTE };
