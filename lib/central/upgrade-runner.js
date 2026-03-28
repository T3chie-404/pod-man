#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

const fsp = fs.promises;
const STORAGE_LINK_PATH = '/run/xandeum-pod';
const STANDARD_STORAGE_TARGET = '/xandeum-pages';
const TMPFILE_PATH = '/etc/tmpfiles.d/xandeum-pod.conf';

function buildStorageFailureReason(storageState) {
  if (!storageState?.storageSymlinkExists) {
    return `Storage symlink is missing at ${STORAGE_LINK_PATH}`;
  }

  if (storageState.storageSymlinkIsSymbolicLink === false) {
    return `Storage path exists but is not a symlink: ${STORAGE_LINK_PATH}`;
  }

  if (!storageState.storageTargetExists) {
    return `Storage symlink target is missing: ${STORAGE_LINK_PATH} -> ${storageState.storageSymlinkTarget || 'unknown target'}`;
  }

  return `Storage configuration is not usable: ${STORAGE_LINK_PATH}`;
}

async function writeStorageTmpfile(targetPath) {
  await fsp.writeFile(TMPFILE_PATH, `L ${STORAGE_LINK_PATH} - - - - ${targetPath}\n`, 'utf8');
}

async function ensureSymlinkTarget(targetPath) {
  try {
    const linkStat = await fsp.lstat(STORAGE_LINK_PATH);
    if (linkStat.isSymbolicLink()) {
      await fsp.unlink(STORAGE_LINK_PATH);
    } else {
      throw new Error(`${STORAGE_LINK_PATH} exists and is not a symlink`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fsp.symlink(targetPath, STORAGE_LINK_PATH);
}

async function createInstallerCompatCopy(installerPath, storageState, log) {
  if (!storageState?.storageReady || !storageState.storageUsesCustomTarget) {
    return installerPath;
  }

  const installerRaw = await fsp.readFile(installerPath, 'utf8');
  let patched = installerRaw;
  const targetPath = storageState.storageTargetResolved || storageState.storageSymlinkTarget;

  const installStorageReplacement = `ensure_install_storage() {
    local canonical_target="${STANDARD_STORAGE_TARGET}"
    local requested_target="\${XANDEUM_STORAGE_TARGET:-$canonical_target}"
    local link_path="${STORAGE_LINK_PATH}"

    if [ "$requested_target" = "$canonical_target" ]; then
        if [ ! -f "$canonical_target" ]; then
            echo "Creating $canonical_target (1g)..."
            fallocate "$canonical_target" -l 1g
        else
            echo "$canonical_target already exists. Skipping creation."
        fi
    elif [ ! -e "$requested_target" ]; then
        echo "Error: custom storage target does not exist: $requested_target"
        exit 1
    else
        echo "Using custom storage target: $requested_target"
    fi

    if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
        echo "Creating $link_path -> $requested_target"
        ln -s "$requested_target" "$link_path"
    else
        echo "$link_path already exists. Leaving it unchanged."
    fi
}`;

  const tmpfileReplacement = `ensure_xandeum_pod_tmpfile() {
    TMPFILE="${TMPFILE_PATH}"
    STORAGE_TARGET="\${XANDEUM_STORAGE_TARGET:-${STANDARD_STORAGE_TARGET}}"
    echo "L ${STORAGE_LINK_PATH} - - - - $STORAGE_TARGET" > "$TMPFILE"
    echo "Created $TMPFILE"

    systemd-tmpfiles --create
}`;

  patched = patched.replace(/ensure_install_storage\(\)\s*\{[\s\S]*?^\}/m, installStorageReplacement);
  patched = patched.replace(/ensure_xandeum_pod_tmpfile\(\)\s*\{[\s\S]*?^\}/m, tmpfileReplacement);

  const compatPath = path.join('/tmp', `install-storage-compat-${process.pid}.sh`);
  await fsp.writeFile(compatPath, patched, 'utf8');
  await fsp.chmod(compatPath, 0o755);
  if (compatPath !== installerPath) {
    await log(`Prepared installer compatibility wrapper for custom storage target ${targetPath}`);
  }
  return compatPath;
}

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
      const childEnv = {
        ...process.env,
        ...(options.env || {})
      };
      const child = spawn(command, args, {
        ...options,
        env: childEnv,
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
    if (storageBefore.storageReady && storageBefore.storageUsesCustomTarget) {
      storageActions.push(`use-custom-storage-target: ${STORAGE_LINK_PATH} -> ${storageBefore.storageTargetResolved || storageBefore.storageSymlinkTarget || 'unknown target'}`);
    } else if (!storageBefore.storageSymlinkExists) {
      if (!storageBefore.storageFileExists) {
        storageActions.push(`fallocate ${STANDARD_STORAGE_TARGET} -l 1g`);
        await runCommand('fallocate', ['-l', '1g', STANDARD_STORAGE_TARGET]);
      }
      storageActions.push(`ln -s ${STANDARD_STORAGE_TARGET} ${STORAGE_LINK_PATH}`);
      await runCommand('ln', ['-s', STANDARD_STORAGE_TARGET, STORAGE_LINK_PATH]);
    } else if (!storageBefore.storageReady) {
      await fail(buildStorageFailureReason(storageBefore), {
        storage: {
          before: storageBefore,
          after: storageBefore,
          actions: storageActions
        }
      });
    } else if (!storageBefore.storageFileExists) {
      storageActions.push('fallocate /xandeum-pages -l 1g');
      await runCommand('fallocate', ['-l', '1g', '/xandeum-pages']);
    }

    const refreshedStorage = await getStorageState();
    if (!refreshedStorage.storageReady) {
      await fail(buildStorageFailureReason(refreshedStorage), {
        storage: {
          before: storageBefore,
          after: refreshedStorage,
          actions: storageActions
        }
      });
    }

    if (refreshedStorage.storageUsesCustomTarget) {
      storageActions.push(`preserve-custom-storage-target: ${STORAGE_LINK_PATH} -> ${refreshedStorage.storageTargetResolved || refreshedStorage.storageSymlinkTarget || 'unknown target'}`);
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

  let effectiveInstallerPath = installerPath;
  try {
    effectiveInstallerPath = await createInstallerCompatCopy(installerPath, storageBefore, log);
  } catch (error) {
    await fail(`Failed to prepare installer compatibility wrapper: ${error.message}`);
  }

  await persist({
    phase: 'updating',
    installerPath,
    effectiveInstallerPath,
    plannedCommand: buildInstallerCommand(installerPath, state.atlasCluster, state.prpcMode, state.operatorRevenue)
  });

  try {
    const installerEnv = {
      ...process.env
    };
    if (storageBefore.storageReady && storageBefore.storageUsesCustomTarget) {
      installerEnv.XANDEUM_STORAGE_TARGET = storageBefore.storageTargetResolved || storageBefore.storageSymlinkTarget;
    }
    await runCommand('bash', [
      effectiveInstallerPath,
      '--non-interactive',
      '--update',
      '--prpc-mode',
      state.prpcMode,
      '--atlas-cluster',
      state.atlasCluster,
      '--operator-revenue',
      state.operatorRevenue
    ], {
      cwd: '/root',
      env: installerEnv
    });
  } catch (error) {
    await fail(`Installer failed: ${error.message}`);
  }

  try {
    if (storageBefore.storageReady && storageBefore.storageUsesCustomTarget) {
      const customTarget = storageBefore.storageTargetResolved || storageBefore.storageSymlinkTarget;
      await writeStorageTmpfile(customTarget);
      storageActions.push(`update-tmpfile-target: ${TMPFILE_PATH} -> ${customTarget}`);
      await ensureSymlinkTarget(customTarget);
      storageActions.push(`restore-custom-storage-target: ${STORAGE_LINK_PATH} -> ${customTarget}`);
      await runCommand('systemd-tmpfiles', ['--create']);
    }
  } catch (error) {
    await fail(`Failed to restore custom storage configuration: ${error.message}`, {
      storage: {
        before: storageBefore,
        after: await getStorageState(),
        actions: storageActions
      }
    });
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
