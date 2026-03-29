const pty = require("node-pty");
const { execSync } = require("child_process");

/**
 * Terminal Manager
 * 
 * Handles pseudo-terminal sessions with security features
 */

class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this.shell = process.env.SHELL || "/bin/bash";
    this.maxSessions = 10;
    this.sessionTimeout = 1000 * 60 * 60; // 1 hour
    this.dangerousCommands = ["rm -rf /", "mkfs", "dd if=/dev/zero", "> /dev/sda"];
    this.activityLog = [];
  }

  /**
   * Create a new PTY session
   */
  createSession(sessionId, cols = 80, rows = 24, userRole = 'admin') {
    try {
      if (userRole !== 'admin') {
        throw new Error('Terminal access requires an admin session');
      }

      let ptyProcess;

      // Admin user: spawn root shell
      ptyProcess = pty.spawn(this.shell, [], {
        name: "xterm-color",
        cols: cols,
        rows: rows,
        cwd: process.env.HOME || "/root",
        env: process.env
      });
      this.logActivity(sessionId, "SESSION_CREATED", `Shell: ${this.shell}`);

      this.sessions.set(sessionId, { ptyProcess, startTime: Date.now(), userRole });

      return ptyProcess;
    } catch (error) {
      this.logActivity("system", "SESSION_CREATE_FAILED", error.message);
      throw error;
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Write data to session
   */
  writeToSession(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (session && session.ptyProcess) {
      // Check for dangerous commands
      if (this.isDangerousCommand(data)) {
        this.logActivity(sessionId, "DANGEROUS_COMMAND", data);
      }
      session.ptyProcess.write(data);
    }
  }

  /**
   * Resize session
   */
  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (session && session.ptyProcess) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  /**
   * Close session
   */
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.ptyProcess) {
        session.ptyProcess.kill();
      }
      this.sessions.delete(sessionId);
      this.logActivity(sessionId, "SESSION_CLOSED", "");
    }
  }

  /**
   * Check for dangerous commands
   */
  isDangerousCommand(command) {
    const lowerCmd = command.toLowerCase().trim();
    return this.dangerousCommands.some(dangerous => lowerCmd.includes(dangerous));
  }

  /**
   * Log activity
   */
  logActivity(sessionId, action, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId,
      action,
      details
    };
    this.activityLog.push(entry);
    
    // Keep only last 1000 entries
    if (this.activityLog.length > 1000) {
      this.activityLog.shift();
    }
    
    console.log(`[Terminal] ${sessionId}: ${action} - ${details}`);
  }

  /**
   * Get activity log
   */
  getActivityLog(limit = 100) {
    return this.activityLog.slice(-limit);
  }

  /**
   * Clean up old sessions
   */
  cleanupOldSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.startTime > this.sessionTimeout) {
        this.closeSession(sessionId);
      }
    }
  }

  /**
   * Clean up inactive sessions (called by server)
   */
  cleanupInactiveSessions() {
    this.cleanupOldSessions();
  }

  getUserIds(username) {
    const uid = Number(execSync(`id -u ${username}`, { encoding: "utf8" }).trim());
    const gid = Number(execSync(`id -g ${username}`, { encoding: "utf8" }).trim());
    return { uid, gid };
  }
}

module.exports = new TerminalManager();
