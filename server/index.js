'use strict';
/*
 * DNS-Verwaltung – Server-Teil (SDK 2.7, native Erweiterung). Stellt "dns" für Hostwerk und andere Erweiterungen bereit
 * (Mailserver, Let’s Encrypt dns-01 …) – siehe service.js und README – und hält dynamische Namen aktuell (dynamic.js).
 *   GET    /api/dns                                    → { accounts, providers, dyn, mail, router, web }
 *   POST   /api/dns/accounts                           → { provider, name, creds } (wird vorher beim Anbieter geprüft)
 *   PUT    /api/dns/accounts/:id                       → { name, creds } (leere Geheimnisse bleiben)
 *   DELETE /api/dns/accounts/:id
 *   GET    /api/dns/zones[?force=1]                    → { zones, errors }
 *   GET    /api/dns/zones/:account/:zone/records
 *   POST   /api/dns/zones/:account/:zone/records       → Eintrag
 *   PUT    /api/dns/zones/:account/:zone/records/:id
 *   DELETE /api/dns/zones/:account/:zone/records/:id
 *   GET    /api/dns/zones/:account/:zone/export        → { name, text } (Zonendatei)
 *   POST   /api/dns/zones/:account/:zone/import        → { text, apply } → { add, same, errors, done? }
 *   GET    /api/dns/zones/:account/:zone/dnssec        → { status, ds, providerDs }
 *   POST   /api/dns/verify                             → { name, type, content, priority }
 *   GET    /api/dns/mail                               → Einträge der Mailserver-Erweiterung mit Stand
 *   POST   /api/dns/apply                              → { records: [...] }
 *   GET    /api/dns/public-address                     → öffentliche IPv4/IPv6
 *   GET    /api/dns/sites                              → echte Domains der Webserver (für Vorlagen)
 *   GET    /api/dns/names                              → { hosts, ip, router }
 *   POST   /api/dns/names                              → { kind, name, creds, v4, v6, ttl }
 *   PUT    /api/dns/names/:id · DELETE /api/dns/names/:id
 *   POST   /api/dns/names/:id/update · /api/dns/names/:id/check
 *   POST   /api/dns/names-router/take-over             → DynDNS aus „Router & Portfreigaben“ übernehmen
 */
const path = require('path');
const { DnsService } = require('./service');
const { DynamicNames } = require('./dynamic');
const { dynCatalog } = require('./dynproviders');
const IP = require('./ipdetect');

let svc = null;
let names = null;

/** Benachrichtigungen (SDK 2.10) und Selbstwartung – beides nur, wenn Hostwerk es kennt. */
function makeNotifier(host) {
  const { ctx } = host;
  const n = host.notifications;
  let canNotify = false;
  if (n && typeof n.register === 'function' && typeof n.notify === 'function') {
    try { n.register('dns-names', { de: 'DNS-Namen werden nicht aktualisiert', en: 'DNS names are not updated' }, { on: true }); canNotify = true; } catch { canNotify = false; }
  }
  const t = (s, v) => (typeof host.t === 'function' ? host.t(s, v) : s);
  // Texte in Hostwerks Sprache: Titel und Fehler sind Englisch und stehen in locales/de.json
  const text = ({ lines = [], tail = '' }) => [...lines.map((l) => `${l.name}: ${t(l.error)}`), tail ? t(tail) : ''].filter(Boolean).join('\n');
  return {
    notify: canNotify ? (m) => n.notify('dns-names', { title: t(m.title), text: text(m), kind: m.kind, url: '#/ext/dns' }) : null,
    note: ctx.keeper && typeof ctx.keeper.note === 'function' ? (key, x) => ctx.keeper.note(key, x) : null,
  };
}

