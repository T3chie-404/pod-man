const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec);
const PRPCClient = require("./api");

const BASE58_PUBKEY_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,48}/;
const CACHE_FILE = "/tmp/xpm_pubkey_cache.txt";
const CONFIG_FILE = path.resolve(__dirname, "..", "config.json");
const KEYPAIR_SOURCES = [
  {
    source: "xandminerd-keypair",
    path: "/root/xandminerd/keypairs/pnode-keypair.json"
  },
  {
    source: "local-keypair",
    path: "/local/keypairs/pnode-keypair.json"
  }
];

function extractPubkey(raw) {
  if (!raw) {
    return null;
  }

  const jsonFieldMatch = raw.match(/"publi?cKey"\s*:\s*"([^"]+)"/i);
  if (jsonFieldMatch) {
    return jsonFieldMatch[1];
  }

  const base58Match = raw.match(BASE58_PUBKEY_REGEX);
  return base58Match ? base58Match[0] : null;
}

function isValidPubkey(value) {
  return typeof value === "string" && BASE58_PUBKEY_REGEX.test(value);
}

function buildKeypairDiagnostics(entries = []) {
  const validEntries = entries.filter((entry) => isValidPubkey(entry.pubkey));
  const uniquePubkeys = [...new Set(validEntries.map((entry) => entry.pubkey))];
  const matchStatus = validEntries.length <= 1
    ? (validEntries.length === 1 ? "single-source" : "missing")
    : (uniquePubkeys.length === 1 ? "match" : "mismatch");

  return {
    keypairSources: entries,
    allDetectedPubkeys: uniquePubkeys,
    keypairMatchStatus: matchStatus,
    keypairMismatch: matchStatus === "mismatch"
  };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readConfigPubkey() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return null;
    }

    const config = readJsonFile(CONFIG_FILE);
    return isValidPubkey(config.pubkey) ? config.pubkey : null;
  } catch (error) {
    return null;
  }
}

function persistPubkey(pubkey) {
  if (!isValidPubkey(pubkey)) {
    return;
  }

  try {
    fs.writeFileSync(CACHE_FILE, `${pubkey}\n`, "utf8");
  } catch (error) {
    // Best effort cache only.
  }

  try {
    const config = fs.existsSync(CONFIG_FILE) ? readJsonFile(CONFIG_FILE) : {};
    if (config.pubkey !== pubkey) {
      config.pubkey = pubkey;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    }
  } catch (error) {
    // Best effort persistence only.
  }
}

function inspectKeypairSources() {
  const entries = KEYPAIR_SOURCES.map((candidate) => {
    try {
      if (!fs.existsSync(candidate.path)) {
        return {
          source: candidate.source,
          path: candidate.path,
          exists: false,
          pubkey: null
        };
      }

      const raw = fs.readFileSync(candidate.path, "utf8");
      const pubkey = extractPubkey(raw);

      return {
        source: candidate.source,
        path: candidate.path,
        exists: true,
        pubkey: isValidPubkey(pubkey) ? pubkey : null
      };
    } catch (error) {
      return {
        source: candidate.source,
        path: candidate.path,
        exists: true,
        pubkey: null,
        error: error.message
      };
    }
  });

  const diagnostics = buildKeypairDiagnostics(entries);
  const preferredEntry = entries.find((entry) => isValidPubkey(entry.pubkey)) || null;

  return {
    preferredEntry,
    ...diagnostics
  };
}

async function readKeypairPubkey() {
  const diagnostics = inspectKeypairSources();
  const preferredEntry = diagnostics.preferredEntry;

  if (!preferredEntry) {
    return null;
  }

  persistPubkey(preferredEntry.pubkey);
  return {
    success: true,
    pubkey: preferredEntry.pubkey,
    source: preferredEntry.source,
    path: preferredEntry.path,
    ...diagnostics
  };
}

async function readPrpcPubkey() {
  try {
    const result = await PRPCClient.call("get-pubkey");
    if (!result?.success) {
      return null;
    }

    const raw = result.result;
    const pubkey =
      (typeof raw === "string" && raw) ||
      raw?.pubkey ||
      raw?.publicKey ||
      raw?.result ||
      extractPubkey(JSON.stringify(raw));

    if (isValidPubkey(pubkey)) {
      persistPubkey(pubkey);
      return {
        success: true,
        pubkey,
        source: "prpc"
      };
    }
  } catch (error) {
    return null;
  }

  return null;
}

function readCachedPubkey() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }

    const pubkey = fs.readFileSync(CACHE_FILE, "utf8").trim();
    return isValidPubkey(pubkey)
      ? { success: true, pubkey, source: "cache" }
      : null;
  } catch (error) {
    return null;
  }
}

async function scanLogsForPubkey() {
  try {
    const { stdout } = await execPromise(
      "journalctl -u pod.service --no-pager --lines=1000 | grep -i pubkey"
    );
    const lines = stdout.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      const pubkey = extractPubkey(line);
      if (isValidPubkey(pubkey)) {
        persistPubkey(pubkey);
        return {
          success: true,
          pubkey,
          source: "logs",
          lines
        };
      }
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function getPodPubkey(options = {}) {
  const { allowLogScan = false } = options;
  const keypairDiagnostics = inspectKeypairSources();

  const keypairResult = await readKeypairPubkey();
  if (keypairResult) {
    return keypairResult;
  }

  const prpcResult = await readPrpcPubkey();
  if (prpcResult) {
    return {
      ...prpcResult,
      ...keypairDiagnostics
    };
  }

  const configPubkey = readConfigPubkey();
  if (configPubkey) {
    return {
      success: true,
      pubkey: configPubkey,
      source: "config",
      ...keypairDiagnostics
    };
  }

  const cacheResult = readCachedPubkey();
  if (cacheResult) {
    return {
      ...cacheResult,
      ...keypairDiagnostics
    };
  }

  if (allowLogScan) {
    const logResult = await scanLogsForPubkey();
    if (logResult) {
      return {
        ...logResult,
        ...keypairDiagnostics
      };
    }
  }

  return {
    success: false,
    pubkey: null,
    source: null,
    error: "Pubkey not found",
    ...keypairDiagnostics
  };
}

async function refreshPodPubkey() {
  await execPromise("systemctl restart pod.service");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return getPodPubkey({ allowLogScan: true });
}

module.exports = {
  extractPubkey,
  getPodPubkey,
  refreshPodPubkey,
  inspectKeypairSources
};
