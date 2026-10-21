![DNS-Verwaltung](banner.svg)

# DNS-Verwaltung

Ein Name für deinen Anschluss – kostenlos oder mit eigener Domain –, der deiner IPv4 und IPv6 von selbst folgt, dazu alle
DNS-Einträge deiner Domains direkt bei Cloudflare, deSEC, Hetzner, INWX oder IONOS (A, AAAA, CNAME, MX, TXT, SRV, CAA) mit
Vorlagen, Prüfung, DNSSEC-Stand und Zonendatei. Andere Erweiterungen nutzen den Dienst, z. B. der Mailserver für
SPF/DKIM/DMARC und Let’s Encrypt für Wildcard-Zertifikate (dns-01).

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public) Erweiterung (SDK 2.7, native Erweiterung)

## Was sie kann

- **Namen einrichten** – Assistent mit zwei Wegen: *„Ich habe keine Domain“* (kostenloser Name, Schritt für Schritt mit
  Link zur Anmeldung, Token einfügen) oder *„Ich habe eine Domain“* (Anbieter wählen, verbinden, freiwillig einen Namen
  diesem Anschluss folgen lassen)
- **Wartungsfreie Namen**: Alle 5 Minuten schaut Hostwerk nach der öffentlichen Adresse (mehrere Quellen ohne Konto; eine
  IPv4 zählt erst, wenn zwei dasselbe sagen; für IPv6 die feste Adresse dieses PCs, nicht die wechselnde
  Datenschutz-Adresse) und ändert einen Namen **nur bei einer Änderung** – nie öfter als einmal pro Minute. Alle 6 Stunden
  prüft es bei öffentlichen Resolvern, ob der Name wirklich hierher zeigt, und setzt ihn sonst neu. Anbieter gestört →
  wachsende Pausen (5 min … 6 h), 429 → mindestens so lange warten, wie der Anbieter sagt, Token falsch oder abgelaufen →
  keine weiteren Versuche, bis du ihn änderst. Probleme kommen als **eine** Benachrichtigung (Einstellungen →
  Benachrichtigungen, „DNS-Namen werden nicht aktualisiert“) und stehen in Hostwerks Selbstwartung; jede Änderung steht im
  Verlauf des Namens
- Einträge A, AAAA, CNAME, MX, TXT, SRV und CAA: anlegen, ändern, löschen, filtern; Rechtsklick auf eine Zeile
- **Vorlagen**: Webseite mit und ohne www, Name für einen Hostwerk-Webserver, Minecraft (A/AAAA + SRV, wenn der Port nicht
  25565 ist), Mail-Grundlagen (MX, SPF, DMARC), CAA für Let’s Encrypt – Adressen werden ersetzt, nichts kommt doppelt
- **Prüfen / Ausbreitung**: fragt Cloudflare, Google, Quad9 **und den Namensserver des Anbieters** – so siehst du „der
  Anbieter hat es, die Welt wartet noch auf die TTL“
- **DNSSEC-Stand** je Zone (an, DS fehlt beim Registrar, aus, kaputt) – mit den DS-Einträgen von deSEC zum Kopieren
- **Zonendatei**: speichern (BIND-Format) und vom alten Anbieter einlesen – es kommt nur dazu, was fehlt
- Mailserver-Einträge (SPF/DKIM/DMARC/MX) der Mailserver-Erweiterung mit einem Klick
- Zugangsdaten und Tokens mit Hostwerks Geheimschlüssel verschlüsselt, nie an die Oberfläche geschickt

## Anbieter

