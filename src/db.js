const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './database/shop.db';
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.resolve(DB_PATH));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema
const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
db.exec(schemaSql);

// Seed defaults (idempotent)
const seed = db.transaction(() => {
  const ownerCount = db.prepare('SELECT COUNT(*) AS c FROM employees WHERE role = ?').get('owner').c;
  if (ownerCount === 0) {
    const hash = bcrypt.hashSync('Admin@2026', 10);
    db.prepare(
      'INSERT INTO employees (employee_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
    ).run('EMP-0001', 'System Owner', 'admin@alphaparts.com', hash, 'owner');
  }

  const defaults = [
    ['app_name', 'AlphaParts Pro', 'general'],
    ['app_currency_code', 'DZD', 'currency'],
    ['app_currency_symbol', 'د.ج', 'currency'],
    ['app_currency_format', '{amount} {symbol}', 'currency'],
    ['app_language', 'en', 'general'],
    ['app_theme', 'light', 'theme'],
    ['telegram_bot_token', '', 'telegram'],
    ['telegram_chat_id', '', 'telegram'],
    ['telegram_enabled', 'false', 'telegram'],
    ['sale_discount_enabled', 'true', 'pos'],
    ['sale_tax_enabled', 'false', 'pos'],
    ['sale_tax_rate', '0', 'pos'],
    ['low_stock_threshold', '5', 'general'],
    ['auto_backup_enabled', 'false', 'general'],
    ['last_backup_at', '', 'general'],
  ];
  const upsert = db.prepare(
    'INSERT INTO settings (setting_key, setting_value, setting_group) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO NOTHING'
  );
  defaults.forEach(([k, v, g]) => upsert.run(k, v, g));
});
seed();

// Human-readable ID generators
function nextEmployeeId() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM employees').get();
  return `EMP-${String(row.c + 1).padStart(4, '0')}`;
}
function nextProductId() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM products').get();
  return `PRD-${String(row.c + 1).padStart(4, '0')}`;
}
function nextSaleId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const row = db.prepare("SELECT COUNT(*) AS c FROM sales WHERE sale_id LIKE ?").get(`SALE-${today}-%`);
  return `SALE-${today}-${String(row.c + 1).padStart(4, '0')}`;
}

function logActivity(employeeId, action, entityType, entityId, changes, req) {
  db.prepare(
    'INSERT INTO activity_log (employee_id, action, entity_type, entity_id, changes, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(employeeId || null, action, entityType || null, entityId || null,
        changes ? JSON.stringify(changes) : null,
        req?.ip || null, req?.headers?.['user-agent'] || null);
}

module.exports = { db, nextEmployeeId, nextProductId, nextSaleId, logActivity };
