# KidsStar – Installation und Betrieb

Geprüft mit **Yuvomi 2.86.0** (offizielles Release, Commit `9ae0bdc`) und Node 26 lokal. CI testet Node 22 und 24; das Container-Image nutzt Node 24.

> **Wichtig:** Yuvomis Modulinstallation (Einstellungen → Module → Eigenes Modul hinzufügen) kopiert nur den Ordner `module/`. Den KidsStar-**Dienst** (Sidecar) stellt sie **nicht** bereit. Ohne den Dienst zeigt die Seite „KidsStar-Dienst nicht erreichbar“. Beide Teile gehören zusammen.

## 1. Dienst starten

### Unraid
Vorlage `deploy/unraid/kidsstar.xml` (Docker → Add Container → Template URL `https://raw.githubusercontent.com/FlessingLabs/yuvomi-kidsstar/main/deploy/unraid/kidsstar.xml`).

* **Yuvomi URL:** wie der Container Yuvomi erreicht, z. B. `http://192.168.1.10:3000`.
* **Data:** `/mnt/user/appdata/kidsstar` – in die Sicherung aufnehmen.
* **Pass other paths to Yuvomi:** `true`, wenn Yuvomi danach über den Port dieses Containers geöffnet wird (Betriebsart A). `false`, wenn ein eigener Proxy (z. B. Nginx Proxy Manager) davor steht (Betriebsart B, Abschnitt 2).

### Docker Compose
`deploy/docker-compose.yml`. Für den Tablet-Modus das API-Token als Datei `deploy/secrets/kidsstar_api_token` ablegen; ohne Tablet eine leere Datei anlegen (`touch deploy/secrets/kidsstar_api_token`).

```sh
cd deploy && mkdir -p secrets && touch secrets/kidsstar_api_token
YUVOMI_URL=http://yuvomi:3000 docker compose up -d
curl http://localhost:8089/api/extensions/kidsstar/health   # {"data":{"ok":true,...}}
```

### Ohne Container
Node ≥ 22.13: `PORT=8089 DATA_DIR=/var/lib/kidsstar YUVOMI_URL=http://127.0.0.1:3000 node sidecar/src/main.js`

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `YUVOMI_URL` | `http://yuvomi:3000` | interne Adresse von Yuvomi |
| `DATA_DIR` | `/data` | Datenbank und Bilder |
| `PROXY_YUVOMI` | `true` | `false` = nur `/api/extensions/kidsstar/` bedienen (Betriebsart B) |
| `PUBLIC_ORIGIN` | leer | feste öffentliche Adresse(n) für die Origin-Prüfung, kommagetrennt |
| `YUVOMI_API_TOKEN` / `YUVOMI_API_TOKEN_FILE` | leer | API-Token für das Flurtablet (Abschnitt 5) |
| `TZ` | `Europe/Berlin` | Rückfall-Zeitzone, bis eine Elternsitzung Yuvomis Haushaltszeitzone geliefert hat |
| `AUTH_CACHE_MS` | `5000` | Cache für `/auth/me` je Sitzung |
| `YUVOMI_SESSION_COOKIE` | `yuvomi.sid` | Name von Yuvomis Session-Cookie |

## 2. Gemeinsame Origin (Reverse-Proxy)

Browser, Yuvomi und Dienst müssen **eine** Adresse teilen, damit das Yuvomi-Session-Cookie beim Dienst ankommt.

* **Betriebsart A:** Yuvomi über den Port des KidsStar-Containers öffnen (z. B. `http://server:8089`). Nichts weiter zu tun.
* **Betriebsart B:** Proxy-Beispiele in `deploy/proxy/` – `Caddyfile`, `nginx.conf`, `traefik-labels.yml`, `nginx-proxy-manager.md`. Immer nur `/api/extensions/kidsstar/` an den Dienst. Bei Nginx Proxy Manager „Cache Assets“ ausgeschaltet lassen.
* **Zwei Erweiterungen mit eigenem Eingang** (z. B. QuickShop 1.1 und KidsStar): nur einer darf der Eingang sein. Den anderen mit `PROXY_YUVOMI=false` hinter den Proxy stellen, oder die Eingänge verketten (`YUVOMI_URL` von KidsStar zeigt auf den QuickShop-Container).

