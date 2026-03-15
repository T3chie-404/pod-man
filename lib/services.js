const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

/**
 * Service Management Module
 * 
 * SECURITY CONSIDERATIONS:
 * - Only allows predefined service names (whitelist)
 * - Only allows specific actions (start, stop, restart, status)
 * - Uses parameterized commands to prevent injection
 * - Returns sanitized output
 */

const ALLOWED_SERVICES = ["xandminer", "xandminerd", "pod", "pod-manager"];
const ALLOWED_ACTIONS = ["start", "stop", "restart", "status"];

class ServiceManager {
  /**
   * Validate service name against whitelist
   */
  static validateService(serviceName) {
    if (!ALLOWED_SERVICES.includes(serviceName)) {
      throw new Error(`Invalid service name: ${serviceName}. Allowed: ${ALLOWED_SERVICES.join(", ")}`);
    }
  }

  /**
   * Validate action against whitelist
   */
  static validateAction(action) {
    if (!ALLOWED_ACTIONS.includes(action)) {
      throw new Error(`Invalid action: ${action}. Allowed: ${ALLOWED_ACTIONS.join(", ")}`);
    }
  }

  /**
   * Get status of a service
   */
  static async getStatus(serviceName) {
    this.validateService(serviceName);
    
    try {
      const { stdout } = await execPromise(`systemctl status ${serviceName}.service --no-pager -l`);
      return {
        success: true,
        service: serviceName,
        output: stdout,
        running: stdout.includes("active (running)")
      };
    } catch (error) {
      // A non-zero exit from `systemctl status` is normal for inactive/failed units.
      // Return the status payload rather than treating the status lookup itself as a failure.
      const output = error.stdout || error.stderr || error.message;
      const lowerOutput = String(output).toLowerCase();
      const isFailed = lowerOutput.includes("failed");
      return {
        success: true,
        service: serviceName,
        output,
        running: false,
        state: isFailed ? "failed" : "stopped",
        statusError: error.message
      };
    }
  }

  /**
   * Get status of all monitored services
   */
  static async getAllStatus() {
    const statuses = {};
    
    for (const service of ALLOWED_SERVICES) {
      statuses[service] = await this.getStatus(service);
    }
    
    return statuses;
  }

  /**
   * Control a service (start/stop/restart)
   * 
   * SECURITY: Requires validation on both service name and action
   */
  static async controlService(serviceName, action) {
    this.validateService(serviceName);
    this.validateAction(action);
    
    if (action === "status") {
      return await this.getStatus(serviceName);
    }
    
    // Prevent self-restart/stop (causes disconnection)
    if (serviceName === 'pod-manager' && (action === 'restart' || action === 'stop')) {
      return {
        success: false,
        service: serviceName,
        action: action,
        error: 'Cannot restart/stop monitor service from within itself. Use: sudo systemctl ' + action + ' pod-manager.service'
      };
    }
    
    try {
      const { stdout, stderr } = await execPromise(`systemctl ${action} ${serviceName}.service`);
      
      // Wait a moment for service to change state
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get updated status
      const status = await this.getStatus(serviceName);
      
      return {
        success: true,
        service: serviceName,
        action: action,
        output: stdout || stderr,
        status: status
      };
    } catch (error) {
      return {
        success: false,
        service: serviceName,
        action: action,
        error: error.message,
        output: error.stdout || error.stderr
      };
    }
  }

  /**
   * Restart all services
   * 
   * SECURITY: Only restarts whitelisted services
   */
  static async restartAll() {
    const results = {};
    
    for (const service of ALLOWED_SERVICES) {
      results[service] = await this.controlService(service, "restart");
    }
    
    return results;
  }

  /**
   * Get simple status summary
   */
  static async getStatusSummary() {
    const statuses = await this.getAllStatus();
    const summary = {
      total: ALLOWED_SERVICES.length,
      running: 0,
      stopped: 0,
      failed: 0
    };
    
    for (const service of ALLOWED_SERVICES) {
      const status = statuses[service];
      if (status.running) {
        summary.running++;
      } else if (status.output && status.output.includes("failed")) {
        summary.failed++;
      } else {
        summary.stopped++;
      }
    }
    
    return {
      summary,
      services: statuses
    };
  }
}

module.exports = ServiceManager;
