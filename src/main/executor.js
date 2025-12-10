const fs = require('fs');
const path = require('path');
const { executeCommand, executeSSH, convertWindowsPath, escapeShellArg, getCommandPath, sendTaskUpdate, sendTaskProgress, acquireLock } = require('./utils');
const { getDB, decryptPassword } = require('../database/db');
const config = require('../config');

async function ensureRemoteDirs(sshConfig, remoteDir) {
  const cmd = `mkdir -p ${escapeShellArg(remoteDir)} ${escapeShellArg(remoteDir + '/' + config.paths.versionsDir)} ${escapeShellArg(remoteDir + '/' + config.paths.trashDir)}`;
  const result = await executeSSH(sshConfig, cmd, config.timeouts.sshMkdir);

  if (!result.success) {
    throw new Error(`Failed to create remote directories: ${result.output}`);
  }
}

function getLocalFileList(localDir) {
  const files = [];
  const queue = ['.'];

  while (queue.length > 0) {
    const rel = queue.shift();
    const abs = path.join(localDir, rel);

    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });

      for (const entry of entries) {
        const relPath = rel === '.' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          queue.push(relPath);
        } else if (entry.isFile()) {
          files.push(relPath);
        }
      }
    } catch (error) {
      console.warn(`Skipping directory ${abs}: ${error.message}`);
    }
  }

  return files.map(f => f.replace(/\\/g, '/'));
}

async function getRemoteFileList(sshConfig, remoteDir) {
  const findCmd = `cd ${escapeShellArg(remoteDir)} && find . -type f ! -path "./${config.paths.versionsDir}/*" ! -path "./${config.paths.trashDir}/*" | sed 's|^./||'`;
  const result = await executeSSH(sshConfig, findCmd, config.timeouts.sshFind);

  if (!result.success) {
    throw new Error(`Failed to list remote files: ${result.output}`);
  }

  return result.output.split('\n').filter(f => f.trim() !== '');
}

async function moveFilesToTrash(sshConfig, remoteDir, files, timestamp) {
  if (files.length === 0) {
    return;
  }

  const trashBase = `${remoteDir}/${config.paths.trashDir}/${timestamp}`;
  const commands = [];

  for (const file of files) {
    const fileDir = path.posix.dirname(file);
    const trashTargetDir = fileDir === '.' ? trashBase : `${trashBase}/${fileDir}`;
    const srcPath = `${escapeShellArg(remoteDir)}/${escapeShellArg(file)}`;
    const dstPath = `${escapeShellArg(trashBase)}/${escapeShellArg(file)}`;
    commands.push(`mkdir -p ${escapeShellArg(trashTargetDir)} && mv ${srcPath} ${dstPath}`);
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < commands.length; i += BATCH_SIZE) {
    const batch = commands.slice(i, i + BATCH_SIZE);
    const batchCmd = batch.join(' && ');
    const result = await executeSSH(sshConfig, batchCmd, config.timeouts.sshTrashMove);

    if (!result.success) {
      throw new Error(`Trash batch ${Math.floor(i / BATCH_SIZE)} failed: ${result.output}`);
    }
  }
}

async function syncWithRsync(task) {
  const localDir = convertWindowsPath(task.local_dir);
  const remoteDir = task.remote_dir.replace(/\/+$/, '');
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('Z')[0]}_${process.hrtime.bigint()}`;

  const sshConfig = {
    remote_host: task.remote_host,
    remote_port: task.remote_port,
    username: task.username,
    password: task.password
  };

  if (task.trash_enabled) {
    const remoteFiles = await getRemoteFileList(sshConfig, remoteDir);
    const localFiles = getLocalFileList(task.local_dir);
    const localSet = new Set(localFiles);
    const toTrash = remoteFiles.filter(f => !localSet.has(f));

    if (toTrash.length > 0) {
      console.log(`Moving ${toTrash.length} files to trash...`);
      await moveFilesToTrash(sshConfig, remoteDir, toTrash, timestamp);
    }
  }

  const localDirQuoted = escapeShellArg(localDir + '/');
  const remoteDirQuoted = escapeShellArg(remoteDir + '/');

  const rsyncPath = getCommandPath('rsync');
  const sshpassPath = getCommandPath('sshpass');
  const sshPath = getCommandPath('ssh');

  const rshCmd = `${sshPath} -p ${task.remote_port} -o StrictHostKeyChecking=accept-new`;
  const rshCmdQuoted = escapeShellArg(rshCmd);

  const rsyncArgs = [
    '-avz',
    '--delete',
    '--force',
    `--exclude=${config.paths.versionsDir}`,
    `--exclude=${config.paths.trashDir}`,
    '--progress',
  ];

  if (task.version_enabled) {
    const versionBackupDir = `${remoteDir}/${config.paths.versionsDir}/${timestamp}`;
    const versionBackupDirQuoted = escapeShellArg(versionBackupDir);
    rsyncArgs.push('--backup', `--backup-dir=${versionBackupDirQuoted}`);
  }

  const onOutput = (data) => {
    const matches = data.match(/(\d{1,3}%)\s+([0-9.]+[a-zA-Z]+\/s)/);
    if (matches) {
      sendTaskProgress(task.id, { percent: matches[1], speed: matches[2] });
    }
  };

  const rsyncCmd = `SSHPASS=${escapeShellArg(task.password)} ${sshpassPath} -e ${rsyncPath} ${rsyncArgs.join(' ')} -e ${rshCmdQuoted} ${localDirQuoted} ${task.username}@${task.remote_host}:${remoteDirQuoted} 2>&1`;

  const result = await executeCommand('sh', ['-c', rsyncCmd], {
    timeout: config.timeouts.rsync,
    onOutput: onOutput
  });

  if (result.code === 24) {
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
  if (!task.version_enabled) {
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

  let decryptedPassword = null;
  try {
    decryptedPassword = decryptPassword(task.password);
    const sshConfig = {
      remote_host: task.remote_host,
      remote_port: task.remote_port,
      username: task.username,
      password: decryptedPassword
    };

    console.log(`Task ${taskId}: Ensuring remote directories...`);
    await ensureRemoteDirs(sshConfig, task.remote_dir);

    let syncResult;
    try {
      console.log(`Task ${taskId}: Starting rsync...`);
      const taskWithDecryptedPassword = { ...task, password: decryptedPassword };
      syncResult = await syncWithRsync(taskWithDecryptedPassword);
      output = syncResult.result.output;
      success = syncResult.result.success || syncResult.result.code === 0;

      console.log(`Task ${taskId}: Rsync finished. Success: ${success}, Code: ${syncResult.result.code}`);

      if (!success) {
        throw new Error('rsync returned non-zero code');
      }

      syncMode = 'rsync';
      await cleanVersions(taskWithDecryptedPassword);
      
    } catch (rsyncError) {
      console.warn('Rsync failed, attempting SFTP fallback:', rsyncError.message);
      try {
        console.log(`Task ${taskId}: Starting SFTP fallback...`);
        const taskWithDecryptedPassword = { ...task, password: decryptedPassword };
        syncResult = await syncWithSftp(taskWithDecryptedPassword);
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
    output = output || error.message;
    throw error;
  } finally {
    if (decryptedPassword) {
      decryptedPassword = null;
    }

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
