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
// Dirección pública principal. En Vercel sale sola de VERCEL_PROJECT_PRODUCTION_URL;
// los enlaces de invitación siempre apuntan aquí (las otras direcciones de Vercel están
// protegidas y quien no tiene cuenta de Vercel recibe un error 401).
const PUBLIC_URL = (
  process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
)
  .trim()
  .replace(/\/+$/, '');
// Días que un dispositivo queda recordado después de entrar con Google. Durante ese
// tiempo se entra directo (también después de "Salir"); al terminar, hay que volver a
// entrar con Google. Se puede cambiar con la variable REMEMBER_DAYS.
const REMEMBER_DAYS = Math.min(Math.max(Number(process.env.REMEMBER_DAYS) || 14, 1), 180);
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
// Idioma de los mensajes: el que manda la interfaz (X-Lang); si no, el del navegador.
const LANGS = ['es', 'en'];
app.use((req, res, next) => {
  const h = String(req.get('X-Lang') || '').toLowerCase();
  req.lang = LANGS.includes(h) ? h : /^en\b/i.test(req.get('Accept-Language') || '') ? 'en' : 'es';
  next();
});
const tr = (req, es, en) => (req.lang === 'en' ? en : es);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Protección CSRF: toda petición que modifica datos debe traer este encabezado,
// que un sitio ajeno no puede enviar sin pasar por CORS.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'intercambio') {
    return res.status(403).json({ error: tr(req, 'Solicitud no permitida.', 'Request not allowed.') });
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
  message: (req) => ({
    error: tr(req, 'Demasiados intentos de inicio de sesión. Espera unos minutos.', 'Too many sign-in attempts. Please wait a few minutes.'),
  }),
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, es, en) {
    super(es);
    this.status = status;
    this.en = en || es;
  }
}
// fail(estado, 'mensaje en español', 'message in English')
const fail = (status, es, en) => {
  throw new HttpError(status, es, en);
};
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Las etiquetas van en los dos idiomas, por ejemplo ['la fecha', 'the date'].
function str(v, [es, en], { max = 100, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(400, `Valor inválido en ${es}.`, `Invalid value for ${en}.`);
  v = v.trim().replace(/\s+/g, ' ');
  if (required && !v) fail(400, `Falta ${es}.`, `${cap(en)} is required.`);
  if (v.length > max) fail(400, `${cap(es)} es demasiado largo (máx. ${max} caracteres).`, `${cap(en)} is too long (max ${max} characters).`);
  return v;
}
function longText(v, [es, en], max = 500) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(400, `Valor inválido en ${es}.`, `Invalid value for ${en}.`);
  v = v.trim();
  if (v.length > max) fail(400, `${cap(es)} es demasiado largo (máx. ${max} caracteres).`, `${cap(en)} is too long (max ${max} characters).`);
  return v;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email(v) {
  const e = str(v, ['el correo', 'the email'], { max: 254, required: true }).toLowerCase();
  if (!EMAIL_RE.test(e)) fail(400, `“${e}” no es un correo válido.`, `“${e}” is not a valid email.`);
  return e;
}
// Correo opcional: vacío → null.
function optEmail(v) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  return email(v);
}
const newInviteToken = () => crypto.randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const INVITE_INVALID = [
  'Este enlace ya no es válido. Pídele el enlace actual a quien organiza el intercambio.',
  'This link is no longer valid. Ask the organizer for the current link.',
];
const nameKey = (s) => s.toLocaleLowerCase('es');

