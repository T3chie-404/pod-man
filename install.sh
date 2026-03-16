#!/bin/bash

set -euo pipefail

RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
NC="\033[0m"

DEFAULT_INSTALL_DIR="/root/pod-man"
DEFAULT_LOCAL_PORT="7000"
DEFAULT_CENTRAL_PORT="7000"
DEFAULT_HTTPS_PORT="443"

INSTALL_DIR="$DEFAULT_INSTALL_DIR"
SKIP_CLONE=false
CENTRAL_MODE=false
HTTPS_ENABLED=false
HTTPS_MODE=""
SERVER_NAME=""
LOCAL_PORT="$DEFAULT_LOCAL_PORT"
CENTRAL_URL=""
CENTRAL_SSH_HOST=""
SSH_KNOWN_HOSTS_PATH="/root/.ssh/pod-manager-central-known_hosts"
API_KEY=""
UPDATE_CHOICE=""
SERVICE_STARTED_AT=""

print_banner() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Xandeum Pod Manager - Installer v2${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_step() {
    local title="$1"
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  ${title}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

die() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

info() {
    echo -e "${GREEN}✓${NC} $1"
}

warn() {
    echo -e "${YELLOW}!${NC} $1"
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-N}"
    local answer
    read -r -p "${prompt} " answer
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy]$ ]]
}

prompt_secret() {
    local prompt="$1"
    local secret=""
    read -r -s -p "$prompt" secret
    printf '\n'

    if [ -n "$secret" ]; then
        echo "  [hidden input received: ${#secret} characters]"
    fi

    REPLY="$secret"
}

require_root() {
    if [ "$EUID" -ne 0 ]; then
        die "Please run as root: sudo bash install.sh"
    fi
}

detect_install_dir() {
    local current_dir
    current_dir="$(pwd)"

    if [ -f "./package.json" ] && [ -f "./server.js" ] && [ -f "./config.json.example" ]; then
        INSTALL_DIR="$current_dir"
        SKIP_CLONE=true
        info "Running installer from pod-man directory: $INSTALL_DIR"
    else
        INSTALL_DIR="$DEFAULT_INSTALL_DIR"
        SKIP_CLONE=false
    fi
}

ensure_dependencies() {
    print_step "Step 1: Checking Dependencies"

    if ! command -v node >/dev/null 2>&1; then
        warn "Node.js not found, installing..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
        info "Node.js installed"
    else
        info "Node.js $(node --version)"
    fi

    if ! command -v npm >/dev/null 2>&1; then
        warn "npm not found, installing..."
        apt-get install -y npm
        info "npm installed"
    else
        info "npm $(npm --version)"
    fi

    if ! command -v git >/dev/null 2>&1; then
        warn "git not found, installing..."
        apt-get update
        apt-get install -y git
        info "git installed"
    else
        info "git installed"
    fi

    if ! command -v curl >/dev/null 2>&1; then
        warn "curl not found, installing..."
        apt-get update
        apt-get install -y curl
        info "curl installed"
    fi

    if ! command -v ssh-keyscan >/dev/null 2>&1; then
        warn "ssh-keyscan not found, installing OpenSSH client..."
        apt-get update
        apt-get install -y openssh-client
        info "OpenSSH client installed"
    fi
}

checkout_repo() {
    print_step "Step 2: Getting Pod Manager"

    if [ "$SKIP_CLONE" = true ]; then
        info "Using current directory: $INSTALL_DIR"
    elif [ -d "$INSTALL_DIR/.git" ]; then
        echo "Directory already exists at $INSTALL_DIR"
        echo ""
        echo "Options:"
        echo "  [U] Update from GitHub master (discards local changes)"
        echo "  [K] Keep local version"
        echo ""
        read -r -p "Choose option [U/k]: " UPDATE_CHOICE
        UPDATE_CHOICE="${UPDATE_CHOICE:-U}"

        cd "$INSTALL_DIR"
        if [[ "$UPDATE_CHOICE" =~ ^[Uu]$ ]]; then
            echo "Updating from GitHub master..."
            git fetch origin
            git reset --hard origin/master
            info "Updated to latest master"
        else
            warn "Keeping local version"
        fi
    else
        echo "Cloning repository..."
        git clone https://github.com/T3chie-404/pod-man.git "$INSTALL_DIR"
        info "Repository cloned"
    fi

    cd "$INSTALL_DIR"
}

