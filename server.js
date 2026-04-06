const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const session = require("express-session");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const os = require("os");
const util = require("util");
const { exec } = require("child_process");

// Import our library modules
const ServiceManager = require("./lib/services");
const PRPCClient = require("./lib/api");
const LogManager = require("./lib/logs");
const NetworkManager = require("./lib/network");
const SystemMonitor = require("./lib/system");
const terminalManager = require("./lib/terminal");
const CentralConnector = require("./lib/central/central-connector");
const { getComponentVersions } = require("./lib/component-versions");
const { getPodPubkey, refreshPodPubkey } = require("./lib/pod-pubkey");
const { detectPodCluster } = require("./lib/pod-cluster");
const execPromise = util.promisify(exec);
const ALLOWED_POD_MAN_ROLES = new Set(["admin", "standard", "demo"]);
const LOCAL_AUDIT_LOG_PATH = path.resolve("./pod-man-audit.log");

// Load configuration
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function normalizeConfig() {
  let changed = false;

  config.authentication = config.authentication || {};
  config.authentication.users = Array.isArray(config.authentication.users) ? config.authentication.users : [];
  if (typeof config.authentication.enabled !== "boolean") {
    config.authentication.enabled = false;
    changed = true;
  }

  if (!config.authentication.sessionSecret) {
    config.authentication.sessionSecret = randomToken(32);
    console.log("✓ Generated session secret");
    changed = true;
  }

  if (typeof config.authentication.setupToken !== "string") {
    config.authentication.setupToken = "";
    changed = true;
  }

  if (config.authentication.users.length === 0 && !config.authentication.setupToken) {
    config.authentication.setupToken = randomToken(16);
    console.log("[Setup] Generated one-time setup token. Retrieve it from config.json or service logs before first setup.");
    changed = true;
  }

  if (config.authentication.users.length > 0 && config.authentication.setupToken) {
    config.authentication.setupToken = "";
    changed = true;
  }

  if (config.authentication.users.length > 0 && !config.authentication.enabled) {
    config.authentication.enabled = true;
    changed = true;
  }

  config.centralManagement = config.centralManagement || {};
  const centralDefaults = {
    ownerCentralUserId: "",
    ownerCentralEmail: "",
    ownerBoundAt: "",
    ownerBindingSource: "",
    unattendedUpgradesEnabled: true,
    remoteServiceControlEnabled: true
  };

  for (const [key, value] of Object.entries(centralDefaults)) {
    if (config.centralManagement[key] === undefined) {
      config.centralManagement[key] = value;
      changed = true;
    }
  }

  return changed;
}

function saveConfig() {
  fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
}

function normalizeLocalAuditOutcome(value) {
  const normalized = String(value || "success").trim().toLowerCase();
  return ["success", "failed", "denied"].includes(normalized) ? normalized : "success";
}

function buildLocalAuditActor(req) {
  return {
    username: req?.session?.username || null,
    role: req?.session?.role || null,
    centralUserId: req?.session?.centralUserId || null,
    centralEmail: req?.session?.centralEmail || null,
    ssoAuthenticated: Boolean(req?.session?.ssoAuthenticated)
  };
}

function logLocalAuditEvent(eventType, {
  req = null,
  outcome = "success",
  summary = "",
  details = {}
} = {}) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      eventType,
      outcome: normalizeLocalAuditOutcome(outcome),
      summary: summary || null,
      actor: buildLocalAuditActor(req),
      ipAddress: req?.ip || req?.socket?.remoteAddress || null,
      userAgent: req?.get?.("user-agent") || req?.headers?.["user-agent"] || null,
      details
    };
    fs.appendFileSync(LOCAL_AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("[Audit] Failed to write local audit entry:", error.message);
  }
}

function getAllowedDirectTerminalOrigins(req) {
  const port = Number(config.server?.port || 7000);
  const allowed = new Set();

  for (const host of ["127.0.0.1", "localhost"]) {
    allowed.add(`http://${host}:${port}`);
    allowed.add(`https://${host}:${port}`);
  }

  const requestHost = String(req?.headers?.host || "").trim();
  if (requestHost) {
    allowed.add(`http://${requestHost}`);
    allowed.add(`https://${requestHost}`);
  }

  return allowed;
}

function isAllowedDirectTerminalOrigin(req) {
  const origin = String(req?.headers?.origin || "").trim();
  return origin ? getAllowedDirectTerminalOrigins(req).has(origin) : false;
}

