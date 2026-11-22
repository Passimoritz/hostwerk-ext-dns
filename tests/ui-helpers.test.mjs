/* Umlaut domains shown as typed, records in natural order (ui/src/idn.js, ui/src/sort.js). */
import test from 'node:test';
import assert from 'node:assert';
import url from 'node:url';
import { showDomain } from '../ui/src/idn.js';
import { sortRecords } from '../ui/src/sort.js';
import R from '../server/records.js';

test('Umlaut domains: input becomes Punycode on the server, the page shows Unicode again', () => {
  assert.strictEqual(R.fqdn('wöö', 'müller.example'), 'xn--w-1gaa.xn--mller-kva.example');
  assert.strictEqual(showDomain(R.fqdn('wöö', 'müller.example')), 'wöö.müller.example');
  assert.strictEqual(R.strip('*.Bücher.Example.'), `*.${url.domainToASCII('bücher.example')}`);
  assert.strictEqual(R.validate({ type: 'MX', name: '@', content: 'mail.müller.example' }, 'xn--mller-kva.example').content, 'mail.xn--mller-kva.example');
});

test('records sorted naturally: zone first, host-2 before host-10, then by type', () => {
  const z = 'example.com';
  const recs = ['host-10', 'host-2', '@', 'www', 'host-2'].map((n, i) => ({ name: n === '@' ? z : `${n}.${z}`, type: i === 4 ? 'AAAA' : 'A', content: String(i) }));
  assert.deepStrictEqual(sortRecords(recs, z).map((r) => `${r.name.replace(`.${z}`, '')}/${r.type}`), ['example.com/A', 'host-2/A', 'host-2/AAAA', 'host-10/A', 'www/A']);
});
