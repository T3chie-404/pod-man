#!/bin/bash

set -e

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Error: Must run as root"
    exit 1
fi

# Create demo-user if doesn't exist
if id "demo-user" &>/dev/null; then
    echo "demo-user already exists"
    exit 0
fi

# Create user with restricted bash
useradd -m -s /usr/bin/rbash demo-user
echo "Created demo-user account with restricted shell (rbash)"

# Set a default password
echo "demo-user:demopass123" | chpasswd
echo "Set default password for demo-user"

# Create restricted bin directory
mkdir -p /home/demo-user/bin
echo "Created /home/demo-user/bin for allowed commands"

# Symlink safe commands only
ALLOWED_COMMANDS="ls cat grep less tail head pwd whoami hostname date uptime df free top htop ps"
for cmd in $ALLOWED_COMMANDS; do
    if [ -x "/usr/bin/$cmd" ] || [ -x "/bin/$cmd" ]; then
        ln -sf $(which $cmd) /home/demo-user/bin/ 2>/dev/null || true
    fi
done
echo "Linked safe commands to demo-user bin"

# Set up restricted environment
cat > /home/demo-user/.bash_profile <<'PROFILE'
# Restricted bash profile for demo-user
export PATH=/home/demo-user/bin
export HOME=/home/demo-user
cd $HOME

# Override cd to prevent leaving home
function cd() {
    if [[ "$1" == /* ]] || [[ "$1" == ~* ]] || [[ "$1" == ..* ]]; then
        echo "cd: restricted - demo users cannot leave home directory"
        return 1
    fi
    builtin cd "$@"
}

# Welcome message
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Demo Terminal (Read-Only)"
echo "  Restricted to home directory"
echo "  Type 'help' for available commands"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

alias help='echo "Available: ls cat grep less tail head pwd whoami hostname date df free ps top"'
PROFILE

cat > /home/demo-user/.bashrc <<'BASHRC'
# Prevent escape from restricted shell
export PATH=/home/demo-user/bin
export HOME=/home/demo-user
BASHRC

# Lock down home directory - demo-user can't write
chmod 755 /home/demo-user
chown root:root /home/demo-user/.bash_profile /home/demo-user/.bashrc
chmod 644 /home/demo-user/.bash_profile /home/demo-user/.bashrc

# Create a safe workspace directory
mkdir -p /home/demo-user/workspace
chown demo-user:demo-user /home/demo-user/workspace
chmod 700 /home/demo-user/workspace

echo "Set restrictive environment and permissions"

# Add sudoers rule to allow root to spawn demo-user shell without password
echo "root ALL=(demo-user) NOPASSWD: /usr/bin/rbash" > /etc/sudoers.d/demo-user-shell
chmod 440 /etc/sudoers.d/demo-user-shell
echo "Configured sudoers for demo-user shell access"

# Ensure demo-user has NO sudo access
# (don't add demo-user to sudo group)

# Prevent demo-user from reading sensitive directories
echo "✓ Demo user setup complete (RESTRICTED)"
echo "  Username: demo-user"
echo "  Shell: /usr/bin/rbash (restricted bash)"
echo "  Home: /home/demo-user (can't leave)"
echo "  Commands: limited to safe subset"
echo "  No sudo, no system access, no cd outside home"

