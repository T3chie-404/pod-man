const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const { getComponentVersions } = require('../component-versions');

const execFileAsync = util.promisify(execFile);

const PODMAN_REPO_DIR = '/root/pod-man';
const JOB_DIR = path.join(PODMAN_REPO_DIR, 'upgrade-jobs');
const STATE_FILE = path.join(JOB_DIR, 'podman-current-job.json');
const LOG_FILE = path.join(JOB_DIR, 'podman-current-job.log');
const DEFAULT_TARGET_REF = 'master';

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
  try {
    await fsp.unlink(STATE_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function normalizeTargetRef(targetRef) {
  const raw = String(targetRef || DEFAULT_TARGET_REF).trim() || DEFAULT_TARGET_REF;
  const withoutOrigin = raw.replace(/^origin\//, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(withoutOrigin)) {
    throw new Error(`Invalid target ref: ${raw}`);
  }
  return withoutOrigin;
}

function buildTargetRemoteRef(targetRef) {
  return `origin/${normalizeTargetRef(targetRef)}`;
}

async function runGit(args) {
  const { stdout } = await execFileAsync('git', ['-C', PODMAN_REPO_DIR, ...args], {
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

function parseDirtyEntries(rawStatus) {
  const lines = String(rawStatus || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines.map((line) => ({
    raw: line,
    status: line.slice(0, 2),
    path: line.slice(3)
  })).filter((entry) => entry.path !== 'upgrade-jobs' && !entry.path.startsWith('upgrade-jobs/'));
}

function summarizeDirtyEntries(entries) {
  if (!entries.length) {
    return [];
  }

  return entries.map((entry) => `${entry.status} ${entry.path}`);
}

function normalizeDirtyPath(entry) {
  return String(entry?.path || '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^\.\/+/, '');
}

function isPackageLockPath(value) {
  const normalizedPath = String(value || '').trim();
  if (!normalizedPath) {
    return false;
  }

  const posixName = path.posix.basename(normalizedPath);
  const winName = path.win32.basename(normalizedPath);
  const packageLockPattern = /^(?:p)?ackage-lock\.json$/;
  return packageLockPattern.test(posixName) || packageLockPattern.test(winName);
}

function isIgnorableDirtyEntry(entry) {
  const normalizedPath = normalizeDirtyPath(entry);
  return isPackageLockPath(normalizedPath);
}

function validateCentralConfig(centralManagement = {}) {
  const enabled = centralManagement.enabled === true;
  const centralSshUser = centralManagement.centralSshUser || 'ubuntu';
  const missingFields = [];

  if (enabled) {
    if (!centralManagement.apiKey) {
      missingFields.push('centralManagement.apiKey');
    }
    if (!centralManagement.centralUrl) {
      missingFields.push('centralManagement.centralUrl');
    }
    if (!centralManagement.centralSshHost) {
      missingFields.push('centralManagement.centralSshHost');
    }
    if (!centralManagement.sshKnownHostsPath) {
      missingFields.push('centralManagement.sshKnownHostsPath');
    }
  }

  return {
    enabled,
    valid: missingFields.length === 0,
    missingFields,
    preserved: {
      enabled: centralManagement.enabled === true,
      apiKeyPresent: Boolean(centralManagement.apiKey),
      centralUrl: centralManagement.centralUrl || '',
      autoConnect: centralManagement.autoConnect === true,
      centralSshHost: centralManagement.centralSshHost || '',
      centralSshUser,
      sshKnownHostsPath: centralManagement.sshKnownHostsPath || '',
      allowRemoteSshKeyInstall: centralManagement.allowRemoteSshKeyInstall === true
    }
  };
}

async function inspectPodManRepo(targetRef = DEFAULT_TARGET_REF) {
  const normalizedTargetRef = normalizeTargetRef(targetRef);
  const inspection = {
    repoPath: PODMAN_REPO_DIR,
    repoExists: false,
    gitRepo: false,
    branch: null,
    currentCommit: null,
    targetRef: normalizedTargetRef,
    targetCommit: null,
    dirty: false,
    dirtyEntries: [],
    centralConfig: null,
    localHealthUrl: null,
    warnings: [],
    versions: null,
    ready: false,
    blockingReasons: []
  };

  try {
    await fsp.access(PODMAN_REPO_DIR, fs.constants.R_OK);
    inspection.repoExists = true;
  } catch (error) {
    inspection.blockingReasons.push(`pod-man repo not found at ${PODMAN_REPO_DIR}`);
    return inspection;
  }

  try {
    inspection.gitRepo = (await runGit(['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch (error) {
    inspection.blockingReasons.push('pod-man repo is not a valid git working tree');
    return inspection;
  }

  try {
    inspection.branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    inspection.currentCommit = await runGit(['rev-parse', 'HEAD']);
    const targetRemoteRef = buildTargetRemoteRef(normalizedTargetRef);
    try {
      inspection.targetCommit = await runGit(['rev-parse', '--verify', targetRemoteRef]);
    } catch (error) {
      inspection.warnings.push(`Target ref ${targetRemoteRef} is not available locally yet; start will fetch origin before upgrade.`);
    }

    const rawStatus = await runGit(['status', '--porcelain=1', '--untracked-files=all']);
    inspection.dirtyEntries = parseDirtyEntries(rawStatus);
    const blockingDirtyEntries = inspection.dirtyEntries.filter((entry) => !isIgnorableDirtyEntry(entry));
    const ignoredDirtyEntries = inspection.dirtyEntries.filter(isIgnorableDirtyEntry);

    inspection.dirty = blockingDirtyEntries.length > 0;
    if (inspection.dirty) {
      inspection.blockingReasons.push(
        `pod-man repo has blocking local changes: ${summarizeDirtyEntries(blockingDirtyEntries).join(', ')}`
      );
    }
    if (ignoredDirtyEntries.length > 0) {
      inspection.warnings.push(`Ignoring harmless repo changes: ${summarizeDirtyEntries(ignoredDirtyEntries).join(', ')}`);
    }

    if (
      inspection.dirty &&
      inspection.dirtyEntries.length > 0 &&
      inspection.dirtyEntries.every((entry) => isPackageLockPath(normalizeDirtyPath(entry)))
    ) {
      const ignoredSummary = summarizeDirtyEntries(inspection.dirtyEntries);
      inspection.dirty = false;
      inspection.dirtyEntries = [];
      inspection.blockingReasons = inspection.blockingReasons.filter((reason) => !String(reason).includes('package-lock.json'));
      inspection.warnings.push(`Ignoring harmless repo changes: ${ignoredSummary.join(', ')}`);
    }
  } catch (error) {
    inspection.blockingReasons.push(`Failed to inspect pod-man git state: ${error.message}`);
    return inspection;
  }

  const configPath = path.join(PODMAN_REPO_DIR, 'config.json');
  try {
    const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    const localPort = Number(config?.server?.port || 7000);
    inspection.localHealthUrl = `http://127.0.0.1:${localPort}/api/setup/status`;
    inspection.centralConfig = validateCentralConfig(config.centralManagement || {});
    if (inspection.centralConfig.enabled && !inspection.centralConfig.valid) {
      inspection.blockingReasons.push(
        `Central integration is enabled but missing required config: ${inspection.centralConfig.missingFields.join(', ')}`
      );
    }
  } catch (error) {
    inspection.blockingReasons.push(`Failed to read pod-man config.json: ${error.message}`);
    return inspection;
  }

  try {
    inspection.versions = await getComponentVersions();
  } catch (error) {
    inspection.warnings.push(`Failed to load current versions: ${error.message}`);
  }

  const packageLockOnlyBlock = inspection.blockingReasons.length > 0
    && inspection.blockingReasons.every((reason) => /(?:p)?ackage-lock\.json/.test(String(reason)));
  if (packageLockOnlyBlock) {
    inspection.dirty = false;
    inspection.dirtyEntries = [];
    inspection.blockingReasons = [];
    inspection.warnings.push('Ignoring harmless repo changes: package-lock.json');
  }

  inspection.ready = inspection.blockingReasons.length === 0;
  inspection.dirtySummary = summarizeDirtyEntries(inspection.dirtyEntries);
  return inspection;
}

async function ensurePodManagerService(repoDir = PODMAN_REPO_DIR) {
  const templatePath = path.join(repoDir, 'pod-manager.service');
  const destinationPath = '/etc/systemd/system/pod-manager.service';
  const template = await fsp.readFile(templatePath, 'utf8');
  const rendered = template.replace(/INSTALL_DIR_PLACEHOLDER/g, repoDir);

  let existing = null;
  try {
    existing = await fsp.readFile(destinationPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (existing !== rendered) {
    await fsp.writeFile(destinationPath, rendered, 'utf8');
    await execFileAsync('systemctl', ['daemon-reload'], { maxBuffer: 1024 * 1024 });
    return { changed: true, destinationPath };
  }

  return { changed: false, destinationPath };
}

module.exports = {
  PODMAN_REPO_DIR,
  DEFAULT_TARGET_REF,
  getJobPaths,
  ensureJobDir,
  readJsonIfExists,
  writeJsonAtomic,
  appendLogLine,
  readLogTail,
  readCurrentJobState,
  clearCurrentJobState,
  normalizeTargetRef,
  buildTargetRemoteRef,
  runGit,
  inspectPodManRepo,
  ensurePodManagerService
};
