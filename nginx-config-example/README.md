# nginx Reverse Proxy Setup

This guide explains how to set up nginx as a reverse proxy with HTTPS and basic authentication for the Xandeum Pod Manager.

## Why Use nginx?

- **HTTPS**: Secure encrypted connection
- **Authentication**: Password protection
- **Rate Limiting**: Prevent abuse
- **Better Performance**: nginx handles static files
- **Security Headers**: Additional security layer

## Prerequisites

- Ubuntu/Debian server
- Root access
- Domain name (optional, can use IP)
- Xandeum Pod Manager already installed

## Step-by-Step Installation

### 1. Install nginx and Tools

```bash
sudo apt update
sudo apt install nginx apache2-utils -y
```

### 2. Create Password File

```bash
# Create password for user 'admin' (you can change this)
sudo htpasswd -c /etc/nginx/.htpasswd admin

# You'll be prompted to enter a password
# Enter a strong password!
```

**To add more users:**
```bash
sudo htpasswd /etc/nginx/.htpasswd username
```

### 3. SSL Certificate

**Option A: Self-Signed Certificate (for testing)**

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/pod-manager.key \
  -out /etc/ssl/certs/pod-manager.crt
```

**Option B: Let's Encrypt (recommended for production)**

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```

### 4. Copy nginx Configuration

```bash
# Copy the example config
sudo cp nginx-reverse-proxy.conf /etc/nginx/sites-available/xandeum-pod-monitor

# Edit the configuration
sudo nano /etc/nginx/sites-available/xandeum-pod-monitor

# Update these lines:
# - server_name your-server.com  (change to your domain or IP)
# - ssl_certificate path
# - ssl_certificate_key path
```

### 5. Enable the Site

```bash
# Create symlink to enable site
sudo ln -s /etc/nginx/sites-available/xandeum-pod-monitor /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# If OK, reload nginx
sudo systemctl reload nginx
```

### 6. Update Monitor Configuration

Edit `/root/xandeum-pod-monitor/config.json`:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7000
  }
}
```

**Keep it as 127.0.0.1!** nginx will proxy to it.

### 7. Configure Firewall

```bash
# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Ensure port 7000 is NOT exposed
sudo ufw status
```

### 8. Test Access

1. Go to `https://your-server.com` (or `https://your-ip`)
2. Accept the certificate warning (if using self-signed)
3. Enter username and password
4. You should see the dashboard!

## Security Checklist

- [x] HTTPS enabled with valid certificate
- [x] Basic authentication enabled
- [x] Rate limiting configured
- [x] Firewall allows only 80/443
- [x] Pod Manager binds to localhost only
- [x] Security headers enabled
- [x] Strong password set

## Troubleshooting

### nginx won't start

```bash
# Check configuration
sudo nginx -t

# View error logs
sudo tail -f /var/log/nginx/error.log
```

### Can't access site

```bash
# Check if nginx is running
sudo systemctl status nginx

# Check if port 443 is open
sudo netstat -tulpn | grep :443

# Check firewall
sudo ufw status
```

### Authentication not working

```bash
# Verify password file exists
ls -la /etc/nginx/.htpasswd

# Check nginx error log
sudo tail -f /var/log/nginx/xandeum-pod-monitor-error.log
```

### WebSocket not connecting

- Ensure proxy timeout is set high (3600s in config)
- Check browser console for errors
- Verify WebSocket path: `wss://your-domain.com/terminal`

## Advanced Configuration

### IP Whitelist

Add this inside the `server` block to restrict access by IP:

```nginx
# Allow specific IPs only
allow 1.2.3.4;      # Your IP
allow 5.6.7.8;      # Another trusted IP
deny all;
```

### Custom Port

To use a custom port instead of 443:

```nginx
server {
    listen 7443 ssl http2;  # Custom port
    # ... rest of config
}
```

Don't forget to open the port:
```bash
sudo ufw allow 7443/tcp
```

### Disable Terminal Access

To disable terminal for public access, add this in the nginx config:

```nginx
location /terminal {
    deny all;
}
```

## Maintenance

### Update Certificate

```bash
# For Let's Encrypt (auto-renew)
sudo certbot renew

# For self-signed (recreate)
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/pod-manager.key \
  -out /etc/ssl/certs/pod-manager.crt
sudo systemctl reload nginx
```

### View Access Logs

```bash
sudo tail -f /var/log/nginx/xandeum-pod-monitor-access.log
```

### Change Password

```bash
# Change existing user password
sudo htpasswd /etc/nginx/.htpasswd admin
```

## Security Notes

⚠️ **Important Security Considerations:**

1. **Use Strong Passwords**: Basic auth can be brute-forced
2. **Keep Certificate Updated**: Expired certs show warnings
3. **Monitor Access Logs**: Watch for suspicious activity
4. **Consider IP Whitelist**: If you have static IPs
5. **Disable Terminal**: If not needed for public access
6. **Update Regularly**: Keep nginx and certbot updated

## Support

For issues with:
- nginx: Check [nginx documentation](https://nginx.org/en/docs/)
- Let's Encrypt: Check [Certbot documentation](https://certbot.eff.org/)
- Pod Manager: Open issue on GitHub
