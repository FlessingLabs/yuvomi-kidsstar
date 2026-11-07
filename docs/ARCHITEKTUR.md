# KidsStar – Architektur

Geprüft gegen **Yuvomi 2.86.0** (Commit `9ae0bdc`): `MODULES.md`, `docs/SPEC.md` (Rewards, Task Completions, Users), `docs/DECISIONS.md` (Einträge 4, 6, 11, 12), `docs/PAGE-COMPOSITION.md`, `server/permissions.js`, `server/scopes.js`, `server/auth.js`, `server/routes/rewards.js`.

## Kurzfassung

```
Browser (Yuvomi-Sitzung)          Flurtablet (keine Yuvomi-Sitzung)
   │  /m/kidsstar  (Modul)            │  /api/extensions/kidsstar/tablet/
   │  /api/extensions/kidsstar/*      │  Geräte- + Kindersitzung (Cookies nur für diesen Pfad)
   ▼                                  ▼
┌──────────────────────── KidsStar-Dienst (Sidecar, Node 24, node:sqlite) ───────────────────────┐
│  Identität:   GET /api/v1/auth/me mit dem Session-Cookie der Anfrage (5 s Cache)               │
│  Kinder:      GET /api/v1/family/members (family_role = child)                                 │
│  Zeitzone:    GET /api/v1/preferences → timezone_effective                                     │
│  Tablet:      API-Token (ext:kidsstar:read + family:read) → Kinder + „Modul an?“               │
│  Daten:       /data/kidsstar.db (Journal, Aktionen, Shop …), /data/images, /data/profile-images│
│  optional:    reicht alle anderen Pfade unverändert an Yuvomi weiter (ein Container, kein Proxy)│
└────────────────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                                Yuvomi (offizielles Image, unverändert)
```

* **Modul** (`module/`): native ES-Module und CSS, keine Abhängigkeiten, kein Build. Seite, Einstellungsblatt (Haushalt), Dashboard-Kachel `kidsstar:stars`, Deutsch und Englisch über Yuvomis `t()`.
* **Dienst** (`sidecar/`): ohne npm-Abhängigkeiten. Er ist die **einzige Quelle** für Sternestände und Buchungen.
* **Yuvomis Kern wird nicht verändert.** Nichts liest oder schreibt `yuvomi.db`.

## Was Yuvomi schon hat – und warum KidsStar es nicht wiederverwendet

Yuvomi hat ein eigenes Punkte- und Belohnungssystem (`/api/v1/rewards`, SPEC „Rewards“): ein Journal (`reward_ledger`), einen Katalog, Einlösungen mit Reservierung und Rückbuchung. Punkte gibt es, wenn eine Yuvomi-Aufgabe erledigt wird. Das deckt einen Teil des Auftrags ab, aber nicht den Kernablauf:

