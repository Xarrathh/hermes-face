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
ID="${HERMES_FACE_ID:-face-$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')}"
# Keep the identity this machine already had: changing the id mid-conversation makes the other face
# treat us as a stranger and re-greet from scratch. An explicit environment wins over the old unit.
if [ -f "$UNIT" ] && [ -z "${HERMES_FACE_NAME:-}" ] && [ -z "${HERMES_FACE_ID:-}" ]; then
  old_name="$(sed -n 's/.*--name \([^ ]*\).*/\1/p' "$UNIT" | head -1)"
  old_id="$(sed -n 's/.*--id \([^ ]*\).*/\1/p' "$UNIT" | head -1)"
  [ -n "$old_name" ] && NAME="$old_name"
  [ -n "$old_id" ] && ID="$old_id"
fi

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
systemctl --user enable face-peer.service >/dev/null 2>&1 || true
# restart, not enable --now: an already-running unit is not restarted by --now, and the point of
# running this script is to put the new code in front of the socket.
systemctl --user restart face-peer.service >/dev/null 2>&1 || true
sleep 1
say "peer: $(systemctl --user is-active face-peer.service 2>/dev/null || echo unknown)"

if [ ! -f "$PREFIX/peer.key" ]; then
  printf '%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)" > "$PREFIX/peer.key"
  chmod 600 "$PREFIX/peer.key"
  say "peer: created $PREFIX/peer.key — copy it to the other face"
fi

LAN="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"
IFACE="$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)"
ADDR="$(ip -4 -o addr show dev "${IFACE:-}" 2>/dev/null | awk '{print $4}' | head -1)"
# The rule must name the NETWORK, not the host address: 192.168.10.112/24 only works because nft
# happens to normalise it, and it reads as if one machine were the whole subnet.
SUBNET=""
if [ -n "${ADDR:-}" ]; then
  ip="${ADDR%%/*}"; bits="${ADDR##*/}"
  SUBNET="$(python3 - "$ip" "$bits" <<'PY' 2>/dev/null || true
import ipaddress, sys
print(ipaddress.ip_network(f"{sys.argv[1]}/{sys.argv[2]}", strict=False))
PY
)"
  [ -n "$SUBNET" ] || SUBNET="$ADDR"
fi
NUGGET="$PREFIX/peer-firewall.nft"
echo "peer id:      $ID"
echo "peer port:    tcp/$PEER_PORT   (beacon: udp/9910)"
echo "shared key:   $PREFIX/peer.key"
echo "lan subnet:   ${SUBNET:-unknown}"
echo
if [ -n "${SUBNET:-}" ]; then
  cat > "$NUGGET" <<EOF
# face-peer: let the LAN reach the face-to-face bridge, and nothing else.
# Applies to the running ruleset; re-apply after a reboot or include this file from your own
# nftables configuration if you want it persistent.
add rule inet filter input ip saddr $SUBNET tcp dport $PEER_PORT accept
add rule inet filter input ip saddr $SUBNET udp dport 9910 accept
EOF
  echo "Firewall rule written to $NUGGET (LAN only):"
  sed 's/^/  /' "$NUGGET" | grep -v '^  #'
  echo
fi

if [ "${1:-}" = "--firewall" ]; then
  if [ -z "${SUBNET:-}" ]; then
    echo "cannot work out the LAN subnet; add the rule by hand" >&2
    exit 1
  fi
  # Use whichever firewall is actually running: Omarchy machines commonly run ufw, where nft -f
  # against "inet filter" fails because the rules live in ufw's own tables.
  applied=0
  if command -v ufw >/dev/null 2>&1 && systemctl is-active --quiet ufw 2>/dev/null; then
    pkexec ufw allow from "$SUBNET" to any port "$PEER_PORT" proto tcp comment 'hermes face peer' >/dev/null 2>&1 && applied=1
    pkexec ufw allow from "$SUBNET" to any port 9910 proto udp comment 'hermes face beacon' >/dev/null 2>&1 || true
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then
    pkexec firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$SUBNET port port=$PEER_PORT protocol=tcp accept" >/dev/null 2>&1 && applied=1
    pkexec firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$SUBNET port port=9910 protocol=udp accept" >/dev/null 2>&1 || true
    pkexec firewall-cmd --reload >/dev/null 2>&1 || true
  elif pkexec nft -f "$NUGGET" 2>/dev/null; then
    applied=1
  fi
  if [ "$applied" = "1" ]; then
    date '+%F %T' > "$PREFIX/.firewall-applied"
    say "peer: firewall rules applied for $SUBNET"
    echo "applied."
  else
    echo "not applied: no supported firewall is running (ufw, firewalld, or an inet filter table)." >&2
    echo "the rule file is ready for when one is: $NUGGET" >&2
    echo "right now the peer port is reachable from the whole LAN, not just $SUBNET" >&2
    exit 1
  fi
fi
