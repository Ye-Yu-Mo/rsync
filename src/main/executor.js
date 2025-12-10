const fs = require('fs');
const path = require('path');
const { executeCommand, executeSSH, convertWindowsPath, escapeShellArg, getCommandPath, sendTaskUpdate, sendTaskProgress, acquireLock } = require('./utils');
const { getDB } = require('../database/db');
const config = require('../config');

async function ensureRemoteDirs(sshConfig, remoteDir) {
  const cmd = `mkdir -p ${escapeShellArg(remoteDir)} ${escapeShellArg(remoteDir + '/' + config.paths.versionsDir)}`;
  const result = await executeSSH(sshConfig, cmd, config.timeouts.sshMkdir);

  if (!result.success) {
    throw new Error(`Failed to create remote directories: ${result.output}`);
  }
}

async function syncWithRsync(task) {
  const localDir = convertWindowsPath(task.local_dir);
  // Remove trailing slashes from remoteDir to ensure consistent path handling
  const remoteDir = task.remote_dir.replace(/\/+$/, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('Z')[0];

  const localDirQuoted = escapeShellArg(localDir + '/'); // Trailing slash important for rsync
  const remoteDirQuoted = escapeShellArg(remoteDir + '/');

  const backupDir = `${remoteDir}/${config.paths.versionsDir}/${timestamp}`;
  const backupDirQuoted = escapeShellArg(backupDir);

  const rsyncPath = getCommandPath('rsync');
  const sshpassPath = getCommandPath('sshpass');
  const sshPath = getCommandPath('ssh');

  // Build the SSH command for rsync to use
  // We must strictly quote the password in the environment variable, but sshpass takes it from env.
  // executeCommand handles env vars safely.
  
  const rshCmd = `${sshPath} -p ${task.remote_port} -o StrictHostKeyChecking=accept-new`;
  const rshCmdQuoted = escapeShellArg(rshCmd);

  let rsyncArgs = [
    '-avz',
    '--delete',
    '--force',
    `--exclude=${config.paths.versionsDir}`,
    '--progress',
  ];

  if (task.version_enabled || task.trash_enabled) {
    rsyncArgs.push('--backup');
    rsyncArgs.push(`--backup-dir=${backupDirQuoted}`);
  }

  // Construct the full command string
  // Note: We use localDirQuoted and remoteDirQuoted which are already strictly escaped strings.
  // We use SSHPASS env var for security (avoiding password in process list argument, though still visible in env if inspected)
  const rsyncCmd = `SSHPASS=${escapeShellArg(task.password)} ${sshpassPath} -e ${rsyncPath} ${rsyncArgs.join(' ')} -e ${rshCmdQuoted} ${localDirQuoted} ${task.username}@${task.remote_host}:${remoteDirQuoted} 2>&1`;

  // console.log('Executing rsync:', rsyncCmd); // Debug log (remove in prod)

  const onOutput = (data) => {
    // Parse rsync progress
    // Example: 73159456  28%   43.46kB/s    1:09:49
    // Regex matches: bytes, percent, speed, time
    const matches = data.match(/(\d{1,3}%)\s+([0-9.]+[a-zA-Z]+\/s)/);
    if (matches) {
      const percent = matches[1];
      const speed = matches[2];
      sendTaskProgress(task.id, { percent, speed });
    }
  };

  const result = await executeCommand('sh', ['-c', rsyncCmd], {
    timeout: config.timeouts.rsync,
    onOutput: onOutput
  });
  
  // Rsync code 24 means "Partial transfer due to vanished source files"
  // This is common during live syncs and should be treated as success (or at least partial success).
  if (result.code === 24) {
    console.log('Rsync returned code 24 (vanished files), treating as success.');
    result.code = 0;
    result.success = true;
  }

  return { result, timestamp, syncMode: 'rsync' };
}

async function syncWithSftp(task) {
  // Fallback: This is a "dumb" copy. It does NOT support --delete efficiently and won't do versioning.
  // We only use this if rsync fails.
  const localDir = convertWindowsPath(task.local_dir);
  const remoteDir = task.remote_dir;

  const sshpassPath = getCommandPath('sshpass');
  const sftpPath = getCommandPath('sftp');
  
  // Note: SFTP put -r usually doesn't overwrite if not specified, but here we assume basic overwrite.
  // It definitely does NOT delete files.
  
  const batchCmd = `put -r ${escapeShellArg(localDir)}/* ${escapeShellArg(remoteDir)}/`;
  const sftpCmd = `echo ${escapeShellArg(batchCmd)} | SSHPASS=${escapeShellArg(task.password)} ${sshpassPath} -e ${sftpPath} -P ${task.remote_port} -o StrictHostKeyChecking=accept-new ${task.username}@${task.remote_host}`;

  const result = await executeCommand('sh', ['-c', sftpCmd], { timeout: config.timeouts.sftp });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('Z')[0];

  return { result, timestamp, syncMode: 'sftp' };
}

async function cleanVersions(task) {
  if (!task.version_enabled && !task.trash_enabled) {
    return;
  }

  const sshConfig = {
    remote_host: task.remote_host,
    remote_port: task.remote_port,
    username: task.username,
    password: task.password
  };

  const versionsDir = `${task.remote_dir}/${config.paths.versionsDir}`;
  const keepCount = config.limits.maxVersions + 1;
  const cleanCmd = `cd ${escapeShellArg(versionsDir)} && ls -td */ 2>/dev/null | tail -n +${keepCount} | while read -r d; do rm -rf "$d"; done`;

  try {
    await executeSSH(sshConfig, cleanCmd, config.timeouts.sshVersionCleanup);
  } catch (error) {
    console.error(`Version cleanup failed: ${error.message}`);
  }
}

async function executeSync(taskId) {
  const db = getDB();
  const { task, locked } = acquireLock(db, taskId, { retries: 5, retryDelayMs: 50 });

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (!locked) {
    throw new Error('Task is already running');
  }

  sendTaskUpdate();
  console.log(`Task ${taskId} execution started.`);

  const runStartTime = Date.now();
  let syncMode = 'rsync';
  let success = false;
  let output = '';

  try {
    const sshConfig = {
      remote_host: task.remote_host,
      remote_port: task.remote_port,
      username: task.username,
      password: task.password
    };

    console.log(`Task ${taskId}: Ensuring remote directories...`);
    await ensureRemoteDirs(sshConfig, task.remote_dir);

    let syncResult;
    try {
      console.log(`Task ${taskId}: Starting rsync...`);
      syncResult = await syncWithRsync(task);
      output = syncResult.result.output;
      success = syncResult.result.success || syncResult.result.code === 0;
      
      console.log(`Task ${taskId}: Rsync finished. Success: ${success}, Code: ${syncResult.result.code}`);

      if (!success) {
        throw new Error('rsync returned non-zero code');
      }
      
      syncMode = 'rsync';
      await cleanVersions(task);
      
    } catch (rsyncError) {
      console.warn('Rsync failed, attempting SFTP fallback:', rsyncError.message);
      // Fallback to SFTP
      // Note: SFTP does not support deletion or versioning in this implementation.
      try {
        console.log(`Task ${taskId}: Starting SFTP fallback...`);
        syncResult = await syncWithSftp(task);
        output = `[WARNING: Rsync failed, fell back to SFTP. No deletion/versioning performed.]\n` + syncResult.result.output;
        success = syncResult.result.success || syncResult.result.code === 0;
        syncMode = 'sftp';
      } catch (sftpError) {
        output = `Rsync failed: ${rsyncError.message}\nSFTP failed: ${sftpError.message}`;
        success = false;
      }
    }

    return { success, output, syncMode };
  } catch (error) {
    // Propagate error but keep output for logging
    output = output || error.message;
    throw error;
  } finally {
    const duration = Math.floor((Date.now() - runStartTime) / 1000);
    const status = success ? 'success' : 'fail';
    const failed = !success;

    const writeLogAndState = db.transaction(() => {
      const logStmt = db.prepare(`
        INSERT INTO logs (task_id, timestamp, status, output, duration, sync_mode)
        VALUES (?, strftime('%s', 'now'), ?, ?, ?, ?)
      `);
      const logResult = logStmt.run(taskId, status, output, duration, syncMode);
      console.log(`Task ${taskId}: Log written. ID: ${logResult.lastInsertRowid}, Status: ${status}`);

      const logCount = db.prepare('SELECT COUNT(*) as count FROM logs WHERE task_id = ?').get(taskId).count;
      if (logCount > config.limits.maxLogs) {
        const deleteStmt = db.prepare(`
          DELETE FROM logs WHERE task_id = ? AND id NOT IN (
            SELECT id FROM logs WHERE task_id = ? ORDER BY timestamp DESC LIMIT ?
          )
        `);
        deleteStmt.run(taskId, taskId, config.limits.maxLogs);
      }

      db.prepare(`
        UPDATE tasks SET
          is_running = 0,
          last_sync_time = strftime('%s', 'now'),
          last_sync_status = ?,
          consecutive_failures = CASE
            WHEN ? THEN COALESCE(consecutive_failures, 0) + 1
            ELSE 0
          END,
          enabled = CASE
            WHEN enabled = 1 AND ? AND COALESCE(consecutive_failures, 0) + 1 >= ?
            THEN 0
            ELSE enabled
          END
        WHERE id = ?
      `).run(status, failed ? 1 : 0, failed ? 1 : 0, config.limits.maxConsecutiveFailures, taskId);
    });

    writeLogAndState();
    sendTaskUpdate();
  }
}

async function testConnection(sshConfig) {
  try {
    const result = await executeSSH(sshConfig, 'echo "Connection successful"', config.timeouts.sshTestConnection);
    return { success: result.success, error: result.success ? null : result.output };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  executeSync,
  testConnection
};