| Anbieter | Kosten | Eigene Domain nötig? | Wartungsfrei | Was du brauchst |
|---|---|---|---|---|
| **DuckDNS** | kostenlos | nein (`name.duckdns.org`) | ja | Token (Anmeldung mit GitHub/Google/Reddit/X) |
| **deSEC** (`dedyn.io`) | kostenlos (gemeinnützig) | nein (`name.dedyn.io`) – auch eigene Domains | ja | Token; DNSSEC inklusive, alle Eintragstypen |
| **dynv6** | kostenlos | nein (`name.dynv6.net` …) | ja | HTTP-Token |
| **FreeDNS** (afraid.org) | kostenlos | nein (viele geteilte Domains) | ja | Update-Token je Eintrag (A, AAAA) |
| **No-IP** | kostenloser Name | nein (`name.ddns.net` …) | **nein** – alle 30 Tage per E-Mail bestätigen | Benutzer + Passwort oder DDNS-Schlüssel |
| **Cloudflare** | DNS kostenlos (Free-Tarif) | ja – die Domain kostet beim Registrar Geld | ja | API-Token (Vorlage „Zone-DNS bearbeiten“); Proxy-Schalter |
| **deSEC** (eigene Domain) | kostenlos | ja – Domain bei beliebigem Registrar | ja | Token; Namensserver ns1.desec.io / ns2.desec.org |
| **Hetzner** | DNS kostenlos | ja – Domain kostet Geld | ja | API-Token eines Console-Projekts („Lesen & Schreiben“) |
| **INWX** | DNS bei dort gekauften Domains inklusive | ja – Domain kostet Geld | ja | Benutzer, Passwort, optional TOTP-Geheimnis; TTL ≥ 300 s |
| **IONOS** | DNS bei dort gekauften Domains inklusive | ja – Domain kostet Geld | ja | API-Schlüssel `präfix.geheimnis` |

„Wartungsfrei“ heißt: Nach dem einmaligen Einrichten musst du nie wieder etwas tun – solange der Anbieter das Konto
weiterführt. No-IP gibt es nur als Alternative, deutlich gekennzeichnet.

## Wo sie in Hostwerk auftaucht

| Ort | Was |
|---|---|
| **DNS** (eigene Seite) | Namen, Einträge, Anbieter – die volle Verwaltung |
| **Livebetrieb → DNS** (neben *Domains & HTTPS*) | Namen mit Stand und „Jetzt aktualisieren“, die Domains deiner Webserver mit **DNS-Eintrag anlegen** |
| **Minecraft → Server → Verbinden** | Der kostenlose Name mit Port zum Kopieren, **Eigene Adresse** legt A/AAAA (+ SRV) in deiner Domain an |
| **Livebetrieb → Domains & HTTPS** | Hostwerk nutzt `ctx.dns.acme.create/remove` für Wildcard-Zertifikate und ohne Port 80 |

„Router & Portfreigaben“ behält seine eigene, einfache DynDNS-Einstellung – sie funktioniert weiter. Ein Name wird nie von
beiden aktualisiert: Die DNS-Seite zeigt den Namen des Routers und holt ihn mit **Hier aktuell halten** hierher (der Token
zieht verschlüsselt mit um, die Router-Einstellung wird abgeschaltet).

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
await dns.acme.create({ domain: 'example.com', name: '_acme-challenge.example.com', value }); // ruft Hostwerk selbst auf (SDK 2.10)
const ip = await dns.names.ips();                                                      // { v4, v6 } dieses Anschlusses
dns.names.list();                                                                      // Namen, die diesem Anschluss folgen, mit Stand
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

- DuckDNS, dynv6 und FreeDNS nehmen über ihre Update-Schnittstelle nur A/AAAA (DuckDNS ein TXT) – andere Einträge
  bearbeitest du auf ihrer Webseite. deSEC-Namen können hier jeden Eintragstyp tragen.
- FreeDNS: Jeder Eintrag hat einen eigenen Update-Token (IPv6 braucht einen zweiten).
- No-IP: Kostenlose Namen müssen alle 30 Tage per E-Mail bestätigt werden – das kann Hostwerk nicht übernehmen.
- IPv6: Ein Name bekommt nur dann einen AAAA-Eintrag, wenn die feste IPv6 dieses PCs von außen erreichbar ist (gleiches
  /64 wie die Adresse, die das Internet sieht). Ohne IPv6 nach draußen bleiben vorhandene AAAA-Einträge unangetastet.
- Die Prüfung fragt öffentliche Resolver per DNS (UDP/TCP 53) und – für DNSSEC – per DNS-over-HTTPS (Cloudflare, Google).
- Hostwerks eigene Zertifikatsfunktion (*Livebetrieb → Domains & HTTPS*) nutzt `ctx.dns.acme.create/remove` ab Hostwerk 2.12;
  ältere Versionen kennen nur http-01.
- Die Mailserver-Erweiterung setzt ihre Einträge noch nicht selbst – dafür den Knopf im Reiter Anbieter oder `dns.apply()` nutzen.
- Zonen werden 5 Minuten zwischengespeichert; *Neu laden* holt sie neu.

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`data/dns/dynamic.json` – Namen, die diesem Anschluss folgen, mit Stand und Verlauf; Tokens versiegelt wie die Anbieter-Zugänge.

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
