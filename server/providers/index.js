'use strict';
/*
 * Die unterstützten Anbieter: Formularfelder für die Oberfläche (secret = wird verschlüsselt gespeichert und nie
 * wieder herausgegeben) und eine kurze Anleitung, wo es den Schlüssel gibt.
 * cost: ehrliche Einordnung für den Assistenten – dnsFree = der DNS-Betrieb kostet nichts; die Domain selbst kostet
 * fast immer Geld beim Registrar (Ausnahme: deSEC-Namen unter dedyn.io).
 */
const { Cloudflare } = require('./cloudflare');
const { Hetzner } = require('./hetzner');
const { Inwx } = require('./inwx');
const { Ionos } = require('./ionos');
const { Desec } = require('./desec');

const PROVIDERS = {
  cloudflare: {
    label: 'Cloudflare', make: (c, o) => new Cloudflare(c, o), proxy: true,
    fields: [{ key: 'token', label: 'API token', secret: true, required: true }],
    help: 'Cloudflare → My profile → API tokens → Create token → template “Edit zone DNS”. Pick the zones (or all zones).',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    cost: { dnsFree: true, note: 'DNS is free on the Free plan. The domain itself is bought at a registrar (Cloudflare sells at cost).' },
  },
  desec: {
    label: 'deSEC', make: (c, o) => new Desec(c, o), dnssec: true,
    fields: [{ key: 'token', label: 'API token', secret: true, required: true }],
    help: 'desec.io → Token management → “+” – a token for your account. Works for your own domains and for free names under dedyn.io.',
    url: 'https://desec.io/tokens',
    cost: { dnsFree: true, freeName: true, note: 'Free, run by a non-profit, DNSSEC included. Own domains: point the name servers at ns1.desec.io and ns2.desec.org.' },
  },
  hetzner: {
    label: 'Hetzner', make: (c, o) => new Hetzner(c, o),
    fields: [
      { key: 'token', label: 'API token', secret: true, required: true },
      { key: 'api', label: 'Interface', type: 'select', options: [{ id: 'cloud', label: 'Hetzner Console (Cloud API)' }, { id: 'legacy', label: 'Older DNS console (dns.hetzner.com)' }], default: 'cloud' },
    ],
    help: 'Hetzner Console → your project → Security → API tokens → “Read & Write”. Zones still in the older DNS console need a token from dns.hetzner.com.',
    url: 'https://console.hetzner.com/',
    cost: { dnsFree: true, note: 'DNS hosting is free with a Hetzner account. The domain itself costs money at a registrar.' },
  },
  inwx: {
    label: 'INWX', make: (c, o) => new Inwx(c, o),
    fields: [
      { key: 'user', label: 'User name', required: true },
      { key: 'pass', label: 'Password', secret: true, required: true },
      { key: 'totp', label: 'Two-factor secret (optional)', secret: true },
      { key: 'sandbox', label: 'Test system (OTE)', type: 'switch' },
    ],
    help: 'Best with an extra INWX sub-account that may only change DNS. With two-factor sign-in, enter the secret shown under the QR code – Hostwerk makes the six-digit code itself.',
    url: 'https://www.inwx.de/en/customer/account',
    cost: { dnsFree: true, note: 'DNS is included with domains bought at INWX.' },
  },
  ionos: {
    label: 'IONOS', make: (c, o) => new Ionos(c, o),
    fields: [{ key: 'key', label: 'API key (prefix.secret)', secret: true, required: true }],
    help: 'IONOS developer portal → API keys → create a key. Enter it as prefix.secret (both parts with a dot in between).',
    url: 'https://developer.hosting.ionos.de/keys',
    cost: { dnsFree: true, note: 'DNS is included with domains bought at IONOS.' },
  },
};

/** Für die Oberfläche: ohne make(). */
function catalog() { return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, fields: p.fields, help: p.help, url: p.url, proxy: !!p.proxy, dnssec: !!p.dnssec, cost: p.cost || null })); }

module.exports = { PROVIDERS, catalog };
