## 1.2.2

- New animated icon and banner in the common Hostwerk style (isometric block). / Neues animiertes Symbol und Banner im gemeinsamen Hostwerk-Stil (isometrischer Block).

## 1.2.1

- Records: the card fills the window and only the table scrolls (header sticks) – long zones no longer push the page; empty and no-match states as Hostwerk’s empty tile / Einträge: die Karte füllt das Fenster, nur die Tabelle scrollt (Kopfzeile klebt) – lange Zonen schieben die Seite nicht mehr; leer und ohne Treffer als Hostwerks Leer-Kachel

## 1.2.0

- Lives where it belongs: Go live → Make reachable → DNS, the address card of every Minecraft server and – new – the section “DNS records” of a web server – no own sidebar entry any more (Hostwerk 3.0+); the full page stays under Extensions → Open and can be pinned in the sidebar settings. / Steckt jetzt dort, wo sie hingehört: Livebetrieb → Erreichbar machen → DNS, Adress-Karte jedes Minecraft-Servers und – neu – Abschnitt „DNS-Einträge“ eines Webservers – kein eigener Seitenleisten-Eintrag mehr (Hostwerk 3.0+); die ganze Seite bleibt unter Erweiterungen → Öffnen und lässt sich in den Seitenleisten-Einstellungen anheften.
- New section “DNS records” on the overview of a web server (Hostwerk 3.0+): “Create DNS record” for its domains – only where the domain is connected to a DNS provider. / Neuer Abschnitt „DNS-Einträge“ in der Übersicht eines Webservers (Hostwerk 3.0+): „DNS-Eintrag anlegen“ für seine Domains – nur, wo die Domain bei einem DNS-Anbieter verbunden ist.

## 1.1.0

- Free names without a domain: DuckDNS, deSEC (dedyn.io, with DNSSEC), dynv6, FreeDNS (afraid.org) and – clearly marked as not maintenance-free – No-IP; assistant “I have no domain / I have a domain” with sign-up link and step-by-step help. / Kostenlose Namen ohne Domain: DuckDNS, deSEC (dedyn.io, mit DNSSEC), dynv6, FreeDNS (afraid.org) und – klar als nicht wartungsfrei gekennzeichnet – No-IP; Assistent „Ich habe keine Domain / Ich habe eine Domain“ mit Anmelde-Link und Schritt-für-Schritt-Hilfe.
- Maintenance-free: IPv4/IPv6 changes are detected (several sources without an account, fixed IPv6 instead of the privacy address) and names are updated only on change, at most once a minute; growing pauses when a provider is down, Retry-After on 429, a wrong token stops the tries until it is changed; one bundled notification, self-maintenance entry, check every 6 h that the name really points here, history per name. / Wartungsfrei: IPv4/IPv6-Wechsel werden erkannt (mehrere Quellen ohne Konto, feste IPv6 statt Datenschutz-Adresse) und Namen nur bei Änderung aktualisiert, höchstens einmal pro Minute; wachsende Pausen bei gestörtem Anbieter, Retry-After bei 429, ein falscher Token stoppt die Versuche bis zur Änderung; eine gebündelte Benachrichtigung, Eintrag in der Selbstwartung, alle 6 h Prüfung, ob der Name wirklich hierher zeigt, Verlauf je Name.
- Own domain: a name of a connected zone can follow this connection (A/AAAA, Cloudflare proxy kept). deSEC is a full DNS provider too. / Eigene Domain: ein Name einer verbundenen Zone kann diesem Anschluss folgen (A/AAAA, Cloudflare-Proxy bleibt). deSEC ist auch ein vollwertiger DNS-Anbieter.
- Records: templates (website with/without www, name for a Hostwerk web server, Minecraft SRV, mail basics, CAA), propagation check including the provider’s name server, DNSSEC status, zone file export and import. / Einträge: Vorlagen (Webseite mit/ohne www, Name für einen Hostwerk-Webserver, Minecraft-SRV, Mail-Grundlagen, CAA), Ausbreitungs-Prüfung inklusive Namensserver des Anbieters, DNSSEC-Stand, Zonendatei speichern und einlesen.
- In Hostwerk: Live → DNS (names and domains of the web servers), Minecraft → own address; the DynDNS name of “Router & port forwarding” is never updated twice and can be taken over. / In Hostwerk: Livebetrieb → DNS (Namen und Domains der Webserver), Minecraft → eigene Adresse; der DynDNS-Name von „Router & Portfreigaben“ wird nie doppelt aktualisiert und lässt sich übernehmen.
- Fix: `ctx.dns.acme.create/remove` (SDK 2.10) – Hostwerk’s own certificates can now use dns-01 (wildcards, no port 80). / Behoben: `ctx.dns.acme.create/remove` (SDK 2.10) – Hostwerks eigene Zertifikate können jetzt dns-01 nutzen (Wildcards, ohne Port 80).

## 1.0.0

- First release: DNS records at Cloudflare, Hetzner (Console and older DNS console), INWX and IONOS – add, change, delete, check at public resolvers; mail server records with one click; service "dns" for other extensions (incl. dns-01 for Let’s Encrypt). / Erste Fassung: DNS-Einträge bei Cloudflare, Hetzner (Console und ältere DNS-Konsole), INWX und IONOS – anlegen, ändern, löschen, bei öffentlichen Resolvern prüfen; Mailserver-Einträge mit einem Klick; Dienst „dns“ für andere Erweiterungen (inkl. dns-01 für Let’s Encrypt).
