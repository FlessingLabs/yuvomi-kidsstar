# KidsStar für Yuvomi – Kinder & Sterne

Kinder sammeln mit Alltagsaktionen Sterne und lösen sie im Sterneshop für Wünsche und Geschenke ein:

**Aktion erledigen → ggf. Eltern bestätigen → Sterne erhalten → auf einen Wunsch sparen → im Sterneshop einlösen → Eltern erfüllen das Geschenk.**

* **Aktionen** mit Symbol, Sternen, Wochentagen, „n-mal pro Tag“, einmalig oder wiederkehrend, mit oder ohne Bestätigung; sechs bearbeitbare Vorlagen (Zähne putzen morgens/abends, Zimmer aufräumen, Hausaufgaben, Tisch decken, Müll).
* **Sternestand und Verlauf** je Kind: verfügbar, reserviert, jede Buchung mit Grund und Zeit. Eltern vergeben Extra-Sterne und korrigieren Fehlbuchungen sichtbar. Kein Abzug für versäumte Aufgaben, nie ein negativer Stand.
* **Sterneshop** mit Bildern, Preis, Verfügbarkeit und Freigabe für alle oder einzelne Kinder. **Wünsche** der Kinder (mit Link), von Eltern bepreist oder mit Rückmeldung abgelehnt. **Sparziel**: „Du hast 24 von 40 Sternen. Es fehlen noch 16.“
* **Einlösen** reserviert die Sterne atomar. Eltern genehmigen oder lehnen ab und markieren das Geschenk als übergeben. Preis und Titel werden als Momentaufnahme gespeichert.
* **Flurtablet „Wer bist du?“**: große Bildkacheln für Kinder, die noch nicht lesen; Foto oder Symbol je Kind, optionaler Bildcode aus vier Tiersymbolen, Profilwechsel und automatischer Rücksprung. Eigene, auf KidsStar beschränkte Gerätekopplung, keine Yuvomi-Anmeldung am Tablet.
* Yuvomis Anmeldung, Familienrollen und Rechte (`ext:kidsstar`), Seitengerüst, Hell/Dunkel, Deutsch/Englisch, Dashboard-Kachel. Selbstgehostet, ohne Tracking, ohne Cloud, ohne CDN.

## Aufbau

| Teil | Ordner | Was |
|---|---|---|
| Modul | `module/` | Seite, Einstellungen, Kachel – wird in Yuvomi installiert |
| Dienst | `sidecar/` | Sterne-Journal (SQLite), Bilder, Tablet-Seite – läuft als eigener Container neben Yuvomi |

**Yuvomis Modulinstallation installiert nur `module/`. Den Dienst stellt sie nicht bereit.** Beides wird gebraucht. Yuvomi selbst bleibt unverändert.

## Schnellstart

1. Dienst starten (Unraid-Vorlage `deploy/unraid/kidsstar.xml` oder `deploy/docker-compose.yml`), `YUVOMI_URL` auf Yuvomi zeigen lassen.
2. Yuvomi über den Port des Dienstes öffnen – oder mit eigenem Reverse-Proxy nur `/api/extensions/kidsstar/` zum Dienst leiten (`deploy/proxy/`).
3. In Yuvomi: Einstellungen → Module → Eigenes Modul hinzufügen → `FlessingLabs/yuvomi-kidsstar`, dann einschalten.
4. Kindern die Familienrolle „Kind“ geben. In KidsStar Vorlagen und Belohnungen anlegen.

Ausführlich: **[docs/BETRIEB.md](docs/BETRIEB.md)** (Installation, Proxy, Aktivierung, Update, Deaktivierung, Flurtablet, Sicherung und Wiederherstellung).
Architektur und Abgrenzung zu Yuvomis eigenen Belohnungen: **[docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md)**. Tests und Einschränkungen: **[docs/TESTS.md](docs/TESTS.md)**.

Geprüft mit **Yuvomi 2.86.0**.

## Entwicklung

```sh
npm test                                        # 75 Tests, keine Abhängigkeiten
YUVOMI_DIR=~/src/yuvomi sh tools/e2e/run.sh     # Abnahmelauf gegen ein echtes Yuvomi
```

Lizenz: MIT
