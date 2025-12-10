const fs = require('fs');
const path = require('path');
const { executeCommand, executeSSH, convertWindowsPath, quotePathIfNeeded, getCommandPath } = require('./utils');
const { getDB } = require('../database/db');

async function ensureRemoteDirs(config, remoteDir) {
  const mkdirCmd = `mkdir -p "${remoteDir}" "${remoteDir}/.versions" "${remoteDir}/.trash"`;
  const result = await executeSSH(config, mkdirCmd, 30000);

  if (!result.success) {
    throw new Error(`Failed to create remote directories: ${result.output}`);
  }
}

async function syncWithRsync(task) {
  const localDir = convertWindowsPath(task.local_dir);
  const remoteDir = task.remote_dir;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('Z')[0];

  const localDirQuoted = quotePathIfNeeded(localDir);
  const remoteDirQuoted = quotePathIfNeeded(remoteDir);

  const rsyncPath = getCommandPath('rsync');
  const sshpassPath = getCommandPath('sshpass');
  const sshPath = getCommandPath('ssh');

  let rsyncCmd;
  if (task.version_enabled) {
    const backupDir = `${remoteDirQuoted}/.versions/${timestamp}/`;
    rsyncCmd = `SSHPASS='${task.password}' ${sshpassPath} -e ${rsyncPath} -av -e '${sshPath} -p ${task.remote_port} -o StrictHostKeyChecking=accept-new' --backup --backup-dir="${backupDir}" "${localDirQuoted}/" ${task.username}@${task.remote_host}:"${remoteDirQuoted}"`;
  } else {
    rsyncCmd = `SSHPASS='${task.password}' ${sshpassPath} -e ${rsyncPath} -av -e '${sshPath} -p ${task.remote_port} -o StrictHostKeyChecking=accept-new' "${localDirQuoted}/" ${task.username}@${task.remote_host}:"${remoteDirQuoted}"`;
  }

  const result = await executeCommand('sh', ['-c', rsyncCmd], { timeout: 300000 });
  return { result, timestamp, syncMode: 'rsync' };
}

