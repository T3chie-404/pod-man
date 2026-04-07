# Xandeum Pod Manager (Pod-Man)

![Version](https://img.shields.io/badge/version-1.2.6--rc.1-blue.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)

Interactive web-based monitoring and management dashboard for Xandeum pNodes. Monitor services, view logs, test pRPC API, diagnose network issues, track credits, view graphs, and, for local admin recovery, access an embedded terminal.

## Features

### 🔐 Authentication & Security
- **First-time setup page**: Create admin account on first run
- **Login system**: Secure session-based authentication
- **Role-based access**: Admin, Standard, and Demo users
- **Password hashing**: bcrypt with cost factor 10
- **Session management**: Configurable timeout, secure cookies
- **User management**: Admin can add/remove users
- **Telegram account linking**: Supports Central password recovery and billing notifications
- **Read-only public launch guardrail**: Standard and Demo sessions stay locked in protected mode

### 🎯 Dashboard Overview
- **Real-time system stats**: CPU, RAM, disk usage, uptime
- **Service status cards**: xandminer, xandminerd, pod
- **Network connectivity status**: External IP and public port accessibility
- **Pod credits tracking**: Earned credits + top earner leaderboard
- **DevNet eligibility**: 95th percentile threshold calculator
- **Storage monitoring**: Xandeum-Pages disk usage
- **Health score**: Composite score (0-100%) with detailed formula
- **Auto-refresh**: Every 10 seconds

### 🔧 Service Management
- View status for all services
- Start/Stop/Restart individual services
- View detailed service logs
- **Read-only safety toggle**: Protects against accidental service changes
- **Role-based permissions**: Service control is admin-only

### 📜 Log Viewer
- View logs for any service with line selector pills (100, 2k, 5k, 10k lines)
- Filter logs with search terms
- **Find Pubkey feature**: Passive grep scan (no restart required)
- Automatic pubkey caching

### 🔌 pRPC API Testing
- Built-in API call buttons (get-version, get-stats, get-pods)
- Custom RPC method input for testing
- **Dual-pane display**: Call format (curl command) + Response
- Formatted JSON response display

### 🌐 Network Diagnostics
- **Localhost checks**: Ports 22, 80, 3000, 4000, 6000, 7000 (TCP)
- **Public access tests**: UDP 5000, 9001 + TCP 22, 80, 3000, 4000, 6000
- External IP detection
- Visual status indicators (✅/❌)

### 📊 Graphs
- **4 graphs in 2×2 grid**: CPU, RAM, Disk, Credits
- **Time ranges**: 10m, 6h, 24h (CPU/RAM/Disk) + 40 days (Credits)
- **Persistent storage**: localStorage cache with 24h retention (40d for credits)
- Background data collection every 10 seconds

### 💻 Embedded Terminal
- Full interactive terminal using xterm.js
- **Role-based access**: Admin-only
- **Recovery-focused**: Intended for localhost or SSH-port-forward recovery, not direct remote exposure
- Session management with timeouts

## Installation

### Quick Install

```bash
git clone https://github.com/T3chie-404/pod-man.git
cd pod-man
sudo bash install.sh
```

The installer creates `pod-manager.service` to run as `root`.
New installs default to `/root/pod-man`, but if you run the installer from an existing Pod-Man checkout it preserves that directory and wires the service to that path.
Root privileges remain the expected runtime model because service management, root-shell admin terminal access, and related system integrations depend on them.

Installer v2 walks through one guided setup:
- Choose `Pod-Man Central` or `Local-only`
- If using Central, provide your existing API key and `wss://.../agent-connect`
- If local-only, choose a localhost port (default `7000`)
- Start `pod-manager.service`
- Verify local health, and in Central mode also verify registration and reverse tunnel setup

### Install Flow

```text
install.sh
  -> write config.json
  -> install npm deps + pod-manager.service
  -> start Pod-Man on 127.0.0.1
  -> optional Central registration + reverse tunnel verification
```

### Central vs Local-only

- **Central mode**: Uses an existing Pod-Man Central API key and `wss://.../agent-connect`, enables auto-connect, and verifies the pNode registers during install.
- **Local-only mode**: Keeps Pod-Man on `127.0.0.1` and prompts for a local port, default `7000`.

### Access Model

- **Managed nodes**: Access Pod-Man remotely through Pod-Man Central.
- **Local recovery**: Use `http://127.0.0.1:<port>` on-node or `http://localhost:<port>` over an SSH tunnel.
- **Direct public HTTPS exposure**: Not supported for the release candidate.

### First-Time Setup

1. **Access the setup page**:
   - Local-only: navigate to `http://127.0.0.1:<your-port>` or use an SSH tunnel
   - Central-managed nodes: use Pod-Man Central for remote access

2. **Create admin account**: 
   - You'll see the setup page automatically on first visit
   - Enter username and password for the admin account
   - Enter the one-time setup token generated during install
   - Optionally add additional users (standard or demo roles)
   - Click "Complete Setup"

3. **Login**: After setup, you'll be redirected to the login page
   - Use your admin credentials to log in
   - You can manage users from the login page (admin only)

### User Roles

| Role | Service Control | Terminal Access | User Management | Read-Only Toggle |
|------|----------------|-----------------|-----------------|------------------|
| **Admin** | ✅ Full | ✅ Root shell | ✅ Yes | Can toggle |
| **Standard** | ❌ Blocked | ❌ Blocked | ❌ No | 🔒 Locked protected |
| **Demo** | ❌ Blocked | ❌ Blocked | ❌ No | 🔒 Locked protected |

### Configuration

The `config.json` file is created from `config.json.example` and contains:

```json
{
  "server": {
    "host": "127.0.0.1",  // Keep localhost-only for normal installs
    "port": 7000  // Local Pod-Man web UI port
  },
  "security": {
    "enableServiceControl": true,  // Allows service start/stop/restart from the UI
    "enableTerminal": true,  // Allows the embedded terminal for admin sessions
    "dangerousCommandWarnings": true,  // Warn on obviously destructive terminal commands
    "confirmDestructiveActions": true,  // Require confirmation before risky actions
    "rateLimit": {
      "enabled": true,  // Keep enabled unless you are debugging locally
      "maxRequestsPerMinute": 60
    }
  },
  "authentication": {
    "enabled": false,  // Becomes true after first setup completes
    "sessionSecret": "",  // Generated automatically on first run
    "sessionTimeout": 86400000,  // 24 hours in milliseconds
    "users": [],  // Populated after you create local accounts
    "setupToken": ""  // One-time token required for first-time setup
  },
  "services": [
    "xandminer",
    "xandminerd",
    "pod"  // Services shown in the dashboard and service controls
  ],
  "prpc": {
    "host": "127.0.0.1",  // Local pRPC target
    "port": 6000  // Used by the built-in pRPC API tester
  },
  "terminal": {
    "shell": "/bin/bash",  // Shell spawned for admin terminal sessions
    "maxSessions": 3,  // Reference default; runtime limit is enforced separately
    "dangerousCommands": [
      "rm -rf /",
      "dd if=",
      "mkfs",
      ":(){ :|:& };:",
      "> /dev/sda",
      "chmod -R 777 /"
    ]
  },
  "centralManagement": {
    "enabled": false,  // Set true to link this node to Pod-Man Central
    "apiKey": "",  // Your Pod-Man Central API key
    "centralUrl": "",  // Example: wss://pod-man.com/agent-connect
    "autoConnect": false,  // Auto-connect to Central on service start
    "metricsInterval": 30000,  // How often the node sends metrics to Central
    "forceReconnectAfterMs": 180000,  // Force a fresh Central reconnect after 3 minutes
    "restartAfterMs": 600000,  // Restart connector loop after 10 minutes if needed
    "centralSshHost": "",  // Example: pod-man.com
    "centralSshUser": "ubuntu",  // Central SSH user for reverse tunnel bootstrap
    "sshKnownHostsPath": "",  // Example: /root/.ssh/pod-manager-central-known_hosts
    "allowRemoteSshKeyInstall": false,  // Keep false unless you intentionally want remote key install
    "ownerCentralUserId": "",
    "ownerCentralEmail": "",
    "ownerBoundAt": "",
    "ownerBindingSource": "",  // Populated after Central owner binding
    "unattendedUpgradesEnabled": true,  // Allow Central-managed unattended upgrades
    "remoteServiceControlEnabled": true  // Allow Central to issue remote service-control commands
  }
}
```

**⚠️ Important**: `config.json` is in `.gitignore` and should NEVER be committed to git (contains hashed passwords and session secrets).

Most users should let the installer write this file. The fields you are most likely to adjust manually are:
- `server.port` if you want a different local Pod-Man port
- `centralManagement.enabled`, `apiKey`, and `centralUrl` when linking an existing local node to Central
- `centralManagement.centralSshHost` and `sshKnownHostsPath` if you are repairing Central reverse tunnel trust

## Usage

### Local Access (Default)

```bash
# SSH tunnel from your local machine
ssh -L 7000:localhost:7000 user@your-server

# Open browser
http://localhost:7000
```

If you chose a different local port during install, replace `7000` with that port.

To find the setup token later on the node:

```bash
PODMAN_DIR="$(systemctl cat pod-manager.service | sed -n 's/^WorkingDirectory=//p' | tail -n 1)"
grep -n '"setupToken"' "$PODMAN_DIR/config.json"
```

### Remote Recovery

For managed nodes, use Pod-Man Central for remote access.

If Central is unavailable, use SSH port forwarding instead of exposing Pod-Man directly:

```bash
ssh -L 7000:localhost:7000 user@your-server
```

Then open:

```text
http://localhost:7000
```

## Security Considerations

### 🔒 Authentication Security

- **Passwords**: Hashed with bcrypt (cost factor 10)
- **Session secrets**: Randomly generated 64-character hex
- **Session cookies**: HttpOnly, `SameSite=Strict`, secure when served over HTTPS/tunnel
- **No default credentials**: Must create admin on first setup
- **Cannot delete last admin**: Prevents lockout

### 🛡️ Built-in Protections

- **Localhost-only default**: Binds to 127.0.0.1
- **Rate limiting**: 60 requests/minute
- **Input sanitization**: All user inputs validated
- **Command whitelist**: Only approved services/actions
- **Read-only guardrail**: Non-admin sessions stay locked in protected mode for public launch
- **Terminal restrictions**: Terminal access is admin-only

### ⚠️ Security Best Practices

1. **Use strong passwords** for admin accounts
2. **Use Central or SSH port forwarding** for remote recovery
3. **Keep the read-only toggle ON** during admin sessions unless you are intentionally making changes
4. **Review audit logs** regularly
5. **Don't commit config.json** to git
6. **Change passwords after setup** if needed

## API Endpoints

### Public (No Auth Required)
- `/` - Redirects to setup or login
- `/setup.html` - First-time setup page
- `/login.html` - Login page
- `/api/setup/status` - Check whether setup is complete
- `/api/setup/initialize` - Complete first-time setup
- `/api/login` - Login endpoint
- `/api/logout` - Logout endpoint
- `/api/check-session` - Session status
- `/sso/central` - Central SSO entrypoint

### Protected (Auth Required)
- `/api/dashboard` - Dashboard data
- `/api/services` - Service summary
- `/api/services/:name` - Individual service status
- `/api/logs/:service` - Service logs
- `/api/prpc/:method` - pRPC calls
- `/api/component-versions` - Current component versions
- `/api/network` - Network diagnostics
- `/api/system` - System stats
- `/api/health` - Health score summary
- `/api/pod-pubkey` - Active pod pubkey
- `/api/pod-cluster` - Cluster detection
- `/api/pod-credits` - Credits summary
- `/api/devnet-eligibility` - Percentile and threshold details
- `/api/central/status` - Current Central configuration status

### Admin Only
- `/api/users/add` - Add local users
- `/api/users/delete` - Delete local users
- `/api/users/list` - List local users
- `/api/services/:name/:action` - Start, stop, or restart a service
- `/api/services/restart-all` - Restart all managed services
- `/api/find-pubkey` - Passive pubkey scan and cache
- `/api/terminal/activity` - Terminal activity log
- `/api/central/owner/reset` - Reset local Central owner binding
- `/api/central/configure` - Save Central config
- `/api/central/connect` - Connect to Central
- `/api/central/disconnect` - Disconnect from Central
- `/terminal` (WebSocket) - Interactive terminal (admin session required)

## Troubleshooting

### Can't access setup page

```bash
# Check service status
sudo systemctl status pod-manager

# Check logs
sudo journalctl -u pod-manager -n 50

# Verify config
PODMAN_DIR="$(systemctl cat pod-manager.service | sed -n 's/^WorkingDirectory=//p' | tail -n 1)"
grep -n '"enabled"' "$PODMAN_DIR/config.json"
```

### Forgot admin password

```bash
# Stop service
sudo systemctl stop pod-manager

# Reset config
PODMAN_DIR="$(systemctl cat pod-manager.service | sed -n 's/^WorkingDirectory=//p' | tail -n 1)"
cp "$PODMAN_DIR/config.json.example" "$PODMAN_DIR/config.json"

# Start service
sudo systemctl start pod-manager

# Access setup page again
```

### Can't login after setup

- Clear browser cache/cookies
- Check `config.json` - ensure `authentication.enabled: true`
- Verify sessionSecret is set
- Check browser console (F12) for errors

### Terminal not connecting

- Terminal access requires an admin session
- Standard and Demo users cannot open the embedded terminal
- Check WebSocket connection in browser console (F12)
- Ensure `enableTerminal: true` in config.json

### Services not responding

- Verify services are running: `systemctl status pod xandminer xandminerd`
- Check permissions: Monitor must run as root for systemctl access
- Service control requires an admin session
- Check read-only toggle is OFF before using service controls

## Development

```bash
# Install dependencies
npm install

# Run in development
npm run dev

# Test authentication
curl -X POST http://127.0.0.1:7000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"yourpass"}'
```

## System Requirements

- **OS**: Linux (Ubuntu 20.04+ recommended)
- **Node.js**: v16.0.0 or higher
- **RAM**: 50MB (minimal footprint)
- **Disk**: 50MB
- **Network**: Localhost (no external dependencies)

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
- Join the [(Brand New) Pod-Man Discord Community](https://discord.gg/xKnb2JkR)
- Coffee fund: `2vyUcVL7WAE4Mucph1bKf81iEMRKQRQnzT7eGsBM8ETM`
- Star the repository if you find it useful!

---

**Made with ⚡ for the Xandeum community**