async function getClusterAwareCreditsSummary() {
  const [clusterResult, pubkeyResult] = await Promise.all([
    detectPodCluster(),
    getPodPubkey()
  ]);

  const cluster = clusterResult.cluster || null;
  const creditsEndpoint = clusterResult.creditsEndpoint || null;

  if (!creditsEndpoint) {
    return {
      success: false,
      error: cluster
        ? `No credits endpoint is configured for cluster ${cluster}`
        : "Unable to detect pod cluster from pod.service",
      cluster,
      clusterLabel: clusterResult.clusterLabel,
      creditsEndpoint,
      pubkey: pubkeyResult.pubkey || null,
      pubkeyResult
    };
  }

  const creditsResp = await axios.get(creditsEndpoint, { timeout: 5000 });
  const list = Array.isArray(creditsResp.data?.pods_credits) ? creditsResp.data.pods_credits : [];
  const creditsOnly = list
    .map((entry) => entry.credits)
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);
  const count = creditsOnly.length;
  const percentile95 = count > 0 ? creditsOnly[Math.floor(0.95 * (count - 1))] : null;
  const threshold = percentile95 !== null ? Math.round(percentile95 * 0.8) : null;
  const maxCredits = count > 0 ? creditsOnly[count - 1] : null;
  const pubkey = pubkeyResult.pubkey || null;
  const localEntry = pubkey ? list.find((entry) => entry.pod_id === pubkey) : null;
  const localCredits = localEntry ? localEntry.credits : null;

  return {
    success: true,
    cluster,
    clusterLabel: clusterResult.clusterLabel,
    creditsEndpoint,
    leaderboardScope: clusterResult.clusterLabel,
    pubkey,
    pubkeyResult,
    list,
    localCredits,
    percentile95,
    threshold,
    maxCredits,
    eligible: threshold !== null && localCredits !== null ? localCredits >= threshold : null,
    totalPods: count,
    clusterDetails: clusterResult
  };
}

if (normalizeConfig()) {
  saveConfig();
}

if (config.authentication.users.length === 0 && config.authentication.setupToken) {
  console.log(`[Setup] One-time setup token: ${config.authentication.setupToken}`);
}


// Initialize Central Connector (pass server config for dynamic pod-man port)
const centralConnector = new CentralConnector(config.centralManagement || {}, config.server || {}, {
  getCentralConfig: () => config.centralManagement || {},
  updateCentralConfig: (patch = {}) => {
    config.centralManagement = {
      ...(config.centralManagement || {}),
      ...patch
    };
    saveConfig();
  },
  auditLogger: (eventType, details = {}) => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      eventType,
      ...details
    });
    fs.appendFileSync("./central-audit.log", `${line}\n`, "utf8");
  }
});

// Initialize Express app
const app = express();
app.set("trust proxy", "loopback");
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, callback) => {
    try {
      const requestPath = new URL(info.req.url || "/", "http://localhost").pathname;
      if (requestPath !== "/terminal") {
        logLocalAuditEvent("podman_terminal_denied", {
          req: info.req,
          outcome: "denied",
          summary: "Terminal websocket denied before upgrade",
          details: { reason: "invalid-terminal-path", path: requestPath }
        });
        callback(false, 404, "Not found");
        return;
      }

      if (!isAllowedDirectTerminalOrigin(info.req)) {
        logLocalAuditEvent("podman_terminal_denied", {
          req: info.req,
          outcome: "denied",
          summary: "Terminal websocket denied before upgrade",
          details: {
            reason: "origin-denied",
            origin: info.req.headers?.origin || null,
            allowedOrigins: Array.from(getAllowedDirectTerminalOrigins(info.req))
          }
        });
        callback(false, 403, "Terminal origin denied");
        return;
      }

      callback(true);
    } catch (error) {
      callback(false, 400, "Invalid terminal upgrade request");
    }
  }
});


// Initialize Terminal Manager

// Middleware
app.use(express.json({ limit: '10mb' }));

// Session middleware for authentication
const sessionMiddleware = session({
  name: "pod-man.sid",
  secret: config.authentication.sessionSecret,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: config.authentication.sessionTimeout,
    httpOnly: true,
    sameSite: "strict",
    secure: "auto"
  }
});
app.use(sessionMiddleware);
app.use(express.static("public"));

// Rate limiting (simple in-memory implementation)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = config.security.rateLimit.maxRequestsPerMinute || 60;

function checkRateLimit(req, res, next) {
  if (!config.security.rateLimit.enabled) {
    return next();
  }
  
  const ip = req.ip;
  const now = Date.now();
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const record = requestCounts.get(ip);
  
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  if (record.count >= MAX_REQUESTS) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }
  
  record.count++;
  next();
}

app.use(checkRateLimit);

// ============================================================================
// AUTHENTICATION HELPERS
// ============================================================================

