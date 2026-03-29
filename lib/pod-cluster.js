const fs = require("fs");
const util = require("util");
const { exec } = require("child_process");

const execPromise = util.promisify(exec);

const SERVICE_PATHS = [
  "/etc/systemd/system/pod.service",
  "/lib/systemd/system/pod.service"
];

function normalizeCluster(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const lower = value.toLowerCase();
  if (lower === "mainnet" || lower === "mainnet-alpha") {
    return "mainnet-alpha";
  }
  if (lower === "devnet") {
    return "devnet";
  }
  if (lower === "trynet") {
    return "trynet";
  }
  return null;
}

function parseClusterFromText(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const atlasMatch = text.match(/--atlas-cluster(?:=|\s+)(trynet|devnet|mainnet-alpha)\b/i)
    || text.match(/ATLAS_CLUSTER(?:=|\s+)(trynet|devnet|mainnet-alpha)\b/i);
  if (atlasMatch) {
    return normalizeCluster(atlasMatch[1]);
  }

  if (/\s--mainnet-alpha\b/i.test(text)) {
    return "mainnet-alpha";
  }
  if (/\s--devnet\b/i.test(text)) {
    return "devnet";
  }
  if (/\s--trynet\b/i.test(text)) {
    return "trynet";
  }

  return null;
}

function getCreditsEndpointForCluster(cluster) {
  switch (cluster) {
    case "mainnet-alpha":
      return "https://podcredits.xandeum.network/api/mainnet-pod-credits";
    case "devnet":
      return "https://podcredits.xandeum.network/api/pods-credits";
    default:
      return null;
  }
}

function getClusterLabel(cluster) {
  switch (cluster) {
    case "mainnet-alpha":
      return "Mainnet Alpha";
    case "devnet":
      return "Devnet";
    case "trynet":
      return "Trynet";
    default:
      return "Unknown";
  }
}

function buildClusterResult(cluster, source, servicePath, commandText) {
  return {
    success: Boolean(cluster),
    cluster: cluster || null,
    clusterLabel: getClusterLabel(cluster),
    creditsEndpoint: getCreditsEndpointForCluster(cluster),
    source: source || null,
    servicePath: servicePath || null,
    commandText: commandText || null
  };
}

function inspectServiceFile(servicePath) {
  try {
    if (!fs.existsSync(servicePath)) {
      return null;
    }

    const raw = fs.readFileSync(servicePath, "utf8");
    const cluster = parseClusterFromText(raw);
    if (!cluster) {
      return null;
    }

    const execStartMatch = raw.match(/^ExecStart=(.+)$/mi);
    return buildClusterResult(cluster, "service-file", servicePath, execStartMatch ? execStartMatch[1].trim() : null);
  } catch (error) {
    return null;
  }
}

async function inspectSystemctlDefinition() {
  try {
    const { stdout } = await execPromise("systemctl cat pod.service");
    const cluster = parseClusterFromText(stdout);
    if (!cluster) {
      return null;
    }
    const execStartMatch = stdout.match(/^ExecStart=(.+)$/mi);
    return buildClusterResult(cluster, "systemctl-cat", "/etc/systemd/system/pod.service", execStartMatch ? execStartMatch[1].trim() : null);
  } catch (error) {
    return null;
  }
}

async function detectPodCluster() {
  for (const servicePath of SERVICE_PATHS) {
    const result = inspectServiceFile(servicePath);
    if (result) {
      return result;
    }
  }

  const systemctlResult = await inspectSystemctlDefinition();
  if (systemctlResult) {
    return systemctlResult;
  }

  return buildClusterResult(null, null, null, null);
}

module.exports = {
  detectPodCluster,
  getCreditsEndpointForCluster,
  getClusterLabel,
  normalizeCluster,
  parseClusterFromText
};
