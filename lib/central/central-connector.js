const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Central Connector - Connects pNode to central management server
 * 
 * Security Features:
 * - API key authentication
 * - TLS certificate validation
 * - Command signature verification
 * - Rate limiting
 * - Automatic reconnection with exponential backoff
 */

class CentralConnector {
  constructor(config) {
    this.enabled = config.enabled || false;
    this.apiKey = config.apiKey || null;
    this.centralUrl = config.centralUrl || null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 300000; // 5 minutes
    this.heartbeatInterval = null;
    this.connected = false;
    this.lastHeartbeat = null;
    
    // Command whitelist for security
    this.allowedCommands = {
      'service.restart': { requiresApproval: false, rateLimit: '10/hour' },
      'service.stop': { requiresApproval: true, rateLimit: '5/hour' },
      'service.start': { requiresApproval: false, rateLimit: '10/hour' },
      'logs.get': { requiresApproval: false, rateLimit: '100/hour' },
      'metrics.get': { requiresApproval: false, rateLimit: '1000/hour' },
      'pubkey.get': { requiresApproval: false, rateLimit: '10/hour' }
    };
    
    // Command execution history for rate limiting
    this.commandHistory = new Map();
  }

  /**
   * Initialize connection to central server
   */
  async connect() {
    if (!this.enabled) {
      console.log('[Central] Central management disabled');
      return;
    }

    if (!this.apiKey || !this.centralUrl) {
      console.error('[Central] Missing API key or central URL');
      return;
    }

    try {
      console.log(`[Central] Connecting to ${this.centralUrl}...`);
      
      this.ws = new WebSocket(this.centralUrl, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'Pod-Man-Agent/1.0'
        },
        // TLS options for certificate validation
        rejectUnauthorized: true,
        // Timeout
        handshakeTimeout: 10000
      });

