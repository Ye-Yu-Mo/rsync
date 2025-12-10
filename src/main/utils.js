const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');
const config = require('../config');

const execPromise = util.promisify(exec);

function getBinPath() {
  const platform = os.platform();
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    if (platform === 'win32') {
      return path.join(__dirname, '../../resources/bin/windows');
    } else if (platform === 'darwin') {
      return path.join(__dirname, '../../resources/bin/macos');
    }
  } else {
    const resourcesPath = path.join(process.resourcesPath, 'bin');

    if (platform === 'win32') {
      return path.join(resourcesPath, 'windows');
    } else if (platform === 'darwin') {
      return path.join(resourcesPath, 'macos');
    }
  }

  return null;
}

function getCommandPath(command) {
  const platform = os.platform();

  // macOS/Linux use system rsync/ssh/sftp (only sshpass needs bundling)
  if (platform !== 'win32' && ['rsync', 'ssh', 'sftp'].includes(command)) {
    const systemPath = `/usr/bin/${command}`;
    if (fs.existsSync(systemPath)) {
      return systemPath;
    }
  }

  const binPath = getBinPath();

  if (binPath) {
    const ext = platform === 'win32' ? '.exe' : '';
    const fullPath = path.join(binPath, command + ext);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  return command;
}

function convertWindowsPath(filePath) {
  if (os.platform() !== 'win32') {
    return filePath;
  }
  // Handle UNC paths or drive letters
  return filePath.split(path.sep).join(path.posix.sep).replace(/^[a-zA-Z]:/, (match) => match.toLowerCase());
}

/**
 * Escapes a string to be safe for use as a shell argument.
 * - Unix: Wraps in single quotes and escapes existing single quotes
 * - Windows: Wraps in double quotes and escapes double quotes and backslashes
 */
function escapeShellArg(arg) {
  if (arg === undefined || arg === null) {
    return os.platform() === 'win32' ? '""' : "''";
  }

  const str = String(arg);

  if (os.platform() === 'win32') {
    // Windows: use double quotes, escape " and \
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  } else {
    // Unix: use single quotes, escape '
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
}

// Deprecated: Alias for compatibility, but prefer escapeShellArg
function quotePathIfNeeded(filePath) {
  return escapeShellArg(filePath);
}

async function executeCommand(command, args, options = {}) {
  const timeout = options.timeout || config.timeouts.defaultCommand;
  const env = { ...process.env, ...options.env };
  const onOutput = options.onOutput; // Callback for realtime output

  const binPath = getBinPath();
  if (binPath && os.platform() === 'win32') {
    env.PATH = `${binPath};${env.PATH}`;
  }

  // If args is ['-c', 'cmd_string'], we are running in shell mode.
  // Otherwise, we are running a command directly.
  let spawnCmd = command;
  let spawnArgs = args;
  let shellOption = false;

  if (Array.isArray(args) && args.length === 2 && args[0] === '-c') {
    // We want to run in a shell.
    shellOption = true;
    if (os.platform() === 'win32') {
      spawnCmd = 'cmd.exe';
      spawnArgs = ['/c', args[1]];
    } else {
      spawnCmd = '/bin/sh';
      spawnArgs = ['-c', args[1]];
    }
  }

  return new Promise((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      env,
      detached: config.process.detached,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (data) => {
      const str = data.toString();
      // console.log(`[CMD STDOUT]: ${str.trim()}`); // Too verbose for progress
      if (onOutput) onOutput(str);
      stdout += str;
    });

    child.stderr.on('data', (data) => {
      const str = data.toString();
      console.log(`[CMD STDERR]: ${str.trim()}`);
      stderr += str;
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        // Kill the whole process group
        process.kill(-child.pid, 'SIGKILL');
        console.warn(`[CMD TIMEOUT]: Process for command "${spawnCmd}" (PID: ${child.pid}) killed after ${timeout / 1000}s`);
      } catch (e) {
        // Ignore if already dead
        console.warn(`[CMD TIMEOUT ERROR]: Failed to kill process ${child.pid}: ${e.message}`);
      }
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      console.log(`[CMD CLOSE]: Command "${spawnCmd}" (PID: ${child.pid}) closed with code ${code}, killed: ${killed}`);

      const output = (stdout + stderr).substring(0, config.limits.maxOutputSize);
      
      if (killed) {
         resolve({
          code: -1,
          stdout,
          stderr: stderr + '\n[TIMEOUT]',
          output: output + '\n[TIMEOUT]',
          success: false
        });
      } else {
        resolve({
          code: code || 0,
          stdout,
          stderr,
          output,
          success: code === 0
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: err.message,
        output: err.message,
        success: false
      });
    });
  });
}

function buildSSHCommand(sshConfig, remoteCommand) {
  const { remote_host, remote_port, username, password } = sshConfig;
  const port = remote_port || 22;

  const sshpassPath = getCommandPath('sshpass');
  const sshPath = getCommandPath('ssh');

  const args = [
    '-e',
    sshPath,
    '-p',
    String(port),
    '-o',
    'StrictHostKeyChecking=accept-new',
    `${username}@${remote_host}`,
    remoteCommand
  ];

  return {
    command: sshpassPath,
    args,
    env: { SSHPASS: password }
  };
}

async function executeSSH(sshConfig, remoteCommand, timeout) {
  const defaultTimeout = config.timeouts.ssh;
  const actualTimeout = timeout !== undefined ? timeout : defaultTimeout;
  const { command, args, env } = buildSSHCommand(sshConfig, remoteCommand);
  return executeCommand(command, args, { timeout: actualTimeout, env });
}

function isTaskStale(task, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!task || !task.is_running || !task.started_at) {
    return false;
  }
  return nowSeconds - task.started_at > config.limits.staleTaskThreshold;
}

function releaseLock(db, taskId) {
  db.prepare('UPDATE tasks SET is_running = 0 WHERE id = ?').run(taskId);
}

function acquireLock(db, taskId, options = {}) {
  const retries = options.retries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 50;

  const getTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const lockStmt = db.prepare("UPDATE tasks SET is_running = 1, started_at = strftime('%s', 'now') WHERE id = ? AND is_running = 0");

  const takeLock = db.transaction((id) => {
    const task = getTask.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    if (isTaskStale(task)) {
      releaseLock(db, id);
    }

    const result = lockStmt.run(id);
    if (result.changes === 0) {
      return { locked: false, task: getTask.get(id) };
    }

    return { locked: true, task: getTask.get(id) };
  });

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return takeLock.immediate(taskId);
    } catch (error) {
      if (error.code === 'SQLITE_BUSY' && attempt < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < retryDelayMs * (attempt + 1)) {}
        continue;
      }
      throw error;
    }
  }

  return { locked: false, task: null };
}

function sendTaskUpdate() {
  const { BrowserWindow } = require('electron');
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    win.webContents.send('task-update');
  });
}

function sendTaskProgress(taskId, progress) {
  const { BrowserWindow } = require('electron');
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    win.webContents.send('task-progress', { taskId, ...progress });
  });
}

module.exports = {
  convertWindowsPath,
  quotePathIfNeeded,
  escapeShellArg,
  executeCommand,
  executeSSH,
  buildSSHCommand,
  getCommandPath,
  getBinPath,
  sendTaskUpdate,
  sendTaskProgress,
  isTaskStale,
  acquireLock,
  releaseLock
};
