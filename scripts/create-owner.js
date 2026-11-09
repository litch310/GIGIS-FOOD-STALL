'use strict';
// One-time owner account bootstrap for the Supabase database (port of
// setup_owner.php). Reads DATABASE_URL, OWNER_NAME, OWNER_EMAIL,
// OWNER_PASSWORD and optional OWNER_PHONE from the environment.
const bcrypt = require('bcryptjs');
const { one, query, close } = require('../lib/db');
const { isEmail } = require('../lib/email');

function stop(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

async function main() {
  const name = String(process.env.OWNER_NAME || '').trim();
  const email = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.OWNER_PASSWORD || '');
  const phone = String(process.env.OWNER_PHONE || '').trim();

  if (!name || [...name].length > 100) return stop('Set OWNER_NAME to the owner name (up to 100 characters).');
  if (!isEmail(email)) return stop('Set OWNER_EMAIL to a valid email address.');
  if (password.length < 12) return stop('Set OWNER_PASSWORD to a password with at least 12 characters.');
  if (phone && !/^[0-9+\- ]{7,20}$/.test(phone)) return stop('OWNER_PHONE must be a valid phone number.');

  if (await one("SELECT user_id FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1")) {
    return stop('An active owner already exists. This setup command can only run when no active owner is available.', 2);
  }

  const hash = await bcrypt.hash(password, 12);
  const existing = await one('SELECT user_id, role, status FROM users WHERE email = $1 LIMIT 1', [email]);
  let userId;
  if (existing) {
    if (existing.role !== 'owner' || existing.status !== 'suspended') {
      return stop('That email is already in use. Choose a different owner email.');
    }
    userId = existing.user_id;
    await query(
      "UPDATE users SET full_name = $1, phone = $2, password_hash = $3, status = 'active' WHERE user_id = $4",
      [name, phone || null, hash, userId]
    );
    await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  } else {
    userId = (await one(
      "INSERT INTO users (full_name, email, phone, password_hash, role, status) VALUES ($1, $2, $3, $4, 'owner', 'active') RETURNING user_id",
      [name, email, phone || null, hash]
    )).user_id;
  }
  await query(
    'INSERT INTO account_verifications (user_id, verified_at) VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE SET verified_at = now()',
    [userId]
  );
  console.log(`Owner account ready for ${email}.`);
}

main()
  .catch(error => stop(`Could not create the owner account: ${error.message}`))
  .finally(() => close());
