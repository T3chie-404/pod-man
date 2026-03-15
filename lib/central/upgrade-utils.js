const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const util = require('util');
const { execFile } = require('child_process');

const execFileAsync = util.promisify(execFile);

const CLUSTERS = ['trynet', 'devnet', 'mainnet-alpha'];
const PRPC_MODES = ['public', 'private'];
const INSTALLER_URL = 'https://raw.githubusercontent.com/Xandeum/xandminer-installer/refs/heads/master/install.sh';
const JOB_DIR = '/root/pod-man/upgrade-jobs';
const STATE_FILE = path.join(JOB_DIR, 'current-job.json');
const LOG_FILE = path.join(JOB_DIR, 'current-job.log');

const TEXT_CONFIG_PATHS = [
  '/etc/systemd/system/xandminer.service',
  '/etc/systemd/system/xandminerd.service',
  '/etc/systemd/system/pod.service',
  '/lib/systemd/system/xandminer.service',
  '/lib/systemd/system/xandminerd.service',
  '/lib/systemd/system/pod.service',
  '/etc/default/xandminer',
  '/etc/default/xandminerd',
  '/root/.config/xandeum/config.env',
  '/root/.config/xandeum/pnode.env',
  '/root/xandminerd/.env',
  '/root/xandminer/.env',
  '/root/install.sh'
];

const JSON_CONFIG_PATHS = [
  '/root/xandminer/config.json',
  '/root/xandminerd/config.json',
  '/root/.config/xandeum/config.json',
  '/root/.config/xandeum/pnode.json'
];

const TOML_CONFIG_PATHS = [
  '/root/xandminerd/config.toml',
  '/root/xandminer/config.toml',
  '/root/.config/xandeum/config.toml'
];

function isValidCluster(value) {
  return CLUSTERS.includes(value);
}

function isValidPrpcMode(value) {
  return PRPC_MODES.includes(value);
}

function normalizeCluster(value) {
  return isValidCluster(value) ? value : null;
}

function normalizePrpcMode(value) {
  return isValidPrpcMode(value) ? value : null;
}

function getJobPaths() {
  return {
    jobDir: JOB_DIR,
    stateFile: STATE_FILE,
    logFile: LOG_FILE
  };
}

async function ensureJobDir() {
  await fsp.mkdir(JOB_DIR, { recursive: true, mode: 0o700 });
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, filePath);
}

async function appendLogLine(filePath, message) {
  await ensureJobDir();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fsp.appendFile(filePath, line, 'utf8');
}

async function readLogTail(filePath, maxBytes = 64000, maxLines = 50) {
  try {
    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      const normalized = lines[0] === '' ? lines.slice(1) : lines;
      const trimmed = normalized[normalized.length - 1] === ''
        ? normalized.slice(0, -1)
        : normalized;
      return trimmed.slice(-maxLines).join('\n');
    } finally {
      await handle.close();
    }
  } catch (error) {
    return '';
  }
}

async function readCurrentJobState() {
  return readJsonIfExists(STATE_FILE);
}

