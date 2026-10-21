'use strict';
/*
 * Die vier Anbieter gegen nachgebildete APIs: Anmeldung, Zonen, Einträge lesen/anlegen/ändern/löschen, Fehlertexte.
 * Keine echte Anfrage – fakeFetch lässt jede unbekannte Adresse scheitern.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const F = require('./fakes');
const { Cloudflare } = require('../server/providers/cloudflare');
const { Hetzner } = require('../server/providers/hetzner');
const { Inwx, totp } = require('../server/providers/inwx');
const { Ionos } = require('../server/providers/ionos');
const R = require('../server/records');

test('Cloudflare: list (several pages), MX/SRV/CAA/TXT mapping, change, delete', async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ type: 'A', name: `h${i}.example.com`, content: `10.0.0.${i % 250}`, ttl: 1 }));
  const cf = F.cloudflare({ records: [
    { type: 'MX', name: 'example.com', content: 'mail.example.com', priority: 10, ttl: 3600 },
    { type: 'TXT', name: 'example.com', content: '"v=spf1 mx -all"', ttl: 3600 },
    { type: 'SRV', name: '_minecraft._tcp.example.com', data: { priority: 0, weight: 5, port: 25565, target: 'mc.example.com' }, ttl: 3600 },
    { type: 'CAA', name: 'example.com', data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, ttl: 3600 },
    { type: 'NS', name: 'example.com', content: 'ns.cloudflare.com', ttl: 3600 },
    ...many,
  ] });
  const fetch = F.fakeFetch({ 'api.cloudflare.com': cf.handler });
  const c = new Cloudflare({ token: 'cf-token' }, { fetch });
  assert.deepStrictEqual(await c.test(), { zones: 1 });
  const zone = (await c.zones())[0];
  const list = await c.list(zone);
  assert.strictEqual(list.length, 134, 'all pages, NS left out');
  assert.deepStrictEqual(list.find((r) => r.type === 'SRV'), { id: 'r3', name: '_minecraft._tcp.example.com', type: 'SRV', ttl: 3600, content: '5 25565 mc.example.com', priority: 0 });
  assert.strictEqual(list.find((r) => r.type === 'CAA').content, '0 issue "letsencrypt.org"');
  assert.strictEqual(list.find((r) => r.type === 'TXT').content, 'v=spf1 mx -all');

  const srv = await c.create(zone, R.validate({ name: '_sip._udp', type: 'SRV', content: '1 5060 sip.example.com', priority: 2 }, 'example.com'));
  const sent = fetch.calls.at(-1).body;
  assert.deepStrictEqual(sent.data, { priority: 2, weight: 1, port: 5060, target: 'sip.example.com' });
  assert.strictEqual(srv.content, '1 5060 sip.example.com');
  const txt = await c.create(zone, R.validate({ name: '@', type: 'TXT', content: 'hello world' }, 'example.com'));
  assert.strictEqual(fetch.calls.at(-1).body.content, '"hello world"', 'TXT goes out quoted');
  const up = await c.update(zone, txt.id, R.validate({ name: '@', type: 'TXT', content: 'changed', ttl: 600 }, 'example.com'));
  assert.strictEqual(up.content, 'changed');
  await c.remove(zone, txt.id);
  assert.ok(!cf.st.records.some((r) => r.id === txt.id));
});

test('Cloudflare: a wrong token gives Cloudflare’s own message', async () => {
  const fetch = F.fakeFetch({ 'api.cloudflare.com': F.cloudflare().handler });
  await assert.rejects(new Cloudflare({ token: 'nope' }, { fetch }).test(), (e) => /Cloudflare: Invalid access token/.test(e.message) && e.status === 401);
});

test('Hetzner Cloud: RRSets become single records; add, change and remove values', async () => {
  const hz = F.hetznerCloud({ rrsets: [
    { name: '@', type: 'MX', ttl: 3600, records: [{ value: '10 mail.example.org.' }] },
    { name: '_acme-challenge', type: 'TXT', ttl: 60, records: [{ value: '"one"' }, { value: '"two"' }] },
  ] });
  const fetch = F.fakeFetch({ 'api.hetzner.cloud': hz.handler });
  const h = new Hetzner({ token: 'hz-token' }, { fetch });
  const zone = (await h.zones())[0];
  assert.deepStrictEqual(zone, { id: '11', name: 'example.org' });
  const list = await h.list(zone);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list[0], { id: '@/MX/10 mail.example.org.', name: 'example.org', type: 'MX', ttl: 3600, content: 'mail.example.org', priority: 10 });

  // neuer Wert in vorhandenem RRSet, neues RRSet
  await h.create(zone, R.validate({ name: '_acme-challenge', type: 'TXT', content: 'three', ttl: 60 }, zone.name));
  assert.deepStrictEqual(hz.st.rrsets.find((r) => r.type === 'TXT').records.map((x) => x.value), ['"one"', '"two"', '"three"']);
  const a = await h.create(zone, R.validate({ name: 'www', type: 'A', content: '203.0.113.9' }, zone.name));
  assert.strictEqual(a.id, 'www/A/203.0.113.9');
  // ändern: Wert und TTL
  await h.update(zone, a.id, R.validate({ name: 'www', type: 'A', content: '203.0.113.10', ttl: 300 }, zone.name));
  const www = hz.st.rrsets.find((r) => r.name === 'www');
  assert.deepStrictEqual(www.records, [{ value: '203.0.113.10' }]);
  assert.strictEqual(www.ttl, 300);
  // löschen: einzelner Wert, dann leeres RRSet ganz weg
  await h.remove(zone, '_acme-challenge/TXT/"one"');
  assert.deepStrictEqual(hz.st.rrsets.find((r) => r.type === 'TXT').records.map((x) => x.value), ['"two"', '"three"']);
  await h.remove(zone, 'www/A/203.0.113.10');
  assert.ok(!hz.st.rrsets.some((r) => r.name === 'www'));
});

test('Hetzner older DNS console: own header, records with ids', async () => {
  const hl = F.hetznerLegacy({ records: [{ type: 'TXT', name: '@', value: '"v=spf1 -all"', ttl: 3600 }] });
  const fetch = F.fakeFetch({ 'dns.hetzner.com': hl.handler });
  const h = new Hetzner({ token: 'old-token', api: 'legacy' }, { fetch });
  const zone = (await h.zones())[0];
  assert.strictEqual(zone.name, 'example.net');
  assert.deepStrictEqual((await h.list(zone))[0], { id: 'h1', name: 'example.net', type: 'TXT', ttl: 3600, content: 'v=spf1 -all' });
  const mx = await h.create(zone, R.validate({ name: '@', type: 'MX', content: 'mx.example.net', priority: 5 }, zone.name));
  assert.strictEqual(hl.st.records.find((r) => r.id === mx.id).value, '5 mx.example.net.');
  await h.update(zone, mx.id, R.validate({ name: '@', type: 'MX', content: 'mx2.example.net', priority: 5 }, zone.name));
  assert.strictEqual(hl.st.records.find((r) => r.id === mx.id).value, '5 mx2.example.net.');
  await h.remove(zone, mx.id);
  assert.strictEqual(hl.st.records.length, 1);
  await assert.rejects(new Hetzner({ token: 'x', api: 'legacy' }, { fetch }).zones(), /Hetzner: Invalid authentication credentials/);
});

test('INWX: TOTP code like an authenticator app (RFC 6238 test value)', () => {
  // Geheimnis "12345678901234567890" in Base32, Zeitpunkt 59 s → 94287082 (8 Stellen) → 287082
  assert.strictEqual(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
  assert.strictEqual(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 1111111109000), '081804');
});

test('INWX: sign-in with cookie and two-factor, records, sign-out after every job', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const now = 1111111109000;
  const iw = F.inwx({ tfa: true, expectTan: totp(secret, now), records: [{ name: 'example.de', type: 'MX', content: 'mail.example.de', ttl: 3600, prio: 10 }, { name: 'example.de', type: 'SOA', content: 'x', ttl: 86400 }] });
  const fetch = F.fakeFetch({ 'api.domrobot.com': iw.handler });
  const c = new Inwx({ user: 'dnsbot', pass: 'pw', totp: secret }, { fetch, now: () => now });
  assert.deepStrictEqual(await c.test(), { zones: 1 });
  assert.deepStrictEqual(iw.st.methods.slice(0, 4), ['account.login', 'account.unlock', 'nameserver.list', 'account.logout']);
  const zone = (await c.zones())[0];
  const list = await c.list(zone);
  assert.deepStrictEqual(list, [{ id: '100', name: 'example.de', type: 'MX', ttl: 3600, content: 'mail.example.de', priority: 10 }]);
  const txt = await c.create(zone, R.validate({ name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=none', ttl: 60 }, zone.name));
  const made = iw.st.records.find((r) => String(r.id) === txt.id);
  assert.strictEqual(made.name, '_dmarc.example.de');
  assert.strictEqual(made.ttl, 300, 'INWX needs at least 300 s');
  await c.update(zone, txt.id, R.validate({ name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=quarantine' }, zone.name));
  assert.strictEqual(made.content, 'v=DMARC1; p=quarantine');
  await c.remove(zone, txt.id);
  assert.ok(!iw.st.records.some((r) => String(r.id) === txt.id));
  assert.strictEqual(iw.st.logouts, 6, 'signed out after each of the six jobs');
});

test('INWX: wrong password and missing two-factor secret', async () => {
  const fetch = F.fakeFetch({ 'api.domrobot.com': F.inwx({ tfa: true }).handler });
  await assert.rejects(new Inwx({ user: 'dnsbot', pass: 'bad' }, { fetch }).test(), (e) => /INWX: Authentication error/.test(e.message) && e.status === 401);
  await assert.rejects(new Inwx({ user: 'dnsbot', pass: 'pw' }, { fetch }).test(), /two-factor/);
});

test('IONOS: API key header, create as list, name change = delete + create', async () => {
  const io = F.ionos({ records: [{ name: 'example.eu', type: 'TXT', content: '"v=spf1 include:_spf-eu.ionos.com ~all"', ttl: 3600, prio: 0, disabled: false }] });
  const fetch = F.fakeFetch({ 'api.hosting.ionos.com': io.handler });
  const c = new Ionos({ key: 'pre.secret' }, { fetch });
  const zone = (await c.zones())[0];
  assert.strictEqual((await c.list(zone))[0].content, 'v=spf1 include:_spf-eu.ionos.com ~all');
  const mx = await c.create(zone, R.validate({ name: '@', type: 'MX', content: 'mx.example.eu', priority: 20 }, zone.name));
  assert.ok(Array.isArray(fetch.calls.at(-1).body), 'IONOS takes a list');
  assert.strictEqual(mx.priority, 20);
  const old = (await c.list(zone)).find((r) => r.id === mx.id);
  await c.update(zone, mx.id, R.validate({ name: '@', type: 'MX', content: 'mx.example.eu', priority: 30 }, zone.name), old);
  assert.strictEqual(io.st.records.find((r) => r.id === mx.id).prio, 30);
  const moved = await c.update(zone, mx.id, R.validate({ name: 'sub', type: 'MX', content: 'mx.example.eu', priority: 30 }, zone.name), { ...old, priority: 30 });
  assert.notStrictEqual(moved.id, mx.id);
  assert.ok(!io.st.records.some((r) => r.id === mx.id));
  await assert.rejects(new Ionos({ key: 'x' }, { fetch }).zones(), (e) => /IONOS: The customer is not authorized/.test(e.message) && e.status === 401);
});
