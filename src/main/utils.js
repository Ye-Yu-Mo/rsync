const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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

function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 120000;
    const env = { ...process.env, ...options.env };

    const binPath = getBinPath();
    if (binPath && os.platform() === 'win32') {
      env.PATH = `${binPath};${env.PATH}`;
    }

    const cmdPath = getCommandPath(command);

    const proc = spawn(cmdPath, args, {
      env,
      shell: true,
      ...options.spawnOptions
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Command execution failed: ${error.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (killed) {
        reject(new Error(`Command timed out after ${timeout}ms`));
        return;
      }

      const output = (stdout + stderr).substring(0, 10240);

      resolve({
        code,
        stdout,
        stderr,
        output,
        success: code === 0
      });
    });
  });
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
