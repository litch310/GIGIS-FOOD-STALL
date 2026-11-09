'use strict';
// Node.js API for Gigi's Food House (run by server.js on Render). Mirrors the PHP API (api.php + api/*.php)
// action by action, so app.js works unchanged against either backend.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const bcrypt = require('bcryptjs');
const { formidable } = require('formidable');
const { query, many, one, tx } = require('../lib/db');
const { EmailDeliveryError, isEmail, sendVerificationEmail, sendPasswordResetEmail } = require('../lib/email');

const ORDER_TYPES = ['dine-in', 'take-out', 'delivery'];
const ORDER_STATUSES = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
const ORDER_TRANSITIONS = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};
const VENDOR_TRANSITIONS = {
  pending: ['preparing'],
  preparing: ['completed'],
  ready: ['completed']
};
const MAX_UPLOAD = 3 * 1024 * 1024;
const IMAGE_PATH = /^api\.php\?action=image&id=(\d+)$/;
const SESSION_COOKIE = 'gigis_session';
const SESSION_IDLE = "interval '12 hours'";
const BCRYPT_COST = 12;
const PASSWORD_RULES = 'Password must be at least 8 characters and include a lowercase letter, an uppercase letter, a number and a special character.';
const VENDOR_WAITING = "Your vendor account is waiting for the owner's approval.";

class HttpError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status = 400, code = null) {
  throw new HttpError(message, status, code);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookies
    }
  }
  return cookies;
}

function clientIp(req) {
  // Visitor address as reported by the hosting proxy
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['x-real-ip'] || forwarded || (req.socket && req.socket.remoteAddress) || '').slice(0, 45);
}

function input(ctx, key, fallback = '') {
  const value = ctx.body[key];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function int(value) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? number : 0;
}

function charLength(value) {
  return [...value].length;
}

function validatePassword(password) {
  if (
    charLength(password) < 8
    || !/[a-z]/.test(password)
    || !/[A-Z]/.test(password)
    || !/[0-9]/.test(password)
    || !/[^A-Za-z0-9\s]/.test(password)
  ) {
    fail(PASSWORD_RULES);
  }
}

function publicUser(row) {
  return {
    user_id: Number(row.user_id),
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.status
  };
}

function castOrder(row) {
  return {
    ...row,
    order_id: Number(row.order_id),
    customer_id: Number(row.customer_id),
    item_count: Number(row.item_count),
    total_amount: Number(row.total_amount)
  };
}

function castProduct(row) {
  return {
    ...row,
    product_id: Number(row.product_id),
    category_id: Number(row.category_id),
    price: Number(row.price),
    is_available: Boolean(Number(row.is_available)),
    total_sold: Number(row.total_sold || 0)
  };
}

