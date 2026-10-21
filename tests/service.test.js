'use strict';
/*
 * Der Dienst "dns": Zugänge (Geheimnisse nur versiegelt), Zonen über mehrere Anbieter, set/apply ohne Doppelte,
 * Prüfen über Resolver, dns-01 für Let’s Encrypt, Mail-Einträge des Mailservers und die Routen in activate().
 * Alles gegen Nachbildungen (tests/fakes.js), Daten in einem Temp-Ordner.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./fakes');
const { DnsService } = require('../server/service');
const V = require('../server/verify');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dns-'));

function setup({ answers = {}, byServer, ctx = {} } = {}) {
  const cf = F.cloudflare({ zones: [{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'shop.example.com' }], records: [
    { type: 'TXT', name: 'example.com', content: '"v=spf1 a -all"', ttl: 3600 },
    { type: 'MX', name: 'example.com', content: 'old-mail.example.com', priority: 10, ttl: 3600 },
  ] });
  const io = F.ionos();
  const fetch = F.fakeFetch({ 'api.cloudflare.com': cf.handler, 'api.hosting.ionos.com': io.handler });
  const dir = tmp();
  const svc = new DnsService({ dir, secrets: F.secrets, fetch, resolver: { makeResolver: F.fakeResolver(answers, byServer) }, ctx });
  svc.acmeWait = { every: 1, sleep: async () => {}, timeout: 50 };
  return { svc, cf, io, fetch, dir };
}

test('accounts: checked at the provider, secrets only sealed on disk and never handed out', async () => {
  const { svc, dir } = setup();
  await assert.rejects(svc.saveAccount({ provider: 'cloudflare', creds: { token: 'wrong' } }), /Invalid access token/);
  await assert.rejects(svc.saveAccount({ provider: 'cloudflare', creds: {} }), /Please fill in “API token”/);
  await assert.rejects(svc.saveAccount({ provider: 'nope' }), /Unknown DNS provider/);
  const a = await svc.saveAccount({ provider: 'cloudflare', name: 'My Cloudflare', creds: { token: 'cf-token' } });
  assert.deepStrictEqual(a.fields, { token: true });
  assert.strictEqual(a.zones, 2);
  const disk = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.ok(!disk.includes('cf-token'), 'token is not on disk in plain text');
  assert.ok(disk.includes('enc:'));
  assert.ok(!JSON.stringify(svc.accounts()).includes('cf-token'));
  // umbenennen ohne neues Token: das alte bleibt
  const b = await svc.saveAccount({ name: 'Renamed', creds: { token: '' } }, a.id);
  assert.strictEqual(b.name, 'Renamed');
  assert.strictEqual(F.secrets.open(JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'))[0].creds.token), 'cf-token');
  await svc.saveAccount({ provider: 'ionos', creds: { key: 'pre.secret' } });
  const { zones, errors } = await svc.zones();
  assert.deepStrictEqual(zones.map((z) => z.name), ['example.com', 'example.eu', 'shop.example.com']);
  assert.deepStrictEqual(errors, []);
  svc.removeAccount(a.id);
  assert.strictEqual(svc.accounts().length, 1);
  assert.throws(() => svc.removeAccount('gone'), /DNS account not found/);
});

test('set: no duplicates – SPF/DMARC replaced by tag, MX by target, CNAME by name, others added', async () => {
  const { svc, cf } = setup();
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  const spf = await svc.set({ name: 'example.com', type: 'TXT', content: 'v=spf1 mx -all' });
  assert.strictEqual(spf.action, 'updated');
  assert.strictEqual(cf.st.records.filter((r) => r.type === 'TXT').length, 1);
  assert.strictEqual((await svc.set({ name: 'example.com', type: 'TXT', content: 'v=spf1 mx -all' })).action, 'unchanged');
  assert.strictEqual((await svc.set({ name: 'example.com', type: 'TXT', content: 'google-site-verification=x' })).action, 'created');
  assert.strictEqual((await svc.set({ name: 'example.com', type: 'MX', content: 'old-mail.example.com', priority: 20 })).action, 'updated');
  assert.strictEqual((await svc.set({ name: 'example.com', type: 'MX', content: 'mail2.example.com', priority: 30 })).action, 'created');
  await svc.set({ name: 'www.example.com', type: 'CNAME', content: 'example.com' });
  assert.strictEqual((await svc.set({ name: 'www.example.com', type: 'CNAME', content: 'other.example.com' })).action, 'updated');
  assert.strictEqual(cf.st.records.filter((r) => r.type === 'CNAME').length, 1);
  // längster Zonentreffer: shop.example.com liegt in z2
  await svc.set({ name: 'a.shop.example.com', type: 'A', content: '203.0.113.7' });
  assert.strictEqual(cf.st.records.find((r) => r.name === 'a.shop.example.com').zone, 'z2');
  await assert.rejects(svc.set({ name: 'x.unknown.org', type: 'A', content: '1.2.3.4' }), /No DNS account manages x\.unknown\.org/);
  // entfernen: genau dieser Eintrag
  assert.strictEqual((await svc.remove({ name: 'example.com', type: 'MX', content: 'mail2.example.com' })).action, 'removed');
  assert.strictEqual((await svc.remove({ name: 'example.com', type: 'MX', content: 'mail2.example.com' })).action, 'missing');
  // viele auf einmal: einer mit Fehler hält die anderen nicht auf
  const res = await svc.apply([{ name: '_dmarc.example.com', type: 'TXT', content: 'v=DMARC1; p=none' }, { name: 'example.com', type: 'A', content: 'no-ip' }, { name: 'example.com', type: 'CAA', content: '0 issue "letsencrypt.org"' }]);
  assert.deepStrictEqual(res.map((r) => r.action), ['created', 'error', 'created']);
  assert.match(res[1].error, /IPv4/);
});

test('verify: every public resolver is asked; partly there = not ok yet', async () => {
  const want = { name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 };
  const full = { 'example.com|MX': [{ exchange: 'mail.example.com', priority: 10 }] };
  let { svc } = setup({ answers: full });
  const v = await svc.verify(want);
  assert.ok(v.ok);
  assert.deepStrictEqual(v.results.map((r) => r.resolver), V.RESOLVERS.map((r) => r.id));
  assert.deepStrictEqual(v.results[0].values, ['10 mail.example.com']);
  ({ svc } = setup({ answers: full, byServer: { '9.9.9.9': {} } }));
  const half = await svc.verify(want);
  assert.ok(!half.ok); assert.ok(half.some);
  assert.deepStrictEqual(half.results.find((r) => r.resolver === 'quad9'), { resolver: 'quad9', label: 'Quad9 9.9.9.9', ok: false, values: [] });
  ({ svc } = setup({ answers: { 'example.com|TXT': [['v=spf1 ', 'mx -all']], 'example.com|CAA': [{ critical: 0, issue: 'letsencrypt.org' }], '_x._tcp.example.com|SRV': [{ name: 't.example.com', port: 1, priority: 2, weight: 3 }] } }));
  assert.ok((await svc.verify({ name: 'example.com', type: 'TXT', content: 'v=spf1 mx -all' })).ok, 'TXT pieces are joined');
  assert.ok((await svc.verify({ name: 'example.com', type: 'CAA', content: '0 issue "letsencrypt.org"' })).ok);
  assert.ok((await svc.verify({ name: '_x._tcp.example.com', type: 'SRV', content: '3 1 t.example.com', priority: 2 })).ok);
  ({ svc } = setup({ answers: { 'example.com|A': Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }) } }));
  assert.strictEqual((await svc.verify({ name: 'example.com', type: 'A', content: '1.2.3.4' })).results[0].error, 'ETIMEOUT');
});

test('acme dns-01: two values under one name (domain + wildcard), waits for resolvers, removes only its own', async () => {
  const seen = new Set();
  const answers = { '_acme-challenge.example.com|TXT': () => [...seen].map((v) => [v]) };
  const { svc, cf } = setup({ answers });
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  const base = { type: 'dns-01', token: 't' };
  // Attrappe: der Wert wird "sichtbar", sobald er beim Anbieter liegt
  const orig = svc.set.bind(svc);
  svc.set = async (r) => { const out = await orig(r); seen.add(r.content); return out; };
  await svc.acme.challengeCreateFn({ identifier: { value: 'example.com' } }, base, 'value-apex');
  await svc.acme.challengeCreateFn({ identifier: { value: 'example.com' }, wildcard: true }, base, 'value-wild');
  const txt = cf.st.records.filter((r) => r.name === '_acme-challenge.example.com');
  assert.deepStrictEqual(txt.map((r) => r.content).sort(), ['"value-apex"', '"value-wild"']);
  assert.ok(txt.every((r) => r.ttl === 60));
  await svc.acme.challengeRemoveFn({ identifier: { value: 'example.com' } }, base, 'value-apex');
  assert.deepStrictEqual(cf.st.records.filter((r) => r.name === '_acme-challenge.example.com').map((r) => r.content), ['"value-wild"']);
  await svc.acme.challengeCreateFn({ identifier: { value: 'example.com' } }, { type: 'http-01' }, 'x');
  assert.strictEqual(cf.st.records.filter((r) => r.name === '_acme-challenge.example.com').length, 1, 'http-01 is not ours');
  assert.strictEqual(svc.acme.txtValue('token.thumbprint'), require('crypto').createHash('sha256').update('token.thumbprint').digest('base64url'));
});

test('mail records: takes the mail server’s list, shows what is already there, applies the rest', async () => {
  const mailserver = {
    configured: () => [{ id: 'mailserver', cfg: { name: 'Mail' } }],
    domains: async () => [{ name: 'example.com', records: [
      { name: 'example.com', type: 'MX', value: '10 mail.example.com.', purpose: 'Receiving (MX)' },
      { name: 'example.com', type: 'TXT', value: 'v=spf1 a -all', purpose: 'Sender (SPF)' },
      { name: 'hostwerk._domainkey.example.com', type: 'TXT', value: 'v=DKIM1; k=rsa; p=ABC', purpose: 'Signature (DKIM)' },
    ] }, { name: 'nozone.org', records: [] }],
  };
  const { svc, cf } = setup({ ctx: { mailserver } });
  assert.deepStrictEqual(await new DnsService({ dir: tmp(), secrets: F.secrets, fetch: () => {} }).mailRecords(), { available: false, servers: [] });
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  const m = await svc.mailRecords();
  const d = m.servers[0].domains[0];
  assert.strictEqual(d.zone.name, 'example.com');
  assert.deepStrictEqual(d.records.map((r) => r.present), [false, true, false]);
  assert.deepStrictEqual(d.records[0], { name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10, ttl: 3600, purpose: 'Receiving (MX)', present: false });
  assert.strictEqual(m.servers[0].domains[1].zone, null);
  const res = await svc.apply(d.records.filter((r) => !r.present));
  assert.deepStrictEqual(res.map((r) => r.action), ['created', 'created']);
  assert.ok(cf.st.records.some((r) => r.name === 'hostwerk._domainkey.example.com'));
});

test('activate: provides "dns", registers the routes, errors keep their status', async () => {
  const dir = tmp();
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  const provided = {};
  const host = {
    ctx: { paths: { data: dir } },
    router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') },
    core: (n) => { assert.strictEqual(n, 'secrets'); return F.secrets; },
    provide: (n, o) => { provided[n] = o; },
    error: (status, text) => Object.assign(new Error(text), { status }),
    log: () => {},
  };
  const mod = require('../server/index');
  mod.activate(host);
  assert.ok(provided.dns instanceof DnsService);
  assert.ok(fs.existsSync(path.join(dir, 'dns')));
  for (const k of ['GET /dns', 'POST /dns/accounts', 'PUT /dns/accounts/:id', 'DELETE /dns/accounts/:id', 'GET /dns/zones', 'GET /dns/zones/:account/:zone/records', 'POST /dns/zones/:account/:zone/records', 'PUT /dns/zones/:account/:zone/records/:id', 'DELETE /dns/zones/:account/:zone/records/:id', 'POST /dns/verify', 'GET /dns/mail', 'POST /dns/apply', 'GET /dns/public-address',
    'GET /dns/zones/:account/:zone/export', 'POST /dns/zones/:account/:zone/import', 'GET /dns/zones/:account/:zone/dnssec', 'GET /dns/sites',
    'GET /dns/names', 'POST /dns/names', 'PUT /dns/names/:id', 'DELETE /dns/names/:id', 'POST /dns/names/:id/update', 'POST /dns/names/:id/check', 'POST /dns/names-router/take-over']) assert.ok(routes[k], k);
  let out = null;
  await routes['GET /dns']({}, { json: (x) => { out = x; } });
  assert.deepStrictEqual(out.providers.map((p) => p.id), ['cloudflare', 'desec', 'hetzner', 'inwx', 'ionos']);
  assert.deepStrictEqual(out.dyn.map((p) => p.id), ['duckdns', 'desec', 'dynv6', 'freedns', 'noip']);
  assert.ok(provided.dns.names, 'dynamic names are attached to the service');
  assert.strictEqual(out.mail, false);
  await assert.rejects(routes['DELETE /dns/accounts/:id']({ params: { id: 'x' } }, {}), (e) => e.status === 404);
  mod.deactivate();
});
