const parseIntOrDefault = (envVar, defaultValue) => {
  const parsed = parseInt(envVar, 10);
  return !isNaN(parsed) ? parsed : defaultValue;
};

const config = {
  timeouts: {
    rsync: parseIntOrDefault(process.env.RSYNC_TIMEOUT, 3600000),
    sftp: parseIntOrDefault(process.env.SFTP_TIMEOUT, 300000),
    ssh: parseIntOrDefault(process.env.SSH_TIMEOUT, 120000),
    sshMkdir: parseIntOrDefault(process.env.SSH_MKDIR_TIMEOUT, 30000),
    sshFind: parseIntOrDefault(process.env.SSH_FIND_TIMEOUT, 60000),
    sshTrashMove: parseIntOrDefault(process.env.SSH_TRASH_MOVE_TIMEOUT, 120000),
    sshVersionCleanup: parseIntOrDefault(process.env.SSH_VERSION_CLEANUP_TIMEOUT, 60000),
    sshTrashCleanup: parseIntOrDefault(process.env.SSH_TRASH_CLEANUP_TIMEOUT, 120000),
    sshTestConnection: parseIntOrDefault(process.env.SSH_TEST_CONNECTION_TIMEOUT, 30000),
    defaultCommand: parseIntOrDefault(process.env.DEFAULT_COMMAND_TIMEOUT, 120000)
  },

  limits: {
    maxLogs: parseIntOrDefault(process.env.MAX_LOGS, 100),
    maxVersions: parseIntOrDefault(process.env.MAX_VERSIONS, 10),
    trashRetentionDays: parseIntOrDefault(process.env.TRASH_RETENTION_DAYS, 90),
    maxConsecutiveFailures: parseIntOrDefault(process.env.MAX_CONSECUTIVE_FAILURES, 3),
    staleTaskThreshold: parseIntOrDefault(process.env.STALE_TASK_THRESHOLD, 86400),
    maxOutputSize: parseIntOrDefault(process.env.MAX_OUTPUT_SIZE, 10240)
  },

  paths: {
    versionsDir: process.env.VERSIONS_DIR || '.versions',
    trashDir: process.env.TRASH_DIR || '.trash'
  },

  process: {
    detached: false
  }
};

module.exports = Object.freeze(config);
