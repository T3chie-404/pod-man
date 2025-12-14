#!/bin/bash

set -e

# Colors for output
RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
NC="\033[0m" # No Color

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Xandeum Pod Manager - Quick Installer${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}✗ Please run as root: sudo bash install.sh${NC}"
    exit 1
fi

# Detect installation directory
INSTALL_DIR="/root/xandeum-pod-monitor"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Step 1: Checking Dependencies${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found${NC}"
    echo "  Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
    echo -e "${GREEN}✓${NC} Node.js installed"
else
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓${NC} Node.js $NODE_VERSION"
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found, installing...${NC}"
    apt-get install -y npm
    echo -e "${GREEN}✓${NC} npm installed"
else
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓${NC} npm $NPM_VERSION"
fi

# Check git
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}! git not found, installing...${NC}"
    apt-get update
    apt-get install -y git
    echo -e "${GREEN}✓${NC} git installed"
else
    echo -e "${GREEN}✓${NC} git $(git --version | cut -d' ' -f3)"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Step 2: Installing Pod Manager${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Clone or update repository
if [ -d "$INSTALL_DIR" ]; then
    echo "Directory already exists at $INSTALL_DIR"
    echo ""
    echo "Options:"
    echo "  [U] Update from GitHub (discards local changes)"
    echo "  [K] Keep local version (skip git pull)"
    echo ""
    read -p "Choose option [U/k]: " UPDATE_CHOICE
    UPDATE_CHOICE=${UPDATE_CHOICE:-U}
    
    cd "$INSTALL_DIR"
    
    if [[ "$UPDATE_CHOICE" =~ ^[Uu]$ ]]; then
        echo "Updating from GitHub..."
        git fetch origin
        git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)
        echo -e "${GREEN}✓${NC} Updated to latest version"
    else
        echo -e "${YELLOW}!${NC} Keeping local version"
    fi
else
    echo "Cloning repository..."
    git clone https://github.com/T3chie-404/pod-man.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    echo -e "${GREEN}✓${NC} Repository cloned"
fi

# Install dependencies
echo "Installing dependencies..."
npm install --production
echo -e "${GREEN}✓${NC} Dependencies installed"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Step 3: Setting up System Service${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Stop existing service if running
if systemctl is-active --quiet xandeum-pod-monitor; then
    systemctl stop xandeum-pod-monitor
    echo -e "${YELLOW}!${NC} Stopped existing service"
fi

# Copy service file
cp "$INSTALL_DIR/xandeum-pod-monitor.service" /etc/systemd/system/
echo -e "${GREEN}✓${NC} Service file installed"

# Reload systemd
systemctl daemon-reload
echo -e "${GREEN}✓${NC} Systemd reloaded"

# Enable service
systemctl enable xandeum-pod-monitor
echo -e "${GREEN}✓${NC} Service enabled (starts on boot)"

# Start service
systemctl start xandeum-pod-monitor
sleep 2

# Check if service started
if systemctl is-active --quiet xandeum-pod-monitor; then
    echo -e "${GREEN}✓${NC} Service started successfully"
else
    echo -e "${RED}✗ Service failed to start${NC}"
    echo "  Check logs: sudo journalctl -u xandeum-pod-monitor -n 50"
    exit 1
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Xandeum Pod Manager is now running!"
echo ""
echo -e "${YELLOW}Access URLs:${NC}"
echo "  • Local:  http://127.0.0.1:7000"
SERVER_IP=$(hostname -I | awk '{print $1}')
if [ -n "$SERVER_IP" ]; then
    echo "  • SSH Tunnel: ssh -L 7000:localhost:7000 user@${SERVER_IP}"
fi
echo ""
echo -e "${YELLOW}Service Commands:${NC}"
echo "  • Status:  sudo systemctl status xandeum-pod-monitor"
echo "  • Stop:    sudo systemctl stop xandeum-pod-monitor"
echo "  • Start:   sudo systemctl start xandeum-pod-monitor"
echo "  • Restart: sudo systemctl restart xandeum-pod-monitor"
echo "  • Logs:    sudo journalctl -u xandeum-pod-monitor -f"
echo ""
echo -e "${YELLOW}Optional: Enable HTTPS${NC}"
echo "  • Run: sudo bash $INSTALL_DIR/setup-https.sh"
if [ -n "$SERVER_IP" ]; then
    echo "  • Access via: https://${SERVER_IP}:443"
fi
echo ""
echo -e "${GREEN}Enjoy managing your Xandeum pNode! ⚡${NC}"
echo ""
