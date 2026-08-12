// Pool reused across warm serverless invocations (module scope survives
// between requests handled by the same function instance) — creating a new
// Pool per request would exhaust Postgres connections under load.
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('POSTGRES_URL / DATABASE_URL no configurada');
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { query };