Prüfen: `https://<yuvomi-adresse>/api/extensions/kidsstar/health` liefert JSON mit `"ok":true`.

## 3. Modul installieren und aktivieren

1. Yuvomi-Betreiber: `MODULES_ALLOW_WEB_INSTALL=true` (sonst Ordner `module/` von Hand nach `<modules>/kidsstar` kopieren).
2. Als Admin: **Einstellungen → Module → Eigenes Modul hinzufügen** → `FlessingLabs/yuvomi-kidsstar` (installiert das neueste Release, Ordner `module/`).
3. **Einstellungen → Module → Aktive Module** → KidsStar prüfen und einschalten. Ein per Web installiertes Modul startet ausgeschaltet; ein von Hand kopierter Ordner startet eingeschaltet.
4. **Familie:** Kinder brauchen die Familienrolle **Kind**, Eltern **Vater/Mutter/Elternteil** (oder Adminrecht). Familienrollen setzt ein Admin unter Einstellungen → Familie.
5. **Rechte** (optional): Einstellungen → Haushalt → Rollen & Rechte → „KidsStar“: `write` (Standard), `read` (nur ansehen), `none`.
6. **Kachel:** Übersicht → Kacheln bearbeiten → „Sterne“.
7. **Einstellungen → Module → KidsStar** (nur Admins): Eltern ohne Adminrecht, Bestätigungs-Vorgabe, Wünsche.
8. In KidsStar → **Aktionen → Vorlagen anlegen** und → **Shop → Neue Belohnung**.

## 4. Update, Deaktivierung, Entfernen

* **Update Modul:** erneut aus GitHub installieren. Yuvomi fragt nach dem Ersetzen; ein ersetztes Modul ist danach **ausgeschaltet** und muss wieder eingeschaltet werden (MODULES.md).
* **Update Dienst:** neues Image ziehen und den Container neu starten. Migrationen laufen beim Start automatisch und einzeln in einer Transaktion. **Vorher sichern** (Abschnitt 6). Eine Datenbank einer *neueren* Version lehnt ein älterer Dienst ab, statt sie zu beschädigen. Modul- und Dienstversion zusammen aktualisieren.
* **Deaktivieren:** In Yuvomi ausschalten. Ab dann antwortet der Dienst allen Sitzungen mit `403 module_forbidden` (spätestens nach `AUTH_CACHE_MS`, Standard 5 s) und sperrt das Tablet (spätestens nach 5 s). Die Daten bleiben erhalten.
* **Entfernen:** Modul in Yuvomi löschen, Container stoppen und entfernen. Das Datenverzeichnis enthält dann noch alle Sterne; löschen nur, wenn sie nicht mehr gebraucht werden. Das API-Token in Yuvomi widerrufen.

## 5. Flurtablet einrichten

1. **API-Token (einmalig, Admin):** Yuvomi → Einstellungen → Haushalt → API-Zugang → neues Token, Name „KidsStar-Dienst“, Scopes **genau** `ext:kidsstar:read` und `family:read`. In die Umgebung des Dienstes (`YUVOMI_API_TOKEN` bzw. die Secret-Datei), Dienst neu starten. KidsStar → Reiter *Tablet* zeigt, ob der Tablet-Modus bereit ist.
   * Wofür: Am Tablet ist niemand angemeldet. Mit dem Token prüft der Dienst, welche Mitglieder Kinder sind und ob KidsStar eingeschaltet ist. Das Token kann nichts schreiben.