ensure_config_file() {
    if [ ! -f "$INSTALL_DIR/config.json" ]; then
        cp "$INSTALL_DIR/config.json.example" "$INSTALL_DIR/config.json"
        info "config.json created from example"
    else
        info "config.json already exists"
    fi
}

prompt_install_mode() {
    print_step "Step 3: Installation Mode"

    echo "Choose how you will use Pod-Man:"
    echo "  [Y] Pod-Man Central Server with an existing API key"
    echo "  [N] Local-only Pod-Man on localhost"
    echo ""

    if prompt_yes_no "Use Pod-Man Central? [y/N]:" "N"; then
        CENTRAL_MODE=true
        LOCAL_PORT="$DEFAULT_CENTRAL_PORT"
        echo ""
        read -r -p "Central WebSocket URL [wss://pod-man.com/agent-connect]: " CENTRAL_URL
        CENTRAL_URL="${CENTRAL_URL:-wss://pod-man.com/agent-connect}"
        validate_central_url "$CENTRAL_URL"
        CENTRAL_SSH_HOST="$(extract_central_host "$CENTRAL_URL")"
        prompt_secret "Central API Key: "
        API_KEY="$REPLY"
        [ -n "$API_KEY" ] || die "API key is required for Central mode"
        bootstrap_central_ssh_trust "$CENTRAL_SSH_HOST"
        info "Central mode selected"
    else
        CENTRAL_MODE=false
        read -r -p "Local Pod-Man port [$DEFAULT_LOCAL_PORT]: " LOCAL_PORT
        LOCAL_PORT="${LOCAL_PORT:-$DEFAULT_LOCAL_PORT}"
        validate_port "$LOCAL_PORT"
        info "Local-only mode selected"
    fi
}

prompt_https_mode() {
    print_step "Step 4: Optional HTTPS"

    if prompt_yes_no "Enable HTTPS access through nginx? [y/N]:" "N"; then
        HTTPS_ENABLED=true
        echo ""
        echo "HTTPS options:"
        echo "  [S] Self-signed certificate using this server's IP"
        echo "  [L] Trusted Let's Encrypt certificate using a domain"
        echo ""
        read -r -p "Choose option [S/l]: " HTTPS_MODE
        HTTPS_MODE="${HTTPS_MODE:-S}"

        if [[ "$HTTPS_MODE" =~ ^[Ll]$ ]]; then
            HTTPS_MODE="letsencrypt"
            read -r -p "Enter your FQDN (example: monitor.example.com): " SERVER_NAME
            validate_domain "$SERVER_NAME"
        else
            HTTPS_MODE="self-signed"
            SERVER_NAME="$(detect_public_ip)"
            if [ -z "$SERVER_NAME" ]; then
                read -r -p "Public IP for HTTPS certificate display: " SERVER_NAME
            fi
            [ -n "$SERVER_NAME" ] || die "A server IP is required for self-signed HTTPS"
        fi
        info "HTTPS mode selected: $HTTPS_MODE"
    else
        HTTPS_ENABLED=false
        info "HTTPS disabled; Pod-Man will stay localhost-only"
    fi
}

validate_port() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] || die "Port must be numeric"
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        die "Port must be between 1 and 65535"
    fi
}

