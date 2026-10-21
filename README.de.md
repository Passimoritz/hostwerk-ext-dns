![DNS-Verwaltung](banner.svg)

# DNS-Verwaltung

DNS-Einträge deiner Domains direkt bei Cloudflare, Hetzner, INWX oder IONOS setzen, ändern, löschen und prüfen (A, AAAA, CNAME, MX, TXT, SRV, CAA) – Zugangsdaten verschlüsselt in Hostwerk. Andere Erweiterungen nutzen den Dienst, z. B. der Mailserver für SPF/DKIM/DMARC und Let’s Encrypt für Wildcard-Zertifikate (dns-01).

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public) Erweiterung (SDK 2.7, native Erweiterung)

## Was sie kann

- Cloudflare, Hetzner (Cloud-DNS und die ältere DNS-Konsole), INWX und IONOS über deren offizielle API
- Einträge A, AAAA, CNAME, MX, TXT, SRV und CAA: anlegen, ändern, löschen
- „Prüfen“ fragt öffentliche Resolver (Cloudflare, Google, Quad9), ob ein Eintrag schon draußen ankommt
- Übernimmt die SPF/DKIM/DMARC/MX-Einträge der Mailserver-Erweiterung mit einem Klick
- Zugangsdaten verschlüsselt gespeichert (Hostwerks Geheimnis-Ablage), nie an die Oberfläche geschickt
- Dienst „dns“ für andere Erweiterungen – inklusive fertiger dns-01-Funktionen für Let’s Encrypt (Wildcards)

## Anbieter

| Anbieter | Zugangsdaten | Hinweise |
|---|---|---|
| Cloudflare | API-Token (Vorlage „Zone-DNS bearbeiten“) | Proxy-Schalter für A/AAAA/CNAME |
| Hetzner | API-Token eines Console-Projekts („Lesen & Schreiben“) | „Ältere DNS-Konsole“ wählen für Zonen, die noch auf dns.hetzner.com liegen |
| INWX | Benutzername, Passwort, optional TOTP-Geheimnis | Am besten ein Unterkonto, das nur DNS ändern darf; Testsystem (OTE) wählbar; TTL mindestens 300 s |
| IONOS | API-Schlüssel `präfix.geheimnis` | Name/Typ ändern = löschen + neu anlegen |

## Für andere Erweiterungen: der Dienst `dns`

Die Erweiterung bietet den Dienst **`dns`** an (`"provides": ["dns"]`). Native Erweiterungen holen ihn mit
`await host.use('dns')` (oder `host.ctx.dns`) und tragen `"uses": ["dns"]` ins Manifest ein – dann schlägt Hostwerk das
Paar selbst vor. Namen sind immer vollständig (`_dmarc.example.com`); Zugang und Zone findet der Dienst über den längsten
Treffer.

```js
const dns = await host.use('dns');

await dns.set({ name: 'example.com', type: 'TXT', content: 'v=spf1 mx -all' });          // → { action: 'created' | 'updated' | 'unchanged', record }
await dns.apply([{ name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 }]); // viele auf einmal, ein Fehler hält den Rest nicht auf
await dns.remove({ name: 'www.example.com', type: 'A', content: '203.0.113.5' });      // → { action: 'removed' | 'missing' }
await dns.records('example.com');                                                      // Einträge der Zone
await dns.verify({ name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10 }); // → { ok, some, results: [{ resolver, ok, values }] }
await dns.waitFor(record, { timeout: 180000 });                                        // bis Cloudflare, Google und Quad9 ihn sehen
```

`set()` legt nie Doppelte an: TXT-Einträge mit Kennung (`v=spf1`, `v=DMARC1`, `v=DKIM1` …) ersetzen den alten unter
demselben Namen, MX ersetzt dasselbe Ziel (neue Priorität), CNAME ersetzt den Namen; alles andere kommt nur dazu, wenn es
noch fehlt. Mit `{ replace: false | 'tag' | 'type' }` selbst wählen.

Form eines Eintrags: `{ name, type, content, ttl, priority }` – `content` ist bei MX/CNAME der Hostname, bei TXT der reine
Text (lange DKIM-Schlüssel werden automatisch in Stücke zu 255 Zeichen geteilt), bei SRV `"gewicht port ziel"` (Priorität
getrennt), bei CAA `0 issue "letsencrypt.org"`.

### Mailserver (SPF, DKIM, DMARC)

Die Seite zeigt die Einträge der Erweiterung „Mailserver“ (`ctx.mailserver.domains(id)`) mit einem ✓ für alles, was beim
Anbieter schon steht, und setzt das Fehlende mit einem Klick. Ein Mailserver kann das auch selbst:

```js
const dns = await host.use('dns');
const records = (await mailserver.domains(id)).flatMap((d) => d.records.map((r) => ({
  name: r.name, type: r.type,
  ...(r.type === 'MX' ? { content: r.value.split(' ')[1], priority: Number(r.value.split(' ')[0]) } : { content: r.value }),
})));
await dns.apply(records);
```

### Let’s Encrypt mit dns-01 (Wildcard-Zertifikate)

`dns.acme` enthält die beiden Funktionen, die `acme-client` erwartet. Der TXT-Eintrag kommt neben vorhandene (Domain und
Wildcard brauchen zwei Werte unter demselben Namen), Hostwerk wartet, bis die öffentlichen Resolver ihn sehen, und
entfernt danach nur den eigenen Wert:

```js
const cert = await client.auto({
  csr, email, termsOfServiceAgreed: true,
  challengePriority: ['dns-01'],
  challengeCreateFn: dns.acme.challengeCreateFn,
  challengeRemoveFn: dns.acme.challengeRemoveFn,
});
```

Für eine eigene ACME-Umsetzung liefert `dns.acme.txtValue(keyAuthorization)` den TXT-Wert (base64url von SHA-256).

## Grenzen

- Hostwerks eigene Zertifikatsfunktion (*Livebetrieb → Zertifikate*, 2.11) kennt nur http-01. Für Wildcards braucht es
  eine kleine Änderung in Hostwerk selbst: `ctx.dns.acme` an `acme-client` geben, wenn die Domain mit `*.` beginnt oder
  Port 80 nicht erreichbar ist.
- Die Mailserver-Erweiterung setzt ihre Einträge noch nicht selbst – dafür den Knopf auf dieser Seite oder `dns.apply()` nutzen.
- Zonen werden 5 Minuten zwischengespeichert; *Neu laden* holt sie neu.

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`data/dns/accounts.json` – Anbieter-Zugänge; API-Tokens und Passwörter mit Hostwerks Geheimschlüssel (`config/secret.key`) versiegelt. Entfernen der Erweiterung löscht nichts.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
