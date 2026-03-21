#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const util = require('util');
const { spawn, execFile } = require('child_process');
const {
  INSTALLER_URL,
  appendLogLine,
  buildInstallerCommand,
  findExistingInstallerPath,
  getCurrentVersions,
  getStorageState,
  inspectNode,
  readJsonIfExists,
  writeJsonAtomic
} = require('./upgrade-utils');

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
  let currentChild = null;
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
    if (currentChild) {
      currentChild.kill('SIGTERM');
    }
    await cancel('Upgrade canceled by Central');
  });

  process.on('SIGINT', async () => {
    if (currentChild) {
      currentChild.kill('SIGTERM');
    }
    await cancel('Upgrade canceled by Central');
  });

  async function runCommand(command, args, options = {}) {
    await log(`Running: ${[command, ...args].join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        ...options,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      currentChild = child;

      child.stdout.on('data', (chunk) => {
        appendLogLine(logPath, chunk.toString('utf8').trimEnd()).catch(() => {});
      });

      child.stderr.on('data', (chunk) => {
        appendLogLine(logPath, chunk.toString('utf8').trimEnd()).catch(() => {});
      });

      child.on('error', reject);
      child.on('close', (code) => {
        currentChild = null;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });
    });
  }

  await persist({
    status: 'running',
    phase: 'inspecting',
    startedAt: new Date().toISOString(),
    error: null
  });

  await log(`Upgrade job ${state.jobId} started`);

  const beforeInspection = await inspectNode();
  await persist({
    inspection: beforeInspection,
    warnings: beforeInspection.warnings || []
  });

  let installerPath = null;
  await persist({ phase: 'preparing' });

  if (state.fetchLatestInstaller) {
    installerPath = '/root/install.sh';
    try {
      await runCommand('wget', ['-O', installerPath, state.installerUrl || INSTALLER_URL]);
      await runCommand('chmod', ['a+x', installerPath]);
    } catch (error) {
      await fail(`Failed to fetch latest installer: ${error.message}`);
    }
  } else {
    installerPath = await findExistingInstallerPath();
    if (!installerPath) {
      await fail('Existing installer not found at /root/install.sh or ~/install.sh');
    }
    await log(`Using existing installer at ${installerPath}`);
  }

  const storageBefore = await getStorageState();
  const storageActions = [];

  try {
    if (!storageBefore.storageFileExists) {
      storageActions.push('fallocate /xandeum-pages -l 1g');
      await runCommand('fallocate', ['-l', '1g', '/xandeum-pages']);
    }

    const refreshedStorage = await getStorageState();
    if (!refreshedStorage.storageSymlinkExists) {
      storageActions.push('ln -s /xandeum-pages /run/xandeum-pod');
      await runCommand('ln', ['-s', '/xandeum-pages', '/run/xandeum-pod']);
    } else if (!refreshedStorage.storageSymlinkOk) {
      await fail(`Storage symlink exists but does not point to /xandeum-pages (${refreshedStorage.storageSymlinkTarget || 'unknown target'})`, {
        storage: refreshedStorage
      });
    }

    await persist({
      storage: {
        before: storageBefore,
        after: await getStorageState(),
        actions: storageActions
      }
    });
  } catch (error) {
    await fail(`Failed while preparing storage: ${error.message}`);
  }

  await persist({
    phase: 'updating',
    installerPath,
    plannedCommand: buildInstallerCommand(installerPath, state.atlasCluster, state.prpcMode, state.operatorRevenue)
  });

  try {
    await runCommand('bash', [
      installerPath,
      '--non-interactive',
      '--update',
      '--prpc-mode',
      state.prpcMode,
      '--atlas-cluster',
      state.atlasCluster,
      '--operator-revenue',
      state.operatorRevenue
    ], {
      cwd: '/root'
    });
  } catch (error) {
    await fail(`Installer failed: ${error.message}`);
  }

  await persist({ phase: 'verifying' });

  try {
    const versions = await getCurrentVersions();
    if (!versions.xandminer) {
      await fail(`Version verification failed: ${versions.rpcError || 'RPC did not return a version'}`, {
        verifiedVersions: versions
      });
    }

    await log(`Verified versions: xandminer=${versions.xandminer} xandminerd=${versions.xandminerd} pod=${versions.pod} pod-man=${versions.podMan || 'unknown'}`);
    await persist({
      status: 'completed',
      phase: 'completed',
      completedAt: new Date().toISOString(),
      verifiedVersions: versions,
      result: {
        installerPath,
        storageActions
      }
    });
  } catch (error) {
    await fail(`Verification failed: ${error.message}`);
  }
}

main().catch(async (error) => {
  const statePath = process.argv[2];
  const logPath = process.argv[3];
  if (logPath) {
    try {
      await appendLogLine(logPath, `FATAL: ${error.stack || error.message}`);
    } catch (appendError) {}
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
    } catch (stateError) {}
  }

  process.exit(1);
});
