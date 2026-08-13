// One-off: crea la tabla de settings de la bitácora (clave/valor), para
// guardar cosas como el capital total de la cuenta.
// node app/scripts/migrate_bitacora_settings.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('POSTGRES_URL / DATABASE_URL no configurada en .env.local');

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const SQL = `
CREATE TABLE IF NOT EXISTS bitacora_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

(async () => {
  try {
    await pool.query(SQL);
    console.log('OK: tabla bitacora_settings lista.');
  } finally {
    await pool.end();
  }
})();
