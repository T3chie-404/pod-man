#!/usr/bin/env node

const util = require('util');
const { execFile } = require('child_process');
const {
  PODMAN_REPO_DIR,
  appendLogLine,
  clearCurrentJobState,
  clearIgnorableDirtyEntries,
  ensurePodManagerService,
  inspectPodManRepo,
  normalizeTargetRef,
  readJsonIfExists,
  runGit,
  writeJsonAtomic
} = require('./podman-upgrade-utils');

const execFileAsync = util.promisify(execFile);

async function main() {
  const statePath = process.argv[2];
  const logPath = process.argv[3];

  if (!statePath || !logPath) {
    process.exit(1);
  }

  const state = await readJsonIfExists(statePath);
  if (!state) {
    process.exit(1);
  }

  let cancelInProgress = false;

  async function persist(patch) {
    const nextState = {
      ...state,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    Object.assign(state, nextState);
    await writeJsonAtomic(statePath, nextState);
  }

  async function log(message) {
    await appendLogLine(logPath, message);
  }

  async function fail(message, extra = {}) {
    await log(`ERROR: ${message}`);
    await persist({
      status: 'failed',
      phase: state.phase || 'failed',
      completedAt: new Date().toISOString(),
      error: message,
      ...extra
    });
    process.exit(1);
  }

  async function cancel(message) {
    if (cancelInProgress) {
      return;
    }
    cancelInProgress = true;
    await log(`CANCEL: ${message}`);
    await persist({
      status: 'canceled',
      phase: 'canceled',
      completedAt: new Date().toISOString(),
      error: message
    });
    process.exit(0);
  }

  process.on('SIGTERM', async () => {
    await cancel('Pod-Man upgrade canceled by Central');
  });

  process.on('SIGINT', async () => {
    await cancel('Pod-Man upgrade canceled by Central');
  });

  async function runCommand(command, args, options = {}) {
    await log(`Running: ${[command, ...args].join(' ')}`);
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: process.env,
      maxBuffer: 1024 * 1024,
      ...options
    });
    if (stdout?.trim()) {
      await log(stdout.trim());
    }
    if (stderr?.trim()) {
      await log(stderr.trim());
    }
    return { stdout, stderr };
  }

  async function waitForLocalHealth(url, attempts = 30, delayMs = 2000) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await execFileAsync('curl', ['-fsS', '--max-time', '5', url], {
          env: process.env,
          maxBuffer: 1024 * 1024
        });
        return true;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  async function waitForCentralRecovery(sinceIso, requiresTunnel, attempts = 60, delayMs = 2000) {
    let sawRegistration = false;
    let sawTunnel = !requiresTunnel;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { stdout } = await execFileAsync(
        'journalctl',
        ['-u', 'pod-manager', '--since', sinceIso, '--no-pager', '-n', '300'],
        { env: process.env, maxBuffer: 1024 * 1024 }
      );

      if (stdout.includes('[Central] Registration confirmed')) {
        sawRegistration = true;
      }

      if (stdout.includes('[Reverse-Tunnel] Tunnel established successfully')) {
        sawTunnel = true;
      }

      if (sawRegistration && sawTunnel) {
        return { sawRegistration, sawTunnel };
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return { sawRegistration, sawTunnel };
  }

  const targetRef = normalizeTargetRef(state.targetRef);

  await persist({
    status: 'running',
    phase: 'inspecting',
    startedAt: new Date().toISOString(),
    error: null
  });

  await log(`Pod-Man upgrade job ${state.jobId} started for target ref ${targetRef}`);

  const initialInspection = await inspectPodManRepo(targetRef);
  await persist({ inspection: initialInspection, warnings: initialInspection.warnings || [] });

  if (!initialInspection.ready) {
    await fail(`Pod-Man repo is not ready for self-upgrade: ${initialInspection.blockingReasons.join('; ')}`, {
      inspection: initialInspection
    });
  }

  await persist({ phase: 'fetching' });
  try {
    await runCommand('git', ['-C', PODMAN_REPO_DIR, 'fetch', 'origin', '--prune']);
  } catch (error) {
    await fail(`Failed to fetch origin: ${error.message}`);
  }

  const fetchedInspection = await inspectPodManRepo(targetRef);
  await persist({ inspection: fetchedInspection });

  if (!fetchedInspection.targetCommit) {
    await fail(`Target ref origin/${targetRef} is not available after fetch`);
  }

  await persist({
    phase: 'updating',
    currentCommit: fetchedInspection.currentCommit,
    targetCommit: fetchedInspection.targetCommit
  });

  try {
    const clearedPaths = await clearIgnorableDirtyEntries();
    if (clearedPaths.length > 0) {
      await log(`Cleared ignorable local changes before checkout: ${clearedPaths.join(', ')}`);
    }
    await runCommand('git', ['-C', PODMAN_REPO_DIR, 'checkout', '-B', targetRef, `origin/${targetRef}`]);
    await runCommand('git', ['-C', PODMAN_REPO_DIR, 'reset', '--hard', `origin/${targetRef}`]);
  } catch (error) {
    await fail(`Failed to update pod-man repo: ${error.message}`);
  }

  await persist({ phase: 'installing' });
  try {
    await runCommand('npm', ['install', '--production'], { cwd: PODMAN_REPO_DIR });
  } catch (error) {
    await fail(`npm install failed: ${error.message}`);
  }

  await persist({ phase: 'restarting' });
  try {
    const serviceUpdate = await ensurePodManagerService(PODMAN_REPO_DIR);
    await persist({
      result: {
        serviceFileUpdated: serviceUpdate.changed
      }
    });
    await runCommand('systemctl', ['restart', 'pod-manager']);
  } catch (error) {
    await fail(`Failed to restart pod-manager: ${error.message}`);
  }

  const restartStartedAt = new Date().toISOString();

  await persist({ phase: 'verifying-local', restartStartedAt });
  const localHealthOk = await waitForLocalHealth(fetchedInspection.localHealthUrl);
  if (!localHealthOk) {
    await fail(`Local pod-man health check failed at ${fetchedInspection.localHealthUrl}`);
  }

  const requiresCentralRecovery = fetchedInspection.centralConfig?.enabled === true;
  let centralRecovery = {
    sawRegistration: !requiresCentralRecovery,
    sawTunnel: !requiresCentralRecovery
  };

  if (requiresCentralRecovery) {
    await persist({ phase: 'verifying-central' });
    centralRecovery = await waitForCentralRecovery(restartStartedAt, true);
    if (!centralRecovery.sawRegistration || !centralRecovery.sawTunnel) {
      const missing = [
        !centralRecovery.sawRegistration ? 'Central registration' : null,
        !centralRecovery.sawTunnel ? 'reverse tunnel' : null
      ].filter(Boolean);
      await fail(`Pod-Man upgrade completed, but verification failed: ${missing.join(' and ')} did not recover cleanly`);
    }
  }

  const verifiedVersions = await inspectPodManRepo(targetRef);

  await clearCurrentJobState();
  await persist({
    status: 'completed',
    phase: 'completed',
    completedAt: new Date().toISOString(),
    verifiedVersions: verifiedVersions.versions,
    result: {
      currentCommit: verifiedVersions.currentCommit,
      targetCommit: verifiedVersions.targetCommit,
      localHealthUrl: verifiedVersions.localHealthUrl,
      centralRecovery
    }
  });
}

main().catch(async (error) => {
  const statePath = process.argv[2];
  const logPath = process.argv[3];

  if (logPath) {
    try {
      await appendLogLine(logPath, `FATAL: ${error.stack || error.message}`);
    } catch (_) {
      // ignore
    }
  }

  if (statePath) {
    try {
      const current = await readJsonIfExists(statePath);
      if (current) {
        await writeJsonAtomic(statePath, {
          ...current,
          status: 'failed',
          phase: current.phase || 'failed',
          error: error.message,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    } catch (_) {
      // ignore
    }
  }

  process.exit(1);
});
