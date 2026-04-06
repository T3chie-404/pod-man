/**
 * Reverse SSH Tunnel Manager
 * Establishes reverse SSH tunnel from pNode to Pod Manager Central
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);

class ReverseTunnel {
  constructor(config) {
    this.centralHost = config.centralHost || 'pod-man.com';
    this.centralUser = config.centralUser || config.centralSshUser || 'ubuntu';
    this.podManPort = config.podManPort || 7000;
    this.knownHostsPath = config.knownHostsPath || null;
    this.pnodeId = null;
    this.assignedPorts = null;
    this.tunnelProcess = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 300000; // 5 minutes
    this.reconnectTimer = null;
    this.isReconnecting = false;
    
    const homeDir = os.homedir();
    this.sshKeyPath = path.join(homeDir, '.ssh', 'pnode_tunnel_key');
  }

  /**
   * Generate SSH keypair for reverse tunnel
   */
  async generateKeypair() {
    const sshDir = path.dirname(this.sshKeyPath);
    
    // Ensure .ssh directory exists
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    }
    
    // Check if keypair already exists
    if (fs.existsSync(this.sshKeyPath) && fs.existsSync(`${this.sshKeyPath}.pub`)) {
      console.log('[Reverse-Tunnel] SSH keypair already exists');
      return this.getPublicKey();
    }
    
    try {
      // Generate ED25519 keypair
      await execAsync(`ssh-keygen -t ed25519 -f "${this.sshKeyPath}" -N "" -C "pnode-reverse-tunnel"`);
      
      // Set correct permissions
      fs.chmodSync(this.sshKeyPath, 0o600);
      fs.chmodSync(`${this.sshKeyPath}.pub`, 0o644);
      
      console.log('[Reverse-Tunnel] Generated SSH keypair');
      return this.getPublicKey();
      
    } catch (error) {
      console.error('[Reverse-Tunnel] Failed to generate keypair:', error.message);
      throw error;
    }
  }

  /**
   * Get SSH public key
   */
  getPublicKey() {
    try {
      return fs.readFileSync(`${this.sshKeyPath}.pub`, 'utf8').trim();
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate remote ports based on pNode ID
   */
  getRemotePorts(pnodeId) {
    const hash = parseInt(pnodeId.substring(0, 8).replace(/-/g, ''), 16);
    const maxPortBaseSlots = 4500;
    const basePort = 20000 + ((hash % maxPortBaseSlots) * 10);
    
    return {
      xandminer: basePort + 0,
      xandminerd: basePort + 1,
      'pod-man': basePort + 2
    };
  }

  setAssignedPorts(ports) {
    const valid = ports
      && Number.isInteger(ports.xandminer)
      && Number.isInteger(ports.xandminerd)
      && Number.isInteger(ports['pod-man']);

    this.assignedPorts = valid ? {
      xandminer: ports.xandminer,
      xandminerd: ports.xandminerd,
      'pod-man': ports['pod-man']
    } : null;
  }

  /**
   * Establish reverse SSH tunnel to central server
   */
  async establish(pnodeId) {
    // Prevent multiple concurrent establishment attempts
    if (this.connected || this.tunnelProcess || this.isReconnecting) {
      console.log('[Reverse-Tunnel] Already connected or connecting');
      return;
    }
    
    this.isReconnecting = true;
    
    this.pnodeId = pnodeId;
    const ports = this.assignedPorts || this.getRemotePorts(pnodeId);
    
    console.log(`[Reverse-Tunnel] Establishing to ${this.centralHost} with ports:`, ports);

    if (!this.knownHostsPath || !fs.existsSync(this.knownHostsPath)) {
      throw new Error('Central SSH host trust is not configured. Missing known_hosts pin for reverse tunnel.');
    }
    
    const tunnelArgs = [
      '-N', // No command
      '-T', // No TTY
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${this.knownHostsPath}`,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-i', this.sshKeyPath,
      '-R', `${ports.xandminer}:localhost:3000`,
      '-R', `${ports.xandminerd}:localhost:4000`,
      '-R', `${ports['pod-man']}:localhost:${this.podManPort}`,
      `${this.centralUser}@${this.centralHost}`
    ];
    
    try {
      this.tunnelProcess = spawn('ssh', tunnelArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      this.tunnelProcess.stdout.on('data', (data) => {
        console.log('[Reverse-Tunnel]', data.toString().trim());
      });
      
      this.tunnelProcess.stderr.on('data', (data) => {
        console.error('[Reverse-Tunnel] Error:', data.toString().trim());
      });
      
      this.tunnelProcess.on('close', (code) => {
        console.log(`[Reverse-Tunnel] Tunnel closed with code ${code}`);
        this.connected = false;
        this.tunnelProcess = null;
        
        // Auto-reconnect
        this.scheduleReconnect();
      });
      
      this.tunnelProcess.on('error', (error) => {
        console.error('[Reverse-Tunnel] Process error:', error.message);
        this.connected = false;
        this.tunnelProcess = null;
        this.scheduleReconnect();
      });
      
      // Wait a moment for tunnel to establish
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      if (this.tunnelProcess && !this.tunnelProcess.killed) {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        console.log('[Reverse-Tunnel] Tunnel established successfully');
      }
      
    } catch (error) {
      console.error('[Reverse-Tunnel] Failed to establish:', error.message);
      this.isReconnecting = false;
      this.scheduleReconnect();
    }
  }

  setCentralUser(username) {
    if (typeof username === 'string' && username.trim()) {
      this.centralUser = username.trim();
    }
  }

  /**
   * Apply bounded jitter so reconnect attempts spread out instead of aligning.
   */
  calculateReconnectDelay() {
    const baseDelay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    const jitterRange = Math.min(30000, Math.max(1000, Math.floor(baseDelay * 0.2)));
    const jitterOffset = Math.floor(Math.random() * ((jitterRange * 2) + 1)) - jitterRange;
    return Math.max(1000, baseDelay + jitterOffset);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    // Clear any existing timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (!this.pnodeId || this.isReconnecting) return;
    
    const delay = this.calculateReconnectDelay();
    
    this.reconnectAttempts++;
    
    console.log(`[Reverse-Tunnel] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.pnodeId && !this.connected) {
        this.establish(this.pnodeId);
      }
    }, delay);
  }

  /**
   * Disconnect tunnel
   */
  disconnect() {
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.tunnelProcess) {
      console.log('[Reverse-Tunnel] Disconnecting tunnel');
      this.tunnelProcess.kill('SIGTERM');
      this.tunnelProcess = null;
    }
    
    this.connected = false;
    this.isReconnecting = false;
    this.pnodeId = null;
  }

  /**
   * Get tunnel status
   */
  getStatus() {
    return {
      connected: this.connected,
      pnodeId: this.pnodeId,
      reconnectAttempts: this.reconnectAttempts,
      centralHost: this.centralHost
    };
  }
}

module.exports = ReverseTunnel;
