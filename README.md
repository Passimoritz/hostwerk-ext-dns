![DNS management](banner.svg)

# DNS management

Set, change, delete and check the DNS records of your domains right at Cloudflare, Hetzner, INWX or IONOS (A, AAAA, CNAME, MX, TXT, SRV, CAA) – credentials stored encrypted in Hostwerk. Other extensions use the service, e.g. the mail server for SPF/DKIM/DMARC and Let’s Encrypt for wildcard certificates (dns-01).

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

## What it does

- Cloudflare, Hetzner (Cloud DNS and the older DNS console), INWX and IONOS over their official APIs
- Records A, AAAA, CNAME, MX, TXT, SRV and CAA: add, change, delete
- “Check” asks public resolvers (Cloudflare, Google, Quad9) whether a record is out there yet
- Takes over the SPF/DKIM/DMARC/MX records of the mail server extension with one click
- Credentials are stored encrypted (Hostwerk’s secret store) and never sent to the interface
- Service “dns” for other extensions – including ready-made dns-01 functions for Let’s Encrypt (wildcards)

## Providers

| Provider | Credentials | Notes |
|---|---|---|
| Cloudflare | API token (template “Edit zone DNS”) | Proxy switch for A/AAAA/CNAME |
| Hetzner | API token of a Console project (“Read & Write”) | Choose “Older DNS console” for zones still on dns.hetzner.com |
| INWX | User name, password, optional TOTP secret | Best a sub-account that may only change DNS; test system (OTE) selectable; TTL at least 300 s |
| IONOS | API key `prefix.secret` | Name/type changes are done as delete + create |

## For other extensions: the service `dns`

The extension offers the service **`dns`** (`"provides": ["dns"]`). Native extensions reach it with
`await host.use('dns')` (or `host.ctx.dns`) and add `"uses": ["dns"]` to their manifest – Hostwerk then suggests the
pair. Names are always full names (`_dmarc.example.com`); the right account and zone are found by the longest match.

```js
const dns = await host.use('dns');

await dns.set({ name: 'example.com', type: 'TXT', content: 'v=spf1 mx -all' });          // → { action: 'created' | 'updated' | 'unchanged', record }
await dns.apply([{ name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 }]); // many at once, one error does not stop the rest
await dns.remove({ name: 'www.example.com', type: 'A', content: '203.0.113.5' });      // → { action: 'removed' | 'missing' }
await dns.records('example.com');                                                      // records of the zone
await dns.verify({ name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 }); // → { ok, some, results: [{ resolver, ok, values }] }
await dns.waitFor(record, { timeout: 180000 });                                        // until Cloudflare, Google and Quad9 see it
```

`set()` never creates duplicates: TXT records with a tag (`v=spf1`, `v=DMARC1`, `v=DKIM1` …) replace the old one under the
same name, MX replaces the same target (new priority), CNAME replaces the name; everything else is only added if it is not
there yet. Pass `{ replace: false | 'tag' | 'type' }` to choose yourself.

Record format: `{ name, type, content, ttl, priority }` – `content` for MX/CNAME is the host name, for TXT the plain text
(long DKIM keys are split into 255-character pieces automatically), for SRV `"weight port target"` (priority separately),
for CAA `0 issue "letsencrypt.org"`.

### Mail server (SPF, DKIM, DMARC)

The page shows the records of the extension “Mail server” (`ctx.mailserver.domains(id)`) with a ✓ for each one that is
already at the provider and sets the missing ones with one click. A mail server can do the same itself:

```js
const dns = await host.use('dns');
const records = (await mailserver.domains(id)).flatMap((d) => d.records.map((r) => ({
  name: r.name, type: r.type,
  ...(r.type === 'MX' ? { content: r.value.split(' ')[1], priority: Number(r.value.split(' ')[0]) } : { content: r.value }),
})));
await dns.apply(records);
```

### Let’s Encrypt with dns-01 (wildcard certificates)

`dns.acme` has the two functions `acme-client` expects. The TXT record is added next to existing ones (domain and wildcard
need two values under the same name), Hostwerk waits until the public resolvers see it, and afterwards removes only its own
value:

```js
const cert = await client.auto({
  csr, email, termsOfServiceAgreed: true,
  challengePriority: ['dns-01'],
  challengeCreateFn: dns.acme.challengeCreateFn,
  challengeRemoveFn: dns.acme.challengeRemoveFn,
});
```

For an own ACME implementation, `dns.acme.txtValue(keyAuthorization)` gives the TXT value (base64url of SHA-256).

## Limits

- Hostwerk’s own certificate function (*Live → Certificates*, 2.11) only knows http-01. Wildcards need a small change in
  Hostwerk itself: pass `ctx.dns.acme` to `acme-client` when the domain starts with `*.` or port 80 is not reachable.
- The mail server extension does not set its records by itself yet – use the button on this page or `dns.apply()`.
- Zones are cached for 5 minutes; *Reload* fetches them again.

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`data/dns/accounts.json` – provider accounts; API tokens and passwords sealed with Hostwerk’s secret key (`config/secret.key`). Removing the extension deletes nothing.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
