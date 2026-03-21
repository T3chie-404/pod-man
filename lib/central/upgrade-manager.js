const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const fs = require('fs').promises;
const {
  CLUSTERS,
  PRPC_MODES,
  INSTALLER_URL,
  buildInstallerCommand,
  clearCurrentJobState,
  ensureJobDir,
  getJobPaths,
  inspectNode,
  isValidCluster,
  isValidPrpcMode,
  readCurrentJobState,
  readLogTail,
  writeJsonAtomic
} = require('./upgrade-utils');

const execFileAsync = util.promisify(execFile);

class UpgradeManager {
  async inspect() {
    const inspection = await inspectNode();
    return {
      ...inspection,
      allowedClusters: CLUSTERS,
      allowedPrpcModes: PRPC_MODES,
      fetchLatestInstallerDefault: true,
      installerUrl: INSTALLER_URL
    };
  }

  async start(params = {}) {
    const atlasCluster = params.atlasCluster;
    const prpcMode = params.prpcMode;
    const operatorRevenue = params.operatorRevenue ? String(params.operatorRevenue).trim() : '';
    const fetchLatestInstaller = params.fetchLatestInstaller !== false;
    const installerUrl = params.installerUrl || INSTALLER_URL;

    if (!isValidCluster(atlasCluster)) {
      throw new Error(`Invalid atlas cluster: ${atlasCluster}`);
    }

    if (!isValidPrpcMode(prpcMode)) {
      throw new Error(`Invalid pRPC mode: ${prpcMode}`);
    }
    if (!/^\d+$/.test(operatorRevenue)) {
      throw new Error(`Invalid operator revenue: ${params.operatorRevenue}`);
    }

    const active = await readCurrentJobState();
    if (active && ['queued', 'running'].includes(active.status)) {
      throw new Error(`Upgrade job ${active.jobId} is already running`);
    }

    await ensureJobDir();
    await clearCurrentJobState();

    const { stateFile, logFile } = getJobPaths();
    const jobId = `upgrade-${Date.now()}`;
    const unitName = `pod-man-upgrade-${Date.now()}`;
    const state = {
      jobId,
      unitName,
      status: 'queued',
      phase: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      atlasCluster,
      prpcMode,
      operatorRevenue,
      fetchLatestInstaller,
      installerUrl,
      plannedCommand: buildInstallerCommand('/root/install.sh', atlasCluster, prpcMode, operatorRevenue),
      result: null,
      error: null,
      warnings: []
    };

    try {
      await fs.unlink(logFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await writeJsonAtomic(stateFile, state);

    const runnerPath = path.join(__dirname, 'upgrade-runner.js');
    const args = [
      '--unit',
      unitName,
      '--property',
      'Type=exec',
      '--collect',
      process.execPath,
      runnerPath,
      stateFile,
      logFile
    ];

    await execFileAsync('systemd-run', args, {
      env: process.env,
      maxBuffer: 1024 * 1024
    });

    return {
      success: true,
      jobId,
      unitName,
      status: 'queued',
      phase: 'queued'
    };
  }

  async cancel(params = {}) {
    const state = await readCurrentJobState();
    if (!state) {
      return {
        success: true,
        active: false,
        canceled: false,
        message: 'No active upgrade job'
      };
    }

    if (params.jobId && params.jobId !== state.jobId) {
      return {
        success: true,
        active: false,
        canceled: false,
        message: 'Job ID does not match the current upgrade job'
      };
    }

    if (!['queued', 'running'].includes(state.status)) {
      return {
        success: true,
        active: false,
        canceled: false,
        message: `Upgrade job is already ${state.status}`
      };
    }

    if (state.unitName) {
      await execFileAsync('systemctl', ['stop', state.unitName], {
        env: process.env,
        maxBuffer: 1024 * 1024
      });
    }

    return {
      success: true,
      active: false,
      canceled: true,
      jobId: state.jobId,
      unitName: state.unitName || null
    };
  }

  async status(params = {}) {
    const state = await readCurrentJobState();
    if (!state) {
      return {
        success: true,
        active: false,
        job: null
      };
    }

    if (params.jobId && params.jobId !== state.jobId) {
      return {
        success: true,
        active: false,
        job: null
      };
    }

    const { logFile } = getJobPaths();
    const logTail = await readLogTail(logFile);
    return {
      success: true,
      active: ['queued', 'running'].includes(state.status),
      job: {
        ...state,
        logTail
      }
    };
  }
}

module.exports = UpgradeManager;
