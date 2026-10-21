'use strict';
/*
 * Kostenlose DynDNS-Anbieter (Erfolg, falscher Token, 429, Netzfehler), deSEC als Zonen-Anbieter, IP-Erkennung und
 * die wartungsfreien dynamischen Namen (nur bei Änderung, Pausen, gebündelte Meldungen, Router-Übernahme).
 * Nur Attrappen – keine echte Anfrage geht hinaus.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./fakes');
const { DYN, DynError, fullName, dynCatalog } = require('../server/dynproviders');
const { Desec } = require('../server/providers/desec');
const IP = require('../server/ipdetect');
const { DynamicNames, MIN_GAP_MS, BACKOFF_START_MS } = require('../server/dynamic');
const { DnsService } = require('../server/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dyn-'));
const netDown = () => { throw new TypeError('fetch failed'); };

/* ---------------- Attrappen der Update-Schnittstellen ---------------- */
function dynFakes({ token = 'good-token', status = null } = {}) {
  const seen = [];
  const auth = (c) => (c.headers.Authorization || '').replace(/^Basic /, '');
  const dec = (b) => Buffer.from(b, 'base64').toString();
  const h = (fn) => (c) => { seen.push(c); if (status === 429) return F.reply(429, 'slow down', { 'Retry-After': '120' }); if (status === 'down') return netDown(); return fn(c); };
  return {
    seen,
    handlers: {
      'www.duckdns.org': h((c) => F.reply(200, c.url.searchParams.get('token') === token ? 'OK\n203.0.113.7\n\nUPDATED' : 'KO')),
      'update.dedyn.io': h((c) => (dec(auth(c)).split(':')[1] === token ? F.reply(200, 'good') : F.reply(401, 'badauth'))),
      'dynv6.com': h((c) => (c.url.searchParams.get('token') === token ? F.reply(200, 'addresses updated') : F.reply(401, 'invalid authentication token'))),
      'sync.afraid.org': h((c) => F.reply(200, c.path === `/u/${token}/` ? `Updated 1 host(s) to ${c.url.searchParams.get('ip')}` : 'ERROR: Unable to locate this record')),
      'v6.sync.afraid.org': h((c) => F.reply(200, c.path === '/u/six/' ? 'No IP change detected' : 'ERROR')),
      'dynupdate.no-ip.com': h((c) => F.reply(200, dec(auth(c)) === `me@example.com:${token}` ? `good ${c.url.searchParams.get('myip')}` : 'badauth')),
    },
  };
}

const CASES = [
  ['duckdns', 'srv.duckdns.org', { token: 'good-token' }, { token: 'nope' }],
  ['desec', 'srv.dedyn.io', { token: 'good-token' }, { token: 'nope' }],
  ['dynv6', 'srv.dynv6.net', { token: 'good-token' }, { token: 'nope' }],
  ['freedns', 'srv.mooo.com', { token: 'good-token', token6: 'six' }, { token: 'nope' }],
  ['noip', 'srv.ddns.net', { user: 'me@example.com', pass: 'good-token' }, { user: 'me@example.com', pass: 'nope' }],
];

for (const [kind, name, good, wrong] of CASES) {
  test(`dyn ${kind}: success, wrong token, 429 and network error`, async () => {
    const ok = dynFakes();
    const r = await DYN[kind].update({ name, creds: good, ip4: '203.0.113.7', ip6: '2001:db8::7' }, { fetch: F.fakeFetch(ok.handlers) });
    assert.ok(['updated', 'unchanged'].includes(r.answer));
    // Token nie im Fehlertext
    const e1 = await DYN[kind].update({ name, creds: wrong, ip4: '203.0.113.7' }, { fetch: F.fakeFetch(ok.handlers) }).catch((e) => e);
    assert.ok(e1 instanceof DynError);
    assert.ok(['auth', 'config'].includes(e1.kind), `${kind}: ${e1.kind}`);
    assert.ok(!/nope|good-token/.test(e1.message));
    const lim = dynFakes({ status: 429 });
    const e2 = await DYN[kind].update({ name, creds: good, ip4: '203.0.113.7' }, { fetch: F.fakeFetch(lim.handlers) }).catch((e) => e);
    assert.strictEqual(e2.kind, 'rate');
    assert.strictEqual(e2.retryAfter, 120);
    const down = dynFakes({ status: 'down' });
    const e3 = await DYN[kind].update({ name, creds: good, ip4: '203.0.113.7' }, { fetch: F.fakeFetch(down.handlers) }).catch((e) => e);
    assert.strictEqual(e3.kind, 'down');
  });
}

