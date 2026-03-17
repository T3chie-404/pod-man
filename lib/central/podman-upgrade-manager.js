const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const {
  DEFAULT_TARGET_REF,
  appendLogLine,
  clearCurrentJobState,
  ensureJobDir,
  getJobPaths,
  inspectPodManRepo,
  readCurrentJobState,
  readLogTail,
  writeJsonAtomic
} = require('./podman-upgrade-utils');

const execFileAsync = util.promisify(execFile);

class PodManUpgradeManager {
  async inspect(params = {}) {
    const targetRef = params.targetRef || DEFAULT_TARGET_REF;
    return inspectPodManRepo(targetRef);
  }

  async start(params = {}) {
    const targetRef = params.targetRef || DEFAULT_TARGET_REF;
    const inspection = await inspectPodManRepo(targetRef);
    if (!inspection.ready) {
      throw new Error(`Pod-Man self-upgrade is blocked: ${inspection.blockingReasons.join('; ')}`);
    }

    const active = await readCurrentJobState();
    if (active && ['queued', 'running'].includes(active.status)) {
      throw new Error(`Pod-Man upgrade job ${active.jobId} is already running`);
    }

    await ensureJobDir();
    await clearCurrentJobState();

    const { stateFile, logFile } = getJobPaths();
    const jobId = `podman-upgrade-${Date.now()}`;
    const unitName = `pod-man-self-upgrade-${Date.now()}`;
    const state = {
      jobId,
      unitName,
      status: 'queued',
      phase: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      targetRef,
      inspection,
      result: null,
      error: null,
      warnings: inspection.warnings || []
    };

    try {
      await appendLogLine(logFile, `Queued Pod-Man self-upgrade for ${targetRef}`);
    } catch (_) {
      // ignore initial log append failure; state file is the source of truth
    }

    await writeJsonAtomic(stateFile, state);

    const runnerPath = path.join(__dirname, 'podman-upgrade-runner.js');
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
      phase: 'queued',
      targetRef
    };
  }

  async cancel(params = {}) {
    const state = await readCurrentJobState();
    if (!state) {
      return {
        success: true,
        active: false,
        canceled: false,
        message: 'No active pod-man upgrade job'
      };
    }

    if (params.jobId && params.jobId !== state.jobId) {
      return {
        success: true,
        active: false,
        canceled: false,
        message: 'Job ID does not match the current pod-man upgrade job'
      };
    }

    if (!['queued', 'running'].includes(state.status)) {
      return {
        success: true,
        active: false,
        canceled: false,
        message: `Pod-Man upgrade job is already ${state.status}`
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

module.exports = PodManUpgradeManager;
