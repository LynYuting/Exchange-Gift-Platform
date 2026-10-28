// Intercambio navideño — servidor
// Express + PostgreSQL (Neon o Supabase) + inicio de sesión con Google (Google Identity Services).
// Funciona igual en tu computadora (npm start) y en Vercel (función serverless).
//
// Regla principal de privacidad: la API nunca envía a quién le toca a otra
// persona. Cada usuario solo recibe su propia asignación, ni el organizador
// puede ver las de los demás.

require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { db, ready } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ON_VERCEL = !!process.env.VERCEL;
const IS_PROD = process.env.NODE_ENV === 'production' || ON_VERCEL;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
// Inicio de sesión de prueba (sin Google), solo para desarrollo local.
const DEV_LOGIN = !IS_PROD && process.env.DEV_LOGIN === 'true';
const SESSION_DAYS = 30;
const MAX_MEMBERS = 100;
const MAX_ITEMS = 30;
const MAX_PHOTO_MB = 4; // Vercel acepta como máximo 4.5 MB por petición
const CURRENCIES = ['MXN', 'USD', 'EUR', 'GBP'];

if (!GOOGLE_CLIENT_ID && !DEV_LOGIN) {
  console.warn('⚠️  Falta GOOGLE_CLIENT_ID: nadie podrá iniciar sesión.');
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY || ON_VERCEL) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// ---------------------------------------------------------------------------
// Seguridad HTTP
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", 'https://accounts.google.com/gsi/style'],
        fontSrc: ["'self'"],
        frameSrc: ['https://accounts.google.com/gsi/'],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
    // El botón de Google abre una ventana emergente y necesita estos dos ajustes.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Protección CSRF: toda petición que modifica datos debe traer este encabezado,
// que un sitio ajeno no puede enviar sin pasar por CORS.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'intercambio') {
    return res.status(403).json({ error: 'Solicitud no permitida.' });
  }
  next();
});

// Nota: en Vercel cada instancia lleva su propia cuenta; aun así frena abusos.
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: IS_PROD ? 30 : 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Espera unos minutos.' },
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function str(v, label, { max = 100, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(400, `Valor inválido en ${label}.`);
  v = v.trim().replace(/\s+/g, ' ');
  if (required && !v) fail(400, `Falta ${label}.`);
  if (v.length > max) fail(400, `${cap(label)} es demasiado largo (máx. ${max} caracteres).`);
  return v;
}
function longText(v, label, max = 500) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(400, `Valor inválido en ${label}.`);
  v = v.trim();
  if (v.length > max) fail(400, `${cap(label)} es demasiado largo (máx. ${max} caracteres).`);
  return v;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email(v) {
  const e = str(v, 'el correo', { max: 254, required: true }).toLowerCase();
  if (!EMAIL_RE.test(e)) fail(400, `“${e}” no es un correo válido.`);
  return e;
}
// Correo opcional: vacío → null.
function optEmail(v) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  return email(v);
}
const newInviteToken = () => crypto.randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const INVITE_INVALID = 'Este enlace ya no es válido. Pídele el enlace actual a quien organiza el intercambio.';
const nameKey = (s) => s.toLocaleLowerCase('es');

function money(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e8) fail(400, `${label} debe ser un número positivo.`);
  return Math.round(n * 100) / 100;
}
function link(v) {
  const s = str(v, 'el link', { max: 2000 });
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    fail(400, 'El link no es una dirección web válida.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) fail(400, 'El link debe empezar con http:// o https://');
  return u.toString();
}
function isoDate(v) {
  const s = str(v, 'la fecha', { max: 10 });
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(400, 'La fecha no es válida.');
  return s;
}
function currency(v) {
  const c = str(v, 'la moneda', { max: 3 }).toUpperCase() || 'MXN';
  if (!CURRENCIES.includes(c)) fail(400, 'Moneda no soportada.');
  return c;
}
function idParam(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== String(v)) fail(404, 'No encontrado.');
  return n;
}

// Espera a que existan las tablas antes de atender cualquier petición de la API.
app.use(
  '/api',
  wrap(async (req, res, next) => {
    await ready();
    next();
  })
);

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db.run('DELETE FROM sessions WHERE expires_at < now()'); // limpieza
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, new Date(Date.now() + maxAge));
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge, path: '/' });
}

