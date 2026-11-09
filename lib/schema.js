'use strict';
// Creates the tables from schema.sql when the database is empty, so a new
// Render Postgres database needs no manual setup. A database that already
// has the tables is never changed.
const fs = require('node:fs');
const path = require('node:path');
const { tx, one } = require('./db');

const SCHEMA_FILE = path.join(__dirname, '..', 'schema.sql');
const LOCK_ID = 482119; // any constant; stops two instances racing

async function ensureSchema() {
  return tx(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const existing = await one("SELECT to_regclass('public.users') AS users_table", [], client);
    if (existing.users_table) return false;
    await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    return true;
  });
}

module.exports = { ensureSchema };
