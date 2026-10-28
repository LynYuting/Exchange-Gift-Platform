// Base de datos: usuarios, sesiones, grupos, participantes y wishlists.
//
// - En tu computadora usa un archivo SQLite local (data/intercambio.db).
// - En Vercel usa Turso (SQLite en la nube), porque Vercel no guarda archivos
//   entre peticiones. Se activa al definir TURSO_DATABASE_URL.
const path = require('path');
const fs = require('fs');

const REMOTE_URL = (process.env.TURSO_DATABASE_URL || '').trim();
let client;
if (REMOTE_URL) {
  // Cliente HTTP puro, sin código nativo: ideal para funciones serverless.
  const { createClient } = require('@libsql/client/web');
  client = createClient({ url: REMOTE_URL, authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined });
} else {
  const { createClient } = require('@libsql/client');
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  client = createClient({ url: `file:${path.join(dir, 'intercambio.db')}` });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,          -- siempre en minúsculas
  google_sub  TEXT UNIQUE,
  google_name TEXT,
  picture     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,              -- sha256 del token de la cookie
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_groups (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  budget        REAL,
  currency      TEXT NOT NULL DEFAULT 'MXN',
  event_date    TEXT,                        -- YYYY-MM-DD
  organizer_id  INTEGER NOT NULL REFERENCES users(id),
  drawn_at      TEXT,                        -- NULL = sorteo pendiente
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cada participante del grupo. El nombre lo pone el organizador.
-- La cuenta de Google se vincula por correo al iniciar sesión.
CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES gift_groups(id),
  display_name  TEXT NOT NULL,
  email         TEXT NOT NULL,               -- siempre en minúsculas
  receiver_id   INTEGER REFERENCES members(id),  -- a quién le regala
  joined_at     TEXT,                        -- primera vez que entró
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, email)
);

-- Las fotos se guardan dentro de la base de datos (ya reducidas a ~1200 px),
-- así no hace falta otro servicio de almacenamiento.
CREATE TABLE IF NOT EXISTS wishlist_items (
  id          INTEGER PRIMARY KEY,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  name        TEXT NOT NULL,
  cost        REAL,
  link        TEXT,
  photo_mime  TEXT,
  photo_data  BLOB,
  photo_ver   TEXT,                          -- cambia con cada foto nueva (caché)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_items_member ON wishlist_items(member_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

// Crea las tablas la primera vez (una sola vez por instancia del servidor).
let readyPromise;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await client.executeMultiple(SCHEMA);
      // Migración de la versión anterior (fotos en carpeta uploads/).
      const cols = (await client.execute('PRAGMA table_info(wishlist_items)')).rows.map((r) => r.name);
      for (const [col, type] of [['photo_mime', 'TEXT'], ['photo_data', 'BLOB'], ['photo_ver', 'TEXT']]) {
        if (!cols.includes(col)) await client.execute(`ALTER TABLE wishlist_items ADD COLUMN ${col} ${type}`);
      }
    })().catch((err) => {
      readyPromise = null; // reintenta en la siguiente petición
      throw err;
    });
  }
  return readyPromise;
}

// Ayudantes con la misma forma para el cliente y para transacciones.
function helpers(exec) {
  return {
    async get(sql, ...args) {
      return (await exec({ sql, args })).rows[0];
    },
    async all(sql, ...args) {
      return (await exec({ sql, args })).rows;
    },
    async run(sql, ...args) {
      const r = await exec({ sql, args });
      return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
    },
  };
}

const db = {
  ...helpers((stmt) => client.execute(stmt)),
  // Ejecuta fn dentro de una transacción: o se guarda todo, o nada.
  async transaction(fn) {
    const tx = await client.transaction('write');
    try {
      const result = await fn(helpers((stmt) => tx.execute(stmt)));
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  },
};

module.exports = { db, ready, isRemote: !!REMOTE_URL };
