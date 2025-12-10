const { getDB } = require('../database/db');
const { executeSync } = require('./executor');
const { executeSSH, escapeShellArg, sendTaskUpdate, isTaskStale, releaseLock } = require('./utils');
const config = require('../config');

const schedulers = new Map();
let trashCleanupInterval = null;

function startTaskScheduler(task) {
  if (schedulers.has(task.id)) {
    return;
  }

  const intervalMs = task.interval_minutes * 60 * 1000;

  const timerId = setInterval(async () => {
    const db = getDB();
    const currentTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND enabled = 1').get(task.id);

    if (!currentTask) {
      stopTaskScheduler(task.id);
      return;
    }

    if (currentTask.is_running) {
      if (!isTaskStale(currentTask)) {
        console.log(`Task ${task.id} is already running, skipping this trigger`);
        return;
      }

      releaseLock(db, task.id);
      console.warn(`Task ${task.id} was stuck running, force-resetting flag`);
      sendTaskUpdate();
    }

    try {
      console.log(`Auto-triggering sync for task ${task.id}: ${task.name}`);
      await executeSync(task.id);
    } catch (error) {
      console.error(`Scheduled sync failed for task ${task.id}:`, error.message);
    }
  }, intervalMs);

  schedulers.set(task.id, timerId);
  console.log(`Scheduler started for task ${task.id}: ${task.name}, interval: ${task.interval_minutes} minutes`);
}

function stopTaskScheduler(taskId) {
  const timerId = schedulers.get(taskId);
  if (timerId) {
    clearInterval(timerId);
    schedulers.delete(taskId);
    console.log(`Scheduler stopped for task ${taskId}`);
  }
}

function restartTaskScheduler(taskId) {
  stopTaskScheduler(taskId);

  const db = getDB();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND enabled = 1').get(taskId);

  if (task) {
    startTaskScheduler(task);
  }
}

function loadAllSchedulers() {
  const db = getDB();
  const tasks = db.prepare('SELECT * FROM tasks WHERE enabled = 1').all();

  for (const task of tasks) {
    startTaskScheduler(task);
  }

  console.log(`Loaded ${tasks.length} enabled tasks into scheduler`);
}

async function cleanTrashForTask(task) {
  const sshConfig = {
    remote_host: task.remote_host,
    remote_port: task.remote_port,
    username: task.username,
    password: task.password
  };

  const versionsDir = `${task.remote_dir}/${config.paths.versionsDir}`;
  const cleanCmd = `find ${escapeShellArg(versionsDir)} -mindepth 1 -maxdepth 1 -type d -mtime +${config.limits.trashRetentionDays} -exec rm -rf {} \\;`;

  try {
    await executeSSH(sshConfig, cleanCmd, config.timeouts.sshTrashCleanup);
    console.log(`Trash cleanup completed for task ${task.id}: ${task.name}`);
  } catch (error) {
    console.error(`Trash cleanup failed for task ${task.id}:`, error.message);
  }
}

function startTrashCleanup() {
  if (trashCleanupInterval) {
    return;
  }

  const msUntilMidnight = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow - now;
  };

  const scheduleNextCleanup = () => {
    const delay = msUntilMidnight();

    trashCleanupInterval = setTimeout(async () => {
      console.log('Starting daily trash cleanup...');

      const db = getDB();
      const tasks = db.prepare('SELECT * FROM tasks WHERE trash_enabled = 1').all();

      for (const task of tasks) {
        await cleanTrashForTask(task);
      }

      console.log('Daily trash cleanup completed');
      scheduleNextCleanup();
    }, delay);
  };

  scheduleNextCleanup();
  console.log('Trash cleanup scheduler started (runs daily at 00:00)');
}

function stopTrashCleanup() {
  if (trashCleanupInterval) {
    clearTimeout(trashCleanupInterval);
    trashCleanupInterval = null;
    console.log('Trash cleanup scheduler stopped');
  }
}

function init() {
  loadAllSchedulers();
  startTrashCleanup();
}

module.exports = {
  init,
  startTaskScheduler,
  stopTaskScheduler,
  restartTaskScheduler,
  startTrashCleanup,
  stopTrashCleanup
};
