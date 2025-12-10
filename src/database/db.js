const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const crypto = require('crypto');

let db;

function getKeyFilePath() {
  const userDataPath = app.getPath('userData');
  try {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return path.join(userDataPath, 'encryption.key');
}

function validateKeyHex(keyHex, source) {
  if (!keyHex || keyHex.length !== 64 || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error(`Invalid encryption key from ${source}: must be 64 hex characters`);
  }
  return Buffer.from(keyHex, 'hex');
}

function readKeyFile(keyPath) {
  try {
    let keyHex = fs.readFileSync(keyPath, 'utf8');
    keyHex = keyHex.replace(/^\uFEFF/, '');
    keyHex = keyHex.replace(/[\r\n\s]/g, '');

    if (process.platform !== 'win32') {
      const stats = fs.statSync(keyPath);
      const mode = stats.mode & 0o777;
      if (mode !== 0o600) {
        console.warn(`Warning: ${keyPath} has insecure permissions ${mode.toString(8)}, should be 600`);
      }
    }

    return validateKeyHex(keyHex, keyPath);

  } catch (err) {
    const cpCmd = process.platform === 'win32'
      ? `copy "${keyPath}.backup" "${keyPath}"`
      : `cp "${keyPath}.backup" "${keyPath}"`;

    throw new Error(
      `Failed to read encryption key from ${keyPath}: ${err.message}\n` +
      `Recovery options:\n` +
      `  1. Restore from backup: ${cpCmd}\n` +
      `  2. Reset (ALL PASSWORDS LOST): delete ${keyPath} and restart\n` +
      `  3. Set environment variable: export RSYNC_ENCRYPTION_KEY=<your-key>`
    );
  }
}

function generateAndPersist(keyPath) {
  const lockPath = keyPath + '.lock';
  let lockFd;

  try {
    lockFd = fs.openSync(lockPath, 'wx');

    if (fs.existsSync(keyPath)) {
      fs.closeSync(lockFd);
      fs.unlinkSync(lockPath);
      return readKeyFile(keyPath);
    }

    const keyHex = crypto.randomBytes(32).toString('hex');
    const tmpPath = keyPath + '.tmp';

    try {
      fs.writeFileSync(tmpPath, keyHex, { mode: 0o600 });

      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        try {
          execSync(`icacls "${tmpPath}" /inheritance:r /grant:r "%USERNAME%:(F)"`, { stdio: 'ignore' });
        } catch (err) {
          console.warn('Failed to set Windows ACL on key file:', err.message);
        }
      }

      fs.renameSync(tmpPath, keyPath);

    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }

    const backupPath = keyPath + '.backup';
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(keyPath, backupPath);
    }

    if (process.platform !== 'win32') {
      fs.chmodSync(backupPath, 0o600);
    } else {
      const { execSync } = require('child_process');
      try {
        execSync(`icacls "${backupPath}" /inheritance:r /grant:r "%USERNAME%:(F)"`, { stdio: 'ignore' });
        execSync(`attrib +h "${keyPath}"`, { stdio: 'ignore' });
        execSync(`attrib +h "${backupPath}"`, { stdio: 'ignore' });
      } catch (err) {
        console.warn('Failed to secure backup on Windows:', err.message);
      }
    }

    fs.closeSync(lockFd);
    fs.unlinkSync(lockPath);

    console.log('\n==========================================================');
    console.log('IMPORTANT: New encryption key generated');
    console.log(`Location: ${keyPath}`);
    console.log(`Backup:   ${backupPath}`);
    console.log('==========================================================');
    console.log('BACKUP THESE FILES IMMEDIATELY to prevent data loss!');
    console.log('If lost, all saved passwords will be unrecoverable.');
    console.log('==========================================================\n');

    return Buffer.from(keyHex, 'hex');

  } catch (err) {
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }

    if (err.code === 'EEXIST') {
      let attempts = 0;
      while (attempts < 50) {
        if (fs.existsSync(keyPath)) {
          return readKeyFile(keyPath);
        }
        const start = Date.now();
        while (Date.now() - start < 100) {}
        attempts++;
      }
      throw new Error('Timeout waiting for encryption key generation by another process');
    }

    const errMsg = err.code === 'ENOSPC'
      ? 'Disk full - free up space and restart'
      : `Check directory permissions: ls -ld ${path.dirname(keyPath)}`;

    throw new Error(
      `Failed to generate encryption key at ${keyPath}: ${err.message}\n${errMsg}`
    );
  }
}

function loadEncryptionKey() {
  if (process.env.RSYNC_ENCRYPTION_KEY) {
    return validateKeyHex(process.env.RSYNC_ENCRYPTION_KEY, 'environment variable');
  }

  const keyPath = getKeyFilePath();

  if (fs.existsSync(keyPath)) {
    return readKeyFile(keyPath);
  }

  return generateAndPersist(keyPath);
}

const key = loadEncryptionKey();

function encryptPassword(plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptPassword(stored) {
  if (!stored || !stored.startsWith('v1:')) return stored;
  try {
    const [, ivHex, tagHex, dataHex] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('密码解密失败:', error.message);
    throw new Error('密码解密失败，请检查RSYNC_ENCRYPTION_KEY是否正确');
  }
}

function init() {
  const dbPath = path.join(app.getPath('userData'), 'rsync.db');
  db = new Database(dbPath);

  // 1. Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      remote_host TEXT NOT NULL,
      remote_port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      local_dir TEXT NOT NULL,
      remote_dir TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      version_enabled INTEGER NOT NULL DEFAULT 1,
      trash_enabled INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_running INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_sync_time INTEGER,
      last_sync_status TEXT,
      started_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      status TEXT NOT NULL,
      output TEXT,
      duration INTEGER,
      sync_mode TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
  `);

  // 2. Migration: Add started_at column if it doesn't exist (for existing DBs)
  try {
    const tasksInfo = db.prepare('PRAGMA table_info(tasks)').all();
    const hasStartedAt = tasksInfo.some(column => column.name === 'started_at');
    
    if (!hasStartedAt) {
      db.prepare('ALTER TABLE tasks ADD COLUMN started_at INTEGER').run();
    }
  } catch (error) {
    console.error('Migration failed:', error);
  }

  // 3. Migration: Encrypt plaintext passwords
  try {
    const rows = db.prepare('SELECT id, password FROM tasks').all();
    let encryptedCount = 0;
    for (const row of rows) {
      if (row.password && !row.password.startsWith('v1:')) {
        const encrypted = encryptPassword(row.password);
        db.prepare('UPDATE tasks SET password = ? WHERE id = ?').run(encrypted, row.id);
        encryptedCount++;
      }
    }
    if (encryptedCount > 0) {
      console.log(`已加密 ${encryptedCount} 个明文密码`);
    }
  } catch (error) {
    console.error('密码加密迁移失败:', error);
  }

  return db;
}

function getDB() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

module.exports = {
  init,
  getDB,
  encryptPassword,
  decryptPassword
};