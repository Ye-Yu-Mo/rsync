const { ipcMain } = require('electron');
const { getDB, encryptPassword, decryptPassword } = require('../database/db');
const fs = require('fs');
const config = require('../config');

function stripPassword(task) {
  if (!task) return task;
  const { password, ...rest } = task;
  return rest;
}

function setupHandlers() {
  ipcMain.handle('get-tasks', () => {
    const db = getDB();
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
    return tasks.map(stripPassword);
  });

  ipcMain.handle('get-task', (event, id) => {
    const db = getDB();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return stripPassword(task);
  });

  ipcMain.handle('create-task', (event, task) => {
    const localDir = task.local_dir;
    if (!fs.existsSync(localDir)) {
      throw new Error(`本地目录不存在: ${localDir}`);
    }

    const db = getDB();
    const stmt = db.prepare(`
      INSERT INTO tasks (
        name, remote_host, remote_port, username, password,
        local_dir, remote_dir, interval_minutes, version_enabled, trash_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const encryptedPassword = encryptPassword(task.password);
    const result = stmt.run(
      task.name,
      task.remote_host,
      task.remote_port,
      task.username,
      encryptedPassword,
      task.local_dir,
      task.remote_dir,
      task.interval_minutes,
      task.version_enabled,
      task.trash_enabled
    );

    const newTaskId = result.lastInsertRowid;
    const newTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(newTaskId);

    const scheduler = require('./scheduler');
    if (newTask.enabled) {
      scheduler.startTaskScheduler(newTask);
    }

    return newTaskId;
  });

  ipcMain.handle('update-task', (event, id, task) => {
    const localDir = task.local_dir;
    if (!fs.existsSync(localDir)) {
      throw new Error(`本地目录不存在: ${localDir}`);
    }

    const db = getDB();
    const stmt = db.prepare(`
      UPDATE tasks SET
        name = ?, remote_host = ?, remote_port = ?, username = ?, password = ?,
        local_dir = ?, remote_dir = ?, interval_minutes = ?, version_enabled = ?, trash_enabled = ?,
        updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);

    const encryptedPassword = encryptPassword(task.password);
    stmt.run(
      task.name,
      task.remote_host,
      task.remote_port,
      task.username,
      encryptedPassword,
      task.local_dir,
      task.remote_dir,
      task.interval_minutes,
      task.version_enabled,
      task.trash_enabled,
      id
    );

    const scheduler = require('./scheduler');
    scheduler.restartTaskScheduler(id);

    return true;
  });

  ipcMain.handle('delete-task', (event, id) => {
    const db = getDB();
    db.prepare('DELETE FROM logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

    const scheduler = require('./scheduler');
    scheduler.stopTaskScheduler(id);

    return true;
  });

  ipcMain.handle('toggle-task', (event, id, enabled) => {
    const db = getDB();
    const stmt = db.prepare(`
      UPDATE tasks SET
        enabled = ?,
        consecutive_failures = 0,
        updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);
    stmt.run(enabled ? 1 : 0, id);

    const scheduler = require('./scheduler');
    if (enabled) {
      scheduler.restartTaskScheduler(id);
    } else {
      scheduler.stopTaskScheduler(id);
    }

    return true;
  });

  ipcMain.handle('get-logs', (event, taskId) => {
    const db = getDB();
    const logs = db.prepare(`
      SELECT * FROM logs
      WHERE task_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(taskId, config.limits.maxLogs);
    return logs;
  });

  ipcMain.handle('test-connection', async (event, sshConfig) => {
    const { testConnection } = require('./executor');
    return await testConnection(sshConfig);
  });

  ipcMain.handle('sync-task', async (event, id) => {
    const { executeSync } = require('./executor');
    try {
      const result = await executeSync(id);
      return { success: result.success, output: result.output, syncMode: result.syncMode };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { setupHandlers };
