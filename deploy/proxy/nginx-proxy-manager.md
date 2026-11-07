# Nginx Proxy Manager

Für Haushalte, deren Yuvomi schon hinter Nginx Proxy Manager (NPM) läuft (Betriebsart B, KidsStar mit `PROXY_YUVOMI=false`):

1. Den bestehenden Proxy-Host von Yuvomi öffnen → Reiter **Custom locations** → **Add location**.
2. Location: `/api/extensions/kidsstar/`, Scheme `http`, Forward Hostname/IP: Adresse des KidsStar-Containers (z. B. `192.168.1.10`), Forward Port: der veröffentlichte Port (z. B. `8089`).
3. Im Zahnrad der Location eintragen:
   ```
   proxy_set_header X-Forwarded-Host $host;
   proxy_set_header X-Forwarded-Proto $scheme;
   client_max_body_size 4m;
   add_header Cache-Control "no-store" always;
   ```
4. Speichern. **„Cache Assets“ ausgeschaltet lassen**: sonst liefert NPM alte Moduldateien aus.

Prüfen: `https://<yuvomi-adresse>/api/extensions/kidsstar/health` muss `{"data":{"ok":true,...}}` zeigen.