app.use(
  '/api',
  wrap(async (req, res, next) => {
    const token = req.cookies.sid;
    if (token) {
      req.user = await db.get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > now()`,
        sha256(token)
      );
    }
    next();
  })
);

const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Inicia sesión para continuar.' });

async function upsertUser({ email: mail, sub = null, name = null, picture = null }) {
  if (sub) {
    // Si esa cuenta de Google cambió de correo, liberamos el vínculo anterior.
    await db.run('UPDATE users SET google_sub = NULL WHERE google_sub = ? AND email <> ?', sub, mail);
  }
  await db.run(
    `INSERT INTO users (email, google_sub, google_name, picture) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       google_sub  = COALESCE(excluded.google_sub, users.google_sub),
       google_name = COALESCE(excluded.google_name, users.google_name),
       picture     = COALESCE(excluded.picture, users.picture)`,
    mail,
    sub,
    name,
    picture
  );
  const user = await db.get('SELECT * FROM users WHERE email = ?', mail);
  await linkByEmail(user);
  return user;
}

// Si el organizador registró el correo de esta cuenta en algún intercambio,
// la vincula a ese lugar (si nadie lo tomó y la cuenta no está ya en ese grupo).
async function linkByEmail(user) {
  await db.run(
    `UPDATE members m SET user_id = ?, joined_at = COALESCE(m.joined_at, now())
     WHERE m.email = ? AND m.user_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM members x WHERE x.group_id = m.group_id AND x.user_id = ?)`,
    user.id,
    user.email,
    user.id
  );
}

// Lo mismo, pero para todos los lugares de un grupo con correo registrado.
async function linkGroupByEmail(groupId) {
  await db.run(
    `UPDATE members m SET user_id = u.id, joined_at = now()
     FROM users u
     WHERE m.group_id = ? AND m.user_id IS NULL AND m.email = u.email
       AND NOT EXISTS (SELECT 1 FROM members x WHERE x.group_id = m.group_id AND x.user_id = u.id)`,
    groupId
  );
}

const publicUser = (u) => ({ email: u.email, name: u.google_name, picture: u.picture });

// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, devLogin: DEV_LOGIN });
});

app.post(
  '/api/auth/google',
  authLimiter,
  wrap(async (req, res) => {
    if (!GOOGLE_CLIENT_ID) fail(500, 'El inicio de sesión con Google no está configurado (falta GOOGLE_CLIENT_ID).');
    const credential = str(req.body.credential, 'la credencial', { max: 5000, required: true });
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      fail(401, 'No se pudo verificar tu cuenta de Google. Intenta de nuevo.');
    }
    if (!payload || !payload.email || !payload.email_verified) {
      fail(401, 'Tu cuenta de Google no tiene un correo verificado.');
    }
    const user = await upsertUser({
      email: payload.email.toLowerCase(),
      sub: payload.sub,
      name: payload.name || null,
      picture: payload.picture || null,
    });
    await startSession(res, user.id);
    res.json({ user: publicUser(user) });
  })
);

if (DEV_LOGIN) {
  console.warn('⚠️  DEV_LOGIN activo: se puede entrar con cualquier correo sin Google. No lo uses en producción.');
  app.post(
    '/api/auth/dev',
    authLimiter,
    wrap(async (req, res) => {
      const mail = email(req.body.email);
      const user = await upsertUser({ email: mail, name: mail.split('@')[0] });
      await startSession(res, user.id);
      res.json({ user: publicUser(user) });
    })
  );
}

app.post(
  '/api/auth/logout',
  wrap(async (req, res) => {
    if (req.cookies.sid) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(req.cookies.sid));
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  })
);

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

// ---------------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------------
async function groupAccess(groupId, user) {
  const g = await db.get('SELECT * FROM gift_groups WHERE id = ?', groupId);
  // Respondemos 404 (no 403) para no revelar que el grupo existe.
  if (!g) fail(404, 'Ese grupo no existe o no formas parte de él.');
  const me = await db.get('SELECT * FROM members WHERE group_id = ? AND user_id = ?', g.id, user.id);
  const isOrganizer = g.organizer_id === user.id;
  if (!me && !isOrganizer) fail(404, 'Ese grupo no existe o no formas parte de él.');
  return { g, me, isOrganizer };
}
const requireOrganizer = (a) => {
  if (!a.isOrganizer) fail(403, 'Solo quien organiza el grupo puede hacer esto.');
};
const requireNotDrawn = (g) => {
  if (g.drawn_at) fail(409, 'El sorteo ya se hizo. Reinícialo primero para cambiar quién participa.');
};

async function itemsFor(memberId) {
  const rows = await db.all(
    'SELECT id, name, cost, link, photo_ver FROM wishlist_items WHERE member_id = ? ORDER BY position NULLS LAST, id',
    memberId
  );
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    cost: i.cost,
    link: i.link,
    photoUrl: i.photo_ver ? `/api/wishlist/${i.id}/photo?v=${i.photo_ver}` : null,
  }));
}

// Cada nombre debe ser único en el grupo, para que nadie elija el de otra persona por confusión.
async function assertNameFree(q, groupId, name, exceptId = 0) {
  const clash = await q.get(
    'SELECT 1 FROM members WHERE group_id = ? AND lower(display_name) = lower(?) AND id <> ?',
    groupId,
    name,
    exceptId
  );
  if (clash) fail(409, `Ya hay alguien llamado “${name}” en este intercambio. Usa un nombre distinto, por ejemplo con apellido.`);
}

// Nombre del organizador: el que tiene en el grupo, o el de su cuenta de Google.
async function organizerName(groupId, organizerId) {
  const r = await db.get(
    `SELECT COALESCE(m.display_name, u.google_name, u.email) AS name
     FROM users u LEFT JOIN members m ON m.group_id = ? AND m.user_id = u.id
     WHERE u.id = ?`,
    groupId,
    organizerId
  );
  return r ? r.name : '';
}

app.get(
  '/api/groups',
  requireUser,
  wrap(async (req, res) => {
    await linkByEmail(req.user);
    const rows = await db.all(
      `SELECT g.id, g.name, g.event_date, g.drawn_at, g.organizer_id, m.display_name AS my_name
       FROM gift_groups g
       LEFT JOIN members m ON m.group_id = g.id AND m.user_id = ?
       WHERE m.id IS NOT NULL OR g.organizer_id = ?
       ORDER BY g.event_date IS NULL, g.event_date, g.id`,
      req.user.id,
      req.user.id
    );
    res.json({
      groups: rows.map((r) => ({
        id: r.id,
        name: r.name,
        eventDate: r.event_date,
        drawn: !!r.drawn_at,
        isOrganizer: r.organizer_id === req.user.id,
        myName: r.my_name,
      })),
    });
  })
);

app.post(
  '/api/groups',
  requireUser,
  wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 'el nombre del grupo', { max: 80, required: true });
    const description = longText(b.description, 'la descripción');
    const budget = money(b.budget, 'El presupuesto');
    const cur = currency(b.currency);
    const eventDate = isoDate(b.eventDate);
    // El organizador puede participar (queda ligado a su nombre desde el inicio) o solo organizar.
    const me = b.me && typeof b.me === 'object' && b.me.participate ? str(b.me.name, 'tu nombre', { max: 60, required: true }) : null;
    const list = Array.isArray(b.participants) ? b.participants : [];
    if (list.length + (me ? 1 : 0) > MAX_MEMBERS) fail(400, `Máximo ${MAX_MEMBERS} participantes por grupo.`);
    const seenNames = new Set();
    const seenEmails = new Set();
    const addName = (n) => {
      if (seenNames.has(nameKey(n))) fail(400, `El nombre “${n}” está repetido. Usa nombres distintos para que cada quien encuentre el suyo.`);
      seenNames.add(nameKey(n));
    };
    if (me) addName(me);
    const participants = list.map((p) => {
      const pName = str(p && p.name, 'el nombre del participante', { max: 60, required: true });
      addName(pName);
      const pEmail = optEmail(p && p.email); // opcional, por compatibilidad
      if (pEmail && seenEmails.has(pEmail)) fail(400, `El correo ${pEmail} está repetido.`);
      if (pEmail) seenEmails.add(pEmail);
      return { name: pName, email: pEmail };
    });

    const groupId = await db.transaction(async (tx) => {
      const { id } = await tx.get(
        `INSERT INTO gift_groups (name, description, budget, currency, event_date, organizer_id, invite_token)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        name,
        description,
        budget,
        cur,
        eventDate,
        req.user.id,
        newInviteToken()
      );
      if (me) {
        await tx.run('INSERT INTO members (group_id, display_name, user_id, joined_at) VALUES (?, ?, ?, now())', id, me, req.user.id);
      }
      for (const p of participants) {
        await tx.run('INSERT INTO members (group_id, display_name, email) VALUES (?, ?, ?)', id, p.name, p.email);
      }
      return id;
    });
    await linkGroupByEmail(groupId);
    res.status(201).json({ id: groupId });
  })
);