async function clearCurrentJobState() {
  const files = [STATE_FILE];
  for (const file of files) {
    try {
      await fsp.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function runSystemctlCat(service) {
  try {
    const { stdout } = await execFileAsync('systemctl', ['cat', `${service}.service`], {
      maxBuffer: 1024 * 1024
    });
    return stdout;
  } catch (error) {
    return `${error.stdout || ''}\n${error.stderr || ''}`;
  }
}

function extractFlagsFromText(text) {
  if (!text || typeof text !== 'string') {
    return { atlasCluster: null, prpcMode: null };
  }

  const clusterMatch = text.match(/--atlas-cluster(?:=|\s+)(trynet|devnet|mainnet-alpha)\b/i)
    || text.match(/ATLAS_CLUSTER(?:=|\s+)(trynet|devnet|mainnet-alpha)\b/i)
    || text.match(/atlas[_-]cluster(?:\s*[:=]\s*|\s+)(trynet|devnet|mainnet-alpha)\b/i);
  const prpcMatch = text.match(/--prpc-mode(?:=|\s+)(public|private)\b/i)
    || text.match(/PRPC_MODE(?:=|\s+)(public|private)\b/i)
    || text.match(/prpc[_-]mode(?:\s*[:=]\s*|\s+)(public|private)\b/i);

  return {
    atlasCluster: clusterMatch ? normalizeCluster(clusterMatch[1].toLowerCase()) : null,
    prpcMode: prpcMatch ? normalizePrpcMode(prpcMatch[1].toLowerCase()) : null
  };
}

function extractFlagsFromObject(value) {
  if (!value || typeof value !== 'object') {
    return { atlasCluster: null, prpcMode: null };
  }

  const keysToTry = [
    'atlasCluster',
    'atlas_cluster',
    'cluster',
    'prpcMode',
    'prpc_mode',
    'mode'
  ];

  let atlasCluster = null;
  let prpcMode = null;

  for (const key of keysToTry) {
    const current = value[key];
    if (!atlasCluster && typeof current === 'string') {
      atlasCluster = normalizeCluster(current);
    }
    if (!prpcMode && typeof current === 'string') {
      prpcMode = normalizePrpcMode(current);
    }
  }

  for (const nested of Object.values(value)) {
    if (atlasCluster && prpcMode) {
      break;
    }
    if (nested && typeof nested === 'object') {
      const child = extractFlagsFromObject(nested);
      atlasCluster = atlasCluster || child.atlasCluster;
      prpcMode = prpcMode || child.prpcMode;
    }
  }

  return { atlasCluster, prpcMode };
}

async function detectNodeConfiguration() {
  const warnings = [];
  const sources = [];
  let atlasCluster = null;
  let prpcMode = null;

  for (const service of ['xandminer', 'xandminerd', 'pod']) {
    const text = await runSystemctlCat(service);
    const extracted = extractFlagsFromText(text);
    if (extracted.atlasCluster || extracted.prpcMode) {
      atlasCluster = atlasCluster || extracted.atlasCluster;
      prpcMode = prpcMode || extracted.prpcMode;
      sources.push(`systemd:${service}`);
    }
    if (atlasCluster && prpcMode) {
      break;
    }
  }

  if (!atlasCluster || !prpcMode) {
    for (const filePath of TEXT_CONFIG_PATHS) {
      try {
        const text = await fsp.readFile(filePath, 'utf8');
        const extracted = extractFlagsFromText(text);
        if (extracted.atlasCluster || extracted.prpcMode) {
          atlasCluster = atlasCluster || extracted.atlasCluster;
          prpcMode = prpcMode || extracted.prpcMode;
          sources.push(`text:${filePath}`);
        }
        if (atlasCluster && prpcMode) {
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          warnings.push(`Failed to inspect ${filePath}: ${error.message}`);
        }
      }
    }
  }

  if (!atlasCluster || !prpcMode) {
    for (const filePath of JSON_CONFIG_PATHS) {
      const json = await readJsonIfExists(filePath);
      if (!json) {
        continue;
      }
      const extracted = extractFlagsFromObject(json);
      if (extracted.atlasCluster || extracted.prpcMode) {
        atlasCluster = atlasCluster || extracted.atlasCluster;
        prpcMode = prpcMode || extracted.prpcMode;
        sources.push(`json:${filePath}`);
      }
      if (atlasCluster && prpcMode) {
        break;
      }
    }
  }

  if (!atlasCluster || !prpcMode) {
    for (const filePath of TOML_CONFIG_PATHS) {
      try {
        const text = await fsp.readFile(filePath, 'utf8');
        const extracted = extractFlagsFromText(text);
        if (extracted.atlasCluster || extracted.prpcMode) {
          atlasCluster = atlasCluster || extracted.atlasCluster;
          prpcMode = prpcMode || extracted.prpcMode;
          sources.push(`toml:${filePath}`);
        }
        if (atlasCluster && prpcMode) {
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          warnings.push(`Failed to inspect ${filePath}: ${error.message}`);
        }
      }
    }
  }

  if (!atlasCluster) {
    warnings.push('Unable to auto-detect atlas cluster from known service/config locations');
  }
  if (!prpcMode) {
    warnings.push('Unable to auto-detect pRPC mode from known service/config locations');
  }

  return {
    atlasCluster: atlasCluster || null,
    prpcMode: prpcMode || null,
    detectionSource: sources.length ? sources.join(', ') : null,
    warnings
  };
}

async function getStorageState() {
  let storageFileExists = false;
  let storageSymlinkExists = false;
  let storageSymlinkOk = false;
  let storageSymlinkTarget = null;

  try {
    await fsp.stat('/xandeum-pages');
    storageFileExists = true;
  } catch (error) {
    storageFileExists = false;
  }

  try {
    const linkStat = await fsp.lstat('/run/xandeum-pod');
    storageSymlinkExists = true;
    if (linkStat.isSymbolicLink()) {
      const target = await fsp.readlink('/run/xandeum-pod');
      storageSymlinkTarget = target;
      storageSymlinkOk = path.resolve(path.dirname('/run/xandeum-pod'), target) === '/xandeum-pages';
    }
  } catch (error) {
    storageSymlinkExists = false;
    storageSymlinkOk = false;
  }

  return {
    storageReady: storageFileExists && storageSymlinkOk,
    storageFileExists,
    storageSymlinkExists,
    storageSymlinkOk,
    storageSymlinkTarget
  };
}

async function getCurrentVersions() {
  const { getComponentVersions } = require('../component-versions');
  return getComponentVersions();
}

async function getPubkey() {
  try {
    const LogManager = require('../logs');
    const result = await LogManager.getPubkeyPassive();
    if (result?.success && result.pubkey) {
      return {
        pubkey: result.pubkey,
        source: result.source || null
      };
    }
  } catch (error) {
    return {
      pubkey: null,
      error: error.message
    };
  }

  return {
    pubkey: null,
    error: null
  };
}

function extractKeypairPubkey(raw) {
  if (!raw) {
    return null;
  }

  const jsonFieldMatch = raw.match(/"publi?cKey"\s*:\s*"([^"]+)"/i);
  if (jsonFieldMatch) {
    return jsonFieldMatch[1];
  }

  const base58Match = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,48}/);
  return base58Match ? base58Match[0] : null;
}

