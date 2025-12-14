# Xandeum Pod Manager (Pod-Man)

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)

Interactive web-based monitoring and management dashboard for Xandeum pNodes. Monitor services, view logs, test pRPC API, diagnose network issues, track credits, view graphs, and access an embedded terminal - all from a single, secure web interface.

## Features

### 🎯 Dashboard Overview
- **Real-time system stats**: CPU, RAM, disk usage, uptime (formatted as 1d 22h 30m)
- **Service status cards**: xandminer, xandminerd, pod, xandeum-pod-monitor
- **Network connectivity status**: External IP and public port accessibility
- **Pod credits tracking**: Earned credits + top earner leaderboard
- **DevNet eligibility**: 95th percentile threshold calculator
- **Storage monitoring**: Xandeum-Pages disk usage
- **Health score**: Composite score (0-100%) with detailed formula
- **Auto-refresh**: Every 10 seconds

### 🔧 Service Management
- View status for all services (xandminer, xandminerd, pod, xandeum-pod-monitor)
- Start/Stop/Restart individual services
- Restart all services with one click
- View detailed service logs (scrollable up to 2000 chars per service)
- Confirmation dialogs for all destructive actions
- **Read-only safety toggle**: Protects against accidental service changes

### 📜 Log Viewer
- View logs for any service with **line selector pills**: 100, 2k, 5k, 10k lines
- Backend supports up to **10,000 lines** (50MB buffer)
- Filter logs with search terms (searches thousands of entries)
- **Find Pubkey feature**: Passive grep scan (20,000 lines, no restart)
- Only shows for pod service logs
- Automatic pubkey caching to file

### 🔌 pRPC API Testing
- Built-in API call buttons (get-version, get-stats, get-pods)
- Custom RPC method input for testing
- **Dual-pane display**: Call format (curl command) + Response
- Formatted JSON response display
- Shows exact curl command with your public IP
- Error handling and timeout management

### 🌐 Network Diagnostics
- **Localhost checks**: Ports 22, 80, 3000, 4000, 6000, 7000 (TCP)
- **Public access tests**: UDP 5000, 9001 + TCP 22, 80, 3000, 4000, 6000
- Shows 0.0.0.0 bindings as "PUBLIC + LOCALHOST"
- External IP detection
- Sorted port display (smallest → largest)
- UDP/TCP section dividers
- Visual status indicators (✅/❌)
- Firewall/router forwarding reminder

### 📊 Graphs
- **4 graphs in 2×2 grid**: CPU, RAM, Disk, Credits
- **Time ranges**: 10m, 6h, 24h (CPU/RAM/Disk) + **40 days** (Credits)
- **Persistent storage**: localStorage cache with 24h retention (40d for credits)
- Background data collection every 10 seconds (regardless of tab)
- Automatic axis scaling: CPU/RAM/Disk 0-100%, Credits 0-90k
- Simplified x-axis labels (e.g., "-10m → now" or "-2.2d → now")
- Chart titles overlay (CPU, RAM, DISK, CREDITS)

### 💻 Embedded Terminal
- Full interactive terminal using xterm.js
- **Read-only guard**: Terminal access blocked when safety toggle is on
- Reconnect button for session recovery
- Session management with timeouts
- Terminal activity logging for audit
- Warning about installer scripts breaking sessions

### 🛡️ Security Features
- **Localhost-only by default** (127.0.0.1:7000)
- **Read-only safety toggle**: Defaults to "Protected" mode, blocks all dangerous actions
- **Command whitelist**: Only predefined services can be controlled
- **Dangerous command warnings**: Detects and blocks risky commands in terminal
- **Rate limiting**: Prevents API abuse (60 requests/minute)
- **Input validation**: All user inputs are sanitized
- **Session limits**: Prevents resource exhaustion
- **Activity logging**: All terminal commands logged
- **Confirmation dialogs**: For all destructive actions
- **Self-restart prevention**: Monitor service can't restart itself via UI

## 🚀 Quick Start: Turn-Key HTTPS Setup

**NEW!** The easiest way to enable secure HTTPS access:

```bash
cd /root/xandeum-pod-monitor
sudo bash setup-https.sh
```