app.get(
  '/api/groups/:id',
  requireUser,
  wrap(async (req, res) => {
    const { g, me, isOrganizer } = await groupAccess(idParam(req.params.id), req.user);
    const members = await db.all(
      `SELECT m.id, m.display_name, m.user_id, u.email AS account
       FROM members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY lower(m.display_name), m.id`,
      g.id
    );

    // Solo se busca la asignación del usuario actual.
    const receiver = me && me.receiver_id ? members.find((m) => m.id === me.receiver_id) : null;

    res.json({
      group: {
        id: g.id,
        name: g.name,
        description: g.description,
        budget: g.budget,
        currency: g.currency,
        eventDate: g.event_date,
        drawn: !!g.drawn_at,
        drawnAt: g.drawn_at,
        organizerName: await organizerName(g.id, g.organizer_id),
        isOrganizer,
        // El enlace de invitación del grupo solo lo ve quien organiza.
        ...(isOrganizer ? { inviteToken: g.invite_token } : {}),
      },
      me: me ? { id: me.id, name: me.display_name } : null,
      receiver: receiver ? { id: receiver.id, name: receiver.display_name } : null,
      // Nunca incluye a quién le regala cada quien. Qué cuenta eligió cada
      // nombre solo lo ve el organizador (para corregir errores).
      participants: members.map((m) => ({
        id: m.id,
        name: m.display_name,
        isMe: !!me && m.id === me.id,
        joined: !!m.user_id,
        ...(isOrganizer ? { account: m.account } : {}),
      })),
      myWishlist: me ? await itemsFor(me.id) : [],
      receiverWishlist: receiver ? await itemsFor(receiver.id) : null,
    });
  })
);

app.patch(
  '/api/groups/:id',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    const b = req.body || {};
    const next = {
      name: 'name' in b ? str(b.name, 'el nombre del grupo', { max: 80, required: true }) : a.g.name,
      description: 'description' in b ? longText(b.description, 'la descripción') : a.g.description,
      budget: 'budget' in b ? money(b.budget, 'El presupuesto') : a.g.budget,
      currency: 'currency' in b ? currency(b.currency) : a.g.currency,
      eventDate: 'eventDate' in b ? isoDate(b.eventDate) : a.g.event_date,
    };
    await db.run(
      'UPDATE gift_groups SET name = ?, description = ?, budget = ?, currency = ?, event_date = ? WHERE id = ?',
      next.name,
      next.description,
      next.budget,
      next.currency,
      next.eventDate,
      a.g.id
    );
    res.json({ ok: true });
  })
);

app.delete(
  '/api/groups/:id',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM wishlist_items WHERE member_id IN (SELECT id FROM members WHERE group_id = ?)', a.g.id);
      await tx.run('DELETE FROM members WHERE group_id = ?', a.g.id);
      await tx.run('DELETE FROM gift_groups WHERE id = ?', a.g.id);
    });
    res.json({ ok: true });
  })
);

// ---- Participantes (solo organizador) ----
app.post(
  '/api/groups/:id/members',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    requireNotDrawn(a.g);
    const name = str(req.body.name, 'el nombre', { max: 60, required: true });
    const { n } = await db.get('SELECT COUNT(*)::int AS n FROM members WHERE group_id = ?', a.g.id);
    if (n >= MAX_MEMBERS) fail(400, `Máximo ${MAX_MEMBERS} participantes por grupo.`);
    await assertNameFree(db, a.g.id, name);
    await db.run('INSERT INTO members (group_id, display_name) VALUES (?, ?)', a.g.id, name);
    res.status(201).json({ ok: true });
  })
);

app.patch(
  '/api/groups/:id/members/:mid',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    const m = await db.get('SELECT * FROM members WHERE id = ? AND group_id = ?', idParam(req.params.mid), a.g.id);
    if (!m) fail(404, 'Ese participante no existe.');
    const name = str(req.body.name, 'el nombre', { max: 60, required: true });
    await assertNameFree(db, a.g.id, name, m.id);
    await db.run('UPDATE members SET display_name = ? WHERE id = ?', name, m.id);
    res.json({ ok: true });
  })
);

// Liberar un nombre: si alguien eligió el que no era, la cuenta se desvincula
// y el nombre vuelve a quedar disponible en el enlace del grupo.
app.post(
  '/api/groups/:id/members/:mid/release',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    const m = await db.get('SELECT id FROM members WHERE id = ? AND group_id = ?', idParam(req.params.mid), a.g.id);
    if (!m) fail(404, 'Ese participante no existe.');
    // También se borra el correo (grupos anteriores) para que no se vuelva a vincular solo.
    await db.run('UPDATE members SET user_id = NULL, joined_at = NULL, email = NULL WHERE id = ?', m.id);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/groups/:id/members/:mid',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    requireNotDrawn(a.g);
    const m = await db.get('SELECT * FROM members WHERE id = ? AND group_id = ?', idParam(req.params.mid), a.g.id);
    if (!m) fail(404, 'Ese participante no existe.');
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM wishlist_items WHERE member_id = ?', m.id);
      await tx.run('DELETE FROM members WHERE id = ?', m.id);
    });
    res.json({ ok: true });
  })
);

// Cambiar el enlace del grupo: el anterior deja de servir (por si se compartió de más).
app.post(
  '/api/groups/:id/invite',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    await db.run('UPDATE gift_groups SET invite_token = ? WHERE id = ?', newInviteToken(), a.g.id);
    res.json({ ok: true });
  })
);

// ---- Enlace de invitación del grupo ----
// Un solo enlace para todos. Quien lo abre entra con Google y elige su nombre
// de la lista que escribió el organizador. Cada nombre se puede elegir una vez.
async function findGroupByInvite(q, token) {
  if (!TOKEN_RE.test(String(token))) fail(404, INVITE_INVALID);
  const g = await q.get('SELECT id, name, organizer_id, event_date FROM gift_groups WHERE invite_token = ?', token);
  if (!g) fail(404, INVITE_INVALID);
  return g;
}

// Sin sesión solo muestra a qué grupo te invitaron; con sesión, también la lista de nombres.
app.get(
  '/api/invites/:token',
  wrap(async (req, res) => {
    const g = await findGroupByInvite(db, req.params.token);
    const out = {
      groupId: g.id,
      groupName: g.name,
      eventDate: g.event_date,
      organizerName: await organizerName(g.id, g.organizer_id),
    };
    if (req.user) {
      const rows = await db.all(
        'SELECT id, display_name, user_id FROM members WHERE group_id = ? ORDER BY lower(display_name), id',
        g.id
      );
      const mine = rows.find((r) => r.user_id === req.user.id);
      out.myName = mine ? mine.display_name : null;
      out.names = rows.map((r) => ({ id: r.id, name: r.display_name, taken: !!r.user_id }));
    }
    res.json(out);
  })
);

app.post(
  '/api/invites/:token/claim',
  requireUser,
  wrap(async (req, res) => {
    const memberId = Number(req.body && req.body.memberId);
    if (!Number.isSafeInteger(memberId) || memberId <= 0) fail(400, 'Elige tu nombre de la lista.');
    const result = await db.transaction(async (tx) => {
      const g = await findGroupByInvite(tx, req.params.token);
      // FOR UPDATE: si dos personas eligen el mismo nombre a la vez, solo una gana.
      const m = await tx.get('SELECT id, display_name, user_id FROM members WHERE id = ? AND group_id = ? FOR UPDATE', memberId, g.id);
      if (!m) fail(404, 'Ese nombre ya no está en el intercambio. Recarga la página.');
      if (m.user_id === req.user.id) return { groupId: g.id, name: m.display_name };
      if (m.user_id) {
        fail(409, `Alguien más ya eligió “${m.display_name}”. Si ese es tu nombre, avísale a quien organiza para que lo libere.`);
      }
      const mine = await tx.get('SELECT display_name FROM members WHERE group_id = ? AND user_id = ?', g.id, req.user.id);
      if (mine) fail(409, `Ya estás en este intercambio como ${mine.display_name}. Cada cuenta puede elegir un solo nombre.`);
      await tx.run('UPDATE members SET user_id = ?, joined_at = now() WHERE id = ?', req.user.id, m.id);
      return { groupId: g.id, name: m.display_name };
    });
    res.json(result);
  })
);

// ---- Sorteo (solo organizador) ----
// Baraja a todos (Fisher–Yates con crypto) y forma un solo círculo:
// cada quien le regala al siguiente. Nadie se toca a sí mismo y no hay
// parejas que se regalen entre ellas.
function drawCircle(ids) {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.map((giver, i) => [giver, a[(i + 1) % a.length]]);
}

app.post(
  '/api/groups/:id/draw',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    await db.transaction(async (tx) => {
      // Se vuelve a leer dentro de la transacción para evitar dos sorteos a la vez.
      const g = await tx.get('SELECT drawn_at FROM gift_groups WHERE id = ? FOR UPDATE', a.g.id);
      if (g.drawn_at) fail(409, 'El sorteo ya se hizo.');
      const ids = (await tx.all('SELECT id FROM members WHERE group_id = ?', a.g.id)).map((r) => r.id);
      if (ids.length < 3) fail(400, 'Se necesitan al menos 3 participantes para sortear.');
      for (const [giver, receiver] of drawCircle(ids)) {
        await tx.run('UPDATE members SET receiver_id = ? WHERE id = ?', receiver, giver);
      }
      await tx.run('UPDATE gift_groups SET drawn_at = now() WHERE id = ?', a.g.id);
    });
    res.json({ ok: true });
  })
);

app.post(
  '/api/groups/:id/draw/reset',
  requireUser,
  wrap(async (req, res) => {
    const a = await groupAccess(idParam(req.params.id), req.user);
    requireOrganizer(a);
    await db.transaction(async (tx) => {
      await tx.run('UPDATE members SET receiver_id = NULL WHERE group_id = ?', a.g.id);
      await tx.run('UPDATE gift_groups SET drawn_at = NULL WHERE id = ?', a.g.id);
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Wishlist
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024, files: 1, fields: 10 },
});

// Revisamos los primeros bytes del archivo en lugar de confiar en su extensión.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
function readPhoto(file) {
  const mime = sniffImage(file.buffer);
  if (!mime) fail(400, 'La foto debe ser JPG, PNG, WEBP o GIF.');
  return { mime, data: Buffer.from(file.buffer), ver: crypto.randomBytes(4).toString('hex') };
}

function itemFields(body) {
  return {
    name: str(body.name, 'el nombre del regalo', { max: 120, required: true }),
    cost: money(body.cost, 'El costo'),
    link: link(body.link),
  };
}

async function itemAccess(itemId, user) {
  const item = await db.get(
    `SELECT w.id, w.member_id, w.photo_ver, m.user_id AS owner_id, m.group_id
     FROM wishlist_items w JOIN members m ON m.id = w.member_id WHERE w.id = ?`,
    itemId
  );
  if (!item) fail(404, 'Ese regalo no existe.');
  const isOwner = item.owner_id === user.id;
  const isGiver =
    !isOwner &&
    !!(await db.get(
      'SELECT 1 FROM members WHERE group_id = ? AND user_id = ? AND receiver_id = ?',
      item.group_id,
      user.id,
      item.member_id
    ));
  if (!isOwner && !isGiver) fail(404, 'Ese regalo no existe.');
  return { item, isOwner };
}

app.post(
  '/api/groups/:id/wishlist',
  requireUser,
  upload.single('photo'),
  wrap(async (req, res) => {
    const { me } = await groupAccess(idParam(req.params.id), req.user);
    if (!me) fail(403, 'No participas en este intercambio, así que no tienes wishlist aquí.');
    const f = itemFields(req.body || {});
    const { n } = await db.get('SELECT COUNT(*)::int AS n FROM wishlist_items WHERE member_id = ?', me.id);
    if (n >= MAX_ITEMS) fail(400, `Máximo ${MAX_ITEMS} regalos en tu wishlist.`);
    const photo = req.file ? readPhoto(req.file) : null;
    await db.run(
      `INSERT INTO wishlist_items (member_id, name, cost, link, photo_mime, photo_data, photo_ver, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM wishlist_items WHERE member_id = ?))`,
      me.id,
      f.name,
      f.cost,
      f.link,
      photo ? photo.mime : null,
      photo ? photo.data : null,
      photo ? photo.ver : null,
      me.id
    );
    res.status(201).json({ ok: true });
  })
);

// Ordenar la wishlist por preferencia: recibe todos los ids en el nuevo orden.
app.put(
  '/api/groups/:id/wishlist/order',
  requireUser,
  wrap(async (req, res) => {
    const { me } = await groupAccess(idParam(req.params.id), req.user);
    if (!me) fail(403, 'No participas en este intercambio, así que no tienes wishlist aquí.');
    const raw = req.body && req.body.ids;
    if (!Array.isArray(raw) || raw.length > MAX_ITEMS) fail(400, 'Orden inválido.');
    const ids = raw.map(Number);
    if (ids.some((n) => !Number.isSafeInteger(n))) fail(400, 'Orden inválido.');
    await db.transaction(async (tx) => {
      const current = (await tx.all('SELECT id FROM wishlist_items WHERE member_id = ? FOR UPDATE', me.id)).map((r) => r.id);
      const same = ids.length === current.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
      if (!same) fail(409, 'Tu wishlist cambió mientras la ordenabas. Recarga la página e intenta de nuevo.');
      for (let i = 0; i < ids.length; i++) {
        await tx.run('UPDATE wishlist_items SET position = ? WHERE id = ? AND member_id = ?', i + 1, ids[i], me.id);
      }
    });
    res.json({ ok: true });
  })
);

app.patch(
  '/api/wishlist/:itemId',
  requireUser,
  upload.single('photo'),
  wrap(async (req, res) => {
    const { item, isOwner } = await itemAccess(idParam(req.params.itemId), req.user);
    if (!isOwner) fail(403, 'Solo puedes editar tu propia wishlist.');
    const f = itemFields(req.body || {});
    await db.run('UPDATE wishlist_items SET name = ?, cost = ?, link = ? WHERE id = ?', f.name, f.cost, f.link, item.id);
    if (req.file) {
      const p = readPhoto(req.file);
      await db.run('UPDATE wishlist_items SET photo_mime = ?, photo_data = ?, photo_ver = ? WHERE id = ?', p.mime, p.data, p.ver, item.id);
    } else if (req.body.removePhoto === 'true') {
      await db.run('UPDATE wishlist_items SET photo_mime = NULL, photo_data = NULL, photo_ver = NULL WHERE id = ?', item.id);
    }
    res.json({ ok: true });
  })
);

app.delete(
  '/api/wishlist/:itemId',
  requireUser,
  wrap(async (req, res) => {
    const { item, isOwner } = await itemAccess(idParam(req.params.itemId), req.user);
    if (!isOwner) fail(403, 'Solo puedes borrar regalos de tu propia wishlist.');
    await db.run('DELETE FROM wishlist_items WHERE id = ?', item.id);
    res.json({ ok: true });
  })
);

// Las fotos solo las ve su dueño y la persona a la que le tocó regalarle.
app.get(
  '/api/wishlist/:itemId/photo',
  requireUser,
  wrap(async (req, res) => {
    const { item } = await itemAccess(idParam(req.params.itemId), req.user);
    const row = item.photo_ver && (await db.get('SELECT photo_mime, photo_data FROM wishlist_items WHERE id = ?', item.id));
    if (!row || !row.photo_data) fail(404, 'Ese regalo no tiene foto.');
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(row.photo_mime).send(Buffer.from(row.photo_data));
  })
);

// ---------------------------------------------------------------------------
// Archivos estáticos y errores
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
// En Vercel la carpeta public/ la sirve su CDN; esto es para correrlo localmente.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `La foto pesa más de ${MAX_PHOTO_MB} MB.` : 'No se pudo subir la foto.';
    return res.status(400).json({ error: msg });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud inválida.' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Ese cambio choca con otro participante. Recarga la página e intenta de nuevo.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Algo falló en el servidor. Intenta de nuevo.' });
});

// Localmente arranca el servidor; en Vercel se usa la app exportada.
if (require.main === module) {
  app.listen(PORT, () => console.log(`🎁 Intercambio navideño en http://localhost:${PORT}`));
}

module.exports = app;
