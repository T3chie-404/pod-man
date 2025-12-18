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
    this.centralUser = config.centralUser || 'ubuntu';
    this.pnodeId = null;
    this.tunnelProcess = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 300000; // 5 minutes
    
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
    const basePort = 20000 + ((hash % 9000) * 10);
    
    return {
      xandminer: basePort + 0,
      xandminerd: basePort + 1,
      'pod-man': basePort + 2
    };
  }

  /**
   * Establish reverse SSH tunnel to central server
   */
  async establish(pnodeId) {
    if (this.connected || this.tunnelProcess) {
      console.log('[Reverse-Tunnel] Tunnel already active');
      return;
    }
    
    this.pnodeId = pnodeId;
    const ports = this.getRemotePorts(pnodeId);
    
    console.log(`[Reverse-Tunnel] Establishing to ${this.centralHost} with ports:`, ports);
    
    const tunnelArgs = [
      '-N', // No command
      '-T', // No TTY
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-i', this.sshKeyPath,
      '-R', `${ports.xandminer}:localhost:3000`,
      '-R', `${ports.xandminerd}:localhost:4000`,
      '-R', `${ports['pod-man']}:localhost:7000`,
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
        console.log('[Reverse-Tunnel] Tunnel established successfully');
      }
      
    } catch (error) {
      console.error('[Reverse-Tunnel] Failed to establish:', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (!this.pnodeId) return;
    
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    
    this.reconnectAttempts++;
    
    console.log(`[Reverse-Tunnel] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    
    setTimeout(() => {
      if (this.pnodeId) {
        this.establish(this.pnodeId);
      }
    }, delay);
  }

  /**
   * Disconnect tunnel
   */
  disconnect() {
    if (this.tunnelProcess) {
      console.log('[Reverse-Tunnel] Disconnecting tunnel');
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
    }
    this.connected = false;
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

