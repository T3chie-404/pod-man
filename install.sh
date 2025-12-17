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
INSTALL_DIR="/root/pod-man"

# Check if we're already in the pod-man directory with all files
CURRENT_DIR=$(pwd)
if [ -f "./package.json" ] && [ -f "./server.js" ] && [ -f "./config.json.example" ]; then
    echo -e "${GREEN}✓${NC} Running installer from pod-man directory"
    INSTALL_DIR="$CURRENT_DIR"
    SKIP_CLONE=true
else
    SKIP_CLONE=false
fi

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
    echo -e "${RED}✗ git not found, installing...${NC}"
    apt-get update
    apt-get install -y git
    echo -e "${GREEN}✓${NC} git installed"
else
    echo -e "${GREEN}✓${NC} git installed"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Step 2: Getting Pod Manager${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Clone or update repository
if [ "$SKIP_CLONE" = true ]; then
    echo -e "${GREEN}✓${NC} Using current directory: $INSTALL_DIR"
elif [ -d "$INSTALL_DIR" ]; then
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
        git reset --hard origin/master
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

cd "$INSTALL_DIR"

# Check if config.json exists, if not copy from example
if [ ! -f "config.json" ]; then
    if [ -f "config.json.example" ]; then
        echo "Copying config.json.example to config.json..."
        cp config.json.example config.json
        echo -e "${GREEN}✓${NC} config.json created"
    else
        echo -e "${RED}✗ config.json.example not found!${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓${NC} config.json already exists"
fi

# Install dependencies
echo "Installing dependencies..."
npm install --production
echo -e "${GREEN}✓${NC} Dependencies installed"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Step 3: Setting Up Service${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Install systemd service
if [ -f "pod-manager.service" ]; then
  # Replace placeholder with actual install directory
  sed "s|INSTALL_DIR_PLACEHOLDER|$INSTALL_DIR|g" pod-manager.service > /tmp/pod-manager.service.tmp
  cp /tmp/pod-manager.service.tmp /etc/systemd/system/pod-manager.service
  rm /tmp/pod-manager.service.tmp
    systemctl daemon-reload
    systemctl enable pod-manager
    echo -e "${GREEN}✓${NC} Service installed and enabled"
else
    echo -e "${RED}✗ pod-manager.service not found!${NC}"
    exit 1
fi

# Start service
systemctl start pod-manager
echo -e "${GREEN}✓${NC} Service started"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Pod Manager is now running!"
echo ""
echo "  Access it at: http://127.0.0.1:7000"
echo ""
echo "  First-time setup: Visit the URL above to create your admin account"
echo ""
echo "  Remote access: ssh -L 7000:localhost:7000 user@your-server"
echo ""
echo "  Service commands:"
echo "    sudo systemctl status pod-manager"
echo "    sudo systemctl restart pod-manager"
echo "    sudo journalctl -u pod-manager -f"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
