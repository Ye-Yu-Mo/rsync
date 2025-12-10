const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');

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
    const { app } = require('electron');
    const resourcesPath = path.join(app.getAppPath(), 'resources', 'bin');

    if (platform === 'win32') {
      return path.join(resourcesPath, 'windows');
    } else if (platform === 'darwin') {
      return path.join(resourcesPath, 'macos');
    }
  }

  return null;
}

function getCommandPath(command) {
  const binPath = getBinPath();

  if (binPath) {
    const platform = os.platform();
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

  if (filePath.match(/^[A-Za-z]:\\/)) {
    const drive = filePath[0].toLowerCase();
    const rest = filePath.substring(2).replace(/\\/g, '/');
    return `/${drive}${rest}`;
  }

  return filePath.replace(/\\/g, '/');
}

function quotePathIfNeeded(filePath) {
  if (filePath.includes(' ') || filePath.includes('(') || filePath.includes(')')) {
    return `"${filePath}"`;
  }
  return filePath;
}

async function executeCommand(command, args, options = {}) {
  const timeout = options.timeout || 120000;
  const env = { ...process.env, ...options.env };

  const binPath = getBinPath();
  if (binPath && os.platform() === 'win32') {
    env.PATH = `${binPath};${env.PATH}`;
  }

  const cmdString = Array.isArray(args) && args.length === 2 && args[0] === '-c'
    ? args[1]
    : `${command} ${args.join(' ')}`;

  try {
    const { stdout, stderr } = await execPromise(cmdString, {
      timeout,
      env,
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/sh'
    });

    const output = (stdout + stderr).substring(0, 10240);

    return {
      code: 0,
      stdout,
      stderr,
      output,
      success: true
    };
  } catch (error) {
    const stdout = error.stdout || '';
    const stderr = error.stderr || '';
    const output = (stdout + stderr).substring(0, 10240);
    const code = error.code || 1;

    return {
      code,
      stdout,
      stderr,
      output,
      success: false
    };
  }
}

function buildSSHCommand(config, remoteCommand) {
  const { remote_host, remote_port, username, password } = config;
  const port = remote_port || 22;

  const sshpassPath = getCommandPath('sshpass');
  const sshPath = getCommandPath('ssh');

  const sshCmd = `SSHPASS='${password}' ${sshpassPath} -e ${sshPath} -p ${port} -o StrictHostKeyChecking=accept-new ${username}@${remote_host}`;
  return `${sshCmd} '${remoteCommand.replace(/'/g, "'\\''")}'`;
}

async function executeSSH(config, remoteCommand, timeout = 120000) {
  const cmd = buildSSHCommand(config, remoteCommand);
  return executeCommand('sh', ['-c', cmd], { timeout });
}

module.exports = {
  convertWindowsPath,
  quotePathIfNeeded,
  executeCommand,
  executeSSH,
  buildSSHCommand,
  getCommandPath,
  getBinPath
};
