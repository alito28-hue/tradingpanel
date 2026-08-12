// One-off: crea las tablas de la bitácora en la base Postgres (Neon/Vercel).
// node app/scripts/migrate_bitacora.js
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
CREATE TABLE IF NOT EXISTS bitacora_entries (
  id SERIAL PRIMARY KEY,
  fecha DATE NOT NULL,
  hora_entrada TIME,
  hora_salida TIME,
  symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
  direccion TEXT NOT NULL CHECK (direccion IN ('long','short')),
  precio_entrada NUMERIC,
  precio_salida NUMERIC,
  resultado NUMERIC,
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bitacora_attachments (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES bitacora_entries(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

(async () => {
  try {
    await pool.query(SQL);
    console.log('OK: tablas bitacora_entries / bitacora_attachments listas.');
  } finally {
    await pool.end();
  }
})();
