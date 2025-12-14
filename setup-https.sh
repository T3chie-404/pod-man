#!/bin/bash

# Xandeum Pod Manager - Turn-Key HTTPS Setup
# Can be run standalone or called from install.sh

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo bash setup-https.sh"
    exit 1
fi

# Handle uninstall
if [ "$1" = "--remove" ] || [ "$1" = "--uninstall" ]; then
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  REMOVING HTTPS SETUP${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    if [ -f /etc/nginx/sites-enabled/xandeum-pod-monitor ]; then
        rm -f /etc/nginx/sites-enabled/xandeum-pod-monitor
        rm -f /etc/nginx/sites-available/xandeum-pod-monitor
        echo -e "${GREEN}✓${NC} Removed nginx configuration"
    fi
    
    if systemctl is-active --quiet nginx; then
        systemctl reload nginx
        echo -e "${GREEN}✓${NC} Reloaded nginx"
    fi
    
    echo ""
    echo -e "${GREEN}HTTPS setup removed. Pod Manager still accessible at http://127.0.0.1:7000${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Xandeum Pod Manager - HTTPS Setup Wizard${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "This wizard will set up HTTPS access to your Pod Manager with:"
echo "  • Secure HTTPS connection (SSL/TLS)"
echo "  • Password authentication"
echo "  • nginx reverse proxy"
echo ""

# Ask if user wants HTTPS
if [ -z "$SKIP_HTTPS_PROMPT" ]; then
    read -p "Would you like to enable HTTPS access? (y/N): " ENABLE_HTTPS
    if [[ ! "$ENABLE_HTTPS" =~ ^[Yy]$ ]]; then
        echo ""
        echo -e "${YELLOW}HTTPS setup skipped. Pod Manager accessible at http://127.0.0.1:7000${NC}"
        exit 0
    fi
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Step 1: Installing Dependencies${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

apt-get update -qq
apt-get install -y nginx apache2-utils >/dev/null 2>&1
echo -e "${GREEN}✓${NC} Installed nginx and apache2-utils"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Step 2: Authentication Setup${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Step 3: SSL Certificate${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Determine certificate type
if [ -z "$SSL_TYPE" ]; then
    echo "Certificate options:"
    echo "  [S] Self-signed certificate (works immediately, browser warning)"
    echo "  [L] Let's Encrypt (requires domain name, no browser warning)"
    echo ""
    read -p "Choose option [S/l]: " CERT_TYPE
    CERT_TYPE=${CERT_TYPE:-s}
else
    CERT_TYPE="$SSL_TYPE"
fi

if [[ "$CERT_TYPE" =~ ^[Ll]$ ]]; then
    # Let's Encrypt
    if [ -z "$DOMAIN_NAME" ]; then
        read -p "Enter your domain name (e.g., monitor.example.com): " DOMAIN
    else
        DOMAIN="$DOMAIN_NAME"
    fi
    
    if [ -z "$DOMAIN" ]; then
        echo -e "${RED}Error: Domain name required for Let's Encrypt${NC}"
        exit 1
    fi
    
    # Install certbot
    apt-get install -y certbot python3-certbot-nginx >/dev/null 2>&1
    echo -e "${GREEN}✓${NC} Installed certbot"
    
    # Obtain certificate using standalone mode (before nginx config)
    echo "Obtaining Let's Encrypt certificate..."
    certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} Obtained Let's Encrypt certificate"
    else
        echo -e "${RED}✗ Failed to obtain certificate${NC}"
        echo "  Make sure port 80 is accessible and domain points to this server"
        exit 1
    fi
    
    SSL_CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    SSL_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
    USE_LETSENCRYPT=true
else
    # Self-signed certificate
    echo "Generating self-signed certificate..."
    
    mkdir -p /etc/ssl/xandeum
    
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /etc/ssl/xandeum/monitor.key \
        -out /etc/ssl/xandeum/monitor.crt \
        -subj "/C=US/ST=State/L=City/O=Xandeum/CN=pod-manager" \
        >/dev/null 2>&1
    
    echo -e "${GREEN}✓${NC} Generated self-signed SSL certificate (valid 365 days)"
    echo -e "${YELLOW}⚠️  Note: Browser will show security warning (self-signed cert)${NC}"
    
    SSL_CERT="/etc/ssl/xandeum/monitor.crt"
    SSL_KEY="/etc/ssl/xandeum/monitor.key"
    USE_LETSENCRYPT=false
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Step 4: nginx Configuration${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Determine port
HTTPS_PORT=${HTTPS_PORT:-443}

# Get server name (IP or domain)
if [ -n "$DOMAIN" ]; then
    SERVER_NAME="$DOMAIN"
else
    # Try to get public IP
    PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")
    SERVER_NAME="$PUBLIC_IP"
fi

# Create nginx configuration
cat > /etc/nginx/sites-available/xandeum-pod-monitor <<EOF
# Xandeum Pod Manager - HTTPS Reverse Proxy
# Generated by setup-https.sh

server {
    listen $HTTPS_PORT ssl http2;
    listen [::]:$HTTPS_PORT ssl http2;
    
    server_name $SERVER_NAME;
    
    # SSL Configuration
    ssl_certificate $SSL_CERT;
    ssl_certificate_key $SSL_KEY;
    
    # Modern SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    
    # Basic Authentication
    # Authentication handled by application (login page)
    
    # Note: Rate limiting handled by application (server.js)
    
    # Proxy to Pod Manager
    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # WebSocket support
        proxy_read_timeout 86400;
    }
    
    # Logs
    access_log /var/log/nginx/pod-manager-access.log;
    error_log /var/log/nginx/pod-manager-error.log;
}
EOF

echo -e "${GREEN}✓${NC} Created nginx configuration"

# Enable site
ln -sf /etc/nginx/sites-available/xandeum-pod-monitor /etc/nginx/sites-enabled/

# Disable default nginx site if it exists (prevents port 80 conflict)
if [ -f /etc/nginx/sites-enabled/default ]; then
    rm -f /etc/nginx/sites-enabled/default
    echo "✓ Disabled default nginx site"
fi

# Test nginx configuration
if nginx -t >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} nginx configuration is valid"
else
    echo -e "${RED}✗${NC} nginx configuration test failed"
    nginx -t
    exit 1
fi


# Start or reload nginx
if systemctl is-active --quiet nginx; then
    systemctl reload nginx
    echo -e "${GREEN}✓${NC} Reloaded nginx"
else
    systemctl start nginx
    echo -e "${GREEN}✓${NC} Started nginx"
fi

# Enable nginx on boot
systemctl enable nginx >/dev/null 2>&1

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}✅ HTTPS is now enabled!${NC}"
echo ""
echo "Access your Pod Manager at:"
echo -e "${BLUE}  https://$SERVER_NAME:$HTTPS_PORT${NC}"
echo ""
echo "First-time access:"
echo -e "  ${BLUE}Navigate to the URL above${NC}"
echo -e "  ${BLUE}Complete setup (create admin account)${NC}"
echo ""

if [ "$USE_LETSENCRYPT" = false ]; then
    echo -e "${YELLOW}⚠️  Browser Security Warning:${NC}"
    echo "Your browser will show a security warning because of the self-signed"
    echo "certificate. This is normal. Click 'Advanced' and proceed to the site."
    echo ""
    echo "To avoid the warning, use Let's Encrypt:"
    echo "  sudo bash setup-https.sh --remove"
    echo "  sudo bash setup-https.sh  (then choose Let's Encrypt)"
    echo ""
fi

echo "Additional commands:"
echo "  Test nginx:    sudo nginx -t"
echo "  Reload nginx:  sudo systemctl reload nginx"
echo "  View logs:     sudo tail -f /var/log/nginx/pod-manager-*.log"
echo "  Remove HTTPS:  sudo bash setup-https.sh --remove"
echo ""

# Save configuration info
cat > /root/pod-man/.https-config <<EOF
HTTPS_ENABLED=true
HTTPS_PORT=$HTTPS_PORT
USERNAME=$USERNAME
SSL_TYPE=$([[ "$USE_LETSENCRYPT" = true ]] && echo "letsencrypt" || echo "self-signed")
SERVER_NAME=$SERVER_NAME
INSTALL_DATE=$(date)
EOF

echo -e "${GREEN}Configuration saved to: /root/pod-man/.https-config${NC}"
echo ""