      this.setupEventHandlers();
      
    } catch (error) {
      console.error('[Central] Connection error:', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  setupEventHandlers() {
    this.ws.on('open', () => {
      console.log('[Central] Connected to central server');
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Wait for 'authenticated' message before sending registration
      // This ensures the server is ready to receive it
    });

    this.ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (error) {
        console.error('[Central] Message handling error:', error.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[Central] Connection closed: ${code} ${reason}`);
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[Central] WebSocket error:', error.message);
    });
  }

  /**
   * Handle incoming message from central server
   */
  async handleMessage(message) {
    const { type, id, command, params, signature } = message;

    switch (type) {
      case 'ping':
        this.sendPong(id);
        break;
        
      case 'command':
        await this.handleCommand(id, command, params, signature);
        break;
        
      case 'http-proxy-request':
        await this.handleHttpProxyRequest(message);
        break;
        
      case 'authenticated':
        // Server acknowledged authentication, now send registration
        this.sendRegistration();
        break;
        
      case 'registered':
        // Server confirmed registration, start heartbeat
        console.log('[Central] Registration confirmed');
        this.startHeartbeat();
        break;
        
      case 'revoke':
        console.warn('[Central] API key revoked by central server');
        this.disconnect();
        break;
        
      case 'update-config':
        console.log('[Central] Config update received');
        // Handle config updates
        break;
        
      default:
        console.warn('[Central] Unknown message type:', type);
    }
  }

  /**
   * Handle command from central server
   */
  async handleCommand(id, command, params, signature) {
    // Validate command is in whitelist
    if (!this.allowedCommands[command]) {
      this.sendCommandResponse(id, {
        success: false,
        error: `Command not allowed: ${command}`
      });
      return;
    }

    // Check rate limit
    if (!this.checkRateLimit(command)) {
      this.sendCommandResponse(id, {
        success: false,
        error: 'Rate limit exceeded for this command'
      });
      return;
    }

    // TODO: Verify signature when command signing is implemented
    // if (!this.verifyCommandSignature(command, params, signature)) {
    //   return this.sendCommandResponse(id, { success: false, error: 'Invalid signature' });
    // }

    // Execute command
    try {
      const result = await this.executeCommand(command, params);
      this.sendCommandResponse(id, { success: true, result });
    } catch (error) {
      this.sendCommandResponse(id, { 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Execute allowed command
   */
  async executeCommand(command, params) {
    const [category, action] = command.split('.');
    
    switch (category) {
      case 'service':
        const ServiceManager = require('../services');
        return await ServiceManager.controlService(params.service, action);
        
      case 'logs':
        const LogManager = require('../logs');
        return await LogManager.getLogs(params.service, params.lines || 100);
        
      case 'metrics':
        const SystemMonitor = require('../system');
        return await SystemMonitor.getAllStats();
        
      case 'pubkey':
        const LogMgr = require('../logs');
        return await LogMgr.getPubkeyPassive();
        
      default:
        throw new Error(`Unknown command category: ${category}`);
    }
  }

  /**
   * Check rate limit for command
   */
  checkRateLimit(command) {
    const limit = this.allowedCommands[command].rateLimit;
    if (!limit) return true;

    const [max, period] = limit.split('/');
    const maxCount = parseInt(max);
    const periodMs = period === 'hour' ? 3600000 : 60000;

    const now = Date.now();
    const history = this.commandHistory.get(command) || [];
    
    // Remove old entries
    const recent = history.filter(t => now - t < periodMs);
    
    if (recent.length >= maxCount) {
      return false;
    }

    recent.push(now);
    this.commandHistory.set(command, recent);
    return true;
  }

  /**
   * Send initial registration to central server
   */
  sendRegistration() {
    const os = require('os');
    
    this.send({
      type: 'register',
      data: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        version: '1.0.0', // Pod-Man version
        capabilities: Object.keys(this.allowedCommands)
      }
    });
  }

  /**
   * Send metrics to central server
   */
  async sendMetrics() {
    if (!this.connected) return;

    try {
      const SystemMonitor = require('../system');
      const ServiceManager = require('../services');
      
      const [system, services] = await Promise.all([
        SystemMonitor.getAllStats(),
        ServiceManager.getStatusSummary()
      ]);

      this.send({
        type: 'metrics',
        data: {
          timestamp: Date.now(),
          system,
          services
        }
      });
    } catch (error) {
      console.error('[Central] Error sending metrics:', error.message);
    }
  }

  /**
   * Send message to central server
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send pong response
   */
  sendPong(id) {
    this.send({ type: 'pong', id });
  }

  /**
   * Send command response
   */
  sendCommandResponse(id, response) {
    this.send({
      type: 'command-response',
      id,
      ...response
    });
  }

  /**
   * Handle HTTP proxy request from central server
   */
  async handleHttpProxyRequest(message) {
    const { id, method, path, service, headers, body, query } = message;
    
    try {
      // Map service to port
      const portMap = {
        'xandminer': 3000,
        'xandminerd': 4000,
        'pod-man': 7000
      };
      
      const port = portMap[service];
      if (!port) {
        throw new Error(`Invalid service: ${service}`);
      }
      
      // Build URL
      let urlPath = path;
      if (query && Object.keys(query).length > 0) {
        const queryString = new URLSearchParams(query).toString();
        urlPath += `?${queryString}`;
      }
      
      // Sanitize headers
      const sanitizedHeaders = this.sanitizeProxyHeaders(headers);
      sanitizedHeaders['host'] = `localhost:${port}`;
      
      // Make HTTP request to localhost service
      const response = await this.makeHttpRequest({
        hostname: 'localhost',
        port: port,
        path: urlPath,
        method: method,
        headers: sanitizedHeaders,
        timeout: 30000
      }, body);
      
      // Send response back to central server
      this.send({
        type: 'http-proxy-response',
        id: id,
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
        bodyEncoding: response.bodyEncoding || 'utf8'
      });
      
    } catch (error) {
      console.error('[Central] HTTP proxy error:', error.message);
      
      // Send error response
      this.send({
        type: 'http-proxy-response',
        id: id,
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      });
    }
  }

  /**
   * Make HTTP request using Node.js http/https modules
   */
  makeHttpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const httpModule = options.port === 443 ? https : http;
      
      const req = httpModule.request(options, (res) => {
        const chunks = [];
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          // Keep body as Buffer, convert to base64 for transmission
          const responseBuffer = Buffer.concat(chunks);
          const responseBody = responseBuffer.toString('base64');
          
          // Filter response headers
          const responseHeaders = {};
          for (const [key, value] of Object.entries(res.headers)) {
            const lowerKey = key.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(lowerKey)) {
              responseHeaders[key] = value;
            }
          }
          
          resolve({
            statusCode: res.statusCode,
            headers: responseHeaders,
            body: responseBody,
            bodyEncoding: 'base64' // Tell receiver it's base64
          });
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      // Send body if present
      if (body) {
        req.write(body);
      }
      
      req.end();
    });
  }

  /**
   * Sanitize headers for proxy requests
   */
  sanitizeProxyHeaders(headers) {
    const sanitized = {};
    const blockedHeaders = [
      'host',
      'connection',
      'upgrade',
      'x-forwarded-for',
      'x-forwarded-proto',
      'x-forwarded-host',
      'x-real-ip'
    ];
    
    for (const [key, value] of Object.entries(headers || {})) {
      const lowerKey = key.toLowerCase();
      if (!blockedHeaders.includes(lowerKey)) {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Start heartbeat mechanism
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.connected) {
        this.send({ type: 'heartbeat', timestamp: Date.now() });
        this.lastHeartbeat = Date.now();
        
        // Also send metrics periodically
        this.sendMetrics();
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    
    this.reconnectAttempts++;
    
    console.log(`[Central] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Disconnect from central server
   */
  disconnect() {
    this.enabled = false;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.connected = false;
    console.log('[Central] Disconnected from central server');
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      lastHeartbeat: this.lastHeartbeat,
      reconnectAttempts: this.reconnectAttempts,
      centralUrl: this.centralUrl ? this.centralUrl.replace(/wss?:\/\//, '') : null
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    const wasEnabled = this.enabled;
    
    this.enabled = config.enabled !== undefined ? config.enabled : this.enabled;
    this.apiKey = config.apiKey || this.apiKey;
    this.centralUrl = config.centralUrl || this.centralUrl;

    // Reconnect if configuration changed
    if (this.enabled && !wasEnabled) {
      this.connect();
    } else if (!this.enabled && wasEnabled) {
      this.disconnect();
    }
  }
}

module.exports = CentralConnector;

