-- AlphaParts Pro Database Schema v1.0.0
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'employee')),
    is_active BOOLEAN DEFAULT 1,
    profile_image TEXT,
    phone_number TEXT,
    hire_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    description TEXT,
    category TEXT,
    brand TEXT,
    supplier TEXT,
    supplier_sku TEXT,
    purchase_price REAL NOT NULL,
    selling_price REAL NOT NULL,
    discounted_price REAL,
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
    weight_kg REAL,
    dimensions TEXT,
    is_active BOOLEAN DEFAULT 1,
    is_archived BOOLEAN DEFAULT 0,
    created_by INTEGER REFERENCES employees(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_reference ON products(reference);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);

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
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);

CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id TEXT UNIQUE NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    subtotal REAL NOT NULL,
    discount_amount REAL DEFAULT 0,
    discount_percentage REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total REAL NOT NULL,
    amount_paid REAL NOT NULL,
    change_given REAL DEFAULT 0,
    payment_method TEXT CHECK (payment_method IN ('cash', 'card', 'transfer', 'mixed')),
    currency TEXT DEFAULT 'DZD',
    is_refunded BOOLEAN DEFAULT 0,
    refund_reference TEXT,
    notes TEXT,
    sold_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_employee ON sales(employee_id);

CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total REAL NOT NULL,
    discount_amount REAL DEFAULT 0,
    subtotal REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id TEXT UNIQUE NOT NULL,
    supplier_name TEXT NOT NULL,
    supplier_contact TEXT,
    total_amount REAL NOT NULL,
    status TEXT CHECK (status IN ('draft', 'sent', 'received', 'partial', 'cancelled')),
    ordered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    received_at DATETIME,
    notes TEXT,
    created_by INTEGER REFERENCES employees(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity_ordered INTEGER NOT NULL,
    quantity_received INTEGER DEFAULT 0,
    unit_cost REAL NOT NULL,
    total REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT UNIQUE NOT NULL,
    setting_value TEXT NOT NULL,
    setting_group TEXT,
    is_encrypted BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    is_read BOOLEAN DEFAULT 0,
    is_sent BOOLEAN DEFAULT 0,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER REFERENCES employees(id),
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    changes TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
