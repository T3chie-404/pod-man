const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

/**
 * Log Retrieval Module
 * 
 * SECURITY CONSIDERATIONS:
 * - Only retrieves logs for whitelisted services
 * - Limits log lines to prevent memory exhaustion
 * - Sanitizes grep patterns to prevent injection
 * - No direct user input in shell commands
 */

const ALLOWED_SERVICES = ["xandminer", "xandminerd", "pod", "pod-manager"];
const MAX_LOG_LINES = 10000; // Prevent memory issues

class LogManager {
  /**
   * Validate service name
   */
  static validateService(serviceName) {
    if (!ALLOWED_SERVICES.includes(serviceName)) {
      throw new Error(`Invalid service: ${serviceName}`);
    }
  }

  /**
   * Sanitize grep pattern to prevent command injection
   */
  static sanitizePattern(pattern) {
    if (!pattern) return null;
    
    // Remove potentially dangerous characters
    // Allow: alphanumeric, space, dash, underscore, dot
    return pattern.replace(/[^a-zA-Z0-9 \-_.]/g, "");
  }

  /**
   * Get logs for a service
   */
  static async getLogs(serviceName, lines = 50, filter = null) {
    this.validateService(serviceName);
    
    // Enforce max lines limit
    const safeLines = Math.min(lines, MAX_LOG_LINES);
    
    try {
      let command = `journalctl -u ${serviceName}.service --no-pager --lines=${safeLines}`;
      
      // Add grep filter if provided
      if (filter) {
        const safeFilter = this.sanitizePattern(filter);
        if (safeFilter) {
          command += ` | grep "${safeFilter}"`;
        }
      }
      
      // Increase timeout and buffer for large log requests
      const { stdout } = await Promise.race([
        execPromise(command, { maxBuffer: 50 * 1024 * 1024 }), // 50MB buffer
        new Promise((_, reject) => setTimeout(() => reject(new Error('Log retrieval timeout')), 20000))
      ]);
      
      const logLines = stdout.split("\n").filter(l => l.trim());
      
      return {
        success: true,
        service: serviceName,
        lines: logLines,
        count: logLines.length,
        filter: filter || null
      };
    } catch (error) {
      return {
        success: false,
        service: serviceName,
        error: error.message,
        lines: []
      };
    }
  }

  /**
   * Find pubkey in pod logs
   * This restarts the pod service and captures the startup logs
   */
  static async findPubkey() {
    try {
      // Restart pod service
      await execPromise("systemctl restart pod.service");
      
      // Wait for service to start
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get recent logs and grep for pubkey
      const { stdout } = await execPromise(
        "journalctl -u pod.service --no-pager --lines=100 | grep -i pubkey"
      );
      
      // Extract pubkey from logs (format may vary)
      const lines = stdout.split("\n").filter(l => l.trim());
      
      return {
        success: true,
        lines: lines,
        pubkey: this.extractPubkeyFromLines(lines)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        lines: []
      };
    }
  }

  /**
   * Extract pubkey from log lines
   */
  static extractPubkeyFromLines(lines) {
    // Look for base58 encoded pubkey patterns (typically 32-44 chars)
    const pubkeyRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    
    for (const line of lines) {
      const matches = line.match(pubkeyRegex);
      if (matches && matches.length > 0) {
        return matches[0];
      }
    }
    
    return null;
  }


  /**
   * Get pubkey without restarting the pod service (passive scan)
   */
    /**
   * Get pubkey without restarting the pod service (passive scan)
   */
  static async getPubkeyPassive() {
    const fs = require("fs");
    const path = require("path");
    const configFile = "/root/pod-man/config.json";
    const cacheFile = "/tmp/xpm_pubkey_cache.txt";
    
    // 1. Check config.json first (persistent storage)
    try {
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
        if (config.pubkey && config.pubkey.length >= 32) {
          return { success: true, pubkey: config.pubkey, lines: [], cached: true, source: "config" };
        }
      }
    } catch (e) {}
    
    // 2. Try file cache
    try {
      if (fs.existsSync(cacheFile)) {
        const cached = fs.readFileSync(cacheFile, "utf8").trim();
        if (cached && cached.length >= 32) {
          // Also save to config.json for persistence
          try {
            const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
            config.pubkey = cached;
            fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
          } catch (e) {}
          return { success: true, pubkey: cached, lines: [], cached: true, source: "cache" };
        }
      }
    } catch (e) {}
    
    // 3. Scan logs (reduced from 20000 to 1000 lines for performance)
    try {
      const { stdout } = await execPromise(
        "journalctl -u pod.service --no-pager --lines=1000 | grep -i pubkey"
      );
      const lines = stdout.split("\n").filter(l => l.trim());
      const pk = this.extractPubkeyFromLines(lines);
      if (pk) {
        // Save to both cache and config.json
        try {
          fs.writeFileSync(cacheFile, pk, "utf8");
          const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
          config.pubkey = pk;
          fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
        } catch (e) {}
      }
      return {
        success: true,
        lines,
        pubkey: pk,
        source: pk ? "logs" : null
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        lines: [],
        pubkey: null
      };
    }
  }

  /**
   * Get logs for all services
   */
  static async getAllLogs(lines = 50) {
    const logs = {};
    
    for (const service of ALLOWED_SERVICES) {
      logs[service] = await this.getLogs(service, lines);
    }
    
    return logs;
  }

  /**
   * Stream logs (returns command for frontend to execute via terminal)
   */
  static getStreamCommand(serviceName, lines = 50) {
    this.validateService(serviceName);
    return `journalctl -u ${serviceName}.service -f --lines=${lines}`;
  }
}

module.exports = LogManager;
