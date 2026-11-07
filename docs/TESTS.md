# KidsStar – Tests und Abnahme

Stand 7. November 2026, Version 1.0.0, geprüft gegen **Yuvomi 2.86.0** (Commit `9ae0bdc`, offizielles Release ohne Änderungen).

## Automatische Tests (`npm test`)

75 Tests, alle grün (Node 26 lokal; in CI Node 22 und 24).

| Datei | Prüft |
|---|---|
| `sidecar/test/service.test.js` (31) | Fachlogik direkt auf SQLite: Gutschrift ohne/mit Bestätigung, Ablehnung ohne Sterne, gleiche Anfrage zweimal, Mehrfachklick, belegter Platz bei parallelem Gerät, Wochentage und Tageswechsel, Haushaltszeitzone an der Mitternachtsgrenze (Berlin/UTC/Kiritimati), einmalige Aktionen, Pausieren, Wertänderung nach Meldung, Kinder ohne Elternrechte, fremde Kinderdaten, Rolle „andere“, Leserecht, Rollenregel, Bonus, Korrektur/Gegenbuchung nie unter 0, unveränderliches Journal, Einlösung mit genug/zu wenig Guthaben, parallele Einlösungen, Wiederholung ohne Doppelbuchung, Freigabe der Reservierung bei Ablehnung/Rückzug, Rücknahme, Preisänderung nach Anfrage, Belohnung je Kind, Verfügbarkeit, Wunsch → Shop → Sparziel („24 von 40, fehlen 16“), Ablehnung mit Rückmeldung, Eingabeprüfung |
| `sidecar/test/server.test.js` (14) | HTTP mit nachgebautem Yuvomi: ohne Sitzung 401, **abgeschaltetes Modul (kein `ext:kidsstar`) und Recht `none` → 403**, Rollen aus `/auth/me`, CSRF- und Origin-Pflicht, Benutzer-Id im Körper wird ignoriert, Leserecht, fremde Daten, **12 parallele Meldungen → genau 2 gutgeschrieben**, **5 parallele Einlösungen → nie überzogen**, gleiche Anfrage-Id 5× parallel → eine Anfrage, Bilder (kein SVG, Sicht nach Freigabe, Pfad-Traversal), Größen-/Typgrenzen, **Yuvomi nicht erreichbar → 502**, Cache für `/auth/me` |
| `sidecar/test/tablet.test.js` (19) | Seite ohne Yuvomi-Sitzung mit eigener CSP, **Kopplung** (falscher, abgelaufener, zweimal benutzter Code), nur Eltern verwalten, **nur freigegebene Profile**, Kind am Tablet ohne Elternrechte und ohne Yuvomi-Sitzung, **Profilwechsel: altes Cookie ungültig, keine Daten des vorherigen Kindes**, neues Profil beendet das alte, Sitzung gilt nur auf ihrem Tablet, **Leerlauf-Timeout serverseitig**, **Bildcode** (fehlt, falsch, Sperre nach 5 Fehlversuchen auch für den richtigen Code, Entsperren nach 5 Minuten, Entfernen), Freigabe entziehen beendet Sitzung, Kind ist in Yuvomi kein Kind mehr, **Widerruf**, Neukoppeln, **KidsStar in Yuvomi aus → Tablet gesperrt**, ohne Token kein Tablet-Modus, **Profilbild hochladen/austauschen/entfernen** (alte Datei gelöscht, nur Eltern und gekoppelte Tablets mit Freigabe), CSRF/Origin, Kopplungsbremse |
| `test/module/lib.test.js` (7) | Wochentags-Bitmaske, Fortschritt, Vorlagen, Bildcode-Symbole identisch in Modul und Tablet, Bildverkleinerung, Client: CSRF-Erneuerung, Fehlergründe, „Dienst nicht erreichbar“ |
| `test/module/static.test.js` (4) | Manifest nach MODULES.md (Felder, Dateien, `api.prefix`, Widget), nur Dateitypen, die Yuvomis Installer kopiert, **Deutsch und Englisch vollständig** (gleiche Schlüssel, gleiche Platzhalter, jeder verwendete Schlüssel vorhanden), **kein `innerHTML`/`eval`/externe Skripte** in Modul und Tablet-Seite |

## Abnahmelauf gegen ein echtes Yuvomi (`tools/e2e/`)

Yuvomi 2.86.0 aus dem Quellstand gestartet (`node server/index.js`, eigene Datenbank, Modulordner mit KidsStar), KidsStar-Dienst davor als Eingang (Betriebsart A). Skript `tools/e2e/e2e.mjs`, Ablauf in `tools/e2e/run.sh`.

| Phase | Ergebnis |
|---|---|
| `setup` | Ersteinrichtung, Mitglieder Ian und Mia (Kind), Papa (Vater, kein Admin), Oma (Großeltern); **Modul geladen, Status `enabled`, kein Fehler**; API-Token mit `ext:kidsstar:read` + `family:read` angelegt |
| `flow` | Navigation „Kinder & Sterne“ mit Symbol, **Widget `kidsstar:stars` registriert**, Moduldateien über Yuvomis Asset-Route; Rollen (Mama Admin → Eltern, Papa → Eltern, Ian → Kind, Oma → andere); Aktion ohne Bestätigung, Doppelanfrage, **8 parallele Meldungen → 1**; mit Bestätigung: wartet, Kind darf nicht freigeben, Ablehnung = 0 Sterne, Papa genehmigt = +5; fremde Kinderdaten 404/403; Wunsch → Preis 40 → Sparziel „Du hast 24 von 40 Sternen. Es fehlen noch 16.“; zu wenig Guthaben; **parallele Einlösungen 10 + 20 bei 24 Sternen → eine**; Ablehnung gibt frei; Preisänderung nach Anfrage → Anfrage behält 10 Sterne und alten Titel; veralteter Preis → `price_changed`; genehmigt, übergeben; Bild nur für Berechtigte; Gegenbuchung, die unter 0 führen würde, abgelehnt; Korrektur; Widget-Daten; **Tablet**: Kopplung, Profilbild, Bildcode falsch/richtig, keine Yuvomi-Sitzung am Tablet, Wechsel ohne Daten des vorherigen Kindes |
| `disable` | **KidsStar in Yuvomi ausgeschaltet → Dienst 403 für Kind und Eltern, Tablet 403, Moduldateien 404**; wieder eingeschaltet → 200; **widerrufenes Tablet → `device_unpaired`** |
| `persist` | **Dienst neu gestartet → Stand unverändert (10 Sterne, 2 Aktionen)** |
| Sicherung | `backup.js backup` im laufenden Betrieb (DB + 2 Bilder), danach +7 gebucht (17), Dienst gestoppt, `restore`, gestartet → **wieder 10**; alter Stand als `*.before-restore-*` beiseitegelegt |

Dabei gefunden und behoben: Ein Token mit Scopes erreicht `/api/v1/auth/me` nicht (Yuvomi sperrt `/auth` dafür). Die Prüfung „Modul an?“ fürs Tablet wurde deshalb auf Yuvomis Scope-Prüfung umgestellt (siehe ARCHITEKTUR.md); der nachgebaute Yuvomi der Unit-Tests verhält sich jetzt ebenso.

## Im Browser geprüft (Chrome, Yuvomi 2.86.0 lokal)

* Elternansicht im **Dunkelmodus**: Übersicht (Kinderkarten, Posteingang), Aktionen (Liste, Dialog mit Vorlagen, Symbolen, Wochentagen, Kinderwahl, Esc schließt), Tablet-Reiter (Adresse, Kopplung, Kopplungscode-Dialog, Bildkacheln). Keine Konsolenfehler.
* Kinderansicht im **Hellmodus**: Heute, Stand, Ablehnung mit Rückmeldung, „Zuletzt erhalten“, Sparziel.
* **Mobil (390 px):** Reiter als Symbole, Shop zweispaltig, kein waagerechtes Überlaufen, Yuvomis mobile Navigation unverändert.
* **Tablet-Seite:** Kopplung über das Formular, „Wer bist du?“ mit Bild- und Symbolkachel, Tipp → „Heute“, Shop mit „Du hast 10 von 20 Sternen. Es fehlen noch 10.“, 🔄 Profilwechsel, **Bildcode-Eingabe ohne Text**, Erledigung mit „⭐ +2“, **automatischer Rücksprung nach 30 s Leerlauf** (Server: Sitzung beendet).
* Dienst nicht erreichbar → „KidsStar-Dienst nicht erreichbar … Deine Sterne sind sicher gespeichert“ mit „Erneut versuchen“.
* Dashboard-Kachel als Kind („⭐ 10 · Heute ist alles erledigt · 🎯 Lego Feuerwehr 10/40“), direkt über die Asset-Route geladen.

Dabei gefunden und behoben: Die Kopplung über das Tablet-Formular scheiterte, weil der Client vor dem POST ein CSRF-Token holen wollte, das es vor der Kopplung nicht gibt. Nach einem Neuladen der Tablet-Seite blieb eine Kindersitzung bis zum Leerlauf offen; sie wird jetzt beendet. Yuvomis JSON-404 bei fehlendem Dienst wurde als allgemeiner Fehler statt „nicht erreichbar“ gezeigt.

## Nicht geprüft / Einschränkungen

* **Container-Image nicht lokal gebaut** (kein Docker auf dem Entwicklungsrechner). Die CI baut es und startet es einmal mit `/health` und `/tablet/`. `docker exec … backup.js` und die Wiederherstellung per `docker run` sind nur mit Node direkt geprüft.
* **Reverse-Proxy-Beispiele** (Caddy, nginx, Traefik, Nginx Proxy Manager) sind nicht gegen laufende Proxys getestet; geprüft ist Betriebsart A.
* **Installation aus GitHub über Yuvomis Web-Installer** ist erst nach dem Veröffentlichen eines Releases prüfbar; geprüft ist das Laden aus dem Modulordner.
* **Echte Geräte** (iPad, Android-Tablet) und Screenreader nicht geprüft; Hell/Dunkel und 390 px im Desktop-Chrome.
* **„Modul an?“ fürs Tablet** beruht auf Yuvomis Scope-Prüfung für `/api/v1/extensions/<id>/` (404 = an, 403 = aus), nicht auf einem dafür dokumentierten Endpunkt. Ändert eine spätere Yuvomi-Version das, schließt der Tablet-Modus (jede andere Antwort = gesperrt), statt zu öffnen. Ein Kind mit Yuvomi-Recht `ext:kidsstar = none` kann am Tablet trotzdem geöffnet werden, wenn Eltern es für das Tablet freigeben: Die Rechte einzelner Kinder sind mit dem Token nicht lesbar. Die Tablet-Freigabe ist die Entscheidung dafür.
* **Ein Dienst je Datenbank.** Zwei Prozesse auf derselben Datei sind durch `BEGIN IMMEDIATE` und eindeutige Indizes abgesichert, aber nicht vorgesehen; der Pairing-Bremszähler liegt im Speicher.
* **Keine Verbindung zu Yuvomi-Aufgaben** (siehe ARCHITEKTUR.md).
* Wall-Displays von Yuvomi sehen KidsStar nicht (Displays bekommen nur Kernmodule); dafür ist das Flurtablet da.
* Deaktivierte Yuvomi-Konten: Ihre Sterne bleiben im Journal, das Kind verschwindet aus Listen und Tablet.
