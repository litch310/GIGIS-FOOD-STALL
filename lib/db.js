'use strict';
// Postgres connection shared by the API, server.js and the setup script.
const { Pool } = require('pg');

let pool = null;

function poolConfig() {
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!raw) throw new Error('DATABASE_URL is not configured.');

  // TLS is configured below, so libpq-style ssl* parameters in the URL are
  // removed; node-postgres would otherwise let them override this config.
  const url = new URL(raw);
  const urlSslMode = url.searchParams.get('sslmode');
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }

  const mode = String(process.env.DATABASE_SSL || urlSslMode || 'require').toLowerCase();
  let ssl;
  if (mode === 'disable') {
    ssl = false;
  } else if (process.env.DATABASE_CA_CERT) {
    // PEM certificate of the database's CA, to verify the server
    ssl = { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  } else {
    // Encrypted, but the server certificate is not verified. Set
    // DATABASE_CA_CERT to verify it.
    ssl = { rejectUnauthorized: false };
  }

  return {
    connectionString: url.toString(),
    ssl,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  };
}

function getPool() {
  if (!pool) pool = new Pool(poolConfig());
  return pool;
}

async function query(text, values = [], client = null) {
  return (client || getPool()).query(text, values);
}

async function many(text, values = [], client = null) {
  return (await query(text, values, client)).rows;
}

async function one(text, values = [], client = null) {
  return (await query(text, values, client)).rows[0] || null;
}

// Runs fn(client) inside a transaction; any thrown error rolls it back.
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

module.exports = { query, many, one, tx, close };
