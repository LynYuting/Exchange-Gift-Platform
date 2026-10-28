// Base de datos PostgreSQL: usuarios, sesiones, grupos, participantes y wishlists.
//
// - En producción (Vercel) se conecta a Neon o Supabase con la cadena de
//   conexión de DATABASE_URL (Neon) o POSTGRES_URL (Supabase).
// - En tu computadora, si no hay cadena de conexión, usa PGlite: un Postgres
//   completo guardado en ./data/pgdata, sin instalar nada.
const path = require('path');
const fs = require('fs');

const CONNECTION = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

// Las consultas se escriben con "?" y aquí se convierten a $1, $2… de Postgres.
const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

// ---------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------
let engine; // { query(sql, params) → { rows, count }, exec(sql), transaction(fn(tx)) }

if (CONNECTION) {
  const { Pool } = require('pg');
  const url = new URL(CONNECTION);
  // Quitamos los parámetros SSL de la URL para controlarlos aquí (si se quedan,
  // node-postgres ignora la configuración ssl de abajo).
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'channel_binding']) {
    url.searchParams.delete(p);
  }
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: sslFor(url.hostname),
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  if (process.env.VERCEL) {
    // Cierra las conexiones inactivas antes de que Vercel suspenda la función.
    require('@vercel/functions').attachDatabasePool(pool);
  }
  const wrapClient = (c) => ({
    async query(sql, params = []) {
      const r = await c.query(toPg(sql), params);
      return { rows: r.rows, count: r.rowCount };
    },
    exec: (sql) => c.query(sql), // varias sentencias, sin parámetros
  });
  engine = {
    ...wrapClient(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrapClient(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
} else {
  const { PGlite } = require('@electric-sql/pglite');
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'pgdata');
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  const wrapPglite = (c) => ({
    async query(sql, params = []) {
      const r = await c.query(toPg(sql), params);
      return { rows: r.rows, count: r.affectedRows || 0 };
    },
    exec: (sql) => c.exec(sql), // varias sentencias, sin parámetros
  });
  engine = {
    ...wrapPglite(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrapPglite(tx))),
  };
}

// Neon usa certificados públicos y se verifican normalmente. Supabase firma con
// su propia autoridad: pega su certificado en DATABASE_CA_CERT para verificarlo;
// sin él la conexión va cifrada pero sin verificar el certificado.
function sslFor(host) {
  if (['localhost', '127.0.0.1', '::1'].includes(host) || process.env.DATABASE_SSL === 'false') return false;
  const ca = (process.env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
  if (ca) return { ca, rejectUnauthorized: true };
  if (/(^|\.)supabase\.(co|com)$/.test(host)) {
    console.warn('ℹ️  Supabase sin DATABASE_CA_CERT: conexión cifrada sin verificar el certificado.');
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

// ---------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------
const SCHEMA = `
SELECT pg_advisory_xact_lock(82471993);  -- evita que dos instancias creen tablas a la vez

CREATE TABLE IF NOT EXISTS users (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL UNIQUE,          -- siempre en minúsculas
  google_sub  text UNIQUE,
  google_name text,
  picture     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,              -- sha256 del token de la cookie
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_groups (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  description   text,
  budget        double precision,
  currency      text NOT NULL DEFAULT 'MXN',
  event_date    text,                        -- YYYY-MM-DD
  organizer_id  integer NOT NULL REFERENCES users(id),
  drawn_at      timestamptz,                 -- NULL = sorteo pendiente
  invite_token  text,                        -- enlace de invitación del grupo
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Cada participante del grupo. El nombre lo pone el organizador; cada quien
-- abre el enlace del grupo, entra con Google y elige su nombre (user_id).
CREATE TABLE IF NOT EXISTS members (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      integer NOT NULL REFERENCES gift_groups(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  email         text,                        -- solo grupos de la versión anterior
  user_id       integer REFERENCES users(id) ON DELETE SET NULL,  -- cuenta que eligió este nombre
  receiver_id   integer REFERENCES members(id) ON DELETE SET NULL,  -- a quién le regala
  joined_at     timestamptz,                 -- cuándo eligió su nombre
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, email)
);

-- Migración desde la versión anterior (correo obligatorio, sin enlace de grupo).
ALTER TABLE gift_groups ADD COLUMN IF NOT EXISTS invite_token text;
UPDATE gift_groups SET invite_token = replace(gen_random_uuid()::text, '-', '') WHERE invite_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_invite ON gift_groups(invite_token);
ALTER TABLE members ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE members ALTER COLUMN email DROP NOT NULL;
UPDATE members m SET user_id = u.id FROM users u WHERE m.user_id IS NULL AND m.email = u.email;
-- Una cuenta solo puede ocupar un nombre por intercambio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_group_user ON members(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

-- Las fotos se guardan en la base de datos (ya reducidas a ~1200 px).
CREATE TABLE IF NOT EXISTS wishlist_items (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name        text NOT NULL,
  cost        double precision,
  link        text,
  photo_mime  text,
  photo_data  bytea,
  photo_ver   text,                          -- cambia con cada foto nueva (caché)
  position    integer,                       -- orden de preferencia (1 = la favorita)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Migración: las wishlists anteriores quedan en el orden en que se agregaron.
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS position integer;
UPDATE wishlist_items w SET position = r.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY member_id ORDER BY id) AS rn
  FROM wishlist_items
  WHERE member_id IN (SELECT member_id FROM wishlist_items WHERE position IS NULL)
) r
WHERE w.id = r.id;

CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_items_member ON wishlist_items(member_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Supabase publica automáticamente las tablas por su API REST. Con RLS activado
-- y sin políticas, nadie puede leerlas por ahí; esta app se conecta como dueña
-- de las tablas y no se ve afectada. En Neon no cambia nada.
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_groups    ENABLE ROW LEVEL SECURITY;
ALTER TABLE members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
`;

// Crea las tablas la primera vez (una sola vez por instancia del servidor).
let readyPromise;
function ready() {
  if (!readyPromise) {
    readyPromise = engine.transaction((tx) => tx.exec(SCHEMA)).catch((err) => {
      readyPromise = null; // reintenta en la siguiente petición
      throw err;
    });
  }
  return readyPromise;
}

// ---------------------------------------------------------------------------
// Ayudantes con la misma forma para consultas normales y transacciones
// ---------------------------------------------------------------------------
function helpers(q) {
  return {
    async get(sql, ...args) {
      return (await q.query(sql, args)).rows[0];
    },
    async all(sql, ...args) {
      return (await q.query(sql, args)).rows;
    },
    async run(sql, ...args) {
      return { changes: (await q.query(sql, args)).count };
    },
  };
}

const db = {
  ...helpers(engine),
  // Ejecuta fn dentro de una transacción: o se guarda todo, o nada.
  transaction: (fn) => engine.transaction((tx) => fn(helpers(tx))),
};

module.exports = { db, ready, isRemote: !!CONNECTION };
