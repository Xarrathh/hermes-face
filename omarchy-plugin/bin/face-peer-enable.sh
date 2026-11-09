#!/usr/bin/env bash
# Turn the face-to-face peer bridge on, and keep the network side honest.
#
# Opt-in: a LAN listener is a decision, not a default. This script is what the installer and the
# user run to say yes to it, and it is the only thing that opens the port.
#
# What it does:
#   * copies peer.py beside the bridge and writes face-peer.service for this host's own name;
#   * creates the shared peer key (0600) if it does not exist yet — copy that file to the other
#     face so the two agree;
#   * prints the firewall rule you need, and applies it only when you pass --firewall.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
PEER_PORT="${HERMES_FACE_PEER_PORT:-9910}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/.cache/hermes-face-bar.log"
UNIT="$HOME/.config/systemd/user/face-peer.service"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
PY="$PREFIX/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

NAME="${HERMES_FACE_NAME:-$(hostname -s)}"
ID="face-$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')"

mkdir -p "$PREFIX" || exit 1
install -Dm755 "$PLUGIN_DIR/face/peer.py" "$PREFIX/peer.py" || { say "peer: cannot install peer.py"; exit 1; }
say "peer: installed peer.py as $ID"

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=face-peer — LAN presence and turn-taking for hermes-face
After=hermes-face.service

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=$PY $PREFIX/peer.py --name $NAME --id $ID --port $PEER_PORT \\
  --face-url http://127.0.0.1:$PORT --token-file $PREFIX/token --key-file $PREFIX/peer.key --relay
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload >/dev/null 2>&1 || true
systemctl --user enable --now face-peer.service >/dev/null 2>&1 || true
sleep 1
say "peer: $(systemctl --user is-active face-peer.service 2>/dev/null || echo unknown)"

if [ ! -f "$PREFIX/peer.key" ]; then
  printf '%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)" > "$PREFIX/peer.key"
  chmod 600 "$PREFIX/peer.key"
  say "peer: created $PREFIX/peer.key — copy it to the other face"
fi

LAN="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"
IFACE="$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)"
SUBNET="$(ip -4 -o addr show dev "${IFACE:-}" 2>/dev/null | awk '{print $4}' | head -1)"
echo "peer id:      $ID"
echo "peer port:    tcp/$PEER_PORT   (beacon: udp/9910)"
echo "shared key:   $PREFIX/peer.key"
echo "lan subnet:   ${SUBNET:-unknown}"
echo
echo "Firewall rule for the LAN only (nftables):"
echo "  nft add rule inet filter input ip saddr ${SUBNET:-<lan-cidr>} tcp dport $PEER_PORT accept"
echo "  nft add rule inet filter input ip saddr ${SUBNET:-<lan-cidr>} udp dport 9910 accept"
echo
if [ "${1:-}" = "--firewall" ]; then
  if [ -z "${SUBNET:-}" ]; then
    echo "cannot work out the LAN subnet; add the rule by hand" >&2
    exit 1
  fi
  pkexec nft add rule inet filter input ip saddr "$SUBNET" tcp dport "$PEER_PORT" accept 2>/dev/null \
    || echo "could not apply the rule (no nft table, or approval dismissed); add it by hand" >&2
  pkexec nft add rule inet filter input ip saddr "$SUBNET" udp dport 9910 accept 2>/dev/null || true
  say "peer: firewall rules attempted for $SUBNET"
fi
