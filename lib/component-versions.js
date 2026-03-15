const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const axios = require('axios');
const { execFile } = require('child_process');

const execFileAsync = util.promisify(execFile);

const XANDMINER_ROOT = '/root/xandminer';
const XANDMINERD_ROOT = '/root/xandminerd';
const XANDMINER_API_URL = 'http://127.0.0.1:4000/versions';

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return null;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function normalizeVersion(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function extractConst(text, name) {
  if (!text) {
    return null;
  }

  const patterns = [
    new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`),
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`)
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

async function getXandminerVersionInfo() {
  const info = {
    version: null,
    codename: null,
    packageVersion: null,
    source: null
  };

  const constsPath = path.join(XANDMINER_ROOT, 'src', 'CONSTS.ts');
  const constsText = await readTextIfExists(constsPath);
  if (constsText) {
    info.version = normalizeVersion(extractConst(constsText, 'VERSION_NO'));
    info.codename = extractConst(constsText, 'VERSION_NAME');
    if (info.version) {
      info.source = constsPath;
    }
  }

  const packageJsonPath = path.join(XANDMINER_ROOT, 'package.json');
  const packageJson = await readJsonIfExists(packageJsonPath);
  if (packageJson?.version) {
    info.packageVersion = normalizeVersion(packageJson.version);
    if (!info.version) {
      info.version = info.packageVersion;
      info.source = packageJsonPath;
    }
  }

  return info;
}

async function getXandminerdApiVersions() {
  try {
    const response = await axios.get(XANDMINER_API_URL, {
      timeout: 5000,
      headers: {
        Accept: 'application/json'
      }
    });

    const data = response?.data?.data || response?.data || {};
    return {
      xandminerd: normalizeVersion(data.xandminerd),
      pod: normalizeVersion(data.pod),
      source: XANDMINER_API_URL
    };
  } catch (error) {
    return {
      xandminerd: null,
      pod: null,
      source: null,
      error: error.message
    };
  }
}

async function getXandminerdVersionFallback() {
  const constsPath = path.join(XANDMINERD_ROOT, 'src', 'CONSTS.js');
  const constsText = await readTextIfExists(constsPath);
  if (constsText) {
    const version = normalizeVersion(extractConst(constsText, 'XANDMINERD_VERSION'));
    if (version) {
      return {
        version,
        source: constsPath
      };
    }
  }

  const packageJsonPath = path.join(XANDMINERD_ROOT, 'package.json');
  const packageJson = await readJsonIfExists(packageJsonPath);
  if (packageJson?.version) {
    return {
      version: normalizeVersion(packageJson.version),
      source: packageJsonPath
    };
  }

  return {
    version: null,
    source: null
  };
}

async function getPodBinaryVersion() {
  try {
    const { stdout } = await execFileAsync('pod', ['--version'], {
      maxBuffer: 1024 * 1024
    });
    const match = stdout.match(/pod\s+([0-9]+(?:\.[0-9]+)+)/i);
    return {
      version: match ? normalizeVersion(match[1]) : normalizeVersion(stdout),
      source: 'pod --version'
    };
  } catch (error) {
    return {
      version: null,
      source: null,
      error: error.message
    };
  }
}

async function getPodRpcVersion() {
  try {
    const PRPCClient = require('./api');
    const result = await PRPCClient.getVersion();
    if (!result?.success) {
      return {
        version: null,
        source: null,
        error: result?.error || 'RPC error'
      };
    }

    return {
      version: normalizeVersion(result?.result?.version || result?.result || null),
      source: 'http://127.0.0.1:6000/rpc get-version'
    };
  } catch (error) {
    return {
      version: null,
      source: null,
      error: error.message
    };
  }
}

async function getPodManVersion() {
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = await readJsonIfExists(packageJsonPath);
  return {
    version: packageJson?.version || null,
    source: packageJson?.version ? packageJsonPath : null
  };
}

async function getComponentVersions() {
  const warnings = [];
  const [xandminer, xandminerdApi, xandminerdFallback, podBinary, podRpc, podMan] = await Promise.all([
    getXandminerVersionInfo(),
    getXandminerdApiVersions(),
    getXandminerdVersionFallback(),
    getPodBinaryVersion(),
    getPodRpcVersion(),
    getPodManVersion()
  ]);

  if (xandminerdApi.error) {
    warnings.push(`xandminerd API unavailable: ${xandminerdApi.error}`);
  }
  if (podBinary.error) {
    warnings.push(`pod binary version failed: ${podBinary.error}`);
  }
  if (podRpc.error) {
    warnings.push(`pod RPC version failed: ${podRpc.error}`);
  }

  const podVersion = podBinary.version || xandminerdApi.pod || podRpc.version || null;
  const podVersionSource = podBinary.version
    ? podBinary.source
    : (xandminerdApi.pod ? xandminerdApi.source : podRpc.source);

  const xandminerdVersion = xandminerdApi.xandminerd || xandminerdFallback.version || null;
  const xandminerdSource = xandminerdApi.xandminerd
    ? xandminerdApi.source
    : xandminerdFallback.source;

  if (podBinary.version && podRpc.version && podBinary.version !== podRpc.version) {
    warnings.push(`pod binary (${podBinary.version}) differs from pRPC (${podRpc.version})`);
  }

  return {
    xandminer: xandminer.version,
    xandminerd: xandminerdVersion,
    pod: podVersion,
    podMan: podMan.version,
    codename: xandminer.codename || null,
    sources: {
      xandminer: xandminer.source,
      xandminerd: xandminerdSource,
      pod: podVersionSource,
      podMan: podMan.source
    },
    packageVersions: {
      xandminer: xandminer.packageVersion || null
    },
    rpcVersion: podRpc.version || null,
    warnings
  };
}

module.exports = {
  getComponentVersions
};