async function syncWithSftp(task) {
  const localDir = convertWindowsPath(task.local_dir);
  const remoteDir = task.remote_dir;

  const sshpassPath = getCommandPath('sshpass');
  const sftpPath = getCommandPath('sftp');

  const sftpCmd = `echo 'put -r "${localDir}"/* "${remoteDir}/"' | SSHPASS='${task.password}' ${sshpassPath} -e ${sftpPath} -P ${task.remote_port} -o StrictHostKeyChecking=accept-new ${task.username}@${task.remote_host}`;

  const result = await executeCommand('sh', ['-c', sftpCmd], { timeout: 300000 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('Z')[0];

  return { result, timestamp, syncMode: 'sftp' };
}

async function getLocalFiles(localDir) {
  const files = [];

  function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(localDir);
  return files;
}

async function getRemoteFiles(config, remoteDir) {
  const findCmd = `cd "${remoteDir}" && find . -maxdepth 10 ! -path "./.versions/*" ! -path "./.trash/*" -type f | sed 's|^./||'`;
  const result = await executeSSH(config, findCmd, 60000);

  if (!result.success) {
    throw new Error(`Failed to list remote files: ${result.output}`);
  }

  return result.stdout.split('\n').filter(line => line.trim() !== '');
}

async function moveToTrash(config, remoteDir, filePath, timestamp) {
  const dirname = path.dirname(filePath);
  const trashPath = `${remoteDir}/.trash/${timestamp}`;

  const mkdirCmd = `mkdir -p "${trashPath}/${dirname}"`;
  await executeSSH(config, mkdirCmd, 60000);

  const mvCmd = `mv "${remoteDir}/${filePath}" "${trashPath}/${filePath}"`;
  const result = await executeSSH(config, mvCmd, 60000);

  if (!result.success) {
    console.error(`Failed to move ${filePath} to trash: ${result.output}`);
  }
}

async function handleTrash(task, timestamp) {
  if (!task.trash_enabled) {
    return;
  }

  const config = {
    remote_host: task.remote_host,
    remote_port: task.remote_port,
    username: task.username,
    password: task.password
  };

  try {
    const localFiles = await getLocalFiles(task.local_dir);
    const remoteFiles = await getRemoteFiles(config, task.remote_dir);

    const localSet = new Set(localFiles);
    const extraFiles = remoteFiles.filter(file => !localSet.has(file));

    for (const file of extraFiles) {
      await moveToTrash(config, task.remote_dir, file, timestamp);
    }
  } catch (error) {
    console.error(`Trash operation failed: ${error.message}`);
  }
}

async function cleanVersions(task) {
  if (!task.version_enabled) {
    return;
  }

  const config = {
    remote_host: task.remote_host,
    remote_port: task.remote_port,
    username: task.username,
    password: task.password
  };

  const cleanCmd = `cd "${task.remote_dir}/.versions" && ls -1dt */ | tail -n +11 | xargs -I {} rm -rf {}`;

  try {
    await executeSSH(config, cleanCmd, 60000);
  } catch (error) {
    console.error(`Version cleanup failed: ${error.message}`);
  }
}

async function executeSync(taskId) {
  const db = getDB();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (task.is_running) {
    throw new Error('Task is already running');
  }

  db.prepare('UPDATE tasks SET is_running = 1 WHERE id = ?').run(taskId);

  const startTime = Date.now();
  let syncMode = 'rsync';
  let success = false;
  let output = '';

  try {
    const config = {
      remote_host: task.remote_host,
      remote_port: task.remote_port,
      username: task.username,
      password: task.password
    };

    await ensureRemoteDirs(config, task.remote_dir);

    let syncResult;
    try {
      syncResult = await syncWithRsync(task);
      output = syncResult.result.output;

      if (!syncResult.result.success) {
        console.log('rsync failed, falling back to sftp');
        syncResult = await syncWithSftp(task);
        output = syncResult.result.output;
      }

      syncMode = syncResult.syncMode;
      success = syncResult.result.success || syncResult.result.code === 0;

      if (success) {
        await handleTrash(task, syncResult.timestamp);
        await cleanVersions(task);
      }
    } catch (error) {
      output = error.message;
      success = false;
    }

    const duration = Math.floor((Date.now() - startTime) / 1000);

    const logStmt = db.prepare(`
      INSERT INTO logs (task_id, timestamp, status, output, duration, sync_mode)
      VALUES (?, strftime('%s', 'now'), ?, ?, ?, ?)
    `);
    logStmt.run(taskId, success ? 'success' : 'fail', output, duration, syncMode);

    const logCount = db.prepare('SELECT COUNT(*) as count FROM logs WHERE task_id = ?').get(taskId).count;
    if (logCount > 100) {
      const deleteStmt = db.prepare(`
        DELETE FROM logs WHERE task_id = ? AND id NOT IN (
          SELECT id FROM logs WHERE task_id = ? ORDER BY timestamp DESC LIMIT 100
        )
      `);
      deleteStmt.run(taskId, taskId);
    }

    const consecutiveFailures = success ? 0 : task.consecutive_failures + 1;
    const enabled = consecutiveFailures >= 3 ? 0 : task.enabled;

    const updateStmt = db.prepare(`
      UPDATE tasks SET
        is_running = 0,
        last_sync_time = strftime('%s', 'now'),
        last_sync_status = ?,
        consecutive_failures = ?,
        enabled = ?
      WHERE id = ?
    `);
    updateStmt.run(success ? 'success' : 'fail', consecutiveFailures, enabled, taskId);

    return { success, output, syncMode };
  } catch (error) {
    db.prepare('UPDATE tasks SET is_running = 0 WHERE id = ?').run(taskId);
    throw error;
  }
}

async function testConnection(config) {
  try {
    const result = await executeSSH(config, 'echo ok', 30000);
    return { success: result.success, error: result.success ? null : result.output };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  executeSync,
  testConnection
};
