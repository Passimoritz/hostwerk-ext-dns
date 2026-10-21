'use strict';
/*
 * Zonendatei (Export/Import), DNSSEC-Stand, Ausbreitung beim Namensserver, Vorschläge aus den Webservern und die
 * dns-01-Schnittstelle, die Hostwerk selbst aufruft (ctx.dns.acme.create/remove, SDK 2.10).   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./fakes');
const Z = require('../server/zonefile');
const { dnssecStatus } = require('../server/dnssec');
const { DnsService } = require('../server/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-zone-'));

const ZONE = `; exported by some provider
$ORIGIN example.com.
$TTL 1h
@        IN  A     203.0.113.10
         IN  AAAA  2001:db8::10
@ 3600 IN SOA ns1.example.net. hostmaster.example.com. ( 1 7200 3600 1209600 300 )
@        IN  NS    ns1.example.net.
www      300 IN CNAME @
@        IN  MX    10 mail          ; relative target
@        IN  TXT   "v=spf1 mx -all"
hostwerk._domainkey IN TXT ( "v=DKIM1; k=rsa; "
                             "p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" )
_minecraft._tcp.mc IN SRV 0 5 25565 mc.example.com.
@        IN  CAA   0 issue "letsencrypt.org"
x        IN  HINFO "pc" "win"
`;

test('zone file: understands provider exports (relative names, multi-line TXT, SOA/NS skipped)', () => {
  const { records, errors } = Z.parseZone(ZONE, 'example.com');
  const key = records.map((r) => `${r.name} ${r.ttl} ${r.type} ${r.priority !== undefined ? `${r.priority} ` : ''}${r.content}`);
  assert.deepStrictEqual(key, [
    'example.com 3600 A 203.0.113.10',
    'example.com 3600 AAAA 2001:db8::10',
    'www.example.com 300 CNAME example.com',
    'example.com 3600 MX 10 mail.example.com',
    'example.com 3600 TXT v=spf1 mx -all',
    'hostwerk._domainkey.example.com 3600 TXT v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA',
    '_minecraft._tcp.mc.example.com 3600 SRV 0 5 25565 mc.example.com',
    'example.com 3600 CAA 0 issue "letsencrypt.org"',
  ]);
  assert.deepStrictEqual(errors.map((e) => e.line), [15]);
  assert.match(errors[0].text, /HINFO/);
});

test('zone file: export → import gives the same records', () => {
  const { records } = Z.parseZone(ZONE, 'example.com');
  const text = Z.exportZone({ name: 'example.com' }, records);
  assert.match(text, /^\$ORIGIN example\.com\.$/m);
  assert.match(text, /^www\s+300\s+IN CNAME example\.com\.$/m);
  const back = Z.parseZone(text, 'example.com');
  assert.deepStrictEqual(back.errors, []);
  assert.deepStrictEqual(back.records.map((r) => JSON.stringify(r)).sort(), records.map((r) => JSON.stringify(r)).sort());
});

function setup(ctx = {}) {
  const cf = F.cloudflare({ zones: [{ id: 'z1', name: 'example.com' }], records: [{ type: 'A', name: 'example.com', content: '203.0.113.10', ttl: 3600 }] });
  const fetch = F.fakeFetch({ 'api.cloudflare.com': cf.handler });
  const answers = {
    'example.com|NS': ['ns1.example.net', 'ns2.example.net'], 'ns1.example.net|A': ['192.0.2.53'],
  };
  const byServer = { '192.0.2.53': { 'new.example.com|A': ['203.0.113.20'] } };
  const svc = new DnsService({ dir: tmp(), secrets: F.secrets, fetch, resolver: { makeResolver: F.fakeResolver(answers, byServer) }, ctx });
  svc.acmeWait = { every: 1, sleep: async () => {}, timeout: 50 };
  return { svc, cf };
}

test('import: shows what is new first, then adds only that – nothing is deleted or overwritten', async () => {
  const { svc, cf } = setup();
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  const dry = await svc.importZone(svc.accounts()[0].id, 'z1', ZONE);
  assert.strictEqual(dry.same, 1, 'the A record is already there');
  assert.strictEqual(dry.add.length, 7);
  assert.strictEqual(dry.done, undefined);
  assert.strictEqual(cf.st.records.length, 1);
  const done = await svc.importZone(svc.accounts()[0].id, 'z1', ZONE, { apply: true });
  assert.ok(done.done.every((r) => r.action === 'created'));
  assert.strictEqual(cf.st.records.length, 8);
  const exp = await svc.exportZone(svc.accounts()[0].id, 'z1');
  assert.strictEqual(exp.name, 'example.com.zone');
  assert.match(exp.text, /_minecraft\._tcp\.mc\s+3600\s+IN SRV\s+0 5 25565 mc\.example\.com\./);
  await assert.rejects(svc.importZone(svc.accounts()[0].id, 'z1', 'x'.repeat(600 * 1024)), /too large/);
});

test('verify: also asks the provider’s own name server – “there, only the world is still waiting”', async () => {
  const { svc } = setup();
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  const v = await svc.verify({ name: 'new.example.com', type: 'A', content: '203.0.113.20' });
  assert.strictEqual(v.atProvider, true);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.results[0].label, 'ns1.example.net');
  assert.strictEqual(v.results.length, 4);
});

test('acme for Hostwerk itself (ctx.dns.acme.create/remove): TXT next to existing ones, then removed', async () => {
  const { svc, cf } = setup();
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  await svc.acme.create({ domain: 'example.com', name: '_acme-challenge.example.com', value: 'tok-a' });
  await svc.acme.create({ domain: 'example.com', name: '_acme-challenge.example.com', value: 'tok-b' });
  assert.strictEqual(cf.st.records.filter((r) => r.type === 'TXT').length, 2);
  const r = await svc.acme.remove({ domain: 'example.com', name: '_acme-challenge.example.com', value: 'tok-a' });
  assert.strictEqual(r.action, 'removed');
  assert.deepStrictEqual(cf.st.records.filter((x) => x.type === 'TXT').map((x) => x.content), ['"tok-b"']);
});

test('sites: real domains of the web servers with the zone that manages them (local names left out)', async () => {
  const web = { list: () => [{ id: 'w1', name: 'Apache', vhosts: [{ domain: 'shop.example.com', aliases: 'www.shop.example.com *.example.com' }, { domain: 'blog.localhost' }, { domain: 'other.org' }] }] };
  const { svc } = setup({ web });
  await svc.saveAccount({ provider: 'cloudflare', creds: { token: 'cf-token' } });
  const s = await svc.sites();
  assert.deepStrictEqual(s.map((x) => [x.domain, x.zone && x.zone.name]), [['shop.example.com', 'example.com'], ['www.shop.example.com', 'example.com'], ['*.example.com', 'example.com'], ['other.org', null]]);
  const none = new DnsService({ dir: tmp(), secrets: F.secrets, fetch: async () => { throw new Error('no'); } });
  assert.deepStrictEqual(await none.sites(), []);
});

test('DNSSEC: secure, no DS at the registrar, unsigned, broken, unknown', async () => {
  const doh = (map) => F.fakeFetch({ 'cloudflare-dns.com': (c) => { const t = c.url.searchParams.get('type'); return F.reply(200, map[t]); }, 'dns.google': () => F.reply(500, 'x') });
  assert.strictEqual((await dnssecStatus('a.org', { fetch: doh({ DS: { Status: 0, AD: true, Answer: [{ type: 43, data: '1 13 2 ab' }] }, DNSKEY: { Status: 0, AD: true, Answer: [{ type: 48, data: 'k' }] } }) })).status, 'secure');
  assert.strictEqual((await dnssecStatus('a.org', { fetch: doh({ DS: { Status: 0, AD: false }, DNSKEY: { Status: 0, AD: false, Answer: [{ type: 48, data: 'k' }] } }) })).status, 'no-ds');
  assert.strictEqual((await dnssecStatus('a.org', { fetch: doh({ DS: { Status: 0 }, DNSKEY: { Status: 0 } }) })).status, 'unsigned');
  assert.strictEqual((await dnssecStatus('a.org', { fetch: doh({ DS: { Status: 2 }, DNSKEY: { Status: 2 } }) })).status, 'broken');
  const down = await dnssecStatus('a.org', { fetch: F.fakeFetch({ 'cloudflare-dns.com': () => { throw new TypeError('fetch failed'); }, 'dns.google': () => { throw new TypeError('fetch failed'); } }) });
  assert.strictEqual(down.status, 'unknown');
});