function getCentralHttpBaseUrl() {
  const centralUrl = config.centralManagement?.centralUrl;

  if (!centralUrl) {
    throw new Error("Central URL is not configured");
  }

  const parsed = new URL(centralUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString().replace(/\/$/, "");
}

function setAuthenticatedSession(req, sessionUser) {
  req.session.username = sessionUser.username;
  req.session.role = sessionUser.role;
  req.session.centralUserId = sessionUser.userId || null;
  req.session.centralEmail = sessionUser.email || null;
  req.session.ssoAuthenticated = Boolean(sessionUser.ssoAuthenticated);
}

function isAllowedPodManRole(role) {
  return ALLOWED_POD_MAN_ROLES.has(String(role || "").trim().toLowerCase());
}

function normalizePodManRole(role) {
  return String(role || "").trim().toLowerCase();
}

function assertAllowedPodManRole(role) {
  const normalized = normalizePodManRole(role);
  if (!isAllowedPodManRole(normalized)) {
    throw new Error(`Unsupported role: ${role || "missing"}`);
  }
  return normalized;
}

function establishAuthenticatedSession(req, sessionUser, callback) {
  req.session.regenerate((error) => {
    if (error) {
      callback(error);
      return;
    }
    setAuthenticatedSession(req, sessionUser);
    req.session.save(callback);
  });
}

async function ensureRestrictedShellUser(scriptName) {
  await execPromise(`bash ${path.resolve("./scripts", scriptName)}`);
}

async function ensureAuxiliaryShellAccounts() {
  const roles = new Set((config.authentication.users || []).map((user) => user.role));

  if (roles.has("demo")) {
    try {
      await ensureRestrictedShellUser("setup-demo-user.sh");
    } catch (error) {
      console.error("Failed to ensure demo shell user:", error.message);
    }
  }

  if (roles.has("standard")) {
    try {
      await ensureRestrictedShellUser("setup-standard-user.sh");
    } catch (error) {
      console.error("Failed to ensure standard shell user:", error.message);
    }
  }
}

// Auth middleware
function requireAuth(req, res, next) {
  if (!config.authentication.enabled) {
    return next();
  }
  
  if (!req.session || !req.session.username) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }
  
  next();
}

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (!config.authentication.enabled) {
    return next();
  }
  
  if (!req.session || !req.session.username || req.session.role !== "admin") {
    return res.status(403).json({ success: false, error: "Admin access required" });
  }
  
  next();
}

// Admin or Standard user middleware (excludes demo)
function requireAdminOrStandard(req, res, next) {
  if (!config.authentication.enabled) {
    return next();
  }
  
  if (!req.session || !req.session.username) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }
  
  if (!["admin", "standard"].includes(req.session.role)) {
    return res.status(403).json({ success: false, error: "This role cannot perform that action" });
  }
  
  // Allow admin and standard
  next();
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

/**
 * Check if setup is needed (no users exist)
 */
app.get("/api/setup/status", (req, res) => {
  res.json({
    success: true,
    needsSetup: config.authentication.users.length === 0,
    setupTokenRequired: config.authentication.users.length === 0
  });
});

/**
 * Initialize first-time setup (create admin + optional users)
 */
app.post("/api/setup/initialize", async (req, res) => {
  try {
    // Only allow if no users exist
    if (config.authentication.users.length > 0) {
      return res.status(403).json({ success: false, error: "Setup already completed" });
    }
    
    const { users, setupToken } = req.body;

    if (!setupToken || setupToken !== config.authentication.setupToken) {
      return res.status(403).json({ success: false, error: "Valid setup token required" });
    }
    
    if (!users || !Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ success: false, error: "No users provided" });
    }
    
    // Validate and hash passwords
    const newUsers = [];
    let hasDemoUser = false;
    let hasStandardUser = false;
    
    for (const user of users) {
      if (!user.username || !user.password || !user.role) {
        return res.status(400).json({ success: false, error: "Invalid user data" });
      }

      let normalizedRole;
      try {
        normalizedRole = assertAllowedPodManRole(user.role);
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
      
      const hashedPassword = await bcrypt.hash(user.password, 10);
      newUsers.push({
        username: user.username,
        password: hashedPassword,
        role: normalizedRole
      });
      
      if (normalizedRole === 'demo') {
        hasDemoUser = true;
      } else if (normalizedRole === 'standard') {
        hasStandardUser = true;
      }
    }
    
    // Save users to config
    config.authentication.enabled = true;
    config.authentication.users = newUsers;
    config.authentication.setupToken = "";
    saveConfig();
    
    if (hasDemoUser) {
      try {
        await ensureRestrictedShellUser("setup-demo-user.sh");
      } catch (error) {
        console.error('Failed to setup demo user:', error);
      }
    }

    if (hasStandardUser) {
      try {
        await ensureRestrictedShellUser("setup-standard-user.sh");
      } catch (error) {
        console.error('Failed to setup standard user:', error);
      }
    }
    
    res.json({ success: true, message: "Setup completed" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Login
 */
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: "Username and password required" });
    }
    
    const user = config.authentication.users.find(u => u.username === username);
    
    if (!user) {
      logLocalAuditEvent("podman_local_login_failure", {
        req,
        outcome: "denied",
        summary: "Pod-Man login failed",
        details: { username: username || null, reason: "unknown-user" }
      });
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    if (!isAllowedPodManRole(user.role)) {
      logLocalAuditEvent("podman_local_login_failure", {
        req,
        outcome: "denied",
        summary: "Pod-Man login rejected",
        details: { username: user.username, reason: "unsupported-role", role: user.role || null }
      });
      return res.status(403).json({ success: false, error: "This account has an unsupported role. Contact a local admin." });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      logLocalAuditEvent("podman_local_login_failure", {
        req,
        outcome: "denied",
        summary: "Pod-Man login failed",
        details: { username: user.username, reason: "invalid-password" }
      });
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }
    
    establishAuthenticatedSession(req, {
      username: user.username,
      role: user.role,
      userId: null,
      email: null,
      ssoAuthenticated: false
    }, (error) => {
      if (error) {
        logLocalAuditEvent("podman_local_login_failure", {
          req,
          outcome: "failed",
          summary: "Pod-Man login session establishment failed",
          details: { username: user.username, reason: error.message }
        });
        return res.status(500).json({ success: false, error: "Failed to establish session" });
      }

      logLocalAuditEvent("podman_local_login_success", {
        req,
        summary: "Pod-Man local login succeeded",
        details: { username: user.username, role: user.role }
      });

      res.json({
        success: true,
        username: user.username,
        role: user.role
      });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Logout
 */
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true });
  });
});

