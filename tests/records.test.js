'use strict';
/* Einträge prüfen, vergleichen und umwandeln (anbieterunabhängig).   node --test tests/ */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/records');

test('names: relative ↔ full, @ is the zone itself', () => {
  assert.strictEqual(R.fqdn('@', 'example.com'), 'example.com');
  assert.strictEqual(R.fqdn('', 'example.com.'), 'example.com');
  assert.strictEqual(R.fqdn('www', 'example.com'), 'www.example.com');
  assert.strictEqual(R.fqdn('WWW.Example.com', 'example.com'), 'www.example.com');
  assert.strictEqual(R.fqdn('mail.other.org.', 'example.com'), 'mail.other.org');
  assert.strictEqual(R.fqdn('www.example.com', undefined), 'www.example.com');
  assert.strictEqual(R.relative('example.com', 'example.com'), '@');
  assert.strictEqual(R.relative('_dmarc.example.com.', 'example.com'), '_dmarc');
});

test('validate: every type in its normal form', () => {
  const z = 'example.com';
  assert.deepStrictEqual(R.validate({ name: '@', type: 'a', content: '203.0.113.5' }, z), { name: z, type: 'A', content: '203.0.113.5', ttl: 3600 });
  assert.strictEqual(R.validate({ name: 'v6', type: 'AAAA', content: '2001:DB8::1', ttl: 300 }, z).content, '2001:db8::1');
  assert.strictEqual(R.validate({ name: 'www', type: 'CNAME', content: 'Example.com.' }, z).content, 'example.com');
  assert.deepStrictEqual(R.validate({ name: '@', type: 'MX', content: 'mail.example.com.' }, z), { name: z, type: 'MX', content: 'mail.example.com', ttl: 3600, priority: 10 });
  assert.strictEqual(R.validate({ name: '@', type: 'TXT', content: '"v=spf1 mx -all"' }, z).content, 'v=spf1 mx -all');
  assert.deepStrictEqual(R.validate({ name: '_minecraft._tcp', type: 'SRV', content: '5 25565 MC.example.com.', priority: 0 }, z), { name: `_minecraft._tcp.${z}`, type: 'SRV', content: '5 25565 mc.example.com', ttl: 3600, priority: 0 });
  assert.strictEqual(R.validate({ name: '@', type: 'CAA', content: '0 ISSUE letsencrypt.org' }, z).content, '0 issue "letsencrypt.org"');
  assert.strictEqual(R.validate({ name: '*', type: 'A', content: '203.0.113.5' }, z).name, '*.example.com');
  assert.strictEqual(R.validate({ name: 'x', type: 'A', content: '1.2.3.4', priority: 5 }, z).priority, undefined, 'only MX/SRV keep a priority');
});

test('validate: refuses wrong input with a clear text', () => {
  const z = 'example.com';
  const no = (r, re) => assert.throws(() => R.validate(r, z), (e) => e.status === 400 && re.test(e.message));
  no({ name: '@', type: 'NS', content: 'x' }, /Unknown record type/);
  no({ name: '@', type: 'A', content: '2001:db8::1' }, /IPv4/);
  no({ name: '@', type: 'AAAA', content: '1.2.3.4' }, /IPv6/);
  no({ name: '@', type: 'CNAME', content: 'other.org' }, /domain itself/);
  no({ name: 'mail.other.org.', type: 'A', content: '1.2.3.4' }, /not inside the zone example\.com/);
  no({ name: 'bad name', type: 'A', content: '1.2.3.4' }, /not a valid host name/);
  no({ name: '@', type: 'TXT', content: '' }, /empty/);
  no({ name: 'mc', type: 'SRV', content: '5 25565 mc.example.com' }, /_service\._protocol/);
  no({ name: '_mc._tcp', type: 'SRV', content: '5 99999 mc.example.com' }, /weight port target/);
  no({ name: '@', type: 'CAA', content: '0 whatever "x"' }, /flags tag value/);
  no({ name: '@', type: 'MX', content: 'mail.example.com', priority: -1 }, /priority/);
  no({ name: '@', type: 'A', content: '1.2.3.4', ttl: 0 }, /TTL/);
});

test('TXT: long values split into 255-character pieces and back', () => {
  const dkim = `v=DKIM1; k=rsa; p=${'A'.repeat(400)}`;
  const q = R.txtQuote(dkim);
  assert.strictEqual((q.match(/"/g) || []).length, 4, 'two quoted pieces');
  assert.strictEqual(R.txtUnquote(q), dkim);
  assert.strictEqual(R.txtUnquote(R.txtQuote('say "hi" \\o/')), 'say "hi" \\o/');
  assert.strictEqual(R.txtUnquote('plain text'), 'plain text');
});

test('zone-file values (Hetzner) round-trip', () => {
  const z = 'example.org';
  for (const r of [
    { name: z, type: 'MX', content: 'mail.example.org', priority: 10 },
    { name: `_sip._udp.${z}`, type: 'SRV', content: '5 5060 sip.example.org', priority: 1 },
    { name: `www.${z}`, type: 'CNAME', content: 'example.org' },
    { name: z, type: 'TXT', content: 'v=spf1 mx -all' },
    { name: z, type: 'CAA', content: '0 issuewild "letsencrypt.org"' },
  ]) {
    const v = R.toZoneValue(r);
    const back = R.fromZoneValue(r.type, v);
    assert.strictEqual(back.content, r.content, `${r.type}: ${v}`);
    if (r.priority !== undefined) assert.strictEqual(back.priority, r.priority);
  }
  assert.strictEqual(R.toZoneValue({ type: 'MX', content: 'mail.example.org', priority: 10 }), '10 mail.example.org.');
});

test('same/txtTag/bestZone', () => {
  assert.ok(R.same({ name: 'Example.com.', type: 'mx', content: 'MAIL.example.com.', priority: 10 }, { name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 }));
  assert.ok(!R.same({ name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 20 }, { name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 }));
  assert.ok(R.same({ name: 'example.com', type: 'TXT', content: '"v=spf1 -all"' }, { name: 'example.com', type: 'TXT', content: 'v=spf1 -all' }));
  assert.strictEqual(R.txtTag('v=spf1 mx -all'), 'v=spf1');
  assert.strictEqual(R.txtTag('"v=DMARC1; p=none"'), 'v=dmarc1');
  assert.strictEqual(R.txtTag('google-site-verification=abc'), null);
  const zones = [{ name: 'example.com' }, { name: 'sub.example.com' }, { name: 'other.org' }];
  assert.strictEqual(R.bestZone('a.sub.example.com', zones).name, 'sub.example.com');
  assert.strictEqual(R.bestZone('example.com', zones).name, 'example.com');
  assert.strictEqual(R.bestZone('notexample.com', zones), null);
});
