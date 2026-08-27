require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { db, generateShopCode, nextEmployeeId, nextProductId, nextSaleId, logActivity } = require('./src/db');
const { signToken, authMiddleware, requireRole } = require('./src/auth');

const app = express();
app.use(cors());
app.use(express.json());

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

function sendTelegramMessage(shopId, message) {
  const settings = db.prepare('SELECT setting_value FROM settings WHERE shop_id = ? AND setting_key = ?');
  const token = (settings.get(shopId, 'telegram_bot_token') || {}).setting_value;
  const chatId = (settings.get(shopId, 'telegram_chat_id') || {}).setting_value;
  if (!token || !chatId) return;

  const text = `🔔 **AlphaParts Pro**\n\n${message}`;
  const postData = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 8000,
  }, () => {});
  req.on('error', () => {});
  req.write(postData);
  req.end();
}

app.post('/api/register', (req, res) => {
  const { shopName, ownerName, email, password } = req.body || {};
  if (!shopName || !ownerName || !email || !password) {
    return res.status(400).json({ error: 'validation', message: 'All fields are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'validation', message: 'Password must be at least 8 characters.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'validation', message: 'Invalid email address.' });
  }

  const existing = db.prepare('SELECT id FROM shops WHERE owner_email = ?').get(String(email).toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: 'validation', message: 'Email already registered.' });
  }

  const shopCode = generateShopCode();
  const passwordHash = bcrypt.hashSync(password, 10);
  const employeeId = nextEmployeeId();

  const tx = db.transaction(() => {
    const shopInfo = db.prepare('INSERT INTO shops (shop_code, shop_name, owner_email) VALUES (?, ?, ?)')
      .run(shopCode, shopName, String(email).toLowerCase().trim());
    db.prepare('INSERT INTO employees (employee_id, shop_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(employeeId, shopInfo.lastInsertRowid, ownerName, String(email).toLowerCase().trim(), passwordHash, 'owner');
    const defaultSettings = [
      ['app_language', 'en', 'general'],
      ['app_theme', 'light', 'theme'],
      ['telegram_bot_token', '', 'telegram'],
      ['telegram_chat_id', '', 'telegram'],
      ['telegram_enabled', 'false', 'telegram'],
      ['low_stock_threshold', '5', 'general'],
      ['sale_discount_enabled', 'true', 'pos'],
    ];
    const stmt = db.prepare('INSERT INTO settings (shop_id, setting_key, setting_value, setting_group) VALUES (?, ?, ?, ?)');
    for (const [key, value, group] of defaultSettings) {
      stmt.run(shopInfo.lastInsertRowid, key, value, group);
    }
    return { shopId: shopInfo.lastInsertRowid, shopCode };
  });

  try {
    const result = tx();
    res.status(201).json({ ok: true, shopCode: result.shopCode, message: 'Shop created successfully!' });
  } catch (e) {
    res.status(500).json({ error: 'server', message: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password, shopCode } = req.body || {};
  if (!email || !password || !shopCode) {
    return res.status(400).json({ error: 'validation', message: 'Email, password and shop code are required.' });
  }

  const shop = db.prepare('SELECT id FROM shops WHERE shop_code = ?').get(shopCode.toUpperCase().trim());
  if (!shop) {
    return res.status(401).json({ error: 'invalidCredentials', message: 'Invalid shop code.' });
  }

  const emp = db.prepare('SELECT * FROM employees WHERE shop_id = ? AND email = ? AND is_active = 1')
    .get(shop.id, String(email).toLowerCase().trim());
  if (!emp || !bcrypt.compareSync(password, emp.password_hash)) {
    return res.status(401).json({ error: 'invalidCredentials', message: 'Invalid email or password.' });
  }

  db.prepare('UPDATE employees SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(emp.id);
  logActivity(shop.id, emp.id, 'login', 'employee', emp.employee_id, null, req);

  res.json({
    token: signToken(emp, shop.id),
    employee: {
      id: emp.id,
      employeeId: emp.employee_id,
      fullName: emp.full_name,
      email: emp.email,
      role: emp.role,
      shopCode: shopCode.toUpperCase()
    }
  });
});

app.get('/api/employees', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, employee_id, full_name, email, role, is_active, phone_number, hire_date, last_login FROM employees WHERE shop_id = ? ORDER BY id')
    .all(req.user.shopId);
  res.json(rows);
});

app.post('/api/employees', authMiddleware, requireRole('owner'), (req, res) => {
  const { fullName, email, password, role, phoneNumber } = req.body || {};
  if (!fullName || !email || !password || !role) {
    return res.status(400).json({ error: 'validation', message: 'All fields are required.' });
  }
  if (!['owner', 'manager', 'employee'].includes(role)) {
    return res.status(400).json({ error: 'validation', message: 'Invalid role.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'validation', message: 'Password must be at least 8 characters.' });
  }
  const exists = db.prepare('SELECT id FROM employees WHERE shop_id = ? AND email = ?')
    .get(req.user.shopId, String(email).toLowerCase().trim());
  if (exists) {
    return res.status(409).json({ error: 'validation', message: 'Email already in use.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const employeeId = nextEmployeeId();
  const info = db.prepare('INSERT INTO employees (employee_id, shop_id, full_name, email, password_hash, role, phone_number) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(employeeId, req.user.shopId, fullName, String(email).toLowerCase().trim(), hash, role, phoneNumber || null);
  logActivity(req.user.shopId, req.user.id, 'add_employee', 'employee', employeeId, { fullName, role }, req);
  res.status(201).json({ id: info.lastInsertRowid, employeeId, fullName, email, role });
});

app.put('/api/employees/:id', authMiddleware, requireRole('owner'), (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE shop_id = ? AND id = ?').get(req.user.shopId, req.params.id);
  if (!emp) return res.status(404).json({ error: 'notFound', message: 'Employee not found.' });
  const { fullName, email, role, phoneNumber, isActive, password } = req.body || {};
  if (role && !['owner', 'manager', 'employee'].includes(role)) {
    return res.status(400).json({ error: 'validation', message: 'Invalid role.' });
  }
  const updates = {};
  if (fullName !== undefined) updates.full_name = fullName;
  if (email !== undefined) updates.email = String(email).toLowerCase().trim();
  if (role !== undefined) updates.role = role;
  if (phoneNumber !== undefined) updates.phone_number = phoneNumber;
  if (isActive !== undefined) updates.is_active = isActive;
  if (password) updates.password_hash = bcrypt.hashSync(password, 10);
  const keys = Object.keys(updates);
  if (keys.length) {
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => updates[k]);
    values.push(emp.id);
    db.prepare(`UPDATE employees SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  }
  logActivity(req.user.shopId, req.user.id, 'update_employee', 'employee', emp.employee_id, { fullName, role }, req);
  res.json({ ok: true });
});

app.delete('/api/employees/:id', authMiddleware, requireRole('owner'), (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE shop_id = ? AND id = ?').get(req.user.shopId, req.params.id);
  if (!emp) return res.status(404).json({ error: 'notFound', message: 'Employee not found.' });
  if (emp.id === req.user.id) {
    return res.status(400).json({ error: 'validation', message: 'You cannot delete yourself.' });
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(emp.id);
  logActivity(req.user.shopId, req.user.id, 'delete_employee', 'employee', emp.employee_id, null, req);
  res.json({ ok: true });
});

const PRODUCT_FIELDS = ['name', 'reference', 'description', 'category', 'brand', 'supplier', 'supplier_sku',
  'purchase_price', 'selling_price', 'discounted_price', 'quantity', 'min_quantity', 'max_quantity',
  'reorder_point', 'location', 'compatibility', 'warranty_months', 'weight_kg'];

app.get('/api/products', authMiddleware, (req, res) => {
  const { search, category, brand, stock, page = 1, limit = 20 } = req.query;
  const where = ['p.is_archived = 0', 'p.shop_id = ?'];
  const params = [req.user.shopId];
  if (search) { where.push('(p.name LIKE ? OR p.reference LIKE ? OR p.brand LIKE ?)'); const s = `%${search}%`; params.push(s, s, s); }
  if (category && category !== 'all') { where.push('p.category = ?'); params.push(category); }
  if (brand && brand !== 'all') { where.push('p.brand = ?'); params.push(brand); }
  if (stock === 'low') where.push('p.quantity <= p.min_quantity AND p.quantity > 0');
  if (stock === 'out') where.push('p.quantity = 0');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM products p ${whereSql}`).get(...params).c;
  const rows = db.prepare(`SELECT p.* FROM products p ${whereSql} ORDER BY p.name LIMIT ? OFFSET ?`)
    .all(...params, parseInt(limit, 10), (parseInt(page, 10) - 1) * parseInt(limit, 10));
  res.json({ total, page: parseInt(page, 10), limit: parseInt(limit, 10), items: rows });
});

app.get('/api/products/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE shop_id = ? AND id = ?').get(req.user.shopId, req.params.id);
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
  const productId = nextProductId(req.user.shopId);
  const info = db.prepare(`INSERT INTO products (product_id, shop_id, ${PRODUCT_FIELDS.join(', ')}, created_by) VALUES (?, ?, ${PRODUCT_FIELDS.map(() => '?').join(', ')}, ?)`)
    .run(productId, req.user.shopId, ...PRODUCT_FIELDS.map(f => {
      const v = b[f];
      if (['purchase_price', 'selling_price', 'discounted_price', 'weight_kg'].includes(f)) return v === undefined || v === null || v === '' ? null : Number(v);
      if (['quantity', 'min_quantity', 'max_quantity', 'reorder_point', 'warranty_months'].includes(f)) return v === undefined || v === null || v === '' ? null : parseInt(v, 10);
      if (f === 'compatibility') return Array.isArray(v) ? JSON.stringify(v) : (v || null);
      return v ?? null;
    }), req.user.id);
  logActivity(req.user.shopId, req.user.id, 'add_product', 'product', productId, { name: b.name }, req);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/products/:id', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE shop_id = ? AND id = ?').get(req.user.shopId, req.params.id);
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
  logActivity(req.user.shopId, req.user.id, 'update_product', 'product', prod.product_id, b, req);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(prod.id));
});

app.delete('/api/products/:id', authMiddleware, requireRole('owner', 'manager'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE shop_id = ? AND id = ?').get(req.user.shopId, req.params.id);
  if (!prod) return res.status(404).json({ error: 'notFound', message: 'Product not found.' });
  db.prepare('UPDATE products SET is_archived = 1, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(prod.id);
  logActivity(req.user.shopId, req.user.id, 'delete_product', 'product', prod.product_id, null, req);
  res.json({ ok: true });
});

app.post('/api/products/:id/image', authMiddleware, requireRole('owner', 'manager'), upload.single('image'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE shop_id = ? AND id = ?').get(req.user.shopId, req.params.id);
  if (!prod) return res.status(404).json({ error: 'notFound', message: 'Product not found.' });
  if (!req.file) return res.status(400).json({ error: 'validation', message: 'Image file is required.' });
  const rel = path.join('products', req.file.filename).replace(/\\/g, '/');
  db.prepare('UPDATE products SET image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(`/uploads/${rel}`, prod.id);
  res.json({ imagePath: `/uploads/${rel}` });
});

app.post('/api/sales', authMiddleware, (req, res) => {
  const { items, discountAmount = 0, discountPercentage = 0, amountPaid, paymentMethod = 'cash', customerName, customerPhone, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'validation', message: 'Cart is empty.' });
  }

  const saleTx = db.transaction(() => {
    let subtotal = 0;
    const lineItems = [];
    for (const it of items) {
      const prod = db.prepare('SELECT * FROM products WHERE shop_id = ? AND id = ? AND is_archived = 0')
        .get(req.user.shopId, it.productId);
      if (!prod) throw Object.assign(new Error(`Product not found.`), { status: 404 });
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
    const saleId = nextSaleId(req.user.shopId);
    const info = db.prepare(`INSERT INTO sales (sale_id, shop_id, employee_id, customer_name, customer_phone, subtotal, discount_amount, discount_percentage, total, amount_paid, change_given, payment_method, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(saleId, req.user.shopId, req.user.id, customerName || null, customerPhone || null, subtotal, discount,
           Number(discountPercentage) || 0, total, paid, Math.round((paid - total) * 100) / 100, paymentMethod, notes || null);

    let lowStockAlerts = [];
    for (const li of lineItems) {
      db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, subtotal) VALUES (?, ?, ?, ?, ?, ?)')
        .run(info.lastInsertRowid, li.prod.id, li.qty, li.unitPrice, li.lineTotal, li.lineTotal);
      const newQty = li.prod.quantity - li.qty;
      db.prepare('UPDATE products SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newQty, li.prod.id);
      db.prepare('INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, movement_type, reference_id, performed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(li.prod.id, -li.qty, li.prod.quantity, newQty, 'sale', saleId, req.user.id);

      if (newQty <= (li.prod.min_quantity || 5)) {
        const msg = `⚠️ **تحذير: مخزون منخفض**\n\nالمنتج: *${li.prod.name}*\nالرمز: #${li.prod.reference}\nالمتبقي: *${newQty}* قطعة\nالحد الأدنى: ${li.prod.min_quantity || 5}\nيرجى إعادة الطلب فوراً.`;
        lowStockAlerts.push(msg);
      }

      const saleMsg = `🛒 **صفقة جديدة**\n\n📦 المنتج: *${li.prod.name}*\n🔢 الكمية: *${qty}*\n💰 السعر: *${li.unitPrice}* د.ج\n💵 المجموع: *${lineTotal}* د.ج\n👤 الموظف: ${req.user.fullName || 'موظف'}`;
      sendTelegramMessage(req.user.shopId, saleMsg);
    }

    for (const alert of lowStockAlerts) {
      sendTelegramMessage(req.user.shopId, alert);
    }

    logActivity(req.user.shopId, req.user.id, 'sale', 'sale', saleId, { total, items: lineItems.length }, req);
    return { saleId, subtotal, discount, total, change: Math.round((paid - total) * 100) / 100 };
  });

  try {
    const result = saleTx();
    res.status(201).json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: 'saleFailed', message: e.message });
  }
});

app.get('/api/dashboard', authMiddleware, (req, res) => {
  const shopId = req.user.shopId;
  const todaySales = db.prepare("SELECT COALESCE(SUM(total), 0) AS v, COUNT(*) AS c FROM sales WHERE shop_id = ? AND date(sold_at) = date('now')").get(shopId);
  const itemsSold = db.prepare(`SELECT COALESCE(SUM(si.quantity), 0) AS v FROM sale_items si 
    JOIN sales s ON s.id = si.sale_id WHERE s.shop_id = ? AND date(s.sold_at) = date('now')`).get(shopId);
  const changeGiven = db.prepare("SELECT COALESCE(SUM(change_given), 0) AS v FROM sales WHERE shop_id = ? AND date(sold_at) = date('now')").get(shopId);
  const lowStock = db.prepare('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_archived = 0 AND quantity <= min_quantity').get(shopId);
  const hourly = db.prepare(`SELECT strftime('%H', sold_at) AS hour, SUM(total) AS total 
    FROM sales WHERE shop_id = ? AND date(sold_at) = date('now') GROUP BY hour ORDER BY hour`).all(shopId);
  const weekly = db.prepare(`SELECT date(sold_at) AS day, SUM(total) AS total 
    FROM sales WHERE shop_id = ? AND sold_at >= date('now', '-6 days') GROUP BY day ORDER BY day`).all(shopId);
  const topSelling = db.prepare(`SELECT p.name, SUM(si.quantity) AS qty 
    FROM sale_items si JOIN products p ON p.id = si.product_id 
    JOIN sales s ON s.id = si.sale_id WHERE s.shop_id = ? AND date(s.sold_at) = date('now') 
    GROUP BY p.id ORDER BY qty DESC LIMIT 5`).all(shopId);
  const recent = db.prepare('SELECT action, entity_id, created_at FROM activity_log WHERE shop_id = ? ORDER BY created_at DESC LIMIT 10').all(shopId);
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

app.get('/api/settings', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT setting_key, setting_value, setting_group FROM settings WHERE shop_id = ?').all(req.user.shopId);
  const obj = {};
  rows.forEach(r => { obj[r.setting_key] = r.setting_value; });
  res.json(obj);
});

app.put('/api/settings', authMiddleware, requireRole('owner'), (req, res) => {
  const allowed = ['app_language', 'app_theme', 'telegram_bot_token', 'telegram_chat_id', 'telegram_enabled',
    'sale_discount_enabled', 'sale_tax_enabled', 'sale_tax_rate', 'low_stock_threshold', 'auto_backup_enabled'];
  const stmt = db.prepare('UPDATE settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND setting_key = ?');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (allowed.includes(k)) stmt.run(String(v), req.user.shopId, k);
    }
  });
  tx();
  logActivity(req.user.shopId, req.user.id, 'update_settings', 'settings', null, req.body, req);
  res.json({ ok: true });
});

app.get('/api/shop', authMiddleware, (req, res) => {
  const shop = db.prepare('SELECT shop_code, shop_name FROM shops WHERE id = ?').get(req.user.shopId);
  res.json(shop || {});
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', currency: 'DZD' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'generic', message: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AlphaParts Pro backend running on http://localhost:${PORT}`));