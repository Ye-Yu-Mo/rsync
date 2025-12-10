const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db;

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
  getDB
};