const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

let db;

const keyHex = process.env.RSYNC_ENCRYPTION_KEY;
if (!keyHex) {
  console.error('\n错误: RSYNC_ENCRYPTION_KEY环境变量未设置');
  console.error('密码加密需要64字符的hex密钥（32字节）');
  console.error('生成方式: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('设置方式: export RSYNC_ENCRYPTION_KEY=<生成的密钥>\n');
  throw new Error('RSYNC_ENCRYPTION_KEY未设置，应用无法启动');
}
if (keyHex.length !== 64) {
  throw new Error(`RSYNC_ENCRYPTION_KEY长度错误: 需要64字符，当前${keyHex.length}字符`);
}
const key = Buffer.from(keyHex, 'hex');

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