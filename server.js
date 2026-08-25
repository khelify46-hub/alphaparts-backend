require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { db, nextEmployeeId, nextProductId, nextSaleId, logActivity } = require('./src/db');
const { signToken, authMiddleware, requireRole } = require('./src/auth');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Static uploads ----
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(path.join(UPLOAD_DIR, 'products'), { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(UPLOAD_DIR, 'products'),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10) },
  fileFilter: (req, file, cb) => cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype)),
});

// ================= AUTH =================
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'validation', message: 'Email and password are required.' });
  const emp = db.prepare('SELECT * FROM employees WHERE email = ? AND is_active = 1').get(String(email).toLowerCase().trim());
  if (!emp || !bcrypt.compareSync(password, emp.password_hash)) {
    return res.status(401).json({ error: 'invalidCredentials', message: 'Invalid email or password' });
  }
  db.prepare('UPDATE employees SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(emp.id);
  logActivity(emp.id, 'login', 'employee', emp.employee_id, null, req);
  res.json({
    token: signToken(emp),
    employee: { id: emp.id, employeeId: emp.employee_id, fullName: emp.full_name, email: emp.email, role: emp.role },
  });
});

// ================= EMPLOYEES =================
app.get('/api/employees', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const rows = db.prepare('SELECT id, employee_id, full_name, email, role, is_active, phone_number, hire_date, last_login FROM employees ORDER BY id').all();
  res.json(rows);
});

app.post('/api/employees', authMiddleware, requireRole('owner'), (req, res) => {
  const { fullName, email, password, role, phoneNumber } = req.body || {};
  if (!fullName || !email || !password || !role) return res.status(400).json({ error: 'validation', message: 'fullName, email, password and role are required.' });
  if (!['owner', 'manager', 'employee'].includes(role)) return res.status(400).json({ error: 'validation', message: 'Invalid role.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'validation', message: 'Password must be at least 8 characters.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'validation', message: 'Please enter a valid email address.' });
  const exists = db.prepare('SELECT id FROM employees WHERE email = ?').get(String(email).toLowerCase().trim());
  if (exists) return res.status(409).json({ error: 'validation', message: 'Email already in use.' });
  const hash = bcrypt.hashSync(password, 10);
  const employeeId = nextEmployeeId();
  const info = db.prepare('INSERT INTO employees (employee_id, full_name, email, password_hash, role, phone_number) VALUES (?, ?, ?, ?, ?, ?)')
    .run(employeeId, fullName, String(email).toLowerCase().trim(), hash, role, phoneNumber || null);
  logActivity(req.user.id, 'add_employee', 'employee', employeeId, { fullName, role }, req);
  res.status(201).json({ id: info.lastInsertRowid, employeeId, fullName, email, role });
});

app.put('/api/employees/:id', authMiddleware, requireRole('owner'), (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'notFound', message: 'Employee not found.' });
  const { fullName, email, role, phoneNumber, isActive, password } = req.body || {};
  if (role && !['owner', 'manager', 'employee'].includes(role)) return res.status(400).json({ error: 'validation', message: 'Invalid role.' });
  db.prepare(`UPDATE employees SET full_name = ?, email = ?, role = ?, phone_number = ?, is_active = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(fullName ?? emp.full_name, email ? String(email).toLowerCase().trim() : emp.email, role ?? emp.role,
         phoneNumber ?? emp.phone_number, isActive ?? emp.is_active,
         password ? bcrypt.hashSync(password, 10) : emp.password_hash, emp.id);
  logActivity(req.user.id, 'update_employee', 'employee', emp.employee_id, { fullName, role, isActive }, req);
  res.json({ ok: true });
});

app.delete('/api/employees/:id', authMiddleware, requireRole('owner'), (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'notFound', message: 'Employee not found.' });
  if (emp.id === req.user.id) return res.status(400).json({ error: 'validation', message: 'You cannot delete your own account.' });
  if (emp.role === 'owner') {
    const owners = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE role = 'owner' AND is_active = 1").get().c;
    if (owners <= 1) return res.status(400).json({ error: 'validation', message: 'Cannot delete the last owner.' });
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(emp.id);
  logActivity(req.user.id, 'delete_employee', 'employee', emp.employee_id, null, req);
  res.json({ ok: true });
});

// ================= PRODUCTS =================
const PRODUCT_FIELDS = ['name', 'reference', 'description', 'category', 'brand', 'supplier', 'supplier_sku',
  'purchase_price', 'selling_price', 'discounted_price', 'quantity', 'min_quantity', 'max_quantity',
  'reorder_point', 'location', 'compatibility', 'warranty_months', 'weight_kg'];

app.get('/api/products', authMiddleware, (req, res) => {
  const { search, category, brand, stock, page = 1, limit = 20 } = req.query;
  const where = ["is_archived = 0"];
  const params = [];
  if (search) { where.push('(name LIKE ? OR reference LIKE ? OR brand LIKE ?)'); const s = `%${search}%`; params.push(s, s, s); }
  if (category && category !== 'all') { where.push('category = ?'); params.push(category); }
  if (brand && brand !== 'all') { where.push('brand = ?'); params.push(brand); }
  if (stock === 'low') where.push('quantity <= min_quantity AND quantity > 0');
  if (stock === 'out') where.push('quantity = 0');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM products ${whereSql}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM products ${whereSql} ORDER BY name LIMIT ? OFFSET ?`)
    .all(...params, parseInt(limit, 10), (parseInt(page, 10) - 1) * parseInt(limit, 10));
  res.json({ total, page: parseInt(page, 10), limit: parseInt(limit, 10), items: rows });
});

app.get('/api/products/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'notFound', message: 'Product not found.' });
  res.json(row);
});

function validateProduct(b, forUpdate) {
  if (!forUpdate || b.name !== undefined) if (!b.name?.trim()) return 'Product name is required.';
  if (!forUpdate || b.reference !== undefined) if (!b.reference?.trim()) return 'Reference is required.';
  if (!forUpdate || b.selling_price !== undefined) {
    const p = Number(b.selling_price);
    if (isNaN(p) || p < 0) return 'Selling price must be a positive number.';
  }
  if (!forUpdate || b.purchase_price !== undefined) {
    const p = Number(b.purchase_price);
    if (isNaN(p) || p < 0) return 'Purchase price must be a positive number.';
  }
  return null;
}

app.post('/api/products', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const b = req.body || {};
  const err = validateProduct(b, false);
  if (err) return res.status(400).json({ error: 'validation', message: err });
  const productId = nextProductId();
  const info = db.prepare(`INSERT INTO products (product_id, ${PRODUCT_FIELDS.join(', ')}, created_by) VALUES (?, ${PRODUCT_FIELDS.map(() => '?').join(', ')}, ?)`)
    .run(productId, ...PRODUCT_FIELDS.map(f => {
      const v = b[f];
      if (['purchase_price', 'selling_price', 'discounted_price', 'weight_kg'].includes(f)) return v === undefined || v === null || v === '' ? null : Number(v);
      if (['quantity', 'min_quantity', 'max_quantity', 'reorder_point', 'warranty_months'].includes(f)) return v === undefined || v === null || v === '' ? null : parseInt(v, 10);
      if (f === 'compatibility') return Array.isArray(v) ? JSON.stringify(v) : (v || null);
      return v ?? null;
    }), req.user.id);
  logActivity(req.user.id, 'add_product', 'product', productId, { name: b.name }, req);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/products/:id', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'notFound', message: 'Product not found.' });
  const b = req.body || {};
  const err = validateProduct(b, true);
  if (err) return res.status(400).json({ error: 'validation', message: err });

  if (b.quantity !== undefined && Number(b.quantity) !== prod.quantity) {
    db.prepare('INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, movement_type, performed_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(prod.id, Number(b.quantity) - prod.quantity, prod.quantity, Number(b.quantity), 'adjustment', req.user.id);
  }
  const DECIMAL = ['purchase_price', 'selling_price', 'discounted_price', 'weight_kg'];
  const INTEGER = ['quantity', 'min_quantity', 'max_quantity', 'reorder_point', 'warranty_months'];
  const fieldsToUpdate = PRODUCT_FIELDS.filter(f => b[f] !== undefined);
  if (fieldsToUpdate.length) {
    const values = fieldsToUpdate.map(f => {
      const v = b[f];
      if (DECIMAL.includes(f)) return Number(v);
      if (INTEGER.includes(f)) return parseInt(v, 10);
      if (f === 'compatibility') return Array.isArray(v) ? JSON.stringify(v) : v;
      return v;
    });
    db.prepare(`UPDATE products SET ${fieldsToUpdate.map(f => `${f} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, prod.id);
  }
  logActivity(req.user.id, 'update_product', 'product', prod.product_id, b, req);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(prod.id));
});

app.delete('/api/products/:id', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'notFound', message: 'Product not found.' });
  db.prepare('UPDATE products SET is_archived = 1, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(prod.id);
  logActivity(req.user.id, 'delete_product', 'product', prod.product_id, null, req);
  res.json({ ok: true });
});

app.post('/api/products/:id/image', authMiddleware, requireRole('owner', 'manager'), upload.single('image'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'notFound', message: 'Product not found.' });
  if (!req.file) return res.status(400).json({ error: 'validation', message: 'Image file is required.' });
  const rel = path.join('products', req.file.filename).replace(/\\/g, '/');
  db.prepare('UPDATE products SET image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(`/uploads/${rel}`, prod.id);
  res.json({ imagePath: `/uploads/${rel}` });
});

// ================= SALES (POS) =================
app.post('/api/sales', authMiddleware, (req, res) => {
  const { items, discountAmount = 0, discountPercentage = 0, amountPaid, paymentMethod = 'cash', customerName, customerPhone, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'validation', message: 'Cart is empty.' });
  if (!['cash', 'card', 'transfer', 'mixed'].includes(paymentMethod)) return res.status(400).json({ error: 'validation', message: 'Invalid payment method.' });

  const saleTx = db.transaction(() => {
    let subtotal = 0;
    const lineItems = [];
    for (const it of items) {
      const prod = db.prepare('SELECT * FROM products WHERE id = ? AND is_archived = 0').get(it.productId);
      if (!prod) throw Object.assign(new Error(`Product ${it.productId} not found.`), { status: 404 });
      const qty = parseInt(it.quantity, 10);
      if (!qty || qty < 1) throw Object.assign(new Error('Invalid quantity.'), { status: 400 });
      if (prod.quantity < qty) throw Object.assign(new Error(`Insufficient stock for ${prod.name}. Available: ${prod.quantity}.`), { status: 400 });
      const unitPrice = prod.discounted_price != null && prod.discounted_price > 0 ? prod.discounted_price : prod.selling_price;
      const lineTotal = Math.round(unitPrice * qty * 100) / 100;
      subtotal += lineTotal;
      lineItems.push({ prod, qty, unitPrice, lineTotal });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const discount = Math.round(Math.max(
      Number(discountAmount) || 0,
      subtotal * ((Number(discountPercentage) || 0) / 100)
    ) * 100) / 100;
    const total = Math.round((subtotal - discount) * 100) / 100;
    const paid = Number(amountPaid);
    if (isNaN(paid) || paid < total) throw Object.assign(new Error('Insufficient funds.'), { status: 400 });
    const saleId = nextSaleId();
    const info = db.prepare(`INSERT INTO sales (sale_id, employee_id, customer_name, customer_phone, subtotal, discount_amount, discount_percentage, total, amount_paid, change_given, payment_method, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(saleId, req.user.id, customerName || null, customerPhone || null, subtotal, discount,
           Number(discountPercentage) || 0, total, paid, Math.round((paid - total) * 100) / 100, paymentMethod, notes || null);
    for (const li of lineItems) {
      db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, subtotal) VALUES (?, ?, ?, ?, ?, ?)')
        .run(info.lastInsertRowid, li.prod.id, li.qty, li.unitPrice, li.lineTotal, li.lineTotal);
      const newQty = li.prod.quantity - li.qty;
      db.prepare('UPDATE products SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newQty, li.prod.id);
      db.prepare('INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, movement_type, reference_id, performed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(li.prod.id, -li.qty, li.prod.quantity, newQty, 'sale', saleId, req.user.id);
      if (newQty <= li.prod.min_quantity) {
        db.prepare('INSERT INTO notifications (type, title, message, data) VALUES (?, ?, ?, ?)')
          .run('stock_alert', 'Low stock', `${li.prod.name} is low: ${newQty} left (min ${li.prod.min_quantity}).`, JSON.stringify({ productId: li.prod.id }));
      }
    }
    db.prepare('INSERT INTO notifications (type, title, message, data) VALUES (?, ?, ?, ?)')
      .run('sale', 'New sale', `${saleId} — total ${total} DZD by ${req.user.name}`, JSON.stringify({ saleId, total }));
    logActivity(req.user.id, 'sale', 'sale', saleId, { total, items: lineItems.length }, req);
    return { saleId, subtotal, discount, total, change: Math.round((paid - total) * 100) / 100 };
  });

  try {
    const result = saleTx();
    res.status(201).json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: 'saleFailed', message: e.message });
  }
});

app.get('/api/sales', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const total = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
  const rows = db.prepare(`SELECT s.*, e.full_name AS employee_name FROM sales s JOIN employees e ON e.id = s.employee_id ORDER BY s.sold_at DESC LIMIT ? OFFSET ?`)
    .all(parseInt(limit, 10), (parseInt(page, 10) - 1) * parseInt(limit, 10));
  res.json({ total, items: rows });
});

// ================= DASHBOARD =================
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const todaySales = db.prepare("SELECT COALESCE(SUM(total), 0) AS v, COUNT(*) AS c FROM sales WHERE date(sold_at) = date('now')").get();
  const itemsSold = db.prepare("SELECT COALESCE(SUM(si.quantity), 0) AS v FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE date(s.sold_at) = date('now')").get();
  const changeGiven = db.prepare("SELECT COALESCE(SUM(change_given), 0) AS v FROM sales WHERE date(sold_at) = date('now')").get();
  const lowStock = db.prepare('SELECT COUNT(*) AS c FROM products WHERE is_archived = 0 AND quantity <= min_quantity').get();
  const hourly = db.prepare("SELECT strftime('%H', sold_at) AS hour, SUM(total) AS total FROM sales WHERE date(sold_at) = date('now') GROUP BY hour ORDER BY hour").all();
  const weekly = db.prepare("SELECT date(sold_at) AS day, SUM(total) AS total FROM sales WHERE sold_at >= date('now', '-6 days') GROUP BY day ORDER BY day").all();
  const topSelling = db.prepare(`SELECT p.name, SUM(si.quantity) AS qty FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id
    WHERE date(s.sold_at) = date('now') GROUP BY p.id ORDER BY qty DESC LIMIT 5`).all();
  const recent = db.prepare('SELECT action, entity_id, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10').all();
  res.json({
    todaySalesTotal: todaySales.v,
    todaySalesCount: todaySales.c,
    itemsSoldToday: itemsSold.v,
    changeGivenToday: changeGiven.v,
    lowStockCount: lowStock.c,
    hourly, weekly, topSelling, recent,
    currency: 'DZD',
  });
});

// ================= SETTINGS =================
app.get('/api/settings', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT setting_key, setting_value, setting_group FROM settings').all();
  const obj = {};
  rows.forEach(r => { obj[r.setting_key] = r.setting_value; });
  res.json(obj);
});

app.put('/api/settings', authMiddleware, requireRole('owner'), (req, res) => {
  const allowed = ['app_language', 'app_theme', 'telegram_bot_token', 'telegram_chat_id', 'telegram_enabled',
    'sale_discount_enabled', 'sale_tax_enabled', 'sale_tax_rate', 'low_stock_threshold', 'auto_backup_enabled'];
  const stmt = db.prepare('UPDATE settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (allowed.includes(k)) stmt.run(String(v), k);
    }
  });
  tx();
  logActivity(req.user.id, 'update_settings', 'settings', null, req.body, req);
  res.json({ ok: true });
});

// Telegram connection test
app.post('/api/telegram/test', authMiddleware, requireRole('owner'), (req, res) => {
  const token = (db.prepare("SELECT setting_value AS v FROM settings WHERE setting_key = 'telegram_bot_token'").get() || {}).v;
  const chatId = (db.prepare("SELECT setting_value AS v FROM settings WHERE setting_key = 'telegram_chat_id'").get() || {}).v;
  if (!token || !chatId) return res.status(400).json({ ok: false, message: 'Bot token and chat ID must be configured first.' });
  const postData = JSON.stringify({ chat_id: chatId, text: '✅ AlphaParts Pro: Telegram connection test successful.' });
  const reqT = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 8000,
  }, (resT) => {
    let body = '';
    resT.on('data', c => body += c);
    resT.on('end', () => res.status(resT.statusCode === 200 ? 200 : 400).json({ ok: resT.statusCode === 200, message: body }));
  });
  reqT.on('error', e => res.status(400).json({ ok: false, message: e.message }));
  reqT.on('timeout', () => { reqT.destroy(); res.status(408).json({ ok: false, message: 'Telegram request timed out.' }); });
  reqT.write(postData);
  reqT.end();
});

// ================= ACTIVITY =================
app.get('/api/activity', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const rows = db.prepare(`SELECT a.*, e.full_name FROM activity_log a LEFT JOIN employees e ON e.id = a.employee_id ORDER BY a.created_at DESC LIMIT 50`).all();
  res.json(rows);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', currency: 'DZD' }));

// Errors
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'generic', message: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AlphaParts Pro backend running on http://localhost:${PORT}`));