function money(v, [es, en]) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e8) fail(400, `${es} debe ser un número positivo.`, `${en} must be a positive number.`);
  return Math.round(n * 100) / 100;
}
function link(v) {
  const s = str(v, ['el link', 'the link'], { max: 2000 });
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    fail(400, 'El link no es una dirección web válida.', 'The link is not a valid web address.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) fail(400, 'El link debe empezar con http:// o https://', 'The link must start with http:// or https://');
  return u.toString();
}
function isoDate(v) {
  const s = str(v, ['la fecha', 'the date'], { max: 10 });
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(400, 'La fecha no es válida.', 'The date is not valid.');
  return s;
}
function currency(v) {
  const c = str(v, ['la moneda', 'the currency'], { max: 3 }).toUpperCase() || 'MXN';
  if (!CURRENCIES.includes(c)) fail(400, 'Moneda no soportada.', 'Unsupported currency.');
  return c;
}
function idParam(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== String(v)) fail(404, 'No encontrado.', 'Not found.');
  return n;
}

// Configuración pública: no necesita la base de datos, así la pantalla de entrada no espera.
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, devLogin: DEV_LOGIN, publicUrl: PUBLIC_URL || null, rememberDays: REMEMBER_DAYS });
});

// Espera a que existan las tablas antes de atender cualquier otra petición de la API.
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

const REMEMBER_MS = REMEMBER_DAYS * 24 * 60 * 60 * 1000;
const cookieOpts = (expires) => ({ httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/', expires });

// Sesión: dura hasta que vence el dispositivo (o hasta "Salir").
async function startSession(req, res, userId, expires) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM sessions WHERE expires_at < now()'); // limpieza
  if (req.cookies.sid) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(req.cookies.sid));
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  res.cookie('sid', token, cookieOpts(expires));
}

// Dispositivo de confianza: se crea al entrar con Google y dura REMEMBER_DAYS.
async function trustDevice(req, res, userId, expires) {
  await db.run('DELETE FROM devices WHERE expires_at < now()'); // limpieza
  if (req.cookies.device) await db.run('DELETE FROM devices WHERE token_hash = ?', sha256(req.cookies.device)); // reemplaza el anterior
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('INSERT INTO devices (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  res.cookie('device', token, cookieOpts(expires));
}

async function deviceOf(req) {
  if (!req.cookies.device) return null;
  return db.get('SELECT user_id, expires_at FROM devices WHERE token_hash = ? AND expires_at > now()', sha256(req.cookies.device));
}

// Entrar con Google (o el modo de prueba): dispositivo de confianza + sesión.
async function signIn(req, res, user) {
  const until = new Date(Date.now() + REMEMBER_MS);
  await startSession(req, res, user.id, until);
  await trustDevice(req, res, user.id, until);
  res.json({ user: publicUser(user), rememberUntil: until });
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
  req.user ? next() : res.status(401).json({ error: tr(req, 'Inicia sesión para continuar.', 'Please sign in to continue.') });

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

app.post(
  '/api/auth/google',
  authLimiter,
  wrap(async (req, res) => {
    if (!GOOGLE_CLIENT_ID) fail(500, 'El inicio de sesión con Google no está configurado (falta GOOGLE_CLIENT_ID).', 'Google sign-in is not configured (GOOGLE_CLIENT_ID is missing).');
    const credential = str(req.body.credential, ['la credencial', 'the credential'], { max: 5000, required: true });
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      fail(401, 'No se pudo verificar tu cuenta de Google. Intenta de nuevo.', "We couldn't verify your Google account. Please try again.");
    }
    if (!payload || !payload.email || !payload.email_verified) {
      fail(401, 'Tu cuenta de Google no tiene un correo verificado.', "Your Google account doesn't have a verified email.");
    }
    const user = await upsertUser({
      email: payload.email.toLowerCase(),
      sub: payload.sub,
      name: payload.name || null,
      picture: payload.picture || null,
    });
    await signIn(req, res, user);
  })
);

// "Continuar como …": entra directo con el dispositivo de confianza, sin pasar por Google.
app.post(
  '/api/auth/device',
  authLimiter,
  wrap(async (req, res) => {
    const d = await deviceOf(req);
    if (!d) {
      res.clearCookie('device', { path: '/' });
      fail(
        401,
        `Pasaron más de ${REMEMBER_DAYS} días desde que entraste con Google en este dispositivo. Entra de nuevo con Google.`,
        `It's been more than ${REMEMBER_DAYS} days since you signed in with Google on this device. Please sign in with Google again.`
      );
    }
    const user = await db.get('SELECT * FROM users WHERE id = ?', d.user_id);
    await startSession(req, res, user.id, new Date(d.expires_at)); // no alarga el plazo
    res.json({ user: publicUser(user), rememberUntil: d.expires_at });
  })
);

// "Usar otra cuenta de Google": este dispositivo deja de estar recordado.
app.post(
  '/api/auth/forget',
  wrap(async (req, res) => {
    if (req.cookies.device) await db.run('DELETE FROM devices WHERE token_hash = ?', sha256(req.cookies.device));
    res.clearCookie('device', { path: '/' });
    res.json({ ok: true });
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
      await signIn(req, res, user);
    })
  );
}

// "Salir": termina la sesión, pero el dispositivo sigue recordado (para "Continuar como …").
app.post(
  '/api/auth/logout',
  wrap(async (req, res) => {
    if (req.cookies.sid) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(req.cookies.sid));
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  })
);

app.get(
  '/api/me',
  wrap(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    const d = await deviceOf(req);
    res.json({ user: publicUser(req.user), rememberUntil: d && d.user_id === req.user.id ? d.expires_at : null });
  })
);

// ---------------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------------
async function groupAccess(groupId, user) {
  const g = await db.get('SELECT * FROM gift_groups WHERE id = ?', groupId);
  // Respondemos 404 (no 403) para no revelar que el grupo existe.
  if (!g) fail(404, 'Ese grupo no existe o no formas parte de él.', "That exchange doesn't exist or you're not part of it.");
  const me = await db.get('SELECT * FROM members WHERE group_id = ? AND user_id = ?', g.id, user.id);
  const isOrganizer = g.organizer_id === user.id;
  if (!me && !isOrganizer) fail(404, 'Ese grupo no existe o no formas parte de él.', "That exchange doesn't exist or you're not part of it.");
  return { g, me, isOrganizer };
}
const requireOrganizer = (a) => {
  if (!a.isOrganizer) fail(403, 'Solo quien organiza el grupo puede hacer esto.', 'Only the organizer can do this.');
};
const requireNotDrawn = (g) => {
  if (g.drawn_at) fail(409, 'El sorteo ya se hizo. Reinícialo primero para cambiar quién participa.', 'The draw is already done. Reset it first to change who takes part.');
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
  if (clash) fail(409, `Ya hay alguien llamado “${name}” en este intercambio. Usa un nombre distinto, por ejemplo con apellido.`, `There's already someone called “${name}” in this exchange. Use a different name, for example with a last name.`);
}

async function assertEmailFree(q, groupId, mail, exceptId = 0) {
  const clash = await q.get('SELECT 1 FROM members WHERE group_id = ? AND email = ? AND id <> ?', groupId, mail, exceptId);
  if (clash) fail(409, `El correo ${mail} ya está registrado para otra persona de este intercambio.`, `The email ${mail} is already registered for someone else in this exchange.`);
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
    const name = str(b.name, ['el nombre del grupo', 'the group name'], { max: 80, required: true });
    const description = longText(b.description, ['la descripción', 'the description']);
    const budget = money(b.budget, ['El presupuesto', 'The budget']);
    const cur = currency(b.currency);
    const eventDate = isoDate(b.eventDate);
    // El organizador puede participar (queda ligado a su nombre desde el inicio) o solo organizar.
    const me = b.me && typeof b.me === 'object' && b.me.participate ? str(b.me.name, ['tu nombre', 'your name'], { max: 60, required: true }) : null;
    const list = Array.isArray(b.participants) ? b.participants : [];
    if (list.length + (me ? 1 : 0) > MAX_MEMBERS) fail(400, `Máximo ${MAX_MEMBERS} participantes por grupo.`, `Maximum ${MAX_MEMBERS} participants per exchange.`);
    const seenNames = new Set();
    const seenEmails = new Set();
    const addName = (n) => {
      if (seenNames.has(nameKey(n))) fail(400, `El nombre “${n}” está repetido. Usa nombres distintos para que cada quien encuentre el suyo.`, `The name “${n}” is repeated. Use different names so everyone can find theirs.`);
      seenNames.add(nameKey(n));
    };
    if (me) addName(me);
    const participants = list.map((p) => {
      const pName = str(p && p.name, ['el nombre del participante', 'the participant name'], { max: 60, required: true });
      addName(pName);
      const pEmail = optEmail(p && p.email); // opcional, por compatibilidad
      if (pEmail && seenEmails.has(pEmail)) fail(400, `El correo ${pEmail} está repetido.`, `The email ${pEmail} is repeated.`);
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
      `SELECT m.id, m.display_name, m.user_id, m.email, u.email AS account
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
        ...(isOrganizer ? { account: m.account, email: m.email } : {}),
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
      name: 'name' in b ? str(b.name, ['el nombre del grupo', 'the group name'], { max: 80, required: true }) : a.g.name,
      description: 'description' in b ? longText(b.description, ['la descripción', 'the description']) : a.g.description,
      budget: 'budget' in b ? money(b.budget, ['El presupuesto', 'The budget']) : a.g.budget,
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
    const name = str(req.body.name, ['el nombre', 'the name'], { max: 60, required: true });
    const mail = optEmail(req.body.email);
    const { n } = await db.get('SELECT COUNT(*)::int AS n FROM members WHERE group_id = ?', a.g.id);
    if (n >= MAX_MEMBERS) fail(400, `Máximo ${MAX_MEMBERS} participantes por grupo.`, `Maximum ${MAX_MEMBERS} participants per exchange.`);
    await assertNameFree(db, a.g.id, name);
    if (mail) await assertEmailFree(db, a.g.id, mail);
    await db.run('INSERT INTO members (group_id, display_name, email) VALUES (?, ?, ?)', a.g.id, name, mail);
    await linkGroupByEmail(a.g.id); // si esa cuenta ya existe, queda ligada de una vez
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
    if (!m) fail(404, 'Ese participante no existe.', "That participant doesn't exist.");
    const name = 'name' in req.body ? str(req.body.name, ['el nombre', 'the name'], { max: 60, required: true }) : m.display_name;
    const mail = 'email' in req.body ? optEmail(req.body.email) : m.email;
    await assertNameFree(db, a.g.id, name, m.id);
    if (mail && mail !== m.email) await assertEmailFree(db, a.g.id, mail, m.id);
    // Cambiar el correo no desliga a quien ya entró; para eso está "Liberar".
    await db.run('UPDATE members SET display_name = ?, email = ? WHERE id = ?', name, mail, m.id);
    await linkGroupByEmail(a.g.id);
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
    if (!m) fail(404, 'Ese participante no existe.', "That participant doesn't exist.");
    // Si el correo registrado es el de la cuenta que se libera, se borra (si no, se volvería
    // a ligar sola). Si es otro, se conserva y esa persona queda ligada en cuanto entre.
    await db.run(
      `UPDATE members SET user_id = NULL, joined_at = NULL,
         email = CASE WHEN email = (SELECT u.email FROM users u WHERE u.id = members.user_id) THEN NULL ELSE email END
       WHERE id = ?`,
      m.id
    );
    await linkGroupByEmail(a.g.id);
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
    if (!m) fail(404, 'Ese participante no existe.', "That participant doesn't exist.");
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
  if (!TOKEN_RE.test(String(token))) fail(404, ...INVITE_INVALID);
  const g = await q.get('SELECT id, name, organizer_id, event_date FROM gift_groups WHERE invite_token = ?', token);
  if (!g) fail(404, ...INVITE_INVALID);
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
        'SELECT id, display_name, user_id, email FROM members WHERE group_id = ? ORDER BY lower(display_name), id',
        g.id
      );
      const mine = rows.find((r) => r.user_id === req.user.id);
      out.myName = mine ? mine.display_name : null;
      // Un nombre con correo registrado solo lo puede tomar esa cuenta (entra sola, sin elegir).
      // No se envía el correo, solo que está reservado.
      out.names = rows.map((r) => ({
        id: r.id,
        name: r.display_name,
        taken: !!r.user_id,
        reserved: !r.user_id && !!r.email && r.email !== req.user.email,
      }));
    }
    res.json(out);
  })
);

app.post(
  '/api/invites/:token/claim',
  requireUser,
  wrap(async (req, res) => {
    const memberId = Number(req.body && req.body.memberId);
    if (!Number.isSafeInteger(memberId) || memberId <= 0) fail(400, 'Elige tu nombre de la lista.', 'Pick your name from the list.');
    const result = await db.transaction(async (tx) => {
      const g = await findGroupByInvite(tx, req.params.token);
      // FOR UPDATE: si dos personas eligen el mismo nombre a la vez, solo una gana.
      const m = await tx.get('SELECT id, display_name, user_id, email FROM members WHERE id = ? AND group_id = ? FOR UPDATE', memberId, g.id);
      if (!m) fail(404, 'Ese nombre ya no está en el intercambio. Recarga la página.', 'That name is no longer in the exchange. Reload the page.');
      if (m.user_id === req.user.id) return { groupId: g.id, name: m.display_name };
      if (m.user_id) {
        fail(409, `Alguien más ya eligió “${m.display_name}”. Si ese es tu nombre, avísale a quien organiza para que lo libere.`, `Someone else already picked “${m.display_name}”. If that's your name, ask the organizer to release it.`);
      }
      if (m.email && m.email !== req.user.email) {
        fail(409, `“${m.display_name}” está reservado para otra cuenta de Google. Si eres tú, entra con el correo que registró quien organiza, o pídele que lo cambie.`, `“${m.display_name}” is reserved for another Google account. If it's you, sign in with the email the organizer registered, or ask them to change it.`);
      }
      const mine = await tx.get('SELECT display_name FROM members WHERE group_id = ? AND user_id = ?', g.id, req.user.id);
      if (mine) fail(409, `Ya estás en este intercambio como ${mine.display_name}. Cada cuenta puede elegir un solo nombre.`, `You're already in this exchange as ${mine.display_name}. Each account can pick only one name.`);
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
      if (g.drawn_at) fail(409, 'El sorteo ya se hizo.', 'The draw is already done.');
      const ids = (await tx.all('SELECT id FROM members WHERE group_id = ?', a.g.id)).map((r) => r.id);
      if (ids.length < 3) fail(400, 'Se necesitan al menos 3 participantes para sortear.', 'You need at least 3 participants to do the draw.');
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
  if (!mime) fail(400, 'La foto debe ser JPG, PNG, WEBP o GIF.', 'The photo must be JPG, PNG, WEBP or GIF.');
  return { mime, data: Buffer.from(file.buffer), ver: crypto.randomBytes(4).toString('hex') };
}

function itemFields(body) {
  return {
    name: str(body.name, ['el nombre del regalo', 'the gift name'], { max: 120, required: true }),
    cost: money(body.cost, ['El costo', 'The cost']),
    link: link(body.link),
  };
}

async function itemAccess(itemId, user) {
  const item = await db.get(
    `SELECT w.id, w.member_id, w.photo_ver, m.user_id AS owner_id, m.group_id
     FROM wishlist_items w JOIN members m ON m.id = w.member_id WHERE w.id = ?`,
    itemId
  );
  if (!item) fail(404, 'Ese regalo no existe.', "That gift doesn't exist.");
  const isOwner = item.owner_id === user.id;
  const isGiver =
    !isOwner &&
    !!(await db.get(
      'SELECT 1 FROM members WHERE group_id = ? AND user_id = ? AND receiver_id = ?',
      item.group_id,
      user.id,
      item.member_id
    ));
  if (!isOwner && !isGiver) fail(404, 'Ese regalo no existe.', "That gift doesn't exist.");
  return { item, isOwner };
}

app.post(
  '/api/groups/:id/wishlist',
  requireUser,
  upload.single('photo'),
  wrap(async (req, res) => {
    const { me } = await groupAccess(idParam(req.params.id), req.user);
    if (!me) fail(403, 'No participas en este intercambio, así que no tienes wishlist aquí.', "You're not taking part in this exchange, so you don't have a wishlist here.");
    const f = itemFields(req.body || {});
    const { n } = await db.get('SELECT COUNT(*)::int AS n FROM wishlist_items WHERE member_id = ?', me.id);
    if (n >= MAX_ITEMS) fail(400, `Máximo ${MAX_ITEMS} regalos en tu wishlist.`, `Maximum ${MAX_ITEMS} gifts in your wishlist.`);
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
    if (!me) fail(403, 'No participas en este intercambio, así que no tienes wishlist aquí.', "You're not taking part in this exchange, so you don't have a wishlist here.");
    const raw = req.body && req.body.ids;
    if (!Array.isArray(raw) || raw.length > MAX_ITEMS) fail(400, 'Orden inválido.', 'Invalid order.');
    const ids = raw.map(Number);
    if (ids.some((n) => !Number.isSafeInteger(n))) fail(400, 'Orden inválido.', 'Invalid order.');
    await db.transaction(async (tx) => {
      const current = (await tx.all('SELECT id FROM wishlist_items WHERE member_id = ? FOR UPDATE', me.id)).map((r) => r.id);
      const same = ids.length === current.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
      if (!same) fail(409, 'Tu wishlist cambió mientras la ordenabas. Recarga la página e intenta de nuevo.', 'Your wishlist changed while you were sorting it. Reload the page and try again.');
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
    if (!isOwner) fail(403, 'Solo puedes editar tu propia wishlist.', 'You can only edit your own wishlist.');
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
    if (!isOwner) fail(403, 'Solo puedes borrar regalos de tu propia wishlist.', 'You can only delete gifts from your own wishlist.');
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
    if (!row || !row.photo_data) fail(404, 'Ese regalo no tiene foto.', "That gift doesn't have a photo.");
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(row.photo_mime).send(Buffer.from(row.photo_data));
  })
);

// ---------------------------------------------------------------------------
// Archivos estáticos y errores
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: tr(req, 'No encontrado.', 'Not found.') }));
// En Vercel la carpeta public/ la sirve su CDN; esto es para correrlo localmente.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? tr(req, `La foto pesa más de ${MAX_PHOTO_MB} MB.`, `The photo is larger than ${MAX_PHOTO_MB} MB.`)
        : tr(req, 'No se pudo subir la foto.', "The photo couldn't be uploaded.");
    return res.status(400).json({ error: msg });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: tr(req, 'Solicitud inválida.', 'Invalid request.') });
  if (err instanceof HttpError) return res.status(err.status).json({ error: tr(req, err.message, err.en) });
  if (err && err.code === '23505') {
    return res.status(409).json({
      error: tr(req, 'Ese cambio choca con otro participante. Recarga la página e intenta de nuevo.', 'That change conflicts with another participant. Reload the page and try again.'),
    });
  }
  console.error(err);
  res.status(500).json({ error: tr(req, 'Algo falló en el servidor. Intenta de nuevo.', 'Something went wrong on the server. Please try again.') });
});

// Localmente arranca el servidor; en Vercel se usa la app exportada.
if (require.main === module) {
  app.listen(PORT, () => console.log(`🎁 Intercambio navideño en http://localhost:${PORT}`));
}

module.exports = app;