| Benötigt | Yuvomi Rewards / Tasks 2.86.0 | Folge |
|---|---|---|
| Kind meldet „erledigt“, **Eltern bestätigen**, erst dann Punkte | Punkte fließen beim Abhaken sofort; eine Bestätigung der Erledigung gibt es nicht | Lücke |
| Belohnung **nur für bestimmte Kinder** | Katalog ist haushaltsweit („no mapping from a reward to a child“, #1310) | Lücke |
| **Wunschvorschläge** der Kinder mit Preisfestlegung | nicht vorhanden | Lücke |
| **Sparziel**, vom Kind gewählt | Yuvomi zeigt automatisch die nächste erreichbare Prämie (`public/utils/reward-goal.js`); ein gewähltes Ziel je Kind gibt es nicht | Lücke |
| Aktion nur an bestimmten **Wochentagen**, **n-mal pro Tag** | Aufgaben-Wiederholung erzeugt Folgeinstanzen; Deckel „einmal je Haushaltstag“ (#1603) | anders gelöst |
| Katalog und Bonus verwalten durch Eltern ohne Adminrecht | `requireAdmin` | Lücke |
| Kein negativer verfügbarer Stand | ausdrücklich erlaubt (Rückbuchung einer wieder geöffneten Aufgabe) | Widerspruch |
| Bilder für Belohnungen | Emoji-Feld | Lücke |

Die Lücken ließen sich nur durch Änderungen an Yuvomis Kern schließen. Das schließt der Auftrag aus. Ein Mischbetrieb – KidsStar-Freigaben, die dann per `POST /rewards/bonus` Kernpunkte buchen – hätte zwei Wahrheiten erzeugt (Reservierungen und Kindzuordnung im Sidecar, Punkte im Kern) und Bonusrechte von Yuvomis Adminrolle abhängig gemacht. **Entscheidung: KidsStar führt eine eigene Einheit („Sterne“) in einer eigenen Datenbank.**

### Abgrenzung, damit nichts doppelt gutgeschrieben wird

* KidsStar **liest keine Yuvomi-Aufgaben und schreibt keine Kernpunkte**. Eine Erledigung in KidsStar erzeugt nie Yuvomi-Punkte und umgekehrt. Es gibt keinen automatischen Weg, über den dieselbe Erledigung beides erzeugt.
* Sterne und Yuvomi-Punkte sind getrennte Einheiten ohne Umrechnung.
* **Empfehlung an den Haushalt:** Kinderaufgaben entweder in KidsStar oder als Yuvomi-Aufgabe mit Punkten führen, nicht beides. Werden beide genutzt, sollten Kinderaufgaben in Yuvomi `0` Punkte haben.
* **Keine Verbindung zu Yuvomi-Aufgaben im ersten Release.** Eine sichere Kopplung bräuchte eine stabile Schnittstelle „Erledigung X ist bestätigt“ mit Idempotenzschlüssel. Yuvomis `GET /tasks/completions` liefert Ereignisse, aber ohne Bestätigungsschritt, und `DELETE`/Wiedereröffnen löscht Abschlüsse (SPEC „Task Completions“). Eine Abfrage per Abgleich könnte nach Wiedereröffnen doppelt buchen. Das ist als Einschränkung dokumentiert, nicht gebaut.

### Bezug zu DECISIONS.md

Eintrag 6 („One model, not two“) lehnt für Yuvomis **Kern** ein zweites Modell für wiederkehrende Haushaltsarbeit neben Aufgaben ab. KidsStar ist eine **Erweiterung** und genau deshalb außerhalb des Kerns gebaut. Die Spannung ist dennoch real: Ein Haushalt hat jetzt zwei Orte für Kinderpflichten. Die Abgrenzung oben ist die Antwort darauf. Sollte Yuvomi später Erledigungs-Bestätigung und Belohnungen je Kind im Kern anbieten, ist ein Umzug der Sterne in den Kern der richtige Schritt (Daten liegen exportierbar in SQLite).

## Rollen

Gelesen wird allein Yuvomis `/auth/me` (Browserangaben zählen nie):

| KidsStar-Rolle | Bedingung | Darf |
|---|---|---|
| **Eltern** | `permissions.admin` **oder** Familienrolle `dad`/`mom`/`parent` mit `ext:kidsstar = write` (abschaltbar, nur Admins) | Aktionen, Shop, Freigaben, Bonus, Korrekturen, Tablets |
| **Kind** | Familienrolle `child` | eigene Daten: melden, ansehen, wünschen, einlösen anfragen |
| andere | alle übrigen (z. B. Großeltern) | nur einen Hinweis |

Die Familienrolle setzt in Yuvomi ausschließlich ein Administrator (`PATCH /auth/users/:id`). Das Modulrecht `ext:kidsstar` (none/read/write) wirkt zusätzlich: `read` = nur lesen, `none` = kein Zugriff. Yuvomis eigene Belohnungen erlauben Freigaben nur Admins; KidsStar erweitert das bewusst auf Eltern-Familienrollen, weil der Auftrag von „Eltern“ spricht. Haushalte, die das nicht wollen, schalten es in den Einstellungen ab.

## Datenmodell und Journal

Tabelle `ledger` ist das unveränderliche Journal (Trigger verbieten `UPDATE`/`DELETE`). Jede Zeile hat zwei Wirkungen:

| Art | `delta` (verfügbar) | `reserved_delta` (reserviert) |
|---|---|---|
| `earn` Aktion erledigt | +n | 0 |
| `bonus` Eltern vergeben | +n | 0 |
| `correction` Korrektur / Gegenbuchung | ±n | 0 |
| `reserve` Einlösung angefragt | −n | +n |
| `release` abgelehnt / zurückgezogen | +n | −n |
| `redeem` genehmigt | 0 | −n |
| `refund` Genehmigung zurückgenommen | +n | 0 |

`verfügbar = SUM(delta)`, `reserviert = SUM(reserved_delta)`. Es gibt keinen gespeicherten Kontostand. Jede abziehende Buchung prüft in derselben Transaktion, dass `verfügbar` nicht unter 0 fällt.

**Gegen Doppelbuchungen:**

* Erledigung: `UNIQUE(child_id, request_id)` macht Wiederholungen derselben Anfrage idempotent. `UNIQUE(action_id, child_id, period, slot) WHERE status IN ('pending','approved')` verhindert, dass parallele Meldungen mehr Plätze belegen als `per_day` erlaubt. `UNIQUE(completion_id) WHERE kind='earn'` sorgt für höchstens eine Gutschrift je Erledigung.
* Einlösung: `UNIQUE(child_id, request_id)`, `UNIQUE(child_id, reward_id) WHERE status='pending'` und `UNIQUE(redemption_id, kind)` im Journal.
* Alle Prüf- und Schreibschritte laufen synchron in `BEGIN IMMEDIATE … COMMIT`, ohne `await` dazwischen. Der Node-Treiber ist synchron, also gibt es zwischen „Guthaben prüfen“ und „reservieren“ keinen Punkt, an dem eine zweite Anfrage dazwischenkommt.

**Momentaufnahmen:** Eine Erledigung speichert Titel, Symbol und Sterne der Aktion zum Zeitpunkt der Meldung. Ändern Eltern danach den Wert, gilt für die schon gemeldete Erledigung der alte. Eine Einlösung speichert Titel, Symbol, Bild und Preis. Der Browser schickt den Preis, den das Kind bestätigt hat (`expected_stars`). Weicht der aktuelle Preis ab, wird nichts gebucht (`409 price_changed`). Der Browser kann also nur einen veralteten Preis ablehnen, nie einen Preis vorgeben.

**Tagesgrenzen:** Der Haushaltstag kommt aus Yuvomis `timezone_effective`. Wiederkehrende Aktionen zählen je Haushaltstag (`period = YYYY-MM-DD`), einmalige insgesamt (`period = 'once'`). Versäumte Aktionen ziehen nie Sterne ab.

**Migrationen:** `sidecar/src/db.js`, versioniert in `schema_migrations`. Eine Datenbank aus einer neueren Version wird nicht angefasst.

## Sicherheit

* Jeder Endpunkt außer `/health` und den statischen Tablet-Dateien verlangt eine gültige Yuvomi-Sitzung (oder für das Tablet eine Gerätesitzung) und `ext:kidsstar ≠ none`.
* **Abgeschaltetes Modul:** Yuvomi führt `ext:kidsstar` nur, solange das Modul eingeschaltet ist. Fehlt der Schlüssel in `/auth/me`, antwortet der Dienst `403 module_forbidden`. Der separat erreichbare Dienst ist damit für Sitzungen gesperrt, ohne dass er selbst etwas umschalten muss (im Abnahmelauf geprüft).
* Schreibende Anfragen: passender `Origin`, eigenes Double-Submit-CSRF-Paar (`kidsstar-csrf`-Cookie mit `HttpOnly; SameSite=Strict; Path=/api/extensions/kidsstar` + Header `X-KidsStar-CSRF`), Modulrecht `write` und die Rollen- bzw. Eigentumsprüfung des Endpunkts.
* Eingaben werden im Dienst geprüft (`validate.js`: Längen, ganze Zahlen, nur `http(s)`-Links, keine Steuerzeichen). Ausgaben im Browser werden mit `esc()` maskiert; es gibt kein `innerHTML` (Test `test/module/static.test.js`).
* Bilder: nur PNG/JPEG/WebP, am Inhalt erkannt, Zufallsname, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`. Kein SVG. Belohnungsbilder sehen nur Eltern und Kinder, denen die Belohnung bzw. Einlösung gehört; Profilbilder nur Eltern und gekoppelte Tablets mit Freigabe für dieses Kind.
* Geheimnisse: Das API-Token kommt aus der Umgebung oder einer Datei (`YUVOMI_API_TOKEN_FILE`), nie aus dem Repository oder dem Browser. Geräte- und Sitzungsgeheimnisse liegen nur als SHA-256, Bildcodes als scrypt-Hash mit Salz.

## Flurtablet

Yuvomi bietet Modulen **keine öffentliche Route**: Modulseite und Moduldateien (`/api/v1/modules/assets/…`) verlangen eine Yuvomi-Anmeldung. Die Tablet-Seite liefert deshalb der Dienst selbst aus, auf derselben Origin unter `/api/extensions/kidsstar/tablet/`. Diesen Pfad behandelt Yuvomis Service Worker nicht.

* **Kopplung:** Ein Elternteil legt in Yuvomi (Reiter *Tablet*) ein Gerät an und gibt die Kinder frei. Der Dienst zeigt einen 8-stelligen Code (15 Minuten gültig, einmalig, gehasht gespeichert). Das Tablet löst ihn auf `/tablet/` ein und bekommt ein Geräte-Cookie (`HttpOnly; SameSite=Strict; Path=/api/extensions/kidsstar/tablet`, 400 Tage). Fehlversuche sind je Adresse begrenzt. Widerruf und Neukoppeln beenden die alte Kopplung sofort.
* **Kindersitzung:** Ein Tipp auf die Kachel öffnet sie (ggf. erst nach dem Bildcode). Das aktive Kind steht nur in dieser Sitzung auf dem Server. Je Tablet gibt es eine aktive Kindersitzung; ein Wechsel, ein neues Profil, ein Neuladen der Seite, eine entzogene Freigabe, ein Kind, das in Yuvomi kein Kind mehr ist, oder die Leerlaufzeit beenden sie.
* **Rechte am Tablet:** genau die Kinderfunktionen. Elternfunktionen gibt es unter `/tablet/api` nicht. Die Tablet-Cookies sind keine Yuvomi-Sitzung (`/api/v1/auth/me` → 401).
* **Bildcode:** vier aus neun Tiersymbolen, scrypt-gehasht. Nach fünf Fehlversuchen ist das Profil auf diesem Tablet fünf Minuten gesperrt (serverseitig, auch für den richtigen Code).
* **Modul abgeschaltet / Kind entfernt:** Am Tablet ist niemand bei Yuvomi angemeldet. Der Dienst fragt deshalb mit einem **API-Token** (Scopes `ext:kidsstar:read`, `family:read`):
  * Kinder: `GET /api/v1/family/members`.
  * „Ist KidsStar eingeschaltet?“: Ein Token mit Scopes erreicht `/api/v1/auth/me` nicht (Yuvomi sperrt `/auth` für solche Tokens, GHSA-xcv5-6w6x-x5q2). Der Dienst fragt stattdessen `GET /api/v1/extensions/kidsstar/state`. Yuvomi kennt den Scope `ext:kidsstar` nur bei eingeschaltetem Modul: eingeschaltet → 404 (Scope bekannt, keine Route), ausgeschaltet → 403 (Scope unbekannt). Jede andere Antwort sperrt das Tablet.
  * Das stützt sich auf Yuvomis Scope-Prüfung (`server/scopes.js`), nicht auf einen dafür dokumentierten Endpunkt (siehe Einschränkungen). Ohne Token gibt es keinen Tablet-Modus (`503 tablet_not_configured`).
* **Zeitzone am Tablet:** Das Token darf `/preferences` nicht lesen. Der Dienst merkt sich die zuletzt aus einer Yuvomi-Sitzung gelesene Haushaltszeitzone; bis dahin gilt `TZ`.

## Betriebsarten des Dienstes

* **A – Eingang (Standard):** Der Dienst nimmt alle Anfragen an und reicht alles außerhalb von `/api/extensions/kidsstar/` unverändert an Yuvomi weiter (`proxy.js`, gestreamt, Host-Header bleibt). Ein Container, keine Proxy-Konfiguration.
* **B – hinter eigenem Proxy:** `PROXY_YUVOMI=false`, der Proxy leitet nur `/api/extensions/kidsstar/` weiter (`deploy/proxy/`).

## Bewusste Detailentscheidungen

* Emoji statt Lucide-Symbolen für Aktionen und Belohnungen: am Tablet ohne Yuvomi verfügbar, für Kinder gut erkennbar, ohne Dateien von außen.
* Bilder werden im Browser auf 800 px verkleinert und als JPEG neu kodiert (Metadaten wie der Aufnahmeort fallen weg). Der Dienst nimmt höchstens 2 MB.
* Genehmigte Einlösungen lassen sich zurücknehmen (`refund`), damit „Geschenk doch nicht lieferbar“ ohne freie Korrektur nachvollziehbar bleibt.
* Wünsche werden beim Annehmen zu einer Belohnung, standardmäßig nur für das Kind, das ihn hatte.
* Eine offene Anfrage je Kind und Belohnung. Zwei gleichzeitige Anfragen derselben Belohnung sind fast immer ein Doppelklick.
