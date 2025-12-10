const fs = require('fs');
const path = require('path');
const { executeCommand, executeSSH, convertWindowsPath, escapeShellArg, getCommandPath, sendTaskUpdate, sendTaskProgress } = require('./utils');
const { getDB } = require('../database/db');

async function ensureRemoteDirs(config, remoteDir) {
  // We need .versions (which serves as trash and history)
  const cmd = `mkdir -p ${escapeShellArg(remoteDir)} ${escapeShellArg(remoteDir + '/.versions')}`;
  const result = await executeSSH(config, cmd, 30000);

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
  
  // Unified backup directory for both modified and deleted files
  // If "trash_enabled" or "version_enabled" is on, we use this mechanism.
  // We treat them as the same feature: "Keep history of changes/deletions"
  const backupDir = `${remoteDir}/.versions/${timestamp}`;
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
    '-avz', // Added 'z' for compression
    '--delete', // Enable deletion synchronization
    '--force', // Force deletion of directories even if not empty
    '--exclude=.versions', // Linus Fix: Never backup the backup directory!
    '--progress', // Show progress during transfer
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
    timeout: 3600000,
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

  const result = await executeCommand('sh', ['-c', sftpCmd], { timeout: 300000 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('Z')[0];

  return { result, timestamp, syncMode: 'sftp' };
}

async function cleanVersions(task) {
  if (!task.version_enabled && !task.trash_enabled) {
    return;
  }

  const config = {
    remote_host: task.remote_host,
    remote_port: task.remote_port,
    username: task.username,
    password: task.password
  };

  const versionsDir = `${task.remote_dir}/.versions`;
  // Safer cleanup: List directories by time (newest first), skip first 10, remove the rest.
  // Using 'ls -td' implies sorting by modification time.
  const cleanCmd = `cd ${escapeShellArg(versionsDir)} && ls -td */ 2>/dev/null | tail -n +11 | while read -r d; do rm -rf "$d"; done`;

  try {
    await executeSSH(config, cleanCmd, 60000);
  } catch (error) {
    console.error(`Version cleanup failed: ${error.message}`);
    // Non-fatal error
  }
}

async function executeSync(taskId) {
  const db = getDB();
  let task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // If task was stuck in running state for more than 5 minutes, clear the flag.
  // Linus Fix: Use started_at to detect stuck tasks, not last_sync_time.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startTime = task.started_at || 0;
  // Increase timeout to 24 hours (86400 seconds) because rsync can be long running. 
  // 5 minutes was a joke.
  const isPossiblyStuck = task.is_running && (nowSeconds - startTime > 86400);
  
  if (isPossiblyStuck) {
    db.prepare('UPDATE tasks SET is_running = 0 WHERE id = ?').run(taskId);
    task.is_running = 0;
    sendTaskUpdate(); // Notify UI
  }

  if (task.is_running) {
    throw new Error('Task is already running');
  }

  db.prepare('UPDATE tasks SET is_running = 1, started_at = strftime(\'%s\', \'now\') WHERE id = ?').run(taskId);
  sendTaskUpdate(); // Notify UI
  console.log(`Task ${taskId} execution started.`);

  const runStartTime = Date.now();
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

    console.log(`Task ${taskId}: Ensuring remote directories...`);
    await ensureRemoteDirs(config, task.remote_dir);

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
    const consecutiveFailures = success ? 0 : task.consecutive_failures + 1;
    const enabled = success ? task.enabled : (consecutiveFailures >= 3 ? 0 : task.enabled);
    const status = success ? 'success' : 'fail';

    // Always record a log entry
    const logStmt = db.prepare(`
      INSERT INTO logs (task_id, timestamp, status, output, duration, sync_mode)
      VALUES (?, strftime('%s', 'now'), ?, ?, ?, ?)
    `);
    const logResult = logStmt.run(taskId, status, output, duration, syncMode);
    console.log(`Task ${taskId}: Log written. ID: ${logResult.lastInsertRowid}, Status: ${status}`);

    // Trim logs
    const logCount = db.prepare('SELECT COUNT(*) as count FROM logs WHERE task_id = ?').get(taskId).count;
    if (logCount > 100) {
      const deleteStmt = db.prepare(`
        DELETE FROM logs WHERE task_id = ? AND id NOT IN (
          SELECT id FROM logs WHERE task_id = ? ORDER BY timestamp DESC LIMIT 100
        )
      `);
      deleteStmt.run(taskId, taskId);
    }

    db.prepare(`
      UPDATE tasks SET
        is_running = 0,
        last_sync_time = strftime('%s', 'now'),
        last_sync_status = ?,
        consecutive_failures = ?,
        enabled = ?
      WHERE id = ?
    `).run(status, consecutiveFailures, enabled, taskId);
    
    sendTaskUpdate(); // Notify UI
  }
}

async function testConnection(config) {
  try {
    const result = await executeSSH(config, 'echo "Connection successful"', 30000);
    return { success: result.success, error: result.success ? null : result.output };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  executeSync,
  testConnection
};