function activate(host) {
  const { ctx } = host;
  const dir = path.join(ctx.paths.data, 'dns');
  svc = new DnsService({ dir, secrets: host.core('secrets'), ctx, log: host.log });
  names = new DynamicNames({
    dir, secrets: host.core('secrets'), dns: svc, settings: ctx.settings, notifier: makeNotifier(host), log: host.log,
    detectIp: () => IP.detect({ router: ctx.router }),
  });
  svc.names = names;
  host.provide('dns', svc);
  names.start();
  if (typeof host.on === 'function') host.on('shutdown', () => names && names.stop());
  const r = host.router;
  // Fehler der Anbieter und der Prüfung mit Status weiterreichen (Text wird über locales/de.json übersetzt)
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { throw host.error(e.status || 500, e.message); }
  };
  const id = (req) => String(req.params.id);
  const zp = '/dns/zones/:account/:zone';

  r.get('/dns', wrap(async (req, res) => res.json({
    accounts: svc.accounts(), providers: svc.providers(), dyn: dynCatalog(),
    mail: !!(ctx.mailserver && typeof ctx.mailserver.configured === 'function'), router: !!(ctx.router && typeof ctx.router.net === 'function'),
    web: !!(ctx.web && typeof ctx.web.list === 'function'),
  })));
  r.post('/dns/accounts', wrap(async (req, res) => res.json(await svc.saveAccount(req.body || {}))));
  r.put('/dns/accounts/:id', wrap(async (req, res) => res.json(await svc.saveAccount(req.body || {}, id(req)))));
  r.delete('/dns/accounts/:id', wrap(async (req, res) => { svc.removeAccount(id(req)); res.json({ ok: true }); }));
  r.get('/dns/zones', wrap(async (req, res) => res.json(await svc.zones(req.query.force === '1'))));
  r.get(`${zp}/records`, wrap(async (req, res) => res.json(await svc.list(req.params.account, req.params.zone))));
  r.post(`${zp}/records`, wrap(async (req, res) => res.json(await svc.create(req.params.account, req.params.zone, req.body || {}))));
  r.put(`${zp}/records/:id`, wrap(async (req, res) => res.json(await svc.update(req.params.account, req.params.zone, id(req), req.body || {}))));
  r.delete(`${zp}/records/:id`, wrap(async (req, res) => { await svc.removeRecord(req.params.account, req.params.zone, id(req)); res.json({ ok: true }); }));
  r.get(`${zp}/export`, wrap(async (req, res) => res.json(await svc.exportZone(req.params.account, req.params.zone))));
  r.post(`${zp}/import`, wrap(async (req, res) => { const b = req.body || {}; res.json(await svc.importZone(req.params.account, req.params.zone, b.text, { apply: !!b.apply })); }));
  r.get(`${zp}/dnssec`, wrap(async (req, res) => res.json(await svc.dnssec(req.params.account, req.params.zone))));
  r.post('/dns/verify', wrap(async (req, res) => res.json(await svc.verify(req.body || {}))));
  r.get('/dns/mail', wrap(async (req, res) => res.json(await svc.mailRecords())));
  r.post('/dns/apply', wrap(async (req, res) => res.json(await svc.apply((req.body || {}).records))));
  r.get('/dns/public-address', wrap(async (req, res) => res.json(await svc.publicAddress())));
  r.get('/dns/sites', wrap(async (req, res) => res.json(await svc.sites())));
  // Dynamische Namen
  r.get('/dns/names', wrap(async (req, res) => res.json(names.list())));
  r.post('/dns/names', wrap(async (req, res) => res.json(await names.add(req.body || {}))));
  r.put('/dns/names/:id', wrap(async (req, res) => res.json(await names.change(id(req), req.body || {}))));
  r.delete('/dns/names/:id', wrap(async (req, res) => { names.remove(id(req)); res.json({ ok: true }); }));
  r.post('/dns/names/:id/update', wrap(async (req, res) => res.json(await names.updateNow(id(req)))));
  r.post('/dns/names/:id/check', wrap(async (req, res) => res.json(await names.checkOne(id(req)))));
  r.post('/dns/names-router/take-over', wrap(async (req, res) => res.json(await names.takeOverRouter())));
}

function deactivate() { if (names) names.stop(); names = null; svc = null; }

module.exports = { activate, deactivate };