async function getKeypairReferences() {
  const files = [
    {
      label: 'Active xandminerd keypair',
      shortLabel: 'active',
      path: '/root/xandminerd/keypairs/pnode-keypair.json'
    },
    {
      label: 'Local backup keypair',
      shortLabel: 'backup',
      path: '/local/keypairs/pnode-keypair.json'
    }
  ];

  const entries = await Promise.all(files.map(async (file) => {
    try {
      const raw = await fsp.readFile(file.path, 'utf8');
      const lines = raw.split(/\r?\n/);
      return {
        label: file.label,
        shortLabel: file.shortLabel,
        path: file.path,
        exists: true,
        reference: (lines[1] || lines[0] || '').trim() || null,
        pubkey: extractKeypairPubkey(raw)
      };
    } catch (error) {
      return {
        label: file.label,
        shortLabel: file.shortLabel,
        path: file.path,
        exists: false,
        reference: null,
        pubkey: null
      };
    }
  }));

  const active = entries.find((entry) => entry.shortLabel === 'active') || null;
  const backup = entries.find((entry) => entry.shortLabel === 'backup') || null;

  let status = 'missing';
  if (active?.pubkey && backup?.pubkey) {
    status = active.pubkey === backup.pubkey ? 'match' : 'mismatch';
  } else if (active?.pubkey || backup?.pubkey) {
    status = 'partial';
  }

  const summaryParts = [];
  if (status === 'match') {
    summaryParts.push('Match');
  } else if (status === 'mismatch') {
    summaryParts.push('Mismatch');
  } else if (status === 'partial') {
    summaryParts.push('Partial');
  } else {
    summaryParts.push('Missing');
  }

  if (active?.pubkey) {
    summaryParts.push(`active ${active.pubkey}`);
  }

  if (backup?.pubkey) {
    summaryParts.push(`backup ${backup.pubkey}`);
  }

  return {
    entries,
    active,
    backup,
    status,
    summary: summaryParts.join(' | ')
  };
}

async function findExistingInstallerPath() {
  const homeInstaller = path.join(os.homedir(), 'install.sh');
  const candidates = Array.from(new Set(['/root/install.sh', homeInstaller]));

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch (error) {
      continue;
    }
  }

  return null;
}

function buildInstallerCommand(installerPath, atlasCluster, prpcMode) {
  return `bash ${installerPath} --non-interactive --update --prpc-mode ${prpcMode} --atlas-cluster ${atlasCluster}`;
}

async function inspectNode() {
  const [config, versions, storage, pubkey, keypairRefs, existingInstallerPath] = await Promise.all([
    detectNodeConfiguration(),
    getCurrentVersions(),
    getStorageState(),
    getPubkey(),
    getKeypairReferences(),
    findExistingInstallerPath()
  ]);

  return {
    atlasCluster: config.atlasCluster,
    prpcMode: config.prpcMode,
    detectionSource: config.detectionSource,
    warnings: config.warnings,
    versions,
    storageReady: storage.storageReady,
    storageFileExists: storage.storageFileExists,
    storageSymlinkExists: storage.storageSymlinkExists,
    storageSymlinkOk: storage.storageSymlinkOk,
    storageSymlinkTarget: storage.storageSymlinkTarget,
    pubkey: pubkey.pubkey || null,
    pubkeySource: pubkey.source || null,
    pubkeyError: pubkey.error || null,
    keypairReferences: keypairRefs,
    existingInstallerPath
  };
}

module.exports = {
  CLUSTERS,
  PRPC_MODES,
  INSTALLER_URL,
  getJobPaths,
  ensureJobDir,
  readJsonIfExists,
  writeJsonAtomic,
  appendLogLine,
  readLogTail,
  readCurrentJobState,
  clearCurrentJobState,
  detectNodeConfiguration,
  getStorageState,
  getCurrentVersions,
  getPubkey,
  getKeypairReferences,
  findExistingInstallerPath,
  buildInstallerCommand,
  inspectNode,
  normalizeCluster,
  normalizePrpcMode,
  isValidCluster,
  isValidPrpcMode
};
