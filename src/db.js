const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'shop.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// ========== SHOPS TABLE ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_code TEXT UNIQUE NOT NULL,
    shop_name TEXT NOT NULL,
    owner_email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== EMPLOYEES TABLE ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE NOT NULL,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'employee')),
    is_active BOOLEAN DEFAULT 1,
    profile_image TEXT,
    phone_number TEXT,
    hire_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shop_id, email)
  );
`);

// ========== PRODUCTS TABLE ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT UNIQUE NOT NULL,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    reference TEXT NOT NULL,
    description TEXT,
    category TEXT,
    brand TEXT,
    supplier TEXT,
    supplier_sku TEXT,
    purchase_price DECIMAL(10,2) NOT NULL,
    selling_price DECIMAL(10,2) NOT NULL,
    discounted_price DECIMAL(10,2),
    quantity INTEGER NOT NULL DEFAULT 0,
    min_quantity INTEGER DEFAULT 5,
    max_quantity INTEGER DEFAULT 100,
    reorder_point INTEGER DEFAULT 10,
    image_path TEXT,
    image_thumbnail_path TEXT,
    images TEXT,
    location TEXT,
    compatibility TEXT,
    warranty_months INTEGER DEFAULT 12,
    weight_kg DECIMAL(8,2),
    dimensions TEXT,
    is_active BOOLEAN DEFAULT 1,
    is_archived BOOLEAN DEFAULT 0,
    created_by INTEGER REFERENCES employees(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shop_id, reference)
  );
`);

// ========== SALES TABLE ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id TEXT UNIQUE NOT NULL,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    subtotal DECIMAL(10,2) NOT NULL,
    discount_amount DECIMAL(10,2) DEFAULT 0,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    tax_amount DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    amount_paid DECIMAL(10,2) NOT NULL,
    change_given DECIMAL(10,2) DEFAULT 0,
    payment_method TEXT CHECK (payment_method IN ('cash', 'card', 'transfer', 'mixed')),
    currency TEXT DEFAULT 'DZD',
    is_refunded BOOLEAN DEFAULT 0,
    refund_reference TEXT,
    notes TEXT,
    sold_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== SALE ITEMS ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    total DECIMAL(10,2) NOT NULL,
    discount_amount DECIMAL(10,2) DEFAULT 0,
    subtotal DECIMAL(10,2) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== STOCK MOVEMENTS ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity_change INTEGER NOT NULL,
    previous_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'return', 'adjustment', 'damage', 'restock')),
    reference_id TEXT,
    notes TEXT,
    performed_by INTEGER REFERENCES employees(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== SETTINGS ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    setting_group TEXT,
    is_encrypted BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shop_id, setting_key)
  );
`);

// ========== NOTIFICATIONS ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    is_read BOOLEAN DEFAULT 0,
    is_sent BOOLEAN DEFAULT 0,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== ACTIVITY LOG ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id),
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    changes TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== INDEXES ==========
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_shop_reference ON products(shop_id, reference);
  CREATE INDEX IF NOT EXISTS idx_products_shop_name ON products(shop_id, name);
  CREATE INDEX IF NOT EXISTS idx_employees_shop_email ON employees(shop_id, email);
  CREATE INDEX IF NOT EXISTS idx_sales_shop_date ON sales(shop_id, sold_at);
`);

// ========== HELPERS ==========
function generateShopCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let exists;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    exists = db.prepare('SELECT id FROM shops WHERE shop_code = ?').get(code);
  } while (exists);
  return code;
}

function nextEmployeeId() {
  const last = db.prepare("SELECT employee_id FROM employees ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'EMP-0001';
  const num = parseInt(last.employee_id.split('-')[1], 10) + 1;
  return `EMP-${String(num).padStart(4, '0')}`;
}

function nextProductId(shopId) {
  const last = db.prepare("SELECT product_id FROM products WHERE shop_id = ? ORDER BY id DESC LIMIT 1").get(shopId);
  if (!last) return 'PRD-0001';
  const num = parseInt(last.product_id.split('-')[1], 10) + 1;
  return `PRD-${String(num).padStart(4, '0')}`;
}

function nextSaleId(shopId) {
  const last = db.prepare("SELECT sale_id FROM sales WHERE shop_id = ? ORDER BY id DESC LIMIT 1").get(shopId);
  if (!last) return 'SALE-0001';
  const num = parseInt(last.sale_id.split('-')[1], 10) + 1;
  return `SALE-${String(num).padStart(4, '0')}`;
}

function logActivity(shopId, employeeId, action, entityType, entityId, changes, req) {
  const ip = req?.ip || req?.connection?.remoteAddress || null;
  const userAgent = req?.headers?.['user-agent'] || null;
  db.prepare(`
    INSERT INTO activity_log (shop_id, employee_id, action, entity_type, entity_id, changes, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(shopId, employeeId, action, entityType, entityId, changes ? JSON.stringify(changes) : null, ip, userAgent);
}

module.exports = {
  db,
  generateShopCode,
  nextEmployeeId,
  nextProductId,
  nextSaleId,
  logActivity
};