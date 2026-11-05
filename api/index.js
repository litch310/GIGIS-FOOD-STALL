const crypto = require('node:crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const formidable = require('formidable');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
});

const ORDER_TYPES = ['dine-in', 'take-out', 'delivery'];
const ORDER_STATUSES = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
const TRANSITIONS = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function fail(res, message, status = 400, code) {
  const body = { success: false, message };
  if (code) body.code = code;
  send(res, status, body);
}

function success(res, data = {}) {
  send(res, 200, { success: true, ...data });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionUser(req) {
  const token = parseCookies(req).gigis_session;
  if (!token || !process.env.SESSION_SECRET) return null;
  const [userId, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(userId).digest('hex');
  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return Number(userId);
}

function setSession(res, userId) {
  const id = String(userId);
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(id).digest('hex');
  res.setHeader('Set-Cookie', `gigis_session=${encodeURIComponent(`${id}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax; Secure`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', 'gigis_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
}

async function one(text, values = []) {
  const result = await pool.query(text, values);
  return result.rows[0] || null;
}

async function many(text, values = []) {
  return (await pool.query(text, values)).rows;
}

async function currentUser(req) {
  const userId = sessionUser(req);
  if (!userId) return null;
  const user = await one(
    `SELECT user_id, full_name, email, phone, role, status
     FROM users WHERE user_id = $1 AND status <> 'suspended'`, [userId]
  );
  return user ? { ...user, user_id: Number(user.user_id) } : null;
}

async function requireRole(req, res, roles) {
  const user = await currentUser(req);
  if (!user) {
    fail(res, 'Please sign in first.', 401);
    return null;
  }
  if (!roles.includes(user.role)) {
    fail(res, 'You do not have access to that.', 403);
    return null;
  }
  return user;
}

function input(req, key, fallback = '') {
  return req.body && req.body[key] !== undefined ? String(req.body[key]).trim() : fallback;
}

async function products(staff) {
  return many(
    `SELECT p.product_id, p.category_id, c.name AS category_name, p.name,
            p.description, p.unit, p.price, p.image, p.is_available, p.updated_at,
            cb.full_name AS created_by_name, ub.full_name AS updated_by_name,
            COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN oi.quantity ELSE 0 END), 0) AS total_sold
     FROM products p
     JOIN categories c ON c.category_id = p.category_id
     LEFT JOIN users cb ON cb.user_id = p.created_by
     LEFT JOIN users ub ON ub.user_id = p.updated_by
     LEFT JOIN order_items oi ON oi.product_id = p.product_id
     LEFT JOIN orders o ON o.order_id = oi.order_id
     WHERE p.is_archived = 0 AND ($1 OR p.is_available = 1)
     GROUP BY p.product_id, c.name, cb.full_name, ub.full_name, c.sort_order
     ORDER BY c.sort_order, p.price, p.name`, [staff]
  ).then(rows => rows.map(row => ({
    ...row,
    product_id: Number(row.product_id),
    category_id: Number(row.category_id),
    price: Number(row.price),
    is_available: Boolean(row.is_available),
    total_sold: Number(row.total_sold)
  })));
}

async function orderSummary(where = '', values = []) {
  return many(`SELECT * FROM v_order_summary ${where} ORDER BY created_at DESC`, values).then(rows => rows.map(row => ({
    ...row,
    order_id: Number(row.order_id),
    customer_id: Number(row.customer_id),
    item_count: Number(row.item_count),
    total_amount: Number(row.total_amount)
  })));
}

async function handler(req, res) {
  const action = req.query.action || (req.body && req.body.action);
  try {
    if (!process.env.SESSION_SECRET) return fail(res, 'SESSION_SECRET is not configured.', 500);
    if (action === 'me') return success(res, { user: await currentUser(req) });
    if (action === 'logout') {
      clearSession(res);
      return success(res, { user: null });
    }
    if (action === 'login') {
      const email = input(req, 'email').toLowerCase();
      const user = await one('SELECT * FROM users WHERE email = $1', [email]);
      if (!user || !(await bcrypt.compare(input(req, 'password'), user.password_hash))) {
        return fail(res, 'Wrong email or password.', 401);
      }
      if (user.status === 'suspended') return fail(res, 'This account has been suspended. Please talk to the canteen owner.', 403);
      setSession(res, user.user_id);
      return success(res, { user: { user_id: Number(user.user_id), full_name: user.full_name, email: user.email, phone: user.phone, role: user.role, status: user.status } });
    }
    if (action === 'register') {
      const role = input(req, 'account_type', 'customer');
      const name = input(req, 'full_name');
      const email = input(req, 'email').toLowerCase();
      const password = input(req, 'password');
      if (!['customer', 'vendor'].includes(role) || !name || name.length > 100) return fail(res, 'Please enter valid registration details.');
      if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) {
        return fail(res, 'Password must be at least 8 characters and include a lowercase letter, an uppercase letter, a number and a special character.');
      }
      if (await one('SELECT user_id FROM users WHERE email = $1', [email])) return fail(res, 'That email already has an account.');
      const user = await one(
        `INSERT INTO users (full_name, email, phone, password_hash, role, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id`,
        [name, email, input(req, 'phone') || null, await bcrypt.hash(password, 12), role, role === 'vendor' ? 'pending' : 'active']
      );
      await one('INSERT INTO account_verifications (user_id, verified_at) VALUES ($1, CURRENT_TIMESTAMP)', [user.user_id]);
      return success(res, { message: 'Account created. You can now sign in.' });
    }
    if (action === 'menu') {
      const user = await currentUser(req);
      const categories = await many('SELECT category_id, name FROM categories ORDER BY sort_order, name');
      const items = await products(Boolean(user && ['owner', 'vendor'].includes(user.role)));
      const ranks = [...items].sort((a, b) => b.total_sold - a.total_sold).slice(0, 3);
      const rankMap = new Map(ranks.filter(item => item.total_sold > 0).map((item, index) => [item.product_id, index + 1]));
      return success(res, { categories: categories.map(c => ({ ...c, category_id: Number(c.category_id) })), products: items.map(p => ({ ...p, rank: rankMap.get(p.product_id) || 0 })) });
    }
    if (action === 'place_order') {
      const user = await requireRole(req, res, ['customer']);
      if (!user) return;
      const type = input(req, 'order_type', 'dine-in');
      const cart = JSON.parse(input(req, 'cart', '[]'));
      if (!ORDER_TYPES.includes(type) || !Array.isArray(cart) || !cart.length) return fail(res, 'Your tray is empty.');
      const lines = new Map();
      for (const line of cart) {
        const id = Number(line.product_id);
        const quantity = Number(line.quantity);
        if (!id || quantity < 1 || quantity > 99) return fail(res, 'Invalid item quantity in your tray.');
        lines.set(id, (lines.get(id) || 0) + quantity);
      }
      const ids = [...lines.keys()];
      const available = await many('SELECT product_id, name, price, is_available, is_archived FROM products WHERE product_id = ANY($1::int[])', [ids]);
      if (available.length !== ids.length || available.some(p => Number(p.is_archived) || !Number(p.is_available))) return fail(res, 'Some items in your tray are no longer available.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const order = await client.query('INSERT INTO orders (customer_id, order_type, notes) VALUES ($1, $2, $3) RETURNING order_id', [user.user_id, type, input(req, 'notes') || null]);
        for (const item of available) await client.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)', [order.rows[0].order_id, item.product_id, lines.get(Number(item.product_id)), item.price]);
        await client.query('COMMIT');
        return success(res, { order_id: Number(order.rows[0].order_id), message: `Order #${order.rows[0].order_id} placed!` });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
    if (action === 'my_orders') {
      const user = await requireRole(req, res, ['customer']);
      if (!user) return;
      const orders = await orderSummary('WHERE customer_id = $1', [user.user_id]);
      return success(res, { orders, total_spent: orders.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + o.total_amount, 0) });
    }
    if (action === 'vendor_orders') {
      const user = await requireRole(req, res, ['vendor']);
      if (!user) return;
      if (user.status !== 'active') return fail(res, 'Your vendor account is waiting for the owner\'s approval.', 403);
      return success(res, { orders: await orderSummary() });
    }
    if (action === 'cancel_order') {
      const user = await requireRole(req, res, ['customer']);
      if (!user) return;
      const result = await pool.query("UPDATE orders SET status = 'cancelled' WHERE order_id = $1 AND customer_id = $2 AND status = 'pending'", [Number(input(req, 'order_id')), user.user_id]);
      if (!result.rowCount) return fail(res, 'Only pending orders can be cancelled.');
      return success(res, { message: 'Order cancelled.' });
    }
    if (action === 'order_details') {
      const user = await requireRole(req, res, ['owner', 'vendor', 'customer']);
      if (!user) return;
      if (user.role === 'vendor' && user.status !== 'active') return fail(res, 'Your vendor account is waiting for the owner\'s approval.', 403);
      const order = (await orderSummary('WHERE order_id = $1', [Number(req.query.order_id)]))[0];
      if (!order || (user.role === 'customer' && order.customer_id !== user.user_id)) return fail(res, 'Order not found.', 404);
      const items = await many(`SELECT oi.product_id, p.name, p.unit, p.image, oi.quantity, oi.unit_price, oi.quantity * oi.unit_price AS subtotal
        FROM order_items oi JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.order_item_id`, [order.order_id]);
      return success(res, { order, items: items.map(i => ({ ...i, product_id: Number(i.product_id), quantity: Number(i.quantity), unit_price: Number(i.unit_price), subtotal: Number(i.subtotal) })) });
    }
    if (action === 'manage_products') {
      const user = await requireRole(req, res, ['owner', 'vendor']);
      if (!user) return;
      return success(res, { products: await products(true) });
    }
    if (action === 'save_product') {
      const user = await requireRole(req, res, ['owner', 'vendor']);
      if (!user) return;
      if (user.role === 'vendor' && user.status !== 'active') return fail(res, 'Your vendor account is waiting for the owner\'s approval.', 403);
      const productId = Number(input(req, 'product_id', '0'));
      const name = input(req, 'name');
      const categoryId = Number(input(req, 'category_id'));
      const description = input(req, 'description') || null;
      const unit = input(req, 'unit', '1 serving');
      const price = Number(input(req, 'price'));
      const available = input(req, 'is_available', '1') === '1' ? 1 : 0;
      if (!name || name.length > 100 || !categoryId || !unit || unit.length > 30 || !Number.isFinite(price) || price < 0 || price > 99999) {
        return fail(res, 'Please enter valid dish details.');
      }
      if (!(await one('SELECT category_id FROM categories WHERE category_id = $1', [categoryId]))) return fail(res, 'Please choose a category.');
      if (productId) {
        const existing = await one('SELECT product_id FROM products WHERE product_id = $1 AND is_archived = 0', [productId]);
        if (!existing) return fail(res, 'Dish not found.', 404);
        await pool.query(`UPDATE products SET name = $1, category_id = $2, description = $3, unit = $4,
          price = $5, is_available = $6, is_archived = 0, updated_by = $7 WHERE product_id = $8`,
          [name, categoryId, description, unit, price, available, user.user_id, productId]);
      } else {
        await pool.query(`INSERT INTO products (name, category_id, description, unit, price, is_available, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`, [name, categoryId, description, unit, price, available, user.user_id]);
      }
      return success(res, { message: `${name} was ${productId ? 'updated' : 'added to'} the menu.` });
    }
    if (action === 'toggle_product') {
      const user = await requireRole(req, res, ['owner', 'vendor']);
      if (!user) return;
      if (user.role === 'vendor' && user.status !== 'active') return fail(res, 'Your vendor account is waiting for the owner\'s approval.', 403);
      await pool.query('UPDATE products SET is_available = CASE WHEN is_available = 1 THEN 0 ELSE 1 END, updated_by = $1 WHERE product_id = $2 AND is_archived = 0', [user.user_id, Number(input(req, 'product_id'))]);
      return success(res, { message: 'Availability updated.' });
    }
    if (action === 'delete_product') {
      const user = await requireRole(req, res, ['owner', 'vendor']);
      if (!user) return;
      if (user.role === 'vendor' && user.status !== 'active') return fail(res, 'Your vendor account is waiting for the owner\'s approval.', 403);
      const id = Number(input(req, 'product_id'));
      const product = await one('SELECT name FROM products WHERE product_id = $1 AND is_archived = 0', [id]);
      if (!product) return fail(res, 'Dish not found.', 404);
      const ordered = await one('SELECT order_item_id FROM order_items WHERE product_id = $1 LIMIT 1', [id]);
      if (ordered) await pool.query('UPDATE products SET is_archived = 1, is_available = 0, updated_by = $1 WHERE product_id = $2', [user.user_id, id]);
      else await pool.query('DELETE FROM products WHERE product_id = $1', [id]);
      return success(res, { message: `${product.name} was removed from the menu.` });
    }
    if (action === 'update_order_status') {
      const user = await requireRole(req, res, ['owner', 'vendor']);
      if (!user) return;
      if (user.role === 'vendor' && user.status !== 'active') return fail(res, 'Your vendor account is waiting for the owner\'s approval.', 403);
      const orderId = Number(input(req, 'order_id'));
      const status = input(req, 'status');
      const order = await one('SELECT status FROM orders WHERE order_id = $1', [orderId]);
      if (!order) return fail(res, 'Order not found.', 404);
      const allowed = user.role === 'vendor' ? ({ pending: ['preparing'], preparing: ['completed'], ready: ['completed'] }[order.status] || []) : TRANSITIONS[order.status];
      if (!ORDER_STATUSES.includes(status) || !allowed.includes(status)) return fail(res, 'That status change is not allowed for this order.', 409);
      await pool.query('UPDATE orders SET status = $1 WHERE order_id = $2 AND status = $3', [status, orderId, order.status]);
      return success(res, { message: 'Order updated.' });
    }
    if (action === 'owner_dashboard') {
      const user = await requireRole(req, res, ['owner']);
      if (!user) return;
      const orders = await orderSummary();
      const active = orders.filter(o => o.status !== 'cancelled');
      const top = await one(`SELECT p.name FROM order_items oi JOIN orders o ON o.order_id = oi.order_id AND o.status <> 'cancelled'
        JOIN products p ON p.product_id = oi.product_id GROUP BY p.product_id, p.name ORDER BY SUM(oi.quantity) DESC LIMIT 1`);
      const pending = await one("SELECT COUNT(*) AS count FROM users WHERE role = 'vendor' AND status = 'pending'");
      return success(res, { orders: orders.map(o => ({ ...o, allowed_statuses: [o.status, ...(TRANSITIONS[o.status] || [])] })), kpis: {
        total_sales: active.reduce((s, o) => s + o.total_amount, 0), today_sales: active.filter(o => new Date(o.created_at).toDateString() === new Date().toDateString()).reduce((s, o) => s + o.total_amount, 0),
        open_orders: orders.filter(o => ['pending', 'preparing', 'ready'].includes(o.status)).length, total_orders: orders.length, top_item: top ? top.name : null, pending_vendors: Number(pending.count)
      }});
    }
    if (action === 'vendors') {
      const user = await requireRole(req, res, ['owner']);
      if (!user) return;
      return success(res, { vendors: await many(`SELECT u.user_id, u.full_name, u.email, u.phone, u.status, u.created_at,
        (SELECT COUNT(*) FROM products p WHERE p.created_by = u.user_id) AS dishes_added,
        (SELECT MAX(p.updated_at) FROM products p WHERE p.updated_by = u.user_id) AS last_menu_edit
        FROM users u WHERE u.role = 'vendor' ORDER BY CASE u.status WHEN 'pending' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, u.full_name`) });
    }
    if (action === 'set_vendor_status') {
      const user = await requireRole(req, res, ['owner']);
      if (!user) return;
      const status = input(req, 'status');
      if (!['active', 'suspended'].includes(status)) return fail(res, 'Unknown account status.');
      await pool.query("UPDATE users SET status = $1 WHERE user_id = $2 AND role = 'vendor'", [status, Number(input(req, 'user_id'))]);
      return success(res, { message: 'Vendor account updated.' });
    }
    if (action === 'customers') {
      const user = await requireRole(req, res, ['owner']);
      if (!user) return;
      return success(res, { customers: await many(`SELECT u.user_id, u.full_name, u.email, u.phone, u.created_at,
        COUNT(s.order_id) AS order_count, COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.total_amount ELSE 0 END), 0) AS total_spent,
        MAX(s.created_at) AS last_order_at FROM users u LEFT JOIN v_order_summary s ON s.customer_id = u.user_id
        WHERE u.role = 'customer' GROUP BY u.user_id ORDER BY total_spent DESC, u.full_name`) });
    }
    return fail(res, 'Unknown action.', 404);
  } catch (error) {
    console.error(error);
    return fail(res, 'A database error occurred.', 500);
  }
}

module.exports = async function vercelHandler(req, res) {
  if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) {
    const form = formidable({ multiples: false });
    const [fields] = await form.parse(req);
    req.body = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  }
  return handler(req, res);
};
