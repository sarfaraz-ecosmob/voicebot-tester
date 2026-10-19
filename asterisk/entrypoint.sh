#!/usr/bin/env bash
# Voicebot Testing - Asterisk container wrapper.
# 1. Renders the checked-in *.conf templates into /etc/asterisk
#    (substituting ASTERISK_EXTERNAL_MEDIA_ADDRESS).
# 2. Generates a self-signed certificate for wss:// on first start (openssl).
# 3. Hands over to the image's original entrypoint, which applies PUID/PGID
#    and execs Asterisk with the container CMD.
set -euo pipefail
umask 022  # recordings must be readable by the api container (uid 10001)

CONF_SRC="/opt/voicebot/conf"
CERT_DIR="/etc/asterisk/certs"
EXTERNAL_MEDIA_ADDRESS="${ASTERISK_EXTERNAL_MEDIA_ADDRESS:-127.0.0.1}"

mkdir -p /etc/asterisk "$CERT_DIR" /var/lib/asterisk/monitor
# The image entrypoint only chowns /var/lib/asterisk when the top dir itself is
# misowned, so a freshly mounted (root-owned) monitor volume would stay
# unwritable for the asterisk user. Fix it explicitly.
chown asterisk:asterisk /var/lib/asterisk/monitor 2>/dev/null || true

# --- 1. Render configuration templates --------------------------------------
for src in "$CONF_SRC"/*.conf; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  if [ -n "$EXTERNAL_MEDIA_ADDRESS" ]; then
    sed "s|__ASTERISK_EXTERNAL_MEDIA_ADDRESS__|${EXTERNAL_MEDIA_ADDRESS}|g" "$src" > "/etc/asterisk/$name"
  else
    # Empty value: drop the option lines entirely (Asterisk uses the
    # container's own IP in that case).
    grep -v "__ASTERISK_EXTERNAL_MEDIA_ADDRESS__" "$src" > "/etc/asterisk/$name" || true
  fi
done

# --- 2. Self-signed certificate for wss:// (optional transport) -------------
if [ ! -f "$CERT_DIR/asterisk.crt" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
      -keyout "$CERT_DIR/asterisk.key" \
      -out "$CERT_DIR/asterisk.crt" \
      -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 || true
  fi
fi
if [ -f "$CERT_DIR/asterisk.crt" ]; then
  chown asterisk:asterisk "$CERT_DIR" "$CERT_DIR"/* 2>/dev/null || true
  chmod 600 "$CERT_DIR"/*.key 2>/dev/null || true
else
  echo "[voicebot] WARNING: TLS cert missing -> wss:// unavailable; ws:// still works" >&2
fi

# --- 3. Original image entrypoint (PUID/PGID handling + exec asterisk) ------
# compose can clear the image CMD when the entrypoint is overridden; fall back
# to the image's default command so Asterisk always starts.
if [ "$#" -eq 0 ]; then
  set -- /usr/sbin/asterisk -vvvdddf -T -W -U asterisk -p
fi
exec /usr/local/bin/entrypoint.sh "$@"
