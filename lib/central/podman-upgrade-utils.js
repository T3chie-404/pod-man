const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const { getComponentVersions } = require('../component-versions');

const execFileAsync = util.promisify(execFile);

const DEFAULT_PODMAN_REPO_DIR = '/root/pod-man';
const PODMAN_REPO_FALLBACKS = [
  DEFAULT_PODMAN_REPO_DIR,
  '/pod-man'
];
const DEFAULT_TARGET_REF = 'master';
let resolvedPodManRepoDir = null;

function getJobPaths(repoDir = resolvedPodManRepoDir || DEFAULT_PODMAN_REPO_DIR) {
  const jobDir = path.join(repoDir, 'upgrade-jobs');
  return {
    jobDir,
    stateFile: path.join(jobDir, 'podman-current-job.json'),
    logFile: path.join(jobDir, 'podman-current-job.log')
  };
}

function extractInstallDirFromServiceText(text) {
  const workingDirectoryMatch = String(text || '').match(/^\s*WorkingDirectory=(.+)\s*$/m);
  if (workingDirectoryMatch?.[1]) {
    return workingDirectoryMatch[1].trim();
  }

  const execStartMatch = String(text || '').match(/^\s*ExecStart=\S+\s+(\S+)\/server\.js\s*$/m);
  if (execStartMatch?.[1]) {
    return execStartMatch[1].trim();
  }

  return null;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.R_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function resolvePodManRepoDir(force = false) {
  if (!force && resolvedPodManRepoDir) {
    return resolvedPodManRepoDir;
  }

  try {
    const { stdout } = await execFileAsync('systemctl', ['cat', 'pod-manager.service'], {
      maxBuffer: 1024 * 1024
    });
    const candidate = extractInstallDirFromServiceText(stdout);
    if (candidate && await pathExists(candidate)) {
      resolvedPodManRepoDir = candidate;
      return resolvedPodManRepoDir;
    }
  } catch (error) {
    // Fall back to known install paths below.
  }

  for (const candidate of PODMAN_REPO_FALLBACKS) {
    if (await pathExists(candidate)) {
      resolvedPodManRepoDir = candidate;
      return resolvedPodManRepoDir;
    }
  }

  resolvedPodManRepoDir = DEFAULT_PODMAN_REPO_DIR;
  return resolvedPodManRepoDir;
}

async function ensureJobDir(repoDir = null) {
  const { jobDir } = getJobPaths(repoDir || await resolvePodManRepoDir());
  await fsp.mkdir(jobDir, { recursive: true, mode: 0o700 });
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
  const { stateFile } = getJobPaths(await resolvePodManRepoDir());
  return readJsonIfExists(stateFile);
}

async function clearCurrentJobState() {
  const { stateFile } = getJobPaths(await resolvePodManRepoDir());
  try {
    await fsp.unlink(stateFile);
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
  const repoDir = await resolvePodManRepoDir();
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function readGitStatusPorcelain() {
  const repoDir = await resolvePodManRepoDir();
  const { stdout } = await execFileAsync('git', ['-C', repoDir, 'status', '--porcelain=1', '--untracked-files=all'], {
    maxBuffer: 1024 * 1024
  });
  return stdout.replace(/\r?\n$/, '');
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

async function clearIgnorableDirtyEntries() {
  const repoDir = await resolvePodManRepoDir();
  const rawStatus = await readGitStatusPorcelain();
  const dirtyEntries = parseDirtyEntries(rawStatus);
  const ignorableEntries = dirtyEntries.filter(isIgnorableDirtyEntry);
  const uniquePaths = [...new Set(ignorableEntries.map((entry) => normalizeDirtyPath(entry)).filter(Boolean))];

  if (!uniquePaths.length) {
    return [];
  }

  await execFileAsync('git', ['-C', repoDir, 'restore', '--staged', '--worktree', '--source=HEAD', '--', ...uniquePaths], {
    maxBuffer: 1024 * 1024
  });

  return uniquePaths;
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
  const repoDir = await resolvePodManRepoDir();
  const inspection = {
    repoPath: repoDir,
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
    await fsp.access(repoDir, fs.constants.R_OK);
    inspection.repoExists = true;
  } catch (error) {
    inspection.blockingReasons.push(`pod-man repo not found at ${repoDir}`);
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

    const rawStatus = await readGitStatusPorcelain();
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

  const configPath = path.join(repoDir, 'config.json');
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

async function ensurePodManagerService(repoDir = null) {
  const effectiveRepoDir = repoDir || await resolvePodManRepoDir();
  const templatePath = path.join(effectiveRepoDir, 'pod-manager.service');
  const destinationPath = '/etc/systemd/system/pod-manager.service';
  const template = await fsp.readFile(templatePath, 'utf8');
  const rendered = template.replace(/INSTALL_DIR_PLACEHOLDER/g, effectiveRepoDir);

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
  DEFAULT_PODMAN_REPO_DIR,
  DEFAULT_TARGET_REF,
  resolvePodManRepoDir,
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
  clearIgnorableDirtyEntries,
  inspectPodManRepo,
  ensurePodManagerService
};
