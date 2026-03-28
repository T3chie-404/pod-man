#!/bin/bash

set -e

if [ "$EUID" -ne 0 ]; then
    echo "Error: Must run as root"
    exit 1
fi

if id "standard-user" &>/dev/null; then
    echo "standard-user already exists"
    exit 0
fi

useradd -m -s /usr/bin/rbash standard-user
echo "Created standard-user account with restricted shell (rbash)"

mkdir -p /home/standard-user/bin
mkdir -p /home/standard-user/workspace

ALLOWED_COMMANDS="ls cat grep less tail head pwd whoami hostname date uptime df free top htop ps env printenv id uname journalctl systemctl curl ss ip"
for cmd in $ALLOWED_COMMANDS; do
    if command -v "$cmd" >/dev/null 2>&1; then
        ln -sf "$(command -v "$cmd")" /home/standard-user/bin/ 2>/dev/null || true
    fi
done
echo "Linked diagnostic commands to standard-user bin"

cat > /home/standard-user/.bash_profile <<'PROFILE'
export PATH=/home/standard-user/bin
export HOME=/home/standard-user
cd "$HOME"

function cd() {
    if [[ "$1" == /* ]] || [[ "$1" == ~* ]] || [[ "$1" == ..* ]]; then
        echo "cd: restricted - standard users cannot leave home directory"
        return 1
    fi
    builtin cd "$@"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Standard Terminal (Restricted)"
echo "  Non-root diagnostic shell"
echo "  Type 'help' for available commands"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

alias help='echo "Available: ls cat grep less tail head pwd whoami hostname date uptime df free top ps env id uname journalctl systemctl curl ss ip"'
PROFILE

cat > /home/standard-user/.bashrc <<'BASHRC'
export PATH=/home/standard-user/bin
export HOME=/home/standard-user
BASHRC

chown root:root /home/standard-user/.bash_profile /home/standard-user/.bashrc
chmod 644 /home/standard-user/.bash_profile /home/standard-user/.bashrc
chown -R standard-user:standard-user /home/standard-user/workspace /home/standard-user/bin
chmod 755 /home/standard-user
chmod 700 /home/standard-user/workspace

echo "✓ Standard user setup complete (RESTRICTED)"
echo "  Username: standard-user"
echo "  Shell: /usr/bin/rbash (restricted bash)"
echo "  Home: /home/standard-user"
echo "  Commands: limited diagnostic subset"
echo "  No sudo, no root shell access"
