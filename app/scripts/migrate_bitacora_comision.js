// One-off: agrega la columna "comision" (comisiones pagadas en la operación, en USD) a
// bitacora_entries. El resultado mostrado pasa a ser resultado cargado - comision.
// node app/scripts/migrate_bitacora_comision.js
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

const SQL = `ALTER TABLE bitacora_entries ADD COLUMN IF NOT EXISTS comision NUMERIC;`;

(async () => {
  try {
    await pool.query(SQL);
    console.log('OK: columna bitacora_entries.comision lista.');
  } finally {
    await pool.end();
  }
})();