This interactive wizard will:
- ✅ Install and configure nginx automatically
- ✅ Auto-disable default nginx site (prevents port conflicts)
- ✅ Generate SSL certificates (self-signed or Let's Encrypt)
- ✅ Set up password authentication
- ✅ Configure secure reverse proxy
- ✅ Start nginx service automatically
- ✅ Test and verify the setup

**No manual configuration needed!** Just answer a few simple questions:
1. Do you want HTTPS? (y/n)
2. Choose username (default: admin)
3. Create password
4. Self-signed or Let's Encrypt certificate?

Then access your monitor at: `https://YOUR-IP:443`

**Note:** localhost:80/stats continues to work (pod service serves it separately).

### Options

```bash
# Enable HTTPS (interactive)
sudo bash setup-https.sh

# Remove HTTPS setup
sudo bash setup-https.sh --remove

# Non-interactive mode (for automation)
SKIP_HTTPS_PROMPT=1 HTTPS_USERNAME=admin HTTPS_PASSWORD=yourpass sudo bash setup-https.sh
```

## Installation

### Quick Install

```bash
wget https://raw.githubusercontent.com/T3chie-404/pod-man/master/install.sh
sudo bash install.sh
```

### Manual Installation

```bash
# Clone the repository
git clone https://github.com/T3chie-404/pod-man.git
cd pod-man

# Install dependencies
npm install

# Start the server
sudo node server.js
```

### Install as System Service

```bash
# Copy service file
sudo cp xandeum-pod-monitor.service /etc/systemd/system/

# Enable and start
sudo systemctl enable xandeum-pod-monitor
sudo systemctl start xandeum-pod-monitor

# Check status
sudo systemctl status xandeum-pod-monitor
```

## Usage

### Local Access (Default)

The monitor runs on `http://127.0.0.1:7000` by default (localhost only).

**Access from your local machine:**
```bash
# Open browser on server
http://127.0.0.1:7000
```

**Access remotely via SSH tunnel:**
```bash
# From your local machine
ssh -L 7000:localhost:7000 user@your-server

# Then open in browser
http://localhost:7000
```

### Public Access (Optional)

For public access with HTTPS and authentication, run `sudo bash setup-https.sh`.

## Configuration

Edit `config.json` to customize:

```json
{
  "server": {
    "host": "127.0.0.1",  // Change to "0.0.0.0" for public access
    "port": 7000
  },
  "security": {
    "enableServiceControl": true,  // Disable to make read-only
    "enableTerminal": true,        // Disable to hide terminal
    "dangerousCommandWarnings": true,
    "confirmDestructiveActions": true,
    "rateLimit": {
      "enabled": true,
      "maxRequestsPerMinute": 60
    }
  }
}
```

## Security Considerations

### 🔒 Default Security Posture

- **Localhost-only**: Binds to 127.0.0.1 by default
- **No public exposure**: Requires SSH tunnel for remote access
- **Read-only toggle**: Defaults to "Protected" mode
- **Minimal attack surface**: Only runs what's necessary

### ⚠️ If Exposing Publicly

If you run `setup-https.sh` or change `host` to `0.0.0.0`:

1. **Use nginx reverse proxy** with basic auth (setup-https.sh does this)
2. **Use HTTPS** with valid certificate (Let's Encrypt recommended)
3. **Enable firewall** and only allow specific IPs if possible
4. **Keep read-only toggle ON** when not making changes
5. **Monitor access logs** regularly

### 🛡️ Built-in Protections

- **Command whitelist**: Only xandminer, xandminerd, pod, xandeum-pod-monitor
- **Action whitelist**: Only start, stop, restart, status
- **Input sanitization**: All user inputs are validated
- **Dangerous command detection**: Warns before executing risky terminal commands
- **Rate limiting**: Prevents brute force and DoS (60 req/min)
- **Session limits**: Prevents resource exhaustion
- **Activity logging**: Audit trail for all terminal commands
- **Self-restart block**: Monitor service cannot restart itself via API

## Attack Vectors Mitigated

| Attack Vector | Mitigation |
|--------------|------------|
| Command injection | Parameterized commands, input validation |
| Fork bomb | Terminal session limits, command detection |
| Disk wiping | Dangerous command warnings, confirmation, read-only toggle |
| Resource exhaustion | Rate limiting, session timeouts, line limits |
| Unauthorized access | Localhost-only default, optional nginx basic auth |
| Service manipulation | Whitelist-based validation, read-only toggle |
| Log flooding | Max line limits (10,000 lines), 50MB buffer |
| Memory leaks | Periodic cleanup, activity log rotation |
| Accidental changes | Read-only safety toggle (defaults to protected) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/dashboard` | GET | Full dashboard data (system, services, network) |
| `/api/services` | GET | All service statuses |
| `/api/services/:name` | GET | Single service status |
| `/api/services/:name/:action` | POST | Control service (requires read-only off) |
| `/api/services/restart-all` | POST | Restart all services (requires read-only off) |
| `/api/logs/:service` | GET | Get service logs (query: lines, filter) |
| `/api/find-pubkey` | POST | Restart pod and extract pubkey from logs |
| `/api/pod-pubkey` | GET | Passive pubkey scan (20k lines, no restart, cached) |
| `/api/pod-credits` | GET | Global credits list + local credits |
| `/api/devnet-eligibility` | GET | Credits analysis with 95th percentile |
| `/api/prpc/:method` | POST | Call pRPC method |
| `/api/network` | GET | Network diagnostics (localhost + public ports) |
| `/api/system` | GET | System stats (CPU, RAM, Disk, Uptime, Xandeum-Pages) |
| `/api/health` | GET | Health check with score calculation |
| `/terminal` | WebSocket | Terminal connection (requires read-only off) |

## Data Persistence

- **Metrics cache**: Browser localStorage (24h retention for CPU/RAM/Disk, 40 days for Credits)
- **Pubkey cache**: File-based `/tmp/xpm_pubkey_cache.txt` + in-memory
- **IP cache**: Browser localStorage for instant pRPC curl command display
- **Survives**: Page reloads, browser restarts, service restarts

## System Requirements

- **OS**: Linux (Ubuntu 20.04+ recommended)
- **Node.js**: v16.0.0 or higher
- **RAM**: 50MB (minimal footprint, 512MB limit via systemd)
- **Disk**: 50MB
- **Network**: Localhost (no external dependencies for core functionality)

## Troubleshooting

### Server won't start

```bash
# Check if port 7000 is in use
sudo netstat -tulpn | grep 7000

# Check logs
sudo journalctl -u xandeum-pod-monitor -n 50

# Check for syntax errors
sudo node -c /root/xandeum-pod-monitor/server.js
```

### Terminal not connecting

- Ensure **Read-Only toggle is OFF** (terminal blocked when protected)
- Check WebSocket connection in browser console (F12)
- Ensure `enableTerminal: true` in config.json
- Check if node-pty is installed: `npm list node-pty`

### Services not responding

- Verify services are running: `systemctl status pod xandminer xandminerd`
- Check permissions: Monitor must run as root for systemctl access
- Check read-only toggle is OFF for service control

### Can't access pRPC API

- Ensure pod service is running
- Check pRPC is listening: `netstat -tulpn | grep 6000`
- Verify port 6000 is accessible

### Graphs not showing data

- Wait 1-2 minutes for metrics to accumulate (collected every 10s)
- Check browser console for errors (F12)
- Clear browser cache and localStorage if needed
- Stay on any tab - metrics collect in background

### Credits not showing

- Pubkey must be detected (check Logs tab → pod → Find Pubkey)
- Pubkey cache: `/tmp/xpm_pubkey_cache.txt`
- Force scan: DevNet section → "Force Pubkey Scan" button
- Credits API: `https://pods-credit.vercel.app/api/pods-credits`

### 10k log selector fails

- Backend has 50MB buffer for large log outputs
- Request timeout: 15s frontend, 20s backend
- If fails: try 5k instead or wait and retry

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Test API endpoints
curl http://127.0.0.1:7000/api/health
curl http://127.0.0.1:7000/api/devnet-eligibility
curl http://127.0.0.1:7000/api/pod-credits
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Apache License 2.0 - see [LICENSE](LICENSE) file for details

## Author

**T3chie-404**
- GitHub: [@T3chie-404](https://github.com/T3chie-404)
- Repository: [pod-man](https://github.com/T3chie-404/pod-man)

## Acknowledgments

- [Xandeum Network](https://xandeum.network) - For the pNode software
- [xterm.js](https://xtermjs.org/) - For the excellent terminal emulator
- [node-pty](https://github.com/microsoft/node-pty) - For PTY support
- [Chart.js](https://www.chartjs.org/) - For beautiful graphs

## Support

For issues, questions, or contributions:
- Open an issue on [GitHub](https://github.com/T3chie-404/pod-man/issues)
- Star the repository if you find it useful!

---

**Made with ⚡ for the Xandeum community**