validate_central_url() {
    local url="$1"
    if [[ ! "$url" =~ ^wss?://.+ ]]; then
        die "Central URL must start with ws:// or wss://"
    fi
    if [[ ! "$url" =~ /agent-connect/?$ ]]; then
        die "Central URL must point to the /agent-connect WebSocket endpoint"
    fi
}

validate_domain() {
    local value="$1"
    [[ "$value" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "A valid FQDN is required for Let's Encrypt"
}

detect_public_ip() {
    curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true
}

extract_central_host() {
    local url="$1"
    python3 - "$url" <<'EOF'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
print(parsed.hostname or "")
EOF
}

bootstrap_central_ssh_trust() {
    local host="$1"
    [ -n "$host" ] || die "Could not determine Central SSH host from Central URL"

    mkdir -p "$(dirname "$SSH_KNOWN_HOSTS_PATH")"
    chmod 700 "$(dirname "$SSH_KNOWN_HOSTS_PATH")"

    local scanned
    scanned="$(ssh-keyscan -H -t ed25519,rsa "$host" 2>/dev/null || true)"
    [ -n "$scanned" ] || die "Failed to fetch Central SSH host keys for $host"

    printf '%s\n' "$scanned" > "$SSH_KNOWN_HOSTS_PATH"
    chmod 600 "$SSH_KNOWN_HOSTS_PATH"

    info "Bootstrapped Central SSH trust for $host"
    ssh-keygen -lf "$SSH_KNOWN_HOSTS_PATH" | sed 's/^/  Fingerprint: /'
}

write_config() {
    local mode
    if [ "$CENTRAL_MODE" = true ]; then
        mode="central"
    else
        mode="local"
    fi

    INSTALLER_MODE="$mode" \
    INSTALLER_PORT="$LOCAL_PORT" \
    INSTALLER_CENTRAL_URL="$CENTRAL_URL" \
    INSTALLER_CENTRAL_SSH_HOST="$CENTRAL_SSH_HOST" \
    INSTALLER_SSH_KNOWN_HOSTS_PATH="$SSH_KNOWN_HOSTS_PATH" \
    INSTALLER_API_KEY="$API_KEY" \
    node <<'EOF'
const fs = require('fs');
const path = require('path');

const configPath = path.resolve(process.cwd(), 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

config.server = config.server || {};
config.server.host = '127.0.0.1';
config.server.port = Number(process.env.INSTALLER_PORT || '7000');

config.centralManagement = config.centralManagement || {};

if (process.env.INSTALLER_MODE === 'central') {
  config.centralManagement.enabled = true;
  config.centralManagement.apiKey = process.env.INSTALLER_API_KEY || '';
  config.centralManagement.centralUrl = process.env.INSTALLER_CENTRAL_URL || '';
  config.centralManagement.autoConnect = true;
  config.centralManagement.centralSshHost = process.env.INSTALLER_CENTRAL_SSH_HOST || '';
  config.centralManagement.sshKnownHostsPath = process.env.INSTALLER_SSH_KNOWN_HOSTS_PATH || '';
  config.centralManagement.allowRemoteSshKeyInstall = false;
} else {
  config.centralManagement.enabled = false;
  config.centralManagement.apiKey = '';
  config.centralManagement.centralUrl = '';
  config.centralManagement.autoConnect = false;
  config.centralManagement.centralSshHost = '';
  config.centralManagement.sshKnownHostsPath = '';
  config.centralManagement.allowRemoteSshKeyInstall = false;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
EOF

    info "config.json updated"
}

install_dependencies() {
    print_step "Step 5: Installing Dependencies"
    npm install --production
    info "Dependencies installed"
}

install_service() {
    print_step "Step 6: Setting Up Service"

    sed "s|INSTALL_DIR_PLACEHOLDER|$INSTALL_DIR|g" "$INSTALL_DIR/pod-manager.service" > /tmp/pod-manager.service.tmp
    cp /tmp/pod-manager.service.tmp /etc/systemd/system/pod-manager.service
    rm /tmp/pod-manager.service.tmp

    systemctl daemon-reload
    systemctl enable pod-manager
    SERVICE_STARTED_AT="$(date -u +"%Y-%m-%d %H:%M:%S")"
    systemctl restart pod-manager
    info "pod-manager.service installed, enabled, and restarted"
}

wait_for_local_health() {
    local port="$1"
    local attempts=20
    local url="http://127.0.0.1:${port}/api/setup/status"

    for _ in $(seq 1 "$attempts"); do
        if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
            info "Local Pod-Man health check passed on port $port"
            return 0
        fi
        sleep 2
    done

    die "Pod-Man did not become healthy on http://127.0.0.1:${port}"
}

verify_central_registration() {
    local service_name="pod-manager"
    local attempts=25
    local registration_seen=false
    local tunnel_seen=false

    for _ in $(seq 1 "$attempts"); do
        local logs
        logs="$(journalctl -u "$service_name" --since "$SERVICE_STARTED_AT" --no-pager -n 200 2>/dev/null || true)"

        if grep -q "Registration confirmed" <<<"$logs"; then
            registration_seen=true
        fi

        if grep -q "Tunnel established successfully" <<<"$logs"; then
            tunnel_seen=true
        fi

        if [ "$registration_seen" = true ] && [ "$tunnel_seen" = true ]; then
            info "Central registration and reverse tunnel verified"
            return 0
        fi

        sleep 2
    done

    warn "Central verification did not fully complete during install"
    echo "  Registration confirmed: $registration_seen"
    echo "  Reverse tunnel established: $tunnel_seen"
    echo "  Check: sudo journalctl -u pod-manager -n 200"
}

run_https_setup() {
    local https_port="$DEFAULT_HTTPS_PORT"

    SETUP_HTTPS_NONINTERACTIVE=1 \
    SSL_TYPE="$HTTPS_MODE" \
    DOMAIN_NAME="$SERVER_NAME" \
    HTTPS_PORT="$https_port" \
    POD_MANAGER_PORT="$LOCAL_PORT" \
    POD_MANAGER_INSTALL_DIR="$INSTALL_DIR" \
    POD_MANAGER_SERVER_NAME="$SERVER_NAME" \
    bash "$INSTALL_DIR/setup-https.sh"

    verify_https "$https_port"
}

verify_https() {
    local https_port="$1"

    if ! nginx -t >/dev/null 2>&1; then
        die "nginx configuration test failed after HTTPS setup"
    fi

    if curl -kfsS --max-time 8 "https://127.0.0.1:${https_port}/api/setup/status" >/dev/null 2>&1; then
        info "HTTPS reachability verified on port $https_port"
    else
        warn "HTTPS setup completed, but local curl verification failed"
        echo "  Check: sudo systemctl status nginx"
        echo "  Check: sudo tail -n 50 /var/log/nginx/pod-manager-error.log"
    fi
}

print_summary() {
    local local_url="http://127.0.0.1:${LOCAL_PORT}"

    print_step "Installation Complete"
    echo "Pod-Man is now running."
    echo ""
    echo "Local URL:"
    echo "  $local_url"
    echo ""

    if [ "$HTTPS_ENABLED" = true ]; then
        echo "HTTPS URL:"
        echo "  https://${SERVER_NAME}:${DEFAULT_HTTPS_PORT}"
        echo ""
    else
        echo "Remote access:"
        echo "  ssh -L ${LOCAL_PORT}:localhost:${LOCAL_PORT} user@your-server"
        echo ""
    fi

    if [ "$CENTRAL_MODE" = true ]; then
        echo "Central mode:"
        echo "  Enabled with auto-connect"
        echo "  Central URL: $CENTRAL_URL"
        echo "  Verification: see installer output above"
        echo ""
    else
        echo "Central mode:"
        echo "  Disabled (local-only install)"
        echo ""
    fi

    echo "Next steps:"
    echo "  1. Open the local or HTTPS URL above"
    echo "  2. Complete first-time setup and create your admin account"
    echo "  3. If Central verification warned, inspect: sudo journalctl -u pod-manager -n 200"
    echo ""
    echo "Service commands:"
    echo "  sudo systemctl status pod-manager"
    echo "  sudo systemctl restart pod-manager"
    echo "  sudo journalctl -u pod-manager -f"
    echo ""
}

main() {
    print_banner
    require_root
    detect_install_dir
    ensure_dependencies
    checkout_repo
    ensure_config_file
    prompt_install_mode
    prompt_https_mode
    write_config
    install_dependencies
    install_service
    wait_for_local_health "$LOCAL_PORT"

    if [ "$CENTRAL_MODE" = true ]; then
        verify_central_registration
    fi

    if [ "$HTTPS_ENABLED" = true ]; then
        run_https_setup
    fi

    print_summary
}

main "$@"
