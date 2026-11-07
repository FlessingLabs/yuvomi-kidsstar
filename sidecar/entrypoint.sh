#!/bin/sh
# Wie Yuvomis entrypoint.sh: als root gestartet (Docker, Unraid) das Datenverzeichnis
# dem node-User geben und dann mit setpriv die Rechte abgeben. Unraid legt
# appdata-Pfade als root bzw. nobody an; ohne das koennte der Dienst seine
# Datenbank nicht schreiben. Als Nicht-root gestartet (z. B. --user) direkt starten.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}"
  HOME=$(getent passwd node | cut -d: -f6)
  export HOME
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