test('dyn: addresses are sent as the provider expects', async () => {
  const f = dynFakes();
  const fetch = F.fakeFetch(f.handlers);
  await DYN.duckdns.update({ name: 'srv.duckdns.org', creds: { token: 'good-token' }, ip4: '203.0.113.7', ip6: '2001:db8::7' }, { fetch });
  const d = f.seen.at(-1).url.searchParams;
  assert.deepStrictEqual([d.get('domains'), d.get('ip'), d.get('ipv6')], ['srv', '203.0.113.7', '2001:db8::7']);
  await DYN.desec.update({ name: 'srv.dedyn.io', creds: { token: 'good-token' }, ip4: '203.0.113.7', ip6: null }, { fetch });
  assert.strictEqual(f.seen.at(-1).url.searchParams.get('myipv6'), 'preserve', 'no IPv6 → keep the old AAAA');
  await DYN.noip.update({ name: 'srv.ddns.net', creds: { user: 'me@example.com', pass: 'good-token' }, ip4: '203.0.113.7', ip6: '2001:db8::7' }, { fetch });
  assert.strictEqual(f.seen.at(-1).url.searchParams.get('myip'), '203.0.113.7,2001:db8::7');
  assert.match(f.seen.at(-1).headers['User-Agent'], /^Hostwerk-DNS\//);
  await DYN.freedns.update({ name: 'srv.mooo.com', creds: { token: 'good-token', token6: 'six' }, ip4: '203.0.113.7', ip6: '2001:db8::7' }, { fetch });
  assert.deepStrictEqual(f.seen.slice(-2).map((c) => c.url.host), ['sync.afraid.org', 'v6.sync.afraid.org']);
  // No-IP: 911 → später wieder, frühestens nach 30 Minuten
  const e = await DYN.noip.update({ name: 'srv.ddns.net', creds: { user: 'u', pass: 'p' }, ip4: '1.2.3.4' }, { fetch: F.fakeFetch({ 'dynupdate.no-ip.com': () => F.reply(200, '911') }) }).catch((x) => x);
  assert.strictEqual(e.kind, 'down');
  assert.strictEqual(e.retryAfter, 1800);
});

test('dyn catalog: honest labels – No-IP is the only one that needs regular confirmation', () => {
  const c = dynCatalog();
  assert.deepStrictEqual(c.map((x) => x.id), ['duckdns', 'desec', 'dynv6', 'freedns', 'noip']);
  assert.ok(c.every((x) => x.free));
  assert.deepStrictEqual(c.filter((x) => x.maintenance !== 'none').map((x) => x.id), ['noip']);
  assert.strictEqual(fullName('duckdns', 'MyServer'), 'myserver.duckdns.org');
  assert.strictEqual(fullName('desec', 'a.dedyn.io.'), 'a.dedyn.io');
  assert.strictEqual(fullName('freedns', 'x.mooo.com'), 'x.mooo.com');
});

/* ---------------- deSEC als Zonen-Anbieter ---------------- */
function desecFake({ token = 'ds-token', minTtl = 3600 } = {}) {
  const st = { rrsets: [{ subname: '', type: 'A', ttl: 3600, records: ['203.0.113.1'] }, { subname: 'www', type: 'CNAME', ttl: 3600, records: ['srv.dedyn.io.'] }], calls: [] };
  const handler = (c) => {
    st.calls.push(`${c.method} ${c.path}`);
    if (c.headers.Authorization !== `Token ${token}`) return F.reply(401, { detail: 'Invalid token.' });
    let m;
    if (c.path === '/api/v1/domains/') return F.reply(200, [{ name: 'srv.dedyn.io', minimum_ttl: minTtl, keys: [{ ds: ['12345 13 2 abcdef'], managed: true }] }]);
    if (c.path === '/api/v1/domains/srv.dedyn.io/rrsets/' && c.method === 'GET') return F.reply(200, st.rrsets);
    if (c.path === '/api/v1/domains/srv.dedyn.io/rrsets/' && c.method === 'POST') { if (c.body.ttl < minTtl) return F.reply(400, { ttl: ['too low'] }); st.rrsets.push(c.body); return F.reply(201, c.body); }
    if ((m = /^\/api\/v1\/domains\/srv\.dedyn\.io\/rrsets\/([^/]+)\/([A-Z]+)\/$/.exec(c.path))) {
      const sub = m[1] === '@' ? '' : decodeURIComponent(m[1]);
      const rr = st.rrsets.find((r) => r.subname === sub && r.type === m[2]);
      if (!rr) return F.reply(404, { detail: 'Not found.' });
      if (c.method === 'GET') return F.reply(200, rr);
      if (c.method === 'PATCH') { Object.assign(rr, c.body); return F.reply(200, rr); }
      if (c.method === 'DELETE') { st.rrsets.splice(st.rrsets.indexOf(rr), 1); return F.reply(204); }
    }
    return F.reply(404, { detail: 'no route' });
  };
  return { st, handler };
}

test('deSEC zones: list, create (TTL raised to the minimum), update and delete at the apex (@)', async () => {
  const fk = desecFake();
  const d = new Desec({ token: 'ds-token' }, { fetch: F.fakeFetch({ 'desec.io': fk.handler }) });
  const [zone] = await d.zones();
  assert.deepStrictEqual(zone, { id: 'srv.dedyn.io', name: 'srv.dedyn.io', minTtl: 3600, dnssec: { ds: ['12345 13 2 abcdef'] } });
  const list = await d.list(zone);
  assert.deepStrictEqual(list.map((r) => `${r.name} ${r.type} ${r.content}`), ['srv.dedyn.io A 203.0.113.1', 'www.srv.dedyn.io CNAME srv.dedyn.io']);
  const txt = await d.create(zone, { name: '_acme-challenge.srv.dedyn.io', type: 'TXT', content: 'abc', ttl: 60 });
  assert.strictEqual(txt.ttl, 3600);
  assert.deepStrictEqual(fk.st.rrsets.at(-1), { subname: '_acme-challenge', type: 'TXT', ttl: 3600, records: ['"abc"'] });
  await d.update(zone, list[0].id, { name: 'srv.dedyn.io', type: 'A', content: '203.0.113.9', ttl: 3600 });
  assert.deepStrictEqual(fk.st.rrsets[0].records, ['203.0.113.9']);
  assert.ok(fk.st.calls.includes('PATCH /api/v1/domains/srv.dedyn.io/rrsets/@/A/'));
  await d.remove(zone, 'srv.dedyn.io/A/203.0.113.9'.replace('srv.dedyn.io', '@'));
  assert.ok(!fk.st.rrsets.some((r) => r.type === 'A'));
  await assert.rejects(new Desec({ token: 'bad' }, { fetch: F.fakeFetch({ 'desec.io': fk.handler }) }).zones(), (e) => e.status === 401 && /Invalid token/.test(e.message));
  await assert.rejects(new Desec({ token: 'ds-token' }, { fetch: F.fakeFetch({ 'desec.io': () => F.reply(429, { detail: 'Request was throttled.' }, { 'Retry-After': '30' }) }) }).zones(), (e) => e.status === 429 && e.retryAfter === 30);
  await assert.rejects(new Desec({ token: 'ds-token' }, { fetch: F.fakeFetch({ 'desec.io': netDown }) }).zones(), (e) => e.status === 502 && /cannot be reached/.test(e.message));
});

/* ---------------- IP-Erkennung ---------------- */
test('ip detection: two sources must agree, Cloudflare trace is understood, IPv6 = fixed address in the same /64', async () => {
  assert.strictEqual(IP.parseIp('fl=1\nh=one.one.one.one\nip=198.51.100.4\nts=1', 4), '198.51.100.4');
  assert.strictEqual(IP.parseIp('<html>', 4), null);
  assert.strictEqual(IP.prefix64('2001:db8:1:2::7'), '2001:db8:1:2');
  assert.strictEqual(IP.prefix64('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2');
  const answers = { 'https://api.ipify.org/': '198.51.100.4', 'https://icanhazip.com/': '198.51.100.4\n' };
  let asked = 0;
  const get = async (url, fam) => { asked++; if (fam === 6) return url.includes('ident') ? '2001:db8:1:2:abcd::99' : Promise.reject(new Error('no v6')); if (!(url in answers)) throw new Error('down'); return answers[url]; };
  const v4 = await IP.publicV4({ get });
  assert.deepStrictEqual([v4.ip, v4.agree], ['198.51.100.4', 2]);
  // Zwei Quellen widersprechen sich, keine Mehrheit → keine Adresse (lieber nichts als etwas Falsches)
  const split = await IP.publicV4({ get: async (url) => (url.includes('ipify') ? '1.1.1.1' : url.includes('icanhazip') ? '2.2.2.2' : Promise.reject(new Error('x'))) });
  assert.strictEqual(split.ip, null);
  assert.ok(split.conflict);
  assert.ok(asked > 0);
  const d = await IP.detect({ get, router: { net: async () => ({ v6: { stable: '2001:db8:1:2::10' } }) } });
  assert.deepStrictEqual([d.v4, d.v6], ['198.51.100.4', '2001:db8:1:2::10']);
  const other = await IP.detect({ get, router: null, localV6: async () => '2001:db8:9:9::10' });
  assert.strictEqual(other.v6, null, 'local address is not in the network the internet sees → no AAAA');
});

/* ---------------- Dynamische Namen ---------------- */
function setup({ ip = { v4: '198.51.100.4', v6: '2001:db8:1:2::10' }, settings = null, answers = {} } = {}) {
  const f = dynFakes();
  const cf = F.cloudflare({ zones: [{ id: 'z1', name: 'example.com' }], records: [{ type: 'A', name: 'home.example.com', content: '192.0.2.1', ttl: 300, proxied: true }] });
  const handlers = { ...f.handlers, 'api.cloudflare.com': cf.handler };
  const fetch = F.fakeFetch(handlers);
  const dir = tmp();
  let clock = 1_000_000;
  const cur = { ...ip };
  // Ohne eigene Antworten zeigen die Resolver jeden Namen auf die aktuelle Adresse (die Welt sieht uns richtig)
  const mirror = () => ({ resolve4: async () => (cur.v4 ? [cur.v4] : []), resolve6: async () => (cur.v6 ? [cur.v6] : []) });
  const resolver = { makeResolver: Object.keys(answers).length ? F.fakeResolver(answers) : mirror };
  const dns = new DnsService({ dir, secrets: F.secrets, fetch, resolver });
  const notes = []; const sent = [];
  const names = new DynamicNames({
    dir, secrets: F.secrets, dns, fetch, resolver, settings, now: () => clock, detectIp: async () => ({ ...cur }),
    notifier: { notify: async (m) => sent.push(m), note: (k, x) => notes.push([k, x]) },
  });
  return { names, dns, f, cf, fetch, dir, handlers, sent, notes, cur, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('names: wrong token is rejected before saving; tokens only sealed; updates only on change and throttled', async () => {
  const s = setup();
  await assert.rejects(s.names.add({ kind: 'duckdns', name: 'srv', creds: { token: 'nope' } }), /DuckDNS rejects/);
  assert.strictEqual(s.names.list().hosts.length, 0);
  const { host } = await s.names.add({ kind: 'duckdns', name: 'srv', creds: { token: 'good-token' } });
  assert.strictEqual(host.name, 'srv.duckdns.org');
  assert.deepStrictEqual(host.fields, { token: true });
  assert.ok(!fs.readFileSync(path.join(s.dir, 'dynamic.json'), 'utf8').includes('good-token'));
  const n0 = s.f.seen.length;
  s.tick(10 * 60000);
  await s.names.tick();
  assert.strictEqual(s.f.seen.length, n0, 'same address → no request');
  s.cur.v4 = '198.51.100.5';
  s.tick(5 * 60000);
  await s.names.tick();
  assert.strictEqual(s.f.seen.length, n0 + 1, 'new address → one update');
  s.cur.v4 = '198.51.100.6';
  s.tick(MIN_GAP_MS / 2);
  s.names.ipCache = null;
  await s.names.tick();
  assert.strictEqual(s.f.seen.length, n0 + 1, 'never more than once a minute');
  const h = s.names.list().hosts[0];
  assert.strictEqual(h.state.ip4, '198.51.100.5');
  assert.ok(h.log.length >= 2 && h.log[0].ip4 === '198.51.100.5');
  // Erkennung kurz gestört (keine IPv4) zählt nicht als Änderung
  s.cur.v4 = null;
  s.tick(10 * 60000); s.names.ipCache = null;
  await s.names.tick();
  assert.strictEqual(s.f.seen.length, n0 + 1);
});

test('names: provider down → growing pauses; 429 → waits at least Retry-After; bundled notifications only on change', async () => {
  const s = setup();
  await s.names.add({ kind: 'dynv6', name: 'a.dynv6.net', creds: { token: 'good-token' } });
  await s.names.add({ kind: 'duckdns', name: 'b', creds: { token: 'good-token' } });
  s.handlers['dynv6.com'] = () => netDown();
  s.handlers['www.duckdns.org'] = () => F.reply(429, 'slow', { 'Retry-After': '3600' });
  s.cur.v4 = '198.51.100.9';
  s.tick(5 * 60000);
  await s.names.tick();
  const [a, b] = s.names.list().hosts;
  assert.strictEqual(a.state.errorKind, 'down');
  assert.strictEqual(a.state.nextTry - s.now(), BACKOFF_START_MS);
  assert.strictEqual(b.state.errorKind, 'rate');
  assert.strictEqual(b.state.nextTry - s.now(), 3600 * 1000);
  assert.strictEqual(s.sent.length, 1, 'one notification for both names');
  assert.match(s.sent[0].title, /2 DNS names/);
  assert.match(s.sent[0].text, /tries again by itself/);
  // Nächster Durchlauf vor Ablauf der Pause: keine Anfrage, keine neue Meldung
  const n = s.f.seen.length;
  s.tick(60000); await s.names.tick();
  assert.strictEqual(s.f.seen.length, n);
  assert.strictEqual(s.sent.length, 1);
  // Zweiter Fehlschlag: Pause verdoppelt
  s.tick(BACKOFF_START_MS); await s.names.tick();
  assert.strictEqual(s.names.list().hosts[0].state.nextTry - s.now(), BACKOFF_START_MS * 2);
  // Wieder in Ordnung → eine Entwarnung
  s.handlers['dynv6.com'] = dynFakes().handlers['dynv6.com'];
  s.handlers['www.duckdns.org'] = dynFakes().handlers['www.duckdns.org'];
  s.tick(2 * 3600 * 1000); await s.names.tick();
  assert.ok(s.names.list().hosts.every((h) => h.state.ok));
  assert.strictEqual(s.sent.length, 2);
  assert.strictEqual(s.sent[1].kind, 'ok');
  assert.ok(s.notes.some(([k, x]) => k.startsWith('dns-name:') && x.ok === false));
});

test('names: token expired → no more tries until changed, the user is told once', async () => {
  const s = setup();
  const { host } = await s.names.add({ kind: 'desec', name: 'srv.dedyn.io', creds: { token: 'good-token' } });
  s.handlers['update.dedyn.io'] = () => F.reply(401, 'badauth');
  s.cur.v4 = '198.51.100.10';
  s.tick(5 * 60000); await s.names.tick();
  let h = s.names.list().hosts[0];
  assert.ok(h.state.blocked);
  assert.strictEqual(s.sent[0].kind, 'error');
  assert.doesNotMatch(s.sent[0].text, /tries again/);
  const n = s.f.seen.length;
  s.tick(24 * 3600 * 1000); s.names.ipCache = null; await s.names.tick();
  assert.strictEqual(s.f.seen.length, n, 'blocked: nothing is sent');
  assert.strictEqual(s.sent.length, 1);
  // Neuer Token → sofort gesetzt, Sperre weg
  s.handlers['update.dedyn.io'] = dynFakes({ token: 'new-token' }).handlers['update.dedyn.io'];
  await s.names.change(host.id, { creds: { token: 'new-token' } });
  h = s.names.list().hosts[0];
  assert.ok(h.state.ok && !h.state.blocked);
});

test('names: own domain (zone) sets A/AAAA through the account and keeps the Cloudflare proxy', async () => {
  const s = setup();
  await s.dns.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  await assert.rejects(s.names.add({ kind: 'zone', name: 'home.other.org' }), /No DNS account manages/);
  const { host } = await s.names.add({ kind: 'zone', name: 'home.example.com', v6: false });
  assert.strictEqual(host.ttl, 300);
  const a = s.cf.st.records.filter((r) => r.name === 'home.example.com' && r.type === 'A');
  assert.deepStrictEqual(a.map((r) => [r.content, r.proxied, r.ttl]), [['198.51.100.4', true, 300]]);
  assert.ok(!s.cf.st.records.some((r) => r.type === 'AAAA'), 'IPv6 switched off for this name');
});

test('names: checks every 6 h whether the name points here, sets it again if not', async () => {
  const s = setup({ answers: { 'srv.duckdns.org|A': ['192.0.2.200'] } });
  await s.names.add({ kind: 'duckdns', name: 'srv', creds: { token: 'good-token' } });
  const n = s.f.seen.length;
  s.tick(20 * 60000); await s.names.tick();
  const h = s.names.list().hosts[0];
  assert.strictEqual(h.state.check, null, 'after the repair the old check is dropped');
  assert.strictEqual(s.f.seen.length, n + 1, 'pointed elsewhere → set again');
  assert.match(h.log[0].text, /did not point here/);
});

test('names: DynDNS of “Router & port forwarding” is never updated twice and can be taken over', async () => {
  const cfg = { router: { dyndns: { provider: 'duckdns', domain: 'srv', token: F.secrets.seal('good-token'), last: null } } };
  let saved = 0;
  const s = setup({ settings: { get: () => cfg, save: () => { saved++; } } });
  // Router speichert DuckDNS ohne Endung – gemeint ist derselbe volle Name
  assert.deepStrictEqual(s.names.list().router, { provider: 'duckdns', name: 'srv.duckdns.org', last: null, canTakeOver: true });
  await assert.rejects(s.names.add({ kind: 'duckdns', name: 'srv', creds: { token: 'good-token' } }), /already updated by “Router/);
  const r = await s.names.takeOverRouter();
  assert.strictEqual(r.host.name, 'srv.duckdns.org');
  assert.strictEqual(cfg.router.dyndns.provider, '', 'router no longer updates it');
  assert.ok(saved >= 1);
  assert.strictEqual(s.names.list().router, null);
  // Fehlschlag beim Übernehmen: Router bleibt wie er war
  const cfg2 = { router: { dyndns: { provider: 'dynv6', domain: 'x.dynv6.net', token: F.secrets.seal('nope'), last: { ok: true } } } };
  const s2 = setup({ settings: { get: () => cfg2, save: () => {} } });
  await assert.rejects(s2.names.takeOverRouter(), /dynv6 does not accept/);
  assert.strictEqual(cfg2.router.dyndns.provider, 'dynv6');
});
