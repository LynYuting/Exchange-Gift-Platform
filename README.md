# 🎁 Intercambio navideño

Plataforma sencilla para organizar intercambios de regalos.

- El organizador crea un grupo y registra a cada participante con **nombre** y **correo**.
- Cada persona entra con **su cuenta de Google**; el correo la vincula a sus grupos, pero el nombre que se muestra es **el que puso el organizador**.
- La barra lateral muestra todos los grupos en los que está la persona.
- En cada grupo ve una etiqueta **De: (su nombre) / Para: (a quién le regala)**, y abajo a los demás participantes con **Para: \*\*\***.
- **Nadie ve las asignaciones de los demás, ni el organizador.** El servidor nunca las envía.
- Cada quien arma su **wishlist** (nombre, costo, link y foto). Solo la ve la persona a la que le tocó regalarle, y cada quien ve la wishlist de su asignado.

---

## 1. Requisitos

- Node.js **22 o más reciente** (`node --version`)

## 2. Crear el ID de cliente de Google

1. Entra a <https://console.cloud.google.com/> y crea un proyecto (o usa uno existente).
2. Abre **Google Auth Platform** (antes "Pantalla de consentimiento de OAuth"):
   - **Branding**: nombre de la app y correo de soporte.
   - **Audience**: tipo **External**. Pulsa **Publish app** para que cualquier cuenta de Google pueda entrar. Como solo se pide correo y perfil, no necesita verificación de Google.
3. Ve a **Clients → Create client**:
   - Tipo: **Web application**
   - **Authorized JavaScript origins**:
     - `http://localhost`
     - `http://localhost:3000`
     - Tu dirección de Vercel cuando la tengas (paso 6), por ejemplo `https://intercambio-navideno.vercel.app`
   - No necesitas "Authorized redirect URIs".
4. Copia el **Client ID** (termina en `.apps.googleusercontent.com`).

## 3. Correrlo en tu computadora

```bash
cd intercambio-navideno
npm install
cp .env.example .env      # en Windows: copy .env.example .env
```

Edita `.env` y pega tu ID:

```env
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
```

```bash
npm start
```

Abre <http://localhost:3000>. Sin cadena de conexión, la app usa **PGlite** (un Postgres guardado en `data/pgdata`), así que no necesitas instalar nada. Si prefieres probar contra tu base de Neon o Supabase, pon su cadena en `DATABASE_URL` dentro de `.env`.

**Probar sin Google:** agrega `DEV_LOGIN=true` al `.env` y reinicia. Aparece un campo para entrar con cualquier correo; usa ventanas de incógnito para simular a cada participante. En Vercel este modo se ignora siempre.

---

## 4. Subirlo a GitHub (o GitLab)

1. Crea un repositorio **vacío** (sin README ni licencia) en GitHub o GitLab.
2. En la terminal, dentro de la carpeta del proyecto:

```bash
git init
git add .
git commit -m "Intercambio navideño"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

- Si el commit dice *"Please tell me who you are"*: `git config --global user.name "Tu nombre"` y `git config --global user.email "tu@correo.com"`, y repite el commit.
- Si pide contraseña, usa un **token**, no tu contraseña normal. En GitHub: Settings → Developer settings → Personal access tokens (o usa `gh auth login`). En GitLab: Avatar → Edit profile → Access → Personal access tokens, con permiso `write_repository`.
- El `.gitignore` ya excluye `.env`, `node_modules/` y `data/`: tus claves y la base local no se suben.

---

## 5. Elegir la base de datos: Neon (recomendado) o Supabase

Vercel no guarda archivos entre peticiones, así que en producción todo (incluidas las fotos) vive en PostgreSQL. La app funciona igual con cualquiera de los dos; las tablas se crean solas la primera vez que alguien la abre.

| | Neon (gratis) | Supabase (gratis) |
|---|---|---|
| Si nadie entra en días | Se duerme a los 5 min y despierta sola en la siguiente visita | **Se pausa tras 1 semana sin uso** y hay que reactivarla a mano |
| Espacio | 1 GB por proyecto | 500 MB por proyecto |
| Certificado SSL | Público, se verifica solo | Propio de Supabase (ver abajo) |

Para un intercambio, donde la gente entra unos días y luego deja pasar semanas, **Neon** es más cómodo: nunca se queda apagada. Con unas 150 KB por foto, el espacio alcanza para miles de regalos en cualquiera de los dos.

### Opción A: Neon (lo más fácil)

Desde Vercel, después de importar el proyecto (paso 6):

1. En tu proyecto de Vercel → pestaña **Storage** → **Create Database** → **Neon**.
2. Elige región **US East (Washington D.C.)**, que es donde Vercel corre las funciones por defecto, y conéctala a tu proyecto.
3. Vercel agrega solo la variable **`DATABASE_URL`** (conexión con pooling). No tienes que copiar nada.

O a mano: crea un proyecto en <https://neon.com> (región AWS us-east), pulsa **Connect**, copia la cadena **con pooling** (el host lleva `-pooler`) y ponla en Vercel como `DATABASE_URL`.

### Opción B: Supabase

1. Crea un proyecto en <https://supabase.com> (región East US). Guarda la contraseña de la base de datos.
2. Pulsa **Connect** → copia la cadena del **Transaction pooler** (puerto **6543**) y reemplaza `[YOUR-PASSWORD]` por tu contraseña.
3. Ponla en Vercel como **`POSTGRES_URL`**. Si usas la integración de Supabase en el Marketplace de Vercel, esa variable se agrega sola.
4. Opcional, para verificar el certificado: en Supabase → Database Settings → SSL Configuration descarga el certificado y pega su contenido completo en una variable **`DATABASE_CA_CERT`**. Sin ella, la conexión va cifrada pero sin verificar el certificado.

La app activa **Row Level Security** en sus tablas: así la API REST pública de Supabase no puede leerlas, ni siquiera con la llave pública del proyecto.

---

## 6. Publicar en Vercel

1. Entra a <https://vercel.com> con tu cuenta de **GitHub** o **GitLab**.
2. **Add New → Project → Import Git Repository** y elige tu repositorio.
3. Vercel detecta **Express** solo. No cambies los comandos de build.
4. En **Environment Variables** agrega `GOOGLE_CLIENT_ID` con tu Client ID de Google (y `POSTGRES_URL` si usas Supabase a mano).
5. **Deploy**. Luego conecta la base de datos (paso 5) y haz **Redeploy** para que tome las variables nuevas.
6. Copia la dirección de producción (por ejemplo `https://intercambio-navideno.vercel.app`).
7. Regresa a Google Cloud → tu cliente → **Authorized JavaScript origins** → agrega esa dirección (sin `/` al final) y guarda. Puede tardar unos minutos en aplicarse.
8. Abre la dirección, entra con Google y crea tu primer intercambio.

