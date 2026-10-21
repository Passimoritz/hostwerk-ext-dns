'use strict';
/*
 * Namen, die von selbst auf diesen Anschluss zeigen („Dynamische Namen“) – wartungsfrei:
 *
 *   - IPv4 und IPv6 werden alle 5 Minuten erkannt (mehrere Quellen ohne Schlüssel, siehe ipdetect.js).
 *   - Ein Name wird nur bei einer Änderung aktualisiert – nie öfter als einmal pro Minute.
 *   - Alle 6 Stunden prüft Hostwerk bei öffentlichen Resolvern, ob der Name wirklich auf diesen Anschluss zeigt;
 *     zeigt er woanders hin (z. B. im Webportal des Anbieters geändert), wird er neu gesetzt.
 *   - Fehler: Token falsch/abgelaufen → keine weiteren Versuche, bis der Nutzer ihn ändert; Anbieter gestört →
 *     wachsende Pausen (5 min … 6 h); zu viele Anfragen (429) → mindestens so lange warten, wie der Anbieter sagt.
 *   - Probleme werden gebündelt gemeldet (eine Benachrichtigung für alle Namen, nur wenn sich etwas ändert) und stehen
 *     in Hostwerks Selbstwartung. Jede Änderung landet im Protokoll des Namens (die letzten 50).
 *
 * Zwei Arten von Namen:
 *   kind = duckdns | desec | dynv6 | freedns | noip   kostenloser Name, Update über die Schnittstelle des Anbieters
 *   kind = zone                                        Name in einer eigenen Domain eines verbundenen Zugangs (A/AAAA)
 *
 * Daten: data/dns/dynamic.json – Tokens mit Hostwerks Geheimschlüssel versiegelt, nie an die Oberfläche.
 * „Router & Portfreigaben“ hat eine eigene, einfache DynDNS-Einstellung (settings.router.dyndns) – sie bleibt nutzbar;
 * derselbe Name wird nie von beiden aktualisiert, und „Übernehmen“ holt ihn hierher.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const R = require('./records');
const V = require('./verify');
const IP = require('./ipdetect');
const { DYN, DynError, fullName } = require('./dynproviders');

const MIN = 60000;
const TICK_MS = 5 * MIN;
const IP_CACHE_MS = 4 * MIN;
const MIN_GAP_MS = MIN;
const CHECK_EVERY_MS = 6 * 60 * MIN;
const BACKOFF_START_MS = 5 * MIN;
const BACKOFF_MAX_MS = 6 * 60 * MIN;
const SETTLE_MS = 15 * MIN;
const LOG_MAX = 50;
const ZONE_TTL = 300;
const ROUTER_KINDS = { duckdns: 'duckdns', dynv6: 'dynv6', desec: 'desec' };

const bad = (status, text) => Object.assign(new Error(text), { status });

class DynamicNames {
  /**
   * @param {object} o
   *   dir, secrets   wie DnsService
   *   dns            der DnsService (für kind = zone und die Prüfung)
   *   fetch          für die Anbieter (Tests: Nachbildung)
   *   detectIp       () → { v4, v6 } (Tests: fest)
   *   resolver       für die Prüfung „zeigt auf mich?“
   *   notifier       { notify({ title, text, kind }), note(key, { ok, label, text }) } – beides optional
   *   settings       Hostwerks Einstellungen (für die DynDNS des Routers), optional
   *   now            Uhr (Tests)
   */
  constructor({ dir, secrets, dns, fetch: fetchFn, detectIp, resolver = {}, notifier = {}, settings = null, now = () => Date.now(), log = () => {} }) {
    this.dir = dir; this.secrets = secrets; this.dns = dns; this.fetch = fetchFn || globalThis.fetch;
    this.detectIp = detectIp || (() => IP.detect());
    this.resolver = resolver; this.notifier = notifier; this.settings = settings; this.now = now; this.log = log;
    this.ipCache = null;
    this.running = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  /* ---------------- Speicher ---------------- */
  file() { return path.join(this.dir, 'dynamic.json'); }
  load() { try { const d = JSON.parse(fs.readFileSync(this.file(), 'utf8')); return { hosts: d.hosts || [], ip: d.ip || null, problems: d.problems || [] }; } catch { return { hosts: [], ip: null, problems: [] }; } }
  save(d) { const f = this.file(); fs.writeFileSync(`${f}.tmp`, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); }
  edit(fn) { const d = this.load(); const r = fn(d); this.save(d); return r; }

  /** Für die Oberfläche: ohne Geheimnisse. */
  pub(h) {
    const p = DYN[h.kind];
    const fields = {};
    for (const f of (p ? p.fields : [])) { const v = (h.creds || {})[f.key]; fields[f.key] = f.secret ? !!v : v === undefined ? null : v; }
    const st = h.state || {};
    return {
      id: h.id, kind: h.kind, label: p ? p.label : h.kind === 'zone' ? 'own domain' : h.kind, name: h.name, v4: h.v4 !== false, v6: h.v6 !== false, ttl: h.ttl || null,
      maintenance: p ? p.maintenance : 'none', fields, created: h.created,
      state: { ip4: st.ip4 || null, ip6: st.ip6 || null, t: st.t || null, ok: st.ok !== false && !st.error, error: st.error || null, errorKind: st.errorKind || null, blocked: !!st.blocked, nextTry: st.nextTry || null, check: st.check || null },
      log: (h.log || []).slice(-LOG_MAX).reverse(),
    };
  }
  list() {
    const d = this.load();
    return { hosts: d.hosts.map((h) => this.pub(h)), ip: d.ip, router: this.routerDyn() };
  }

  /* ---------------- DynDNS der Erweiterung „Router & Portfreigaben“ ---------------- */
  routerCfg() {
    if (!this.settings || typeof this.settings.get !== 'function') return null;
    const s = this.settings.get();
    return s && s.router && s.router.dyndns && s.router.dyndns.provider ? s.router.dyndns : null;
  }
  routerDyn() {
    const d = this.routerCfg();
    if (!d || !d.domain) return null;
    return { provider: d.provider, name: fullName(ROUTER_KINDS[d.provider] || '', d.domain), last: d.last || null, canTakeOver: !!ROUTER_KINDS[d.provider] && !!d.token };
  }
  /** Name aus dem Router hierher holen: Token umziehen (bleibt versiegelt), Router-DynDNS abschalten. */
  async takeOverRouter() {
    const d = this.routerCfg();
    if (!d || !ROUTER_KINDS[d.provider] || !d.token) throw bad(400, 'There is no DynDNS name in “Router & port forwarding” that can be taken over.');
    const kind = ROUTER_KINDS[d.provider];
    const name = fullName(kind, d.domain);
    const token = this.secrets.open(d.token);
    const prev = { provider: d.provider, last: d.last };
    d.provider = ''; d.last = null; // erst abschalten, sonst prüft add() „wird schon vom Router aktualisiert“
    this.settings.save();
    try { return await this.add({ kind, name, creds: { token } }); } catch (e) {
      Object.assign(d, prev); // nichts verloren: der Router aktualisiert weiter wie bisher
      this.settings.save();
      throw e;
    }
  }

  /* ---------------- Namen anlegen / ändern / entfernen ---------------- */
  host(id) { const h = this.load().hosts.find((x) => x.id === id); if (!h) throw bad(404, 'Name not found'); return h; }
  open(h) { const p = DYN[h.kind]; const c = {}; for (const f of (p ? p.fields : [])) { const v = (h.creds || {})[f.key]; c[f.key] = f.secret ? this.secrets.open(v) : v; } return c; }

  /** Neuen Namen anlegen – wird sofort gesetzt; mit falschem Token wird nichts gespeichert. */
  async add(b) { return this.saveHost(b, null); }
  async change(id, b) { return this.saveHost(b, id); }

  async saveHost(b, id) {
    const d = this.load();
    const old = id ? d.hosts.find((x) => x.id === id) : null;
    if (id && !old) throw bad(404, 'Name not found');
    const kind = old ? old.kind : String(b.kind || '');
    const p = DYN[kind];
    if (!p && kind !== 'zone') throw bad(400, 'Unknown DynDNS provider.');
    const name = old ? old.name : fullName(kind, b.name);
    if (!R.DOMAIN.test(name)) throw bad(400, `“${name}” is not a valid name.`);
    if (!old && d.hosts.some((h) => h.name === name)) throw bad(400, 'This name is already in the list.');
    const r = this.routerDyn();
    if (r && r.name === name) throw bad(400, 'This name is already updated by “Router & port forwarding” – take it over there instead of adding it twice.');
    const creds = {};
    if (p) {
      for (const f of p.fields) {
        const v = String(((b.creds || {})[f.key]) || '').trim();
        if (f.secret) creds[f.key] = v ? this.secrets.seal(v) : old ? (old.creds || {})[f.key] || '' : '';
        else creds[f.key] = v || (old ? (old.creds || {})[f.key] || '' : '');
        if (f.required && !creds[f.key]) throw bad(400, `Please fill in “${f.label}”.`);
      }
    } else {
      await this.dns.findZone(name); // wirft, wenn kein Zugang diese Domain verwaltet
    }
    const ttl = kind === 'zone' ? Math.max(60, Math.min(86400, Number(b.ttl) || (old && old.ttl) || ZONE_TTL)) : undefined;
    const h = {
      id: old ? old.id : `${kind}-${crypto.randomBytes(4).toString('hex')}`, kind, name, creds,
      v4: b.v4 !== undefined ? b.v4 !== false : old ? old.v4 !== false : true,
      v6: b.v6 !== undefined ? b.v6 !== false : old ? old.v6 !== false : true,
      ...(ttl ? { ttl } : {}), created: old ? old.created : this.now(),
      state: {}, log: old ? old.log || [] : [],
    };
    // Sofort setzen – so merkt der Nutzer einen falschen Token gleich, nicht erst in fünf Minuten
    const ip = await this.ips(true);
    const res = await this.push(h, ip, { force: true, reason: old ? 'changed' : 'added' });
    if (res.error && (res.errorKind === 'auth' || res.errorKind === 'config')) throw bad(400, res.error);
    this.edit((x) => { x.hosts = old ? x.hosts.map((y) => (y.id === h.id ? h : y)) : [...x.hosts, h]; x.ip = ip; });
    return { host: this.pub(h), warning: res.error || null };
  }

  remove(id) { this.host(id); this.edit((d) => { d.hosts = d.hosts.filter((x) => x.id !== id); }); }

  /* ---------------- Adressen ---------------- */
  async ips(force = false) {
    if (!force && this.ipCache && this.now() - this.ipCache.t < IP_CACHE_MS) return this.ipCache;
    let ip;
    try { ip = await this.detectIp(); } catch (e) { ip = { v4: null, v6: null, error: e.message }; }
    this.ipCache = { ...ip, t: this.now() };
    return this.ipCache;
  }

  /* ---------------- Aktualisieren ---------------- */
  /**
   * Einen Namen auf die aktuellen Adressen setzen. Ändert h (state, log) – speichern macht der Aufrufer.
   * → { action: 'updated' | 'unchanged' | 'skipped', error?, errorKind? }
   */
  async push(h, ip, { force = false, reason = 'ip' } = {}) {
    const st = h.state = h.state || {};
    const t = this.now();
    const want4 = h.v4 !== false && ip.v4 ? ip.v4 : null;
    const want6 = h.v6 !== false && ip.v6 ? ip.v6 : null;
    if (!want4 && !want6) return { action: 'skipped' };
    if (!force) {
      if (st.blocked) return { action: 'skipped' };
      if (st.nextTry && t < st.nextTry) return { action: 'skipped' };
      if (st.tried && t - st.tried < MIN_GAP_MS) return { action: 'skipped' };
      // Nur bei Änderung: eine Familie ohne Adresse (Erkennung kurz gestört) zählt nicht als Änderung
      const same4 = !want4 || st.ip4 === want4;
      const same6 = !want6 || st.ip6 === want6;
      if (same4 && same6 && !st.error && !st.recheck) return { action: 'unchanged' };
    }
    st.tried = t;
    try {
      let answer;
      if (h.kind === 'zone') answer = await this.pushZone(h, want4, want6);
      else answer = (await DYN[h.kind].update({ name: h.name, creds: this.open(h), ip4: want4, ip6: want6 }, { fetch: this.fetch })).answer;
      const changed = st.ip4 !== (want4 || st.ip4) || st.ip6 !== (want6 || st.ip6) || answer === 'updated';
      if (changed || st.error) this.addLog(h, { t, ip4: want4, ip6: want6, ok: true, text: reason === 'ip' ? (answer === 'updated' ? 'address changed' : 'confirmed') : reason });
      Object.assign(st, { ip4: want4 || st.ip4 || null, ip6: want6 || st.ip6 || null, t, ok: true, error: null, errorKind: null, fails: 0, nextTry: null, blocked: false, recheck: false });
      if (changed) st.check = null; // alte Prüfung passt nicht mehr – nach der Wartezeit neu prüfen
      return { action: answer === 'unchanged' ? 'unchanged' : 'updated' };
    } catch (e) {
      const kind = e instanceof DynError ? e.kind : e.status === 429 ? 'rate' : e.status === 401 ? 'auth' : e.status === 400 || e.status === 404 ? 'config' : 'down';
      st.fails = (st.fails || 0) + 1;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (st.fails - 1));
      Object.assign(st, { ok: false, error: e.message, errorKind: kind, blocked: kind === 'auth' || kind === 'config' });
      st.nextTry = st.blocked ? null : t + Math.max(backoff, (e.retryAfter || 0) * 1000);
      if (st.fails === 1 || st.blocked) this.addLog(h, { t, ip4: want4, ip6: want6, ok: false, text: e.message });
      return { action: 'error', error: e.message, errorKind: kind };
    }
  }

  /** Eigene Domain: A/AAAA über den Zugang setzen (ersetzt die Adresse, behält den Cloudflare-Proxy). */
  async pushZone(h, ip4, ip6) {
    const res = [];
    const ttl = h.ttl || ZONE_TTL;
    if (ip4) res.push(await this.dns.set({ name: h.name, type: 'A', content: ip4, ttl }, { replace: 'type' }));
    if (ip6) res.push(await this.dns.set({ name: h.name, type: 'AAAA', content: ip6, ttl }, { replace: 'type' }));
    return res.some((r) => r.action !== 'unchanged') ? 'updated' : 'unchanged';
  }

  addLog(h, e) { h.log = [...(h.log || []), e].slice(-LOG_MAX); }

  /** Zeigt der Name bei öffentlichen Resolvern auf diesen Anschluss? → { t, ok, v4, v6 } */
  async check(h, ip) {
    const out = { t: this.now(), ok: true };
    for (const [fam, type] of [['v4', 'A'], ['v6', 'AAAA']]) {
      const want = h[fam] !== false ? ip[fam] : null;
      if (!want) continue;
      try {
        const v = await V.verify({ name: h.name, type, content: want }, this.resolver);
        out[fam] = { ok: v.ok, some: v.some, values: [...new Set(v.results.flatMap((r) => r.values))] };
        if (!v.ok) out.ok = false;
      } catch (e) { out[fam] = { ok: false, error: e.message }; out.ok = false; }
    }
    return out;
  }
  async checkOne(id) {
    const h = this.host(id);
    const ip = await this.ips();
    const c = await this.check(h, ip);
    this.edit((d) => { const x = d.hosts.find((y) => y.id === id); if (x) { x.state = { ...(x.state || {}), check: c }; } });
    return c;
  }

  /** Sofort neu setzen (Knopf „Jetzt aktualisieren“, auch nach Token-Fehler). */
  async updateNow(id) {
    const d = this.load();
    const h = d.hosts.find((x) => x.id === id);
    if (!h) throw bad(404, 'Name not found');
    const ip = await this.ips(true);
    const r = await this.push(h, ip, { force: true, reason: 'by hand' });
    d.ip = ip;
    this.save(d);
    await this.report(d);
    return { ...r, host: this.pub(h) };
  }

  /** Ein Durchlauf: Adressen erkennen, geänderte Namen setzen, ab und zu prüfen, Probleme melden. */
  async tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      const d = this.load();
      if (!d.hosts.length) return { hosts: 0 };
      const ip = await this.ips();
      const t = this.now();
      const out = [];
      for (const h of d.hosts) {
        const st = h.state = h.state || {};
        // Regelmäßig prüfen, ob die Welt den Namen so sieht – sonst neu setzen
        // (frühestens 15 Minuten nach dem letzten Setzen – vorher können Resolver noch die alte Antwort kennen)
        if (!st.blocked && !st.error && (!st.check || t - st.check.t > CHECK_EVERY_MS) && (!st.t || t - st.t > SETTLE_MS) && (ip.v4 || ip.v6)) {
          try { st.check = await this.check(h, ip); if (!st.check.ok && !(st.check.v4 && st.check.v4.some) && !(st.check.v6 && st.check.v6.some)) st.recheck = true; } catch { /* nächstes Mal */ }
        }
        out.push(await this.push(h, ip, { reason: st.recheck ? 'did not point here' : 'ip' }));
      }
      d.ip = ip;
      this.save(d);
      await this.report(d);
      return { hosts: d.hosts.length, results: out };
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Probleme gebündelt melden – nur wenn sich die Menge der Probleme ändert (keine Dauer-Benachrichtigungen). */
  async report(d) {
    const now = d.hosts.filter((h) => h.state && h.state.error).map((h) => ({ id: h.id, name: h.name, kind: h.state.errorKind, error: h.state.error }));
    const key = (l) => l.map((x) => `${x.id}:${x.kind}`).sort().join('|');
    const before = d.problems || [];
    for (const h of d.hosts) {
      const st = h.state || {};
      if (typeof this.notifier.note === 'function') { try { this.notifier.note(`dns-name:${h.id}`, { ok: !st.error, label: `DNS: ${h.name}`, text: st.error ? st.error : [st.ip4, st.ip6].filter(Boolean).join(' · ') }); } catch { /* Selbstwartung fehlt */ } }
    }
    if (key(now) === key(before)) return;
    d.problems = now;
    this.save(d);
    if (typeof this.notifier.notify !== 'function') return;
    const fresh = now.filter((x) => !before.some((y) => y.id === x.id && y.kind === x.kind));
    try {
      if (fresh.length) {
        const needsYou = fresh.some((x) => x.kind === 'auth' || x.kind === 'config');
        await this.notifier.notify({
          kind: needsYou ? 'error' : 'warn',
          title: fresh.length === 1 ? `DNS name ${fresh[0].name} is not updated` : `${fresh.length} DNS names are not updated`,
          text: fresh.map((x) => `${x.name}: ${x.error}`).join('\n') + (needsYou ? '' : '\nHostwerk tries again by itself.'),
        });
      } else if (!now.length && before.length) {
        await this.notifier.notify({ kind: 'ok', title: 'DNS names are up to date again', text: before.map((x) => x.name).join(', ') });
      }
    } catch (e) { this.log('dns notify:', e.message); }
  }

  /* ---------------- Zeitgeber ---------------- */
  start() {
    this.timer = setTimeout(() => this.tick().catch((e) => this.log('dns tick:', e.message)), 30000);
    this.interval = setInterval(() => this.tick().catch((e) => this.log('dns tick:', e.message)), TICK_MS);
    for (const x of [this.timer, this.interval]) if (x && x.unref) x.unref();
  }
  stop() { clearTimeout(this.timer); clearInterval(this.interval); }
}

/** Prüft eine Adresse für die Oberfläche (nur Form). */
const isIp = (v) => net.isIP(String(v || '')) !== 0;

module.exports = { DynamicNames, TICK_MS, MIN_GAP_MS, CHECK_EVERY_MS, BACKOFF_START_MS, BACKOFF_MAX_MS, ZONE_TTL, isIp };
