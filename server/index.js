'use strict';
/*
 * DNS-Verwaltung – Server-Teil (SDK 2.7, native Erweiterung). Stellt "dns" für Hostwerk und andere Erweiterungen bereit
 * (Mailserver, Let’s Encrypt dns-01 …) – siehe service.js und README.
 *   GET    /api/dns                                    → { accounts, providers, mail, router }
 *   POST   /api/dns/accounts                           → { provider, name, creds } (wird vorher beim Anbieter geprüft)
 *   PUT    /api/dns/accounts/:id                       → { name, creds } (leere Geheimnisse bleiben)
 *   DELETE /api/dns/accounts/:id
 *   GET    /api/dns/zones[?force=1]                    → { zones, errors }
 *   GET    /api/dns/zones/:account/:zone/records
 *   POST   /api/dns/zones/:account/:zone/records       → Eintrag
 *   PUT    /api/dns/zones/:account/:zone/records/:id
 *   DELETE /api/dns/zones/:account/:zone/records/:id
 *   POST   /api/dns/verify                             → { name, type, content, priority }
 *   GET    /api/dns/mail                               → Einträge der Mailserver-Erweiterung mit Stand
 *   POST   /api/dns/apply                              → { records: [...] }
 *   GET    /api/dns/public-address                     → öffentliche IPv4/IPv6 (über „Router & Portfreigaben“)
 */
const path = require('path');
const { DnsService } = require('./service');

let svc = null;

function activate(host) {
  const { ctx } = host;
  svc = new DnsService({ dir: path.join(ctx.paths.data, 'dns'), secrets: host.core('secrets'), ctx, log: host.log });
  host.provide('dns', svc);
  const r = host.router;
  // Fehler der Anbieter und der Prüfung mit Status weiterreichen (Text wird über locales/de.json übersetzt)
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { throw host.error(e.status || 500, e.message); }
  };
  const id = (req) => String(req.params.id);

  r.get('/dns', wrap(async (req, res) => res.json({
    accounts: svc.accounts(), providers: svc.providers(),
    mail: !!(ctx.mailserver && typeof ctx.mailserver.configured === 'function'), router: !!(ctx.router && typeof ctx.router.net === 'function'),
  })));
  r.post('/dns/accounts', wrap(async (req, res) => res.json(await svc.saveAccount(req.body || {}))));
  r.put('/dns/accounts/:id', wrap(async (req, res) => res.json(await svc.saveAccount(req.body || {}, id(req)))));
  r.delete('/dns/accounts/:id', wrap(async (req, res) => { svc.removeAccount(id(req)); res.json({ ok: true }); }));
  r.get('/dns/zones', wrap(async (req, res) => res.json(await svc.zones(req.query.force === '1'))));
  r.get('/dns/zones/:account/:zone/records', wrap(async (req, res) => res.json(await svc.list(req.params.account, req.params.zone))));
  r.post('/dns/zones/:account/:zone/records', wrap(async (req, res) => res.json(await svc.create(req.params.account, req.params.zone, req.body || {}))));
  r.put('/dns/zones/:account/:zone/records/:id', wrap(async (req, res) => res.json(await svc.update(req.params.account, req.params.zone, id(req), req.body || {}))));
  r.delete('/dns/zones/:account/:zone/records/:id', wrap(async (req, res) => { await svc.removeRecord(req.params.account, req.params.zone, id(req)); res.json({ ok: true }); }));
  r.post('/dns/verify', wrap(async (req, res) => res.json(await svc.verify(req.body || {}))));
  r.get('/dns/mail', wrap(async (req, res) => res.json(await svc.mailRecords())));
  r.post('/dns/apply', wrap(async (req, res) => res.json(await svc.apply((req.body || {}).records))));
  r.get('/dns/public-address', wrap(async (req, res) => res.json(await svc.publicAddress())));
}

function deactivate() { svc = null; }

module.exports = { activate, deactivate };