/**
 * Check session
 */
app.get("/api/check-session", (req, res) => {
  if (req.session && req.session.username) {
    res.json({
      success: true,
      authenticated: true,
      username: req.session.username,
      role: req.session.role,
      centralEmail: req.session.centralEmail || null,
      centralUserId: req.session.centralUserId || null,
      ssoAuthenticated: Boolean(req.session.ssoAuthenticated)
    });
  } else {
    res.json({
      success: true,
      authenticated: false
    });
  }
});

/**
 * Central SSO callback
 */
app.get("/sso/central", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";

  if (!config.centralManagement?.enabled || !config.centralManagement?.apiKey) {
    logLocalAuditEvent("podman_sso_failure", {
      req,
      outcome: "denied",
      summary: "Central SSO rejected",
      details: { reason: "central-sso-not-configured" }
    });
    return res.status(503).send("Central SSO is not configured on this pNode.");
  }

  if (!token) {
    logLocalAuditEvent("podman_sso_failure", {
      req,
      outcome: "denied",
      summary: "Central SSO rejected",
      details: { reason: "missing-token" }
    });
    return res.status(400).send("Missing SSO token.");
  }

  if (!centralConnector.pnodeId) {
    logLocalAuditEvent("podman_sso_failure", {
      req,
      outcome: "denied",
      summary: "Central SSO rejected",
      details: { reason: "pnode-not-registered" }
    });
    return res.status(503).send("This pNode is not registered with Central yet.");
  }

  try {
    console.log(`[Central-SSO] Callback start: pnode=${centralConnector.pnodeId} token=${token.slice(0, 12)}...`);
    const centralBaseUrl = getCentralHttpBaseUrl();
    const response = await axios.post(
      `${centralBaseUrl}/api/internal/sso/consume`,
      {
        token,
        pnodeId: centralConnector.pnodeId,
        service: "pod-man"
      },
      {
        headers: {
          Authorization: `Bearer ${config.centralManagement.apiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    const sessionUser = response.data?.sessionUser;

    const normalizedRole = normalizePodManRole(sessionUser?.role);

    if (!response.data?.success || !sessionUser?.username || !normalizedRole || !isAllowedPodManRole(normalizedRole)) {
      console.error("[Central-SSO] Rejecting session: invalid session user payload");
      logLocalAuditEvent("podman_sso_failure", {
        req,
        outcome: "denied",
        summary: "Central SSO rejected",
        details: { reason: "invalid-session-user-payload" }
      });
      return res.status(401).send("Central SSO was rejected.");
    }

    const sanitizedSessionUser = {
      ...sessionUser,
      role: normalizedRole
    };

    return establishAuthenticatedSession(req, sanitizedSessionUser, (error) => {
      if (error) {
        console.error("[Central-SSO] Failed to save session:", error.message);
        logLocalAuditEvent("podman_sso_failure", {
          req,
          outcome: "failed",
          summary: "Central SSO session establishment failed",
          details: { reason: error.message, username: sanitizedSessionUser.username }
        });
        return res.status(500).send("Failed to establish pod-man session.");
      }

      console.log(`[Central-SSO] Session established for ${sanitizedSessionUser.username}`);
      logLocalAuditEvent("podman_sso_success", {
        req,
        summary: "Central SSO succeeded",
        details: {
          username: sanitizedSessionUser.username,
          role: sanitizedSessionUser.role,
          centralUserId: sanitizedSessionUser.userId || null,
          centralEmail: sanitizedSessionUser.email || null
        }
      });
      res.redirect("/");
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error || error.message;
    console.error("[Central-SSO] Consume failed:", message);
    logLocalAuditEvent("podman_sso_failure", {
      req,
      outcome: status >= 500 ? "failed" : "denied",
      summary: "Central SSO consume failed",
      details: { reason: message, status }
    });
    return res.status(status).send(`Central SSO failed: ${message}`);
  }
});

/**
 * Add user (admin only)
 */
app.post("/api/users/add", requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    
    if (!username || !password || !role) {
      logLocalAuditEvent("podman_user_add", {
        req,
        outcome: "denied",
        summary: "Pod-Man user creation rejected",
        details: { reason: "missing-fields", username: username || null, role: role || null }
      });
      return res.status(400).json({ success: false, error: "Username, password, and role required" });
    }
    
    // Check if user exists
    if (config.authentication.users.find(u => u.username === username)) {
      logLocalAuditEvent("podman_user_add", {
        req,
        outcome: "denied",
        summary: "Pod-Man user creation rejected",
        details: { reason: "username-exists", username }
      });
      return res.status(400).json({ success: false, error: "Username already exists" });
    }

    let normalizedRole;
    try {
      normalizedRole = assertAllowedPodManRole(role);
    } catch (error) {
      logLocalAuditEvent("podman_user_add", {
        req,
        outcome: "denied",
        summary: "Pod-Man user creation rejected",
        details: { reason: error.message, username, role }
      });
      return res.status(400).json({ success: false, error: error.message });
    }
    
    // Hash password and add user
    const hashedPassword = await bcrypt.hash(password, 10);
    config.authentication.users.push({
      username,
      password: hashedPassword,
      role: normalizedRole
    });
    
    saveConfig();
    
    if (normalizedRole === 'demo') {
      try {
        await ensureRestrictedShellUser("setup-demo-user.sh");
      } catch (error) {
        console.error('Failed to setup demo user:', error);
      }
    } else if (normalizedRole === 'standard') {
      try {
        await ensureRestrictedShellUser("setup-standard-user.sh");
      } catch (error) {
        console.error('Failed to setup standard user:', error);
      }
    }
    
    logLocalAuditEvent("podman_user_added", {
      req,
      summary: "Pod-Man user added",
      details: { username, role: normalizedRole }
    });
    res.json({ success: true, message: "User added" });
  } catch (error) {
    logLocalAuditEvent("podman_user_add", {
      req,
      outcome: "failed",
      summary: "Pod-Man user creation failed",
      details: { username: req.body?.username || null, reason: error.message }
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete user (admin only)
 */
app.post("/api/users/delete", requireAdmin, (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      logLocalAuditEvent("podman_user_delete", {
        req,
        outcome: "denied",
        summary: "Pod-Man user deletion rejected",
        details: { reason: "missing-username" }
      });
      return res.status(400).json({ success: false, error: "Username required" });
    }
    
    // Don't allow deleting yourself
    if (username === req.session.username) {
      logLocalAuditEvent("podman_user_delete", {
        req,
        outcome: "denied",
        summary: "Pod-Man user deletion rejected",
        details: { username, reason: "cannot-delete-self" }
      });
      return res.status(400).json({ success: false, error: "Cannot delete your own account" });
    }
    
    // Ensure at least one admin remains
    const admins = config.authentication.users.filter(u => u.role === 'admin');
    const userToDelete = config.authentication.users.find(u => u.username === username);
    
    if (userToDelete && userToDelete.role === 'admin' && admins.length <= 1) {
      logLocalAuditEvent("podman_user_delete", {
        req,
        outcome: "denied",
        summary: "Pod-Man user deletion rejected",
        details: { username, reason: "last-admin-protection" }
      });
      return res.status(400).json({ success: false, error: "Cannot delete last admin user" });
    }
    
    // Remove user
    config.authentication.users = config.authentication.users.filter(u => u.username !== username);
    saveConfig();
    
    logLocalAuditEvent("podman_user_deleted", {
      req,
      summary: "Pod-Man user deleted",
      details: { username }
    });
    res.json({ success: true, message: "User deleted" });
  } catch (error) {
    logLocalAuditEvent("podman_user_delete", {
      req,
      outcome: "failed",
      summary: "Pod-Man user deletion failed",
      details: { username: req.body?.username || null, reason: error.message }
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * List users (admin only)
 */
app.get("/api/users/list", requireAdmin, (req, res) => {
  const users = config.authentication.users.map(u => ({
    username: u.username,
    role: u.role
  }));
  
  res.json({ success: true, users });
});



// ============================================================================
// CENTRAL MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * Get central connection status
 */
app.get("/api/central/status", requireAuth, (req, res) => {
  res.json({
    success: true,
    status: centralConnector.getStatus()
  });
});

app.post("/api/central/owner/reset", requireAdmin, (req, res) => {
  if (typeof centralConnector.audit === "function") {
    centralConnector.audit('central-owner-reset', {
      localAdmin: req.session.username || null
    });
  }
  config.centralManagement.ownerCentralUserId = "";
  config.centralManagement.ownerCentralEmail = "";
  config.centralManagement.ownerBoundAt = "";
  config.centralManagement.ownerBindingSource = "";
  saveConfig();
  centralConnector.updateConfig(config.centralManagement);
  logLocalAuditEvent("podman_central_owner_reset", {
    req,
    summary: "Central owner binding reset locally"
  });
  res.json({
    success: true,
    status: centralConnector.getStatus()
  });
});

/**
 * Update central connection config (admin only)
 */
app.post("/api/central/configure", requireAdmin, async (req, res) => {
  try {
    const { enabled, apiKey, centralUrl, autoConnect } = req.body;
    const changed = {};
    
    // Update config file
    if (apiKey !== undefined) {
      config.centralManagement.apiKey = apiKey;
      changed.apiKeyUpdated = true;
    }
    if (centralUrl !== undefined) {
      config.centralManagement.centralUrl = centralUrl;
      changed.centralUrl = centralUrl;
    }
    if (enabled !== undefined) {
      config.centralManagement.enabled = enabled;
      changed.enabled = Boolean(enabled);
    }
    if (autoConnect !== undefined) {
      config.centralManagement.autoConnect = autoConnect;
      changed.autoConnect = Boolean(autoConnect);
    }
    
    saveConfig();
    
    // Update connector
    centralConnector.updateConfig(config.centralManagement);
    logLocalAuditEvent("podman_central_config_updated", {
      req,
      summary: "Central configuration updated locally",
      details: changed
    });
    
    res.json({ success: true, status: centralConnector.getStatus() });
  } catch (error) {
    logLocalAuditEvent("podman_central_config_updated", {
      req,
      outcome: "failed",
      summary: "Central configuration update failed",
      details: { reason: error.message }
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Connect to central server (admin only)
 */
app.post("/api/central/connect", requireAdmin, async (req, res) => {
  try {
    await centralConnector.connect();
    logLocalAuditEvent("podman_central_connect", {
      req,
      summary: "Central connection initiated locally"
    });
    res.json({ success: true, status: centralConnector.getStatus() });
  } catch (error) {
    logLocalAuditEvent("podman_central_connect", {
      req,
      outcome: "failed",
      summary: "Central connection failed",
      details: { reason: error.message }
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Disconnect from central server (admin only)
 */
app.post("/api/central/disconnect", requireAdmin, (req, res) => {
  centralConnector.disconnect();
  logLocalAuditEvent("podman_central_disconnect", {
    req,
    summary: "Central connection disconnected locally"
  });
  res.json({ success: true, status: centralConnector.getStatus() });
});

/**
 * Dashboard overview
 */
app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const [services, system, network, prpcHealth] = await Promise.all([
      ServiceManager.getStatusSummary(),
      SystemMonitor.getAllStats(),
      NetworkManager.getSummary(),
      PRPCClient.healthCheck()
    ]);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      services,
      system,
      network,
      prpc: prpcHealth
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get all service statuses
 */
app.get("/api/services", requireAuth, async (req, res) => {
  try {
    const statuses = await ServiceManager.getAllStatus();
    res.json({ success: true, services: statuses });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single service status
 */
app.get("/api/services/:name", requireAuth, async (req, res) => {
  try {
    const status = await ServiceManager.getStatus(req.params.name);
    res.json({ success: true, service: status });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * Control a service (start/stop/restart)
 */
app.post("/api/services/:name/:action", requireAdmin, async (req, res) => {
  if (!config.security.enableServiceControl) {
    logLocalAuditEvent("podman_service_control", {
      req,
      outcome: "denied",
      summary: "Pod-Man service control denied",
      details: { service: req.params.name, action: req.params.action, reason: "service-control-disabled" }
    });
    return res.status(403).json({ success: false, error: "Service control is disabled" });
  }
  
  try {
    const result = await ServiceManager.controlService(
      req.params.name,
      req.params.action
    );
    logLocalAuditEvent("podman_service_control", {
      req,
      summary: "Pod-Man service control executed",
      details: { service: req.params.name, action: req.params.action }
    });
    res.json(result);
  } catch (error) {
    logLocalAuditEvent("podman_service_control", {
      req,
      outcome: "failed",
      summary: "Pod-Man service control failed",
      details: { service: req.params.name, action: req.params.action, reason: error.message }
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * Restart all services
 */
app.post("/api/services/restart-all", requireAdmin, async (req, res) => {
  if (!config.security.enableServiceControl) {
    logLocalAuditEvent("podman_restart_all", {
      req,
      outcome: "denied",
      summary: "Restart-all denied",
      details: { reason: "service-control-disabled" }
    });
    return res.status(403).json({ success: false, error: "Service control is disabled" });
  }
  
  try {
    const results = await ServiceManager.restartAll();
    logLocalAuditEvent("podman_restart_all", {
      req,
      summary: "Restarted all managed services"
    });
    res.json({ success: true, results });
  } catch (error) {
    logLocalAuditEvent("podman_restart_all", {
      req,
      outcome: "failed",
      summary: "Restart-all failed",
      details: { reason: error.message }
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get logs for a service
 */
app.get("/api/logs/:service", requireAuth, async (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 50;
    const filter = req.query.filter || null;
    
    // Set longer timeout for large log requests
    req.setTimeout(30000); // 30 seconds
    
    const logs = await LogManager.getLogs(req.params.service, lines, filter);
    res.json(logs);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * Find pubkey (restart pod and extract from logs)
 */
app.post("/api/find-pubkey", requireAdmin, async (req, res) => {
  try {
    const result = await refreshPodPubkey();
    logLocalAuditEvent("podman_pubkey_refresh", {
      req,
      summary: "Pod-Man pubkey refresh executed",
      details: {
        pubkey: result?.pubkey || null,
        success: result?.success !== false
      }
    });
    res.json(result);
  } catch (error) {
    logLocalAuditEvent("podman_pubkey_refresh", {
      req,
      outcome: "failed",
      summary: "Pod-Man pubkey refresh failed",
      details: { reason: error.message }
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * pRPC API calls
 */
app.post("/api/prpc/:method", requireAuth, async (req, res) => {
  try {
    const method = req.params.method;
    const params = (req.body && req.body.params) || {};
    
    let result;
    
    // Handle known methods
    switch (method) {
      case "get-version":
        result = await PRPCClient.getVersion();
        break;
      case "get-stats":
        result = await PRPCClient.getStats();
        break;
      case "get-pods":
        result = await PRPCClient.getPods();
        break;
      case "get-pods-with-stats":
        result = await PRPCClient.getPodsWithStats();
        break;
      default:
        // Custom method
        result = await PRPCClient.customCall(method, params);
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Component versions
 */
app.get("/api/component-versions", requireAuth, async (req, res) => {
  try {
    const versions = await getComponentVersions();
    res.json({ success: true, versions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Network diagnostics
 */
app.get("/api/network", requireAuth, async (req, res) => {
  try {
    const diagnostics = await NetworkManager.runDiagnostics();
    res.json({ success: true, diagnostics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * System stats
 */
app.get("/api/system", requireAuth, async (req, res) => {
  try {
    const stats = await SystemMonitor.getAllStats();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Health check
 */
app.get("/api/health", requireAuth, async (req, res) => {
  try {
    const [systemHealth, serviceStatus] = await Promise.all([
      SystemMonitor.getHealthStatus(),
      ServiceManager.getStatusSummary()
    ]);
    
    const overallScore = Math.floor(
      (systemHealth.score * 0.4) + 
      ((serviceStatus.summary.running / serviceStatus.summary.total) * 100 * 0.6)
    );
    
    res.json({
      success: true,
      score: overallScore,
      status: overallScore >= 80 ? "healthy" : overallScore >= 50 ? "warning" : "critical",
      system: systemHealth,
      services: serviceStatus
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get terminal activity log
 */
app.get("/api/terminal/activity", requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const log = terminalManager.getActivityLog(limit);
  res.json({ success: true, log });
});

// ============================================================================
// WEBSOCKET TERMINAL HANDLER
// ============================================================================

/**
 * Passive pubkey lookup (no restart)
 */
app.get("/api/pod-pubkey", requireAuth, async (req, res) => {
  try {
    const result = await getPodPubkey();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Detect pod cluster from pod.service configuration
 */
app.get("/api/pod-cluster", requireAuth, async (req, res) => {
  try {
    const result = await detectPodCluster();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Credits: fetch global list and local credits (if pubkey known)
 */
app.get("/api/pod-credits", requireAuth, async (req, res) => {
  try {
    const summary = await getClusterAwareCreditsSummary();
    if (!summary.success) {
      return res.status(400).json(summary);
    }
    res.json({
      success: true,
      cluster: summary.cluster,
      clusterLabel: summary.clusterLabel,
      creditsEndpoint: summary.creditsEndpoint,
      leaderboardScope: summary.leaderboardScope,
      pubkey: summary.pubkey,
      pubkeyResult: summary.pubkeyResult,
      credits: summary.localCredits,
      list: summary.list
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DevNet eligibility (95th percentile * 0.8 threshold)
 */
app.get("/api/devnet-eligibility", requireAuth, async (req, res) => {
  try {
    const summary = await getClusterAwareCreditsSummary();
    if (!summary.success) {
      return res.status(400).json(summary);
    }

    res.json({
      success: true,
      cluster: summary.cluster,
      clusterLabel: summary.clusterLabel,
      creditsEndpoint: summary.creditsEndpoint,
      leaderboardScope: summary.leaderboardScope,
      clusterDetails: summary.clusterDetails,
      pubkey: summary.pubkey,
      pubkeyResult: summary.pubkeyResult,
      localCredits: summary.localCredits,
      percentile95: summary.percentile95,
      threshold: summary.threshold,
      maxCredits: summary.maxCredits,
      eligible: summary.eligible,
      totalPods: summary.totalPods
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

wss.on("connection", (ws, req) => {
  if (!config.security.enableTerminal) {
    logLocalAuditEvent("podman_terminal_denied", {
      req,
      outcome: "denied",
      summary: "Terminal denied",
      details: { reason: "terminal-disabled" }
    });
    ws.close(1008, "Terminal access is disabled");
    return;
  }

  sessionMiddleware(req, {}, () => {
    if (!req.session || !req.session.username) {
      logLocalAuditEvent("podman_terminal_denied", {
        req,
        outcome: "denied",
        summary: "Terminal denied",
        details: { reason: "not-authenticated" }
      });
      ws.close(1008, "Authentication required");
      return;
    }

    if (req.session.role !== "admin") {
      logLocalAuditEvent("podman_terminal_denied", {
        req,
        outcome: "denied",
        summary: "Terminal denied",
        details: { reason: "admin-session-required", role: req.session.role || null }
      });
      ws.close(1008, "Terminal access requires an admin session");
      return;
    }

    const sessionId = generateSessionId();
    let ptyProcess = null;
    let sessionCreated = false;

    console.log(`[Terminal] New connection: ${sessionId}`);
    logLocalAuditEvent("podman_terminal_opened", {
      req,
      summary: "Terminal websocket opened",
      details: { sessionId }
    });

    // Handle incoming data from WebSocket
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);

        // Create the terminal session from the authenticated server session only.
        if (message.type === "auth" && !sessionCreated) {
          const userRole = req.session.role || "standard";

          try {
            ptyProcess = terminalManager.createSession(sessionId, 80, 24, userRole);
            sessionCreated = true;

            // Send data from PTY to WebSocket
            ptyProcess.on("data", (chunk) => {
              try {
                if (ws.readyState === 1) { // OPEN
                  ws.send(chunk);
                }
              } catch (error) {
                console.error(`[Terminal] Error sending data: ${error.message}`);
              }
            });

            // Handle PTY exit
            ptyProcess.on("exit", () => {
              console.log(`[Terminal] PTY exited: ${sessionId}`);
              terminalManager.closeSession(sessionId);
              if (ws.readyState === 1) {
                ws.close();
              }
            });

            console.log(`[Terminal] Session created for role: ${userRole}`);
          } catch (error) {
            logLocalAuditEvent("podman_terminal_denied", {
              req,
              outcome: "failed",
              summary: "Terminal session creation failed",
              details: { sessionId, reason: error.message, role: userRole }
            });
            console.error(`[Terminal] Error creating session: ${error.message}`);
            ws.send(`Error: ${error.message}\r\n`);
            ws.close();
          }
          return;
        }

        if (message.type === "input" && sessionCreated) {
          terminalManager.writeToSession(sessionId, message.data);
        } else if (message.type === "resize" && sessionCreated) {
          terminalManager.resizeSession(sessionId, message.cols, message.rows);
        }
      } catch (error) {
        console.error(`[Terminal] Error processing message: ${error.message}`);
      }
    });

    // Handle WebSocket close
    ws.on("close", () => {
      console.log(`[Terminal] Connection closed: ${sessionId}`);
      terminalManager.closeSession(sessionId);
      logLocalAuditEvent("podman_terminal_closed", {
        req,
        summary: "Terminal websocket closed",
        details: { sessionId }
      });
    });

    // Handle WebSocket error
    ws.on("error", (error) => {
      console.error(`[Terminal] WebSocket error: ${error.message}`);
      terminalManager.closeSession(sessionId);
    });
  });
});

// ============================================================================
// CLEANUP & STARTUP
// ============================================================================

// Clean up inactive terminal sessions periodically
setInterval(() => {
  terminalManager.cleanupInactiveSessions();
}, 300000); // Every 5 minutes

// Generate random session ID
function generateSessionId() {
  return `term_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Start server
const HOST = config.server.host;
const PORT = config.server.port;

async function startServer() {
  await ensureAuxiliaryShellAccounts();

  server.listen(PORT, HOST, () => {
    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Xandeum Pod Manager (Pod-Man)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");
    console.log(`  Server:    http://${HOST}:${PORT}`);
    console.log(`  Host:      ${HOST === "127.0.0.1" ? "Localhost only" : "Public"}`);
    console.log(`  Security:  Rate limiting ${config.security.rateLimit.enabled ? "enabled" : "disabled"}`);
    console.log(`  Terminal:  ${config.security.enableTerminal ? "Enabled" : "Disabled"}`);
    console.log(`  Services:  ${config.security.enableServiceControl ? "Control enabled" : "Read-only"}`);
    if (config.authentication.users.length === 0 && config.authentication.setupToken) {
      console.log(`  Setup Token: ${config.authentication.setupToken}`);
    }
    console.log("");
    if (HOST === "127.0.0.1") {
      console.log("  Access remotely via SSH tunnel:");
      console.log(`  ssh -L ${PORT}:localhost:${PORT} user@your-server`);
    }
    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");
    
    // Connect to central management server if enabled
    if (config.centralManagement && config.centralManagement.enabled && config.centralManagement.autoConnect) {
      console.log("[Central] Auto-connecting to central management server...");
      centralConnector.connect();
    }
  });
}

startServer().catch((error) => {
  console.error("Failed to start Pod-Man:", error.message);
  process.exit(1);
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("\n\nReceived SIGTERM, shutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