**Actualizaciones:** cada `git push` a `main` vuelve a publicar solo. Las ramas generan "previews" con otra dirección; el botón de Google solo funciona en las direcciones que registraste, así que usa la de producción para el grupo.

**Si cambias una variable de entorno** en Vercel, haz **Redeploy** para que tome efecto.

---

## 7. Cómo se usa

1. **Organizador**: entra → **Crear intercambio** → nombre, fecha, presupuesto y la lista de personas (nombre + correo de Google). Ya apareces en la lista; si solo vas a organizar, quítate.
2. Comparte el enlace. Cada quien entra con el Google de ese correo y el grupo le aparece solo.
3. Cuando estén todos (mínimo 3), el organizador pulsa **Hacer el sorteo**.
4. Cada participante ve a quién le regala, agrega ideas a su wishlist y revisa la de su asignado.

El organizador puede cambiar nombres y correos en cualquier momento. Para agregar o quitar personas después del sorteo debe **reiniciar el sorteo** (las wishlists se conservan).

**El sorteo:** se barajan los participantes con un generador aleatorio criptográfico y se forma un solo círculo; cada quien le regala al siguiente. Nadie se toca a sí mismo y no hay parejas que se regalen entre ellas.

---

## 8. Privacidad y seguridad

- La API solo devuelve **tu** asignación. Los demás llegan sin ningún dato de a quién le regalan; en pantalla se ven como `***`.
- Los correos de los participantes solo los ve el organizador (él los registró).
- Las wishlists y sus fotos solo las pueden pedir su dueño y la persona a la que le tocó regalarle. Las fotos se guardan en la base de datos y se sirven con verificación de sesión, nunca como enlaces públicos.
- El inicio de sesión verifica el token de Google en el servidor y exige correo verificado.
- Cookie de sesión `HttpOnly` + `Secure` + `SameSite=Lax`, protección CSRF, CSP estricta y límite de intentos de inicio de sesión.
- Las fotos se validan por su contenido (JPG, PNG, WEBP o GIF, máx. 4 MB; Vercel acepta hasta 4.5 MB por petición). El navegador las reduce a 1200 px antes de subirlas.

> Nota honesta: quien tenga acceso a la base de datos (tu cuenta de Neon/Supabase o la carpeta `data/`) sí podría leer las asignaciones. Si el organizador administra la base de datos, el grupo tiene que confiar en que no la abrirá.

---

## 9. Estructura

```
intercambio-navideno/
├── server.js          # API, inicio de sesión con Google, sorteo, wishlist (exporta la app para Vercel)
├── db.js              # PostgreSQL: Neon/Supabase en la nube o PGlite local
├── vercel.json        # encabezados de seguridad para los archivos de public/
├── public/            # interfaz; en Vercel la sirve su CDN
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── fonts/         # Young Serif y Figtree (licencia SIL OFL)
├── .env.example
└── data/              # solo local (PGlite): se crea solo
```

### API

| Método | Ruta | Quién |
|---|---|---|
| POST | `/api/auth/google` | cualquiera (token de Google) |
| POST | `/api/auth/logout` | con sesión |
| GET | `/api/me` | cualquiera |
| GET / POST | `/api/groups` | con sesión |
| GET | `/api/groups/:id` | participantes y organizador |
| PATCH / DELETE | `/api/groups/:id` | organizador |
| POST | `/api/groups/:id/members` | organizador (antes del sorteo) |
| PATCH / DELETE | `/api/groups/:id/members/:mid` | organizador |
| POST | `/api/groups/:id/draw` y `/draw/reset` | organizador |
| POST | `/api/groups/:id/wishlist` | participante |
| PATCH / DELETE | `/api/wishlist/:itemId` | dueño del regalo |
| GET | `/api/wishlist/:itemId/photo` | dueño o quien le regala |

Toda petición que no sea GET debe incluir el encabezado `X-Requested-With: intercambio` (la interfaz ya lo hace).