2. **Bildkacheln:** KidsStar → Tablet → je Kind ein Foto/Motiv hochladen (wird verkleinert, nur lokal gespeichert) **oder** Symbol und Farbe wählen. Austauschen und Entfernen ebenda.
3. **Optional Bildcode:** je Kind vier aus neun Tiersymbolen. **Ohne Bildcode kann jede Person am Tablet jedes dort freigegebene Profil öffnen.** Nach fünf Fehlversuchen ist das Profil auf diesem Tablet fünf Minuten gesperrt.
4. **Tablet koppeln:** *Tablet koppeln* → Name, freigegebene Kinder, Rücksprung nach Leerlauf (Sekunden). Den angezeigten Code auf dem Tablet unter `https://<yuvomi-adresse>/api/extensions/kidsstar/tablet/` eingeben (15 Minuten gültig, einmalig). Tipp: die Seite auf dem Tablet zum Startbildschirm hinzufügen.
5. **Ändern / Widerrufen:** Freigaben und Leerlaufzeit über *Bearbeiten*; *Neu koppeln* erzeugt einen neuen Code (die alte Kopplung endet beim Einlösen); *Kopplung widerrufen* sperrt das Tablet sofort.

Bedienung am Tablet: Kachel antippen → „Heute“ des Kindes. Oben rechts 🔄 wechselt das Profil und beendet die Kindersitzung; nach der eingestellten Leerlaufzeit springt das Tablet von selbst zur Auswahl zurück.

## 6. Sicherung und Wiederherstellung

Alle KidsStar-Daten liegen im Datenverzeichnis: `kidsstar.db` (SQLite, WAL), `images/` (Belohnungen), `profile-images/` (Kacheln). Mitglieder, Anmeldung und Rechte gehören zu Yuvomi und dessen eigener Sicherung.

**Sichern im laufenden Betrieb** (konsistente Kopie per `VACUUM INTO`):

```sh
docker exec -u node kidsstar node src/backup.js backup            # → /data/backups/kidsstar-<Zeit>/
docker exec -u node kidsstar node src/backup.js backup /data/backups/vor-update
```

Oder Container stoppen und das ganze Datenverzeichnis kopieren (z. B. Unraid-Appdata-Backup). Bei laufendem Container nie nur `kidsstar.db` ohne `-wal` kopieren.

**Wiederherstellen** (Dienst gestoppt):

```sh
docker stop kidsstar
docker run --rm -v kidsstar-data:/data -v /pfad/zur/sicherung:/restore ghcr.io/flessinglabs/yuvomi-kidsstar \
  node src/backup.js restore /restore
docker start kidsstar
```

Die Wiederherstellung prüft die Sicherung (`integrity_check`), legt den bisherigen Stand als `*.before-restore-<Zeit>` beiseite und führt fehlende Migrationen aus. Gekoppelte Tablets und Kindersitzungen gehören zum Stand der Sicherung; nach einer Wiederherstellung ggf. neu koppeln.

## 7. Fehlerbilder

| Anzeige | Ursache |
|---|---|
| „KidsStar-Dienst nicht erreichbar“ | Dienst aus, oder `/api/extensions/kidsstar/` landet nicht beim Dienst (Proxy) |
| „Kein Zugriff auf KidsStar“ | Modul in Yuvomi aus oder Recht `none` |
| Hinweis „KidsStar ist für Kinder und Eltern“ | Familienrolle weder Kind noch Elternteil |
| Tablet „noch nicht eingerichtet“ | `YUVOMI_API_TOKEN` fehlt oder hat nicht beide Scopes |
| `403 origin_mismatch` beim Speichern | Proxy setzt `X-Forwarded-Host`/`-Proto` nicht → `PUBLIC_ORIGIN` setzen |
| Viele `429` in Yuvomi | Proxy reicht `X-Forwarded-For` nicht weiter; Yuvomi braucht `TRUST_PROXY` |