// ------------------------------------------------------------
// Sessions: stored in the database, so they survive restarts and
// deploys and work across instances. The cookie holds a random token; only its hash
// is stored. Sessions expire after 12 idle hours.
// ------------------------------------------------------------
function setSessionCookie(ctx, token) {
  const forwardedProto = String(ctx.req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = process.env.APP_COOKIE_SECURE === '1'
    || (process.env.APP_COOKIE_SECURE !== '0' && forwardedProto === 'https');
  ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

async function loadSession(ctx) {
  const token = parseCookies(ctx.req)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await one(
    `UPDATE sessions SET expires_at = now() + ${SESSION_IDLE}
     WHERE session_hash = $1 AND expires_at > now()
     RETURNING session_hash, user_id, csrf`,
    [sha256(token)]
  );
  return row ? { hash: row.session_hash, userId: row.user_id === null ? null : Number(row.user_id), csrf: row.csrf } : null;
}

async function startSession(ctx, userId = null) {
  if (ctx.session) await query('DELETE FROM sessions WHERE session_hash = $1', [ctx.session.hash]);
  if (Math.random() < 0.05) await query('DELETE FROM sessions WHERE expires_at <= now()');

  const token = randomToken();
  const csrf = randomToken();
  await query(
    `INSERT INTO sessions (session_hash, user_id, csrf, expires_at) VALUES ($1, $2, $3, now() + ${SESSION_IDLE})`,
    [sha256(token), userId, csrf]
  );
  setSessionCookie(ctx, token);
  ctx.session = { hash: sha256(token), userId, csrf };
  ctx.user = undefined;
  return ctx.session;
}

async function ensureSession(ctx) {
  return ctx.session || startSession(ctx);
}

// The signed-in user, re-read from the database so an approval or
// suspension by the owner applies without signing out.
async function currentUser(ctx) {
  if (ctx.user !== undefined) return ctx.user;
  ctx.user = null;
  if (!ctx.session || !ctx.session.userId) return null;
  const row = await one('SELECT * FROM users WHERE user_id = $1', [ctx.session.userId]);
  if (!row || row.status === 'suspended') {
    await query('UPDATE sessions SET user_id = NULL WHERE session_hash = $1', [ctx.session.hash]);
    ctx.session.userId = null;
    return null;
  }
  ctx.user = publicUser(row);
  return ctx.user;
}

async function requireRole(ctx, roles) {
  const user = await currentUser(ctx);
  if (!user) fail('Please sign in first.', 401);
  if (![].concat(roles).includes(user.role)) fail('You do not have access to that.', 403);
  return user;
}

// The owner and approved vendors can change the menu
async function requireMenuEditor(ctx) {
  const user = await requireRole(ctx, ['owner', 'vendor']);
  if (user.status !== 'active') fail(VENDOR_WAITING, 403);
  return user;
}

function requirePost(ctx) {
  if (ctx.req.method !== 'POST') fail('POST required.', 405);
  const token = String(ctx.req.headers['x-csrf-token'] || '');
  const expected = ctx.session ? ctx.session.csrf : '';
  if (!expected || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    fail('Your session expired. Please refresh the page.', 419);
  }
}

async function sessionPayload(ctx) {
  await ensureSession(ctx);
  return { user: await currentUser(ctx), csrf: ctx.session.csrf };
}

// ------------------------------------------------------------
// Sign-in throttling (auth_attempts)
// ------------------------------------------------------------
async function throttle(ctx, action, email, perEmail, perIp, minutes) {
  await query("DELETE FROM auth_attempts WHERE created_at < now() - interval '1 day'");
  const ip = clientIp(ctx.req);
  const counts = await one(
    `SELECT COUNT(*) FILTER (WHERE ip_address = $1) AS by_ip,
            COUNT(*) FILTER (WHERE email = $2) AS by_email
     FROM auth_attempts
     WHERE action = $3 AND created_at > now() - make_interval(mins => $4::int)
       AND (ip_address = $1 OR email = $2)`,
    [ip, email, action, minutes]
  );
  if (Number(counts.by_ip) >= perIp || Number(counts.by_email) >= perEmail) {
    fail(`Too many attempts. Please wait ${minutes} minutes and try again.`, 429, 'rate_limited');
  }
}

async function recordAttempt(ctx, action, email) {
  await query(
    'INSERT INTO auth_attempts (action, ip_address, email) VALUES ($1, $2, $3)',
    [action, clientIp(ctx.req), [...email].slice(0, 150).join('')]
  );
}

async function purgeExpiredPendingAccounts() {
  await query('DELETE FROM pending_accounts WHERE expires_at <= now()');
}

// Returns a new verification token, or null if one was sent in the past minute.
async function createPendingAccountToken(pendingId, validMinutes) {
  const pending = await one(
    "SELECT pending_id FROM pending_accounts WHERE pending_id = $1 AND status <> 'suspended' AND expires_at > now()",
    [pendingId]
  );
  if (!pending) return null;
  const recent = await one(
    "SELECT token_id FROM pending_account_tokens WHERE pending_id = $1 AND created_at > now() - interval '1 minute'",
    [pendingId]
  );
  if (recent) return null;

  const token = randomToken();
  await tx(async client => {
    await query('DELETE FROM pending_account_tokens WHERE pending_id = $1', [pendingId], client);
    await query(
      'INSERT INTO pending_account_tokens (pending_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3::int))',
      [pendingId, sha256(token), validMinutes],
      client
    );
    await query('UPDATE pending_accounts SET expires_at = now() + make_interval(mins => $2::int) WHERE pending_id = $1', [pendingId, validMinutes], client);
  });
  return token;
}

async function createAccountToken(userId, purpose, validMinutes) {
  const recent = await one(
    "SELECT token_id FROM account_tokens WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 minute'",
    [userId, purpose]
  );
  if (recent) return null;

  const token = randomToken();
  await tx(async client => {
    await query('DELETE FROM account_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose], client);
    await query(
      'INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))',
      [userId, purpose, sha256(token), validMinutes],
      client
    );
  });
  return token;
}

// ------------------------------------------------------------
// Menu helpers
// ------------------------------------------------------------
async function productRows(staffView) {
  const rows = await many(
    `SELECT p.product_id, p.category_id, c.name AS category_name, p.name, p.description,
            p.unit, p.price, p.image, p.is_available, p.updated_at,
            cb.full_name AS created_by_name, ub.full_name AS updated_by_name,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.status <> 'cancelled'), 0) AS total_sold
     FROM products p
     JOIN categories c ON c.category_id = p.category_id
     LEFT JOIN users cb ON cb.user_id = p.created_by
     LEFT JOIN users ub ON ub.user_id = p.updated_by
     LEFT JOIN order_items oi ON oi.product_id = p.product_id
     LEFT JOIN orders o ON o.order_id = oi.order_id
     WHERE p.is_archived = 0 AND ($1::boolean OR p.is_available = 1)
     GROUP BY p.product_id, c.name, c.sort_order, cb.full_name, ub.full_name
     ORDER BY c.sort_order, p.price, p.name`,
    [staffView]
  );
  return rows.map(castProduct);
}

async function activeProduct(productId) {
  const row = await one('SELECT product_id, name FROM products WHERE product_id = $1 AND is_archived = 0', [productId]);
  if (!row) fail('Dish not found.', 404);
  return row;
}

function imageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Render's disk is wiped on every deploy, so uploaded photos are stored
// in the product_images table and served by the "image" action.
async function saveUploadedImage(ctx) {
  const file = ctx.files.image;
  if (!file || file.size === 0) return null;
  if (file.size > MAX_UPLOAD) fail('Photo must be 3 MB or smaller.');
  const data = await fs.readFile(file.filepath);
  const mime = imageMime(data);
  if (!mime) fail('Photo must be a JPG, PNG or WEBP image.');
  const row = await one('INSERT INTO product_images (mime_type, data) VALUES ($1, $2) RETURNING image_id', [mime, data]);
  return `api.php?action=image&id=${row.image_id}`;
}

// Deletes an uploaded photo once no dish uses it. Seed images in
// IMAGES/menu/ are static files and are never deleted.
async function deleteUploadedImage(path) {
  const match = path ? IMAGE_PATH.exec(path) : null;
  if (!match) return;
  if (await one('SELECT 1 FROM products WHERE image = $1 LIMIT 1', [path])) return;
  await query('DELETE FROM product_images WHERE image_id = $1', [Number(match[1])]);
}

// ------------------------------------------------------------
// Actions
// ------------------------------------------------------------
const actions = {};

// Session & accounts
actions.me = async ctx => sessionPayload(ctx);

actions.login = async ctx => {
  requirePost(ctx);
  const email = input(ctx, 'email').toLowerCase();
  const password = input(ctx, 'password');
  await throttle(ctx, 'login', email, 5, 20, 15);

  const user = await one(
    `SELECT u.*, av.user_id AS verification_user_id, av.verified_at
     FROM users u
     LEFT JOIN account_verifications av ON av.user_id = u.user_id
     WHERE u.email = $1`,
    [email]
  );
  if (!user) {
    await purgeExpiredPendingAccounts();
    const pending = await one(
      "SELECT password_hash FROM pending_accounts WHERE email = $1 AND expires_at > now() AND status <> 'suspended' LIMIT 1",
      [email]
    );
    if (pending && await bcrypt.compare(password, pending.password_hash)) {
      fail('Please verify your email before signing in.', 403, 'email_unverified');
    }
    await recordAttempt(ctx, 'login', email);
    fail('Wrong email or password.', 401);
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    await recordAttempt(ctx, 'login', email);
    fail('Wrong email or password.', 401);
  }
  await query("DELETE FROM auth_attempts WHERE action = 'login' AND email = $1", [email]);
  if (user.status === 'suspended') fail('This account has been suspended. Please talk to the canteen owner.', 403);
  if (user.verification_user_id !== null && user.verified_at === null) {
    fail('Please verify your email before signing in.', 403, 'email_unverified');
  }
  await startSession(ctx, Number(user.user_id));
  return sessionPayload(ctx);
};

actions.register = async ctx => {
  requirePost(ctx);
  const accountType = input(ctx, 'account_type', 'customer');
  const name = input(ctx, 'full_name');
  const email = input(ctx, 'email').toLowerCase();
  const password = input(ctx, 'password');

  // Owner accounts are never self-registered
  if (!['customer', 'vendor'].includes(accountType)) fail('Please choose an account type.');
  if (!name || charLength(name) > 100) fail('Please enter your name.');
  if (!isEmail(email)) fail('Please enter a valid email.');
  validatePassword(password);

  await throttle(ctx, 'register', email, 3, 5, 60);
  await recordAttempt(ctx, 'register', email);

  // Vendors can change the menu, so the owner approves them first.
  const status = accountType === 'vendor' ? 'pending' : 'active';
  await purgeExpiredPendingAccounts();

  if (await one('SELECT user_id FROM users WHERE email = $1 LIMIT 1', [email])) fail('That email already has an account.');
  if (await one('SELECT pending_id FROM pending_accounts WHERE email = $1 LIMIT 1', [email])) {
    fail('A registration for this email is waiting for verification. Use the verification screen to resend its link.', 409, 'verification_pending');
  }

  let pendingId;
  try {
    const row = await one(
      `INSERT INTO pending_accounts (full_name, email, password_hash, role, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours') RETURNING pending_id`,
      [name, email, await bcrypt.hash(password, BCRYPT_COST), accountType, status]
    );
    pendingId = row.pending_id;
  } catch (error) {
    if (error.code === '23505') fail('That email already has an account or a registration waiting for verification.');
    throw error;
  }

  try {
    const token = await createPendingAccountToken(pendingId, 1440);
    if (token === null) {
      fail('Your registration is waiting for verification, but an email could not be started. Request another email from the verification screen.', 503, 'verification_pending');
    }
    await sendVerificationEmail(email, name, token);
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error;
    fail(`Your registration is saved temporarily, but the verification email could not be sent. ${error.message} Please try again from the verification screen.`, 503, 'verification_pending');
  }
  return {
    message: 'Registration started. Check your email for a verification link. Your account will be created after you verify.',
    csrf: ctx.session.csrf
  };
};

actions['verify-email'] = async ctx => {
  requirePost(ctx);
  const token = input(ctx, 'token');
  if (!/^[a-f0-9]{64}$/.test(token)) fail('This verification link is invalid or has expired.', 400);

  await purgeExpiredPendingAccounts();
  await tx(async client => {
    const pending = await one(
      `SELECT t.token_id, p.pending_id, p.full_name, p.email, p.phone, p.password_hash, p.role, p.status
       FROM pending_account_tokens t
       JOIN pending_accounts p ON p.pending_id = t.pending_id
       WHERE t.token_hash = $1 AND t.expires_at > now()
         AND p.expires_at > now() AND p.status <> 'suspended'
       FOR UPDATE OF t, p`,
      [sha256(token)],
      client
    );
    if (!pending) fail('This verification link is invalid or has expired.', 400);
    if (await one('SELECT user_id FROM users WHERE email = $1 LIMIT 1 FOR UPDATE', [pending.email], client)) {
      fail('An account already exists for this email. Please sign in.', 409);
    }
    const user = await one(
      `INSERT INTO users (full_name, email, phone, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id`,
      [pending.full_name, pending.email, pending.phone, pending.password_hash, pending.role, pending.status],
      client
    );
    await query('INSERT INTO account_verifications (user_id, verified_at) VALUES ($1, now())', [user.user_id], client);
    await query('DELETE FROM pending_accounts WHERE pending_id = $1', [pending.pending_id], client);
  });
  return { message: 'Email verified. Your account is ready; you can now sign in.', csrf: ctx.session.csrf };
};

actions['resend-verification'] = async ctx => {
  requirePost(ctx);
  const email = input(ctx, 'email').toLowerCase();
  if (!isEmail(email)) fail('Please enter a valid email address.');
  await throttle(ctx, 'resend-verification', email, 3, 10, 60);
  await recordAttempt(ctx, 'resend-verification', email);

  await purgeExpiredPendingAccounts();
  const pending = await one(
    "SELECT pending_id, full_name FROM pending_accounts WHERE email = $1 AND expires_at > now() AND status <> 'suspended'",
    [email]
  );
  if (pending) {
    try {
      const token = await createPendingAccountToken(pending.pending_id, 1440);
      if (token !== null) await sendVerificationEmail(email, pending.full_name, token);
    } catch (error) {
      if (!(error instanceof EmailDeliveryError)) throw error;
      fail(`The verification email could not be sent. ${error.message}`, 503);
    }
  }
  return {
    message: 'If a registration is waiting for verification at this address, check your inbox for a link. If you requested one in the past minute, wait a minute before trying again. Unverified registrations expire after 24 hours.',
    csrf: ctx.session.csrf
  };
};

actions['forgot-password'] = async ctx => {
  requirePost(ctx);
  const email = input(ctx, 'email').toLowerCase();
  if (!isEmail(email)) fail('Please enter a valid email address.');
  await throttle(ctx, 'forgot-password', email, 3, 10, 60);
  await recordAttempt(ctx, 'forgot-password', email);

  const user = await one("SELECT user_id, full_name FROM users WHERE email = $1 AND status <> 'suspended'", [email]);
  if (user) {
    try {
      const token = await createAccountToken(user.user_id, 'reset', 60);
      if (token !== null) await sendPasswordResetEmail(email, user.full_name, token);
    } catch (error) {
      if (!(error instanceof EmailDeliveryError)) throw error;
      fail(`The password reset email could not be sent. ${error.message}`, 503);
    }
  }
  return {
    message: 'If an eligible account uses this address, check your inbox for a password reset link. If you requested one in the past minute, wait a minute before trying again.',
    csrf: ctx.session.csrf
  };
};

actions['reset-password'] = async ctx => {
  requirePost(ctx);
  const token = input(ctx, 'token');
  const password = input(ctx, 'password');
  if (!/^[a-f0-9]{64}$/.test(token)) fail('This password reset link is invalid or has expired.', 400);
  validatePassword(password);
  const hash = await bcrypt.hash(password, BCRYPT_COST);

  const account = await tx(async client => {
    const row = await one(
      `SELECT t.token_id, t.user_id, u.email, av.user_id AS verification_user_id, av.verified_at
       FROM account_tokens t
       JOIN users u ON u.user_id = t.user_id
       LEFT JOIN account_verifications av ON av.user_id = u.user_id
       WHERE t.token_hash = $1 AND t.purpose = 'reset' AND t.expires_at > now()
       FOR UPDATE OF t`,
      [sha256(token)],
      client
    );
    if (!row) fail('This password reset link is invalid or has expired.', 400);
    await query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, row.user_id], client);
    await query("DELETE FROM account_tokens WHERE user_id = $1 AND purpose = 'reset'", [row.user_id], client);
    // Sign the account out everywhere
    await query('DELETE FROM sessions WHERE user_id = $1', [row.user_id], client);
    return row;
  });
  await startSession(ctx);
  const verificationRequired = account.verification_user_id !== null && account.verified_at === null;
  return {
    message: verificationRequired
      ? 'Password updated. Verify your email before signing in.'
      : 'Password updated. You can now sign in.',
    verification_required: verificationRequired,
    email: verificationRequired ? account.email : null,
    csrf: ctx.session.csrf
  };
};

actions.logout = async ctx => {
  requirePost(ctx);
  await startSession(ctx);
  return sessionPayload(ctx);
};

// Menu (public). The owner and vendors also see sold-out dishes.
actions.menu = async ctx => {
  const user = await currentUser(ctx);
  const isStaff = Boolean(user && ['owner', 'vendor'].includes(user.role));
  const categories = (await many('SELECT category_id, name FROM categories ORDER BY sort_order, name'))
    .map(c => ({ ...c, category_id: Number(c.category_id) }));
  const products = await productRows(isStaff);

  // Top 3 best sellers get a badge
  const ranks = new Map();
  [...products]
    .sort((a, b) => b.total_sold - a.total_sold)
    .slice(0, 3)
    .filter(p => p.total_sold > 0)
    .forEach((p, index) => ranks.set(p.product_id, index + 1));
  return { categories, products: products.map(p => ({ ...p, rank: ranks.get(p.product_id) || 0 })) };
};

// Uploaded dish photo (public)
actions.image = async ctx => {
  const id = int(ctx.query.get('id'));
  const row = id > 0 ? await one('SELECT mime_type, data FROM product_images WHERE image_id = $1', [id]) : null;
  if (!row) fail('Photo not found.', 404);
  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', row.mime_type);
  ctx.res.setHeader('Content-Length', row.data.length);
  ctx.res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
  ctx.res.end(row.data);
  return null;
};

// Customer: place order, list own orders, cancel pending order
actions.place_order = async ctx => {
  requirePost(ctx);
  const user = await requireRole(ctx, 'customer');
  const orderType = input(ctx, 'order_type', 'dine-in');
  const notes = input(ctx, 'notes');
  let cart;
  try {
    cart = JSON.parse(input(ctx, 'cart', '[]'));
  } catch {
    cart = null;
  }

  if (!ORDER_TYPES.includes(orderType)) fail('Please choose dine-in, take-out or delivery.');
  if (charLength(notes) > 255) fail('Notes must be 255 characters or fewer.');
  if (!Array.isArray(cart) || !cart.length) fail('Your tray is empty.');

  // Merge duplicate lines and validate quantities
  const lines = new Map();
  for (const line of cart) {
    const productId = line ? int(line.product_id) : 0;
    const quantity = line ? int(line.quantity) : 0;
    if (productId <= 0 || quantity <= 0 || quantity > 99) fail('Invalid item quantity in your tray.');
    lines.set(productId, (lines.get(productId) || 0) + quantity);
  }

  // Prices always come from the database, never from the browser
  const ids = [...lines.keys()];
  const products = await many(
    'SELECT product_id, name, price, is_available, is_archived FROM products WHERE product_id = ANY($1::int[])',
    [ids]
  );
  if (products.length !== ids.length) fail('Some items in your tray are no longer on the menu.');
  for (const p of products) {
    if (Number(p.is_archived)) fail(`${p.name} is no longer on the menu. Please remove it from your tray.`);
    if (!Number(p.is_available)) fail(`${p.name} is sold out. Please remove it from your tray.`);
  }

  const orderId = await tx(async client => {
    const order = await one(
      'INSERT INTO orders (customer_id, order_type, notes) VALUES ($1, $2, $3) RETURNING order_id',
      [user.user_id, orderType, notes || null],
      client
    );
    for (const p of products) {
      await query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
        [order.order_id, p.product_id, lines.get(Number(p.product_id)), p.price],
        client
      );
    }
    return Number(order.order_id);
  });
  return { order_id: orderId, message: `Order #${orderId} placed!` };
};

actions.my_orders = async ctx => {
  const user = await requireRole(ctx, 'customer');
  const orders = (await many('SELECT * FROM v_order_summary WHERE customer_id = $1 ORDER BY created_at DESC', [user.user_id])).map(castOrder);
  // Queue position: open orders placed before each of this customer's pending orders
  const queue = await many(
    `SELECT o.order_id,
            (SELECT COUNT(*) FROM orders a
             WHERE a.status IN ('pending', 'preparing') AND a.order_id < o.order_id) AS orders_ahead
     FROM orders o
     WHERE o.customer_id = $1 AND o.status = 'pending'`,
    [user.user_id]
  );
  const ahead = new Map(queue.map(q => [Number(q.order_id), Number(q.orders_ahead)]));
  let spent = 0;
  for (const order of orders) {
    if (order.status !== 'cancelled') spent += order.total_amount;
    if (ahead.has(order.order_id)) order.orders_ahead = ahead.get(order.order_id);
  }
  return { orders, total_spent: spent };
};

actions.vendor_orders = async ctx => {
  const user = await requireRole(ctx, 'vendor');
  if (user.status !== 'active') fail(VENDOR_WAITING, 403);
  return { orders: (await many('SELECT * FROM v_order_summary ORDER BY created_at DESC')).map(castOrder) };
};

actions.cancel_order = async ctx => {
  requirePost(ctx);
  const user = await requireRole(ctx, 'customer');
  const result = await query(
    "UPDATE orders SET status = 'cancelled' WHERE order_id = $1 AND customer_id = $2 AND status = 'pending'",
    [int(input(ctx, 'order_id')), user.user_id]
  );
  if (!result.rowCount) fail('Only pending orders can be cancelled.');
  return { message: 'Order cancelled.' };
};

// Order line items (owner and active vendor: any order, customer: own orders)
actions.order_details = async ctx => {
  const user = await requireRole(ctx, ['owner', 'vendor', 'customer']);
  if (user.role === 'vendor' && user.status !== 'active') fail(VENDOR_WAITING, 403);
  const orderId = int(ctx.query.get('order_id'));
  const row = await one('SELECT * FROM v_order_summary WHERE order_id = $1', [orderId]);
  if (!row) fail('Order not found.', 404);
  const order = castOrder(row);
  if (user.role === 'customer' && order.customer_id !== user.user_id) fail('Order not found.', 404);

  const items = await many(
    `SELECT oi.product_id, p.name, p.unit, p.image, oi.quantity, oi.unit_price,
            oi.quantity * oi.unit_price AS subtotal
     FROM order_items oi
     JOIN products p ON p.product_id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.order_item_id`,
    [orderId]
  );
  return {
    order,
    items: items.map(i => ({
      ...i,
      product_id: Number(i.product_id),
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
      subtotal: Number(i.subtotal)
    }))
  };
};

// Menu management: the owner and approved vendors share one menu
actions.manage_products = async ctx => {
  await requireRole(ctx, ['owner', 'vendor']);
  return { products: await productRows(true) };
};

actions.save_product = async ctx => {
  requirePost(ctx);
  const user = await requireMenuEditor(ctx);

  let productId = int(input(ctx, 'product_id', '0'));
  const name = input(ctx, 'name');
  const categoryId = int(input(ctx, 'category_id'));
  const description = input(ctx, 'description');
  const unit = input(ctx, 'unit', '1 serving');
  const priceText = input(ctx, 'price');
  const price = Number(priceText);
  const available = input(ctx, 'is_available', '1') === '1' ? 1 : 0;

  if (!name || charLength(name) > 100) fail('Please enter a dish name.');
  if (priceText === '' || !Number.isFinite(price) || price < 0 || price > 99999) fail('Please enter a valid price.');
  if (!unit || charLength(unit) > 30) fail('Please enter a unit, e.g. "1 piece".');
  if (charLength(description) > 255) fail('Description must be 255 characters or fewer.');
  if (!(await one('SELECT 1 FROM categories WHERE category_id = $1', [categoryId]))) fail('Please choose a category.');

  const isNew = productId === 0;
  if (!isNew) {
    await activeProduct(productId);
  } else {
    // Adding back a dish that was removed earlier restores the old record
    const archived = await one('SELECT product_id FROM products WHERE name = $1 AND is_archived = 1', [name]);
    if (archived) productId = Number(archived.product_id);
  }

  let oldImage = null;
  if (productId > 0) oldImage = (await one('SELECT image FROM products WHERE product_id = $1', [productId])).image;

  const image = await saveUploadedImage(ctx);
  try {
    if (productId > 0) {
      await query(
        `UPDATE products SET name = $1, category_id = $2, description = $3, unit = $4, price = $5,
                is_available = $6, is_archived = 0, updated_by = $7, image = COALESCE($8, image)
         WHERE product_id = $9`,
        [name, categoryId, description || null, unit, price, available, user.user_id, image, productId]
      );
    } else {
      await query(
        `INSERT INTO products (name, category_id, description, unit, price, is_available, image, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [name, categoryId, description || null, unit, price, available, image, user.user_id]
      );
    }
  } catch (error) {
    await deleteUploadedImage(image);
    if (error.code === '23505') fail('There is already a dish with that name on the menu.');
    throw error;
  }
  if (image) await deleteUploadedImage(oldImage);

  return { message: isNew ? `${name} was added to the menu.` : `${name} was updated.` };
};

actions.toggle_product = async ctx => {
  requirePost(ctx);
  const user = await requireMenuEditor(ctx);
  const product = await activeProduct(int(input(ctx, 'product_id')));
  await query('UPDATE products SET is_available = 1 - is_available, updated_by = $1 WHERE product_id = $2', [user.user_id, product.product_id]);
  return { message: 'Availability updated.' };
};

actions.delete_product = async ctx => {
  requirePost(ctx);
  const user = await requireMenuEditor(ctx);
  const product = await activeProduct(int(input(ctx, 'product_id')));
  const id = Number(product.product_id);
  const { image } = await one('SELECT image FROM products WHERE product_id = $1', [id]);

  // Dishes that were never ordered are deleted; ordered dishes are archived
  // so past orders keep their line items.
  if (await one('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [id])) {
    await query('UPDATE products SET is_archived = 1, is_available = 0, updated_by = $1 WHERE product_id = $2', [user.user_id, id]);
  } else {
    await query('DELETE FROM products WHERE product_id = $1', [id]);
    await deleteUploadedImage(image);
  }
  return { message: `${product.name} was removed from the menu.` };
};

// Owner: dashboard, order status, vendors, customers
actions.owner_dashboard = async ctx => {
  await requireRole(ctx, 'owner');
  const orders = (await many('SELECT * FROM v_order_summary ORDER BY created_at DESC')).map(order => {
    const cast = castOrder(order);
    cast.allowed_statuses = [cast.status, ...ORDER_TRANSITIONS[cast.status]];
    return cast;
  });

  // "Today" is the canteen's local date, not the database server's (UTC)
  const timezone = process.env.APP_TIMEZONE || 'Asia/Manila';
  const kpi = await one(
    `SELECT COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS total_sales,
            COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'
              AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date), 0) AS today_sales,
            COUNT(*) FILTER (WHERE status IN ('pending', 'preparing', 'ready')) AS open_orders,
            COUNT(*) AS total_orders
     FROM v_order_summary`,
    [timezone]
  );
  const top = await one(
    `SELECT p.name, SUM(oi.quantity) AS qty
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id AND o.status <> 'cancelled'
     JOIN products p ON p.product_id = oi.product_id
     GROUP BY p.product_id, p.name
     ORDER BY qty DESC
     LIMIT 1`
  );
  const pending = await one("SELECT COUNT(*) AS n FROM users WHERE role = 'vendor' AND status = 'pending'");

  return {
    orders,
    kpis: {
      total_sales: Number(kpi.total_sales),
      today_sales: Number(kpi.today_sales),
      open_orders: Number(kpi.open_orders),
      total_orders: Number(kpi.total_orders),
      top_item: top ? top.name : null,
      pending_vendors: Number(pending.n)
    }
  };
};

actions.update_order_status = async ctx => {
  requirePost(ctx);
  const user = await requireRole(ctx, ['owner', 'vendor']);
  if (user.role === 'vendor' && user.status !== 'active') fail(VENDOR_WAITING, 403);
  const status = input(ctx, 'status');
  const orderId = int(input(ctx, 'order_id'));
  if (!ORDER_STATUSES.includes(status)) fail('Unknown order status.');
  const order = await one('SELECT status FROM orders WHERE order_id = $1', [orderId]);
  if (!order) fail('Order not found.', 404);
  const currentStatus = order.status;
  if (status === currentStatus) return { message: 'Order status is unchanged.' };
  const allowed = user.role === 'vendor' ? (VENDOR_TRANSITIONS[currentStatus] || []) : ORDER_TRANSITIONS[currentStatus];
  if (!allowed.includes(status)) fail('That status change is not allowed for this order.', 409);

  const result = await query('UPDATE orders SET status = $1 WHERE order_id = $2 AND status = $3', [status, orderId, currentStatus]);
  if (!result.rowCount) fail('The order changed before this update. Refresh and try again.', 409);
  return { message: 'Order updated.' };
};

actions.vendors = async ctx => {
  await requireRole(ctx, 'owner');
  const vendors = await many(
    `SELECT u.user_id, u.full_name, u.email, u.phone, u.status, u.created_at,
            (SELECT COUNT(*) FROM products p WHERE p.created_by = u.user_id) AS dishes_added,
            (SELECT MAX(p.updated_at) FROM products p WHERE p.updated_by = u.user_id) AS last_menu_edit
     FROM users u
     WHERE u.role = 'vendor'
     ORDER BY CASE u.status WHEN 'pending' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, u.full_name`
  );
  return { vendors: vendors.map(v => ({ ...v, user_id: Number(v.user_id), dishes_added: Number(v.dishes_added) })) };
};

actions.set_vendor_status = async ctx => {
  requirePost(ctx);
  await requireRole(ctx, 'owner');
  const status = input(ctx, 'status');
  const userId = int(input(ctx, 'user_id'));
  if (!['active', 'suspended'].includes(status)) fail('Unknown account status.');
  if (!(await one("SELECT 1 FROM users WHERE user_id = $1 AND role = 'vendor'", [userId]))) fail('Vendor not found.', 404);
  await query("UPDATE users SET status = $1 WHERE user_id = $2 AND role = 'vendor'", [status, userId]);
  return { message: 'Vendor account updated.' };
};

actions.customers = async ctx => {
  await requireRole(ctx, 'owner');
  const customers = await many(
    `SELECT u.user_id, u.full_name, u.email, u.phone, u.created_at,
            COUNT(s.order_id) AS order_count,
            COALESCE(SUM(s.total_amount) FILTER (WHERE s.status <> 'cancelled'), 0) AS total_spent,
            MAX(s.created_at) AS last_order_at
     FROM users u
     LEFT JOIN v_order_summary s ON s.customer_id = u.user_id
     WHERE u.role = 'customer'
     GROUP BY u.user_id, u.full_name, u.email, u.phone, u.created_at
     ORDER BY total_spent DESC, u.full_name`
  );
  return {
    customers: customers.map(c => ({
      ...c,
      user_id: Number(c.user_id),
      order_count: Number(c.order_count),
      total_spent: Number(c.total_spent)
    }))
  };
};

// ------------------------------------------------------------
// Request handling
// ------------------------------------------------------------
async function readBody(req) {
  const type = String(req.headers['content-type'] || '');
  if (req.method !== 'POST') return { body: {}, files: {} };
  if (type.startsWith('multipart/form-data')) {
    const form = formidable({
      maxFiles: 1,
      maxFileSize: MAX_UPLOAD,
      allowEmptyFiles: true,
      minFileSize: 0,
      maxFields: 50,
      maxFieldsSize: 1024 * 1024
    });
    let fields;
    let files;
    try {
      [fields, files] = await form.parse(req);
    } catch (error) {
      if (error.httpCode === 413) fail('Photo must be 3 MB or smaller.');
      fail('The form could not be read. Please try again.');
    }
    const first = value => (Array.isArray(value) ? value[0] : value);
    const body = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, first(value)]));
    const fileMap = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, first(value)]));
    return { body, files: fileMap };
  }
  // app.js always sends multipart forms
  return { body: {}, files: {} };
}

async function removeTempFiles(files) {
  for (const file of Object.values(files || {})) {
    if (file && file.filepath) await fs.unlink(file.filepath).catch(() => {});
  }
}

function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  const ctx = { req, res, query: new URL(req.url, 'http://localhost').searchParams, body: {}, files: {}, session: null, user: undefined };
  try {
    ({ body: ctx.body, files: ctx.files } = await readBody(req));
    const action = ctx.query.get('action') || input(ctx, 'action');
    const run = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
    if (!run) fail('Unknown API action.', 404);
    if (action !== 'image') ctx.session = await loadSession(ctx);

    const data = await run(ctx);
    if (data !== null) sendJson(res, 200, { success: true, ...data });
  } catch (error) {
    if (error instanceof HttpError) {
      const body = { success: false, message: error.message };
      if (error.code) body.code = error.code;
      sendJson(res, error.status, body);
    } else {
      console.error('API error:', error);
      sendJson(res, 500, { success: false, message: 'A database error occurred.' });
    }
  } finally {
    await removeTempFiles(ctx.files);
  }
}

module.exports = handler;
