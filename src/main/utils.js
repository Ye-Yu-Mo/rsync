const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

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

    const proc = spawn(command, args, {
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

  const sshCmd = `SSHPASS='${password}' sshpass -e ssh -p ${port} -o StrictHostKeyChecking=accept-new ${username}@${remote_host}`;
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
  buildSSHCommand
};
