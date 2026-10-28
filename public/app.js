'use strict';
/* Intercambio navideño — interfaz (JavaScript sin dependencias). */
(() => {
  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');
  const state = { config: null, user: null, groups: [], detail: null, $side: null, $main: null };

  // -------------------------------------------------------------------------
  // Idioma (español / inglés). Las traducciones están en i18n.js; la clave es el texto en español.
  // -------------------------------------------------------------------------
  const LANGS = ['es', 'en'];
  let lang = (() => {
    try {
      const saved = localStorage.getItem('idioma');
      if (LANGS.includes(saved)) return saved;
    } catch {
      /* sin almacenamiento */
    }
    return 'es';
  })();
  document.documentElement.lang = lang;
  const missing = new Set();
  /** t('Hola, {name}', { name }) → texto en el idioma actual. */
  function t(es, vars) {
    let out = es;
    if (lang === 'en') {
      const en = window.I18N_EN && window.I18N_EN[es];
      if (en === undefined) {
        if (!missing.has(es)) {
          missing.add(es);
          console.warn('[i18n] Falta traducción:', es);
        }
      } else out = en;
    }
    return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out;
  }
  const locale = () => (lang === 'en' ? 'en-US' : 'es-MX');

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------
  /** Crea elementos sin usar innerHTML con datos del usuario. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v; // vía CSSOM: permitido por la CSP
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  /** Solo para SVG estático escrito aquí mismo (nunca con datos del usuario). */
  function svg(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
  }
  const ICON_GIFT =
    '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="8" width="18" height="13" rx="1.5"/><path d="M3 12h18M12 8v13"/><path d="M12 8c-1.5-3-5-4-5.5-2S9 8 12 8zm0 0c1.5-3 5-4 5.5-2S15 8 12 8z"/></svg>';
  const ICON_X =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_PLUS =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_GRIP =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
  const ICON_UP =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  const ICON_DOWN =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const BRAND_TAG =
    '<svg width="28" height="22" viewBox="0 0 32 26" aria-hidden="true"><path d="M9 1h22v24H9L1 13z" fill="#C21F3A"/><circle cx="9" cy="13" r="2.6" fill="#17392F"/></svg>';

  async function api(path, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: { 'X-Lang': lang }, credentials: 'same-origin' };
    if (method !== 'GET') opts.headers['X-Requested-With'] = 'intercambio';
    if (form) opts.body = form;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new Error(t('No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.'));
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/me' && state.user) {
      state.user = null;
      setSessionHint(false);
      renderLogin(t('Tu sesión terminó. Vuelve a entrar.'));
    }
    if (!res.ok) {
      const err = new Error(data.error || t('Algo falló. Intenta de nuevo.'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const fmtMoney = (n, cur = 'MXN') => {
    if (n === null || n === undefined) return '';
    const digits = { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 };
    // Pesos siempre como "$500 MXN" (en inglés Intl escribiría "MX$500").
    if (cur === 'MXN') return `$${new Intl.NumberFormat(locale(), digits).format(n)} MXN`;
    return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, ...digits }).format(n);
  };
  const parseDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const fmtDate = (s) =>
    parseDate(s).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = (s) => parseDate(s).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  function countdown(s) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const n = Math.round((parseDate(s) - today) / 864e5);
    if (n > 1) return t('faltan {n} días', { n });
    if (n === 1) return t('es mañana');
    if (n === 0) return t('es hoy');
    return t('ya pasó');
  }
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return t('la tienda');
    }
  };
  const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();

  // Siempre con la dirección principal: las otras direcciones de Vercel piden cuenta de Vercel (401).
  const inviteUrl = (token) => `${(state.config && state.config.publicUrl) || location.origin}/#/unirse/${token}`;
  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      toast(t('No se pudo copiar automáticamente. Intenta de nuevo.'), 'error');
    }
  }

  function toast(msg, kind = '') {
    // Las ventanas modales tapan todo lo demás, así que el aviso va dentro de la de más arriba.
    const open = [...document.querySelectorAll('dialog[open]')];
    const host = open.length ? open[open.length - 1] : document.body;
    if ($toasts.parentNode !== host) host.append($toasts);
    const t = h('div', { class: `toast ${kind}` }, msg);
    $toasts.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 5000 : 3000);
  }

  function confirmDialog({ title, text, confirm = t('Confirmar'), danger = false }) {
    return new Promise((resolve) => {
      const dlg = h(
        'dialog',
        { class: 'confirm', 'aria-labelledby': 'dlg-title' },
        h('h2', { id: 'dlg-title' }, title),
        h('p', {}, text),
        h(
          'div',
          { class: 'dialog-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close('no') }, t('Cancelar')),
          h('button', { class: `btn ${danger ? 'btn-red' : ''}`, type: 'button', onclick: () => dlg.close('yes') }, confirm)
        )
      );
      dlg.addEventListener('close', () => {
        resolve(dlg.returnValue === 'yes');
        dlg.remove();
      });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  function showPhoto(src, caption) {
    const dlg = h(
      'dialog',
      { class: 'photo-viewer', 'aria-label': caption },
      h('figure', {}, h('img', { src, alt: caption }), h('figcaption', {}, caption)),
      h('button', { class: 'photo-close', type: 'button', 'aria-label': t('Cerrar foto'), onclick: () => dlg.close() }, svg(ICON_X))
    );
    dlg.addEventListener('close', () => dlg.remove());
    // Clic fuera de la foto la cierra.
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.tagName === 'FIGURE') dlg.close();
    });
    document.body.append(dlg);
    dlg.showModal();
  }

  /** Reduce la foto a máx. 1200 px y la convierte a JPG antes de subirla. */
  async function prepareImage(file) {
    if (!file) return null;
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      return blob ? new File([blob], 'foto.jpg', { type: 'image/jpeg' }) : file;
    } catch {
      return file; // el servidor decide si el formato es válido
    }
  }

  function busy(btn, on, text) {
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = text || t('Guardando…');
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  const storage = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* sin almacenamiento: no pasa nada */
      }
    },
    remove(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* sin almacenamiento: no pasa nada */
      }
    },
  };

  // Pista para el arranque: si este navegador ya inició sesión, mostramos "Cargando…"
  // en lugar de la pantalla de entrada mientras confirmamos la sesión.
  const SESSION_HINT = 'sesion';
  const setSessionHint = (on) => (on ? storage.set(SESSION_HINT, '1') : storage.remove(SESSION_HINT));

  // La configuración se pide una sola vez y se comparte.
  let configPromise = null;
  function getConfig() {
    if (!configPromise) {
      configPromise = api('/api/config').then((c) => (state.config = c));
      configPromise.catch(() => (configPromise = null)); // permite reintentar
    }
    return configPromise;
  }

  // -------------------------------------------------------------------------
  // Etiqueta de regalo
  // -------------------------------------------------------------------------
  function giftTag({ from, to, note, pending = false, reveal = false, single = null }) {
    const string = svg(
      `<svg class="tag-string" viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true">
        <path d="M94 35 C 66 33, 44 8, 3 14" stroke="#B8892B" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        <path d="M94 35 C 68 40, 42 62, 5 57" stroke="#B8892B" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      </svg>`
    );
    const body = single
      ? [h('p', { class: 'tag-name', style: 'border:0' }, single)]
      : [
          h('div', { class: 'tag-line' }, h('span', { class: 'tag-label' }, t('De:')), h('span', { class: 'tag-name' }, from)),
          h('div', { class: 'tag-line para' }, h('span', { class: 'tag-label' }, t('Para:')), h('span', { class: 'tag-name' }, to)),
        ];
    return h(
      'div',
      { class: 'tag-wrap' },
      string,
      h('div', { class: `tag${pending ? ' pending' : ''}${reveal ? ' reveal' : ''}` }, body, note ? h('p', { class: 'tag-note' }, note) : null)
    );
  }

  // -------------------------------------------------------------------------
  // Inicio de sesión
  // -------------------------------------------------------------------------
  let gsiPromise = null;
  function loadGoogleScript() {
    if (!gsiPromise) {
      gsiPromise = new Promise((resolve, reject) => {
        if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
        const s = document.createElement('script');
        s.src = `https://accounts.google.com/gsi/client?hl=${lang}`;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          gsiPromise = null; // permite reintentar
          s.remove();
          reject(new Error(t('No se pudo cargar el inicio de sesión de Google.')));
        };
        document.head.append(s);
      });
    }
    return gsiPromise;
  }

  // Cuenta recordada en este dispositivo. Durante los días que el servidor la recuerda
  // ("until"), "Continuar como …" entra directo, sin Google. Después, hay que pasar por Google.
  const ACCOUNT_KEY = 'cuenta';
  const SIGNED_OUT = 'salio'; // tras "Salir", Google no vuelve a entrar solo
  function rememberedAccount() {
    try {
      const a = JSON.parse(storage.get(ACCOUNT_KEY) || 'null');
      return a && a.email ? a : null;
    } catch {
      return null;
    }
  }
  const directUntil = (acct) => {
    const d = acct && acct.until ? new Date(acct.until) : null;
    return d && d.getTime() > Date.now() ? d : null;
  };
  function forgetAccount() {
    api('/api/auth/forget', { method: 'POST' }).catch(() => {}); // el servidor deja de recordar este dispositivo
    storage.remove(ACCOUNT_KEY);
    storage.remove(SIGNED_OUT);
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
  }

  function onLoggedIn(user, rememberUntil = null) {
    setSessionHint(true);
    storage.set(ACCOUNT_KEY, JSON.stringify({ email: user.email, name: user.name || '', picture: user.picture || '', until: rememberUntil || null }));
    storage.remove(SIGNED_OUT);
    state.user = user;
    startApp();
  }

  // Monta el botón de Google sin mostrar el recuadro vacío que dibuja mientras carga:
  // queda oculto (con un marcador gris en su lugar) hasta que su iframe termina de cargar.
  function mountGoogleButton(slot, clientId, err, { hint = null, auto = false } = {}) {
    loadGoogleScript()
      .then(() => {
        if (!slot.isConnected) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          // En un dispositivo ya usado (y sin haber pulsado "Salir"), Google puede entrar solo.
          auto_select: auto,
          login_hint: hint || undefined,
          itp_support: true,
          callback: async (resp) => {
            err.textContent = '';
            try {
              const { user, rememberUntil } = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } });
              onLoggedIn(user, rememberUntil);
            } catch (e) {
              err.textContent = e.message;
            }
          },
        });
        const host = h('div', { class: 'gsi-button' });
        slot.append(host);
        let shown = false;
        const reveal = () => {
          if (shown) return;
          shown = true;
          slot.classList.add('ready');
          slot.removeAttribute('aria-busy');
        };
        const watch = (frame) => frame.addEventListener('load', () => setTimeout(reveal, 80), { once: true });
        const obs = new MutationObserver(() => {
          const frame = host.querySelector('iframe');
          if (frame) {
            obs.disconnect();
            watch(frame);
          }
        });
        obs.observe(host, { childList: true, subtree: true });
        window.google.accounts.id.renderButton(host, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: hint ? 'continue_with' : 'signin_with',
          locale: lang === 'en' ? 'en' : 'es-419',
          width: 280,
        });
        const frame = host.querySelector('iframe');
        if (frame) {
          obs.disconnect();
          watch(frame);
        }
        setTimeout(() => {
          obs.disconnect();
          reveal(); // por si el iframe nunca avisa
        }, 3000);
        if (auto) window.google.accounts.id.prompt();
      })
      .catch((e) => {
        slot.remove();
        err.textContent = e.message;
      });
  }

  function devLoginForm(err) {
    const input = h('input', { class: 'input', type: 'email', placeholder: 'correo@ejemplo.com', required: true, 'aria-label': t('Correo de prueba') });
    return h(
      'div',
      { class: 'dev-login' },
      h('p', {}, t('Modo de prueba (DEV_LOGIN): entra con cualquier correo, sin Google.')),
      h(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const { user, rememberUntil } = await api('/api/auth/dev', { method: 'POST', body: { email: input.value } });
              onLoggedIn(user, rememberUntil);
            } catch (ex) {
              err.textContent = ex.message;
            }
          },
        },
        input,
        h('button', { class: 'btn', type: 'submit' }, t('Entrar'))
      )
    );
  }

  function renderLogin(message) {
    document.title = t('Intercambio navideño');
    const err = h('p', { class: 'form-error', role: 'alert' }, message || '');
    const slot = h('div', { class: 'gsi-slot', 'aria-busy': 'true' }, h('span', { class: 'gsi-placeholder', 'aria-hidden': 'true' }));
    const devBox = h('div');
    const acct = rememberedAccount();
    const until = directUntil(acct);
    const shortName = acct ? acct.name || acct.email.split('@')[0] : '';
    const avatar = () =>
      h('div', { class: 'avatar' }, acct.picture ? h('img', { src: acct.picture, alt: '', referrerpolicy: 'no-referrer' }) : initial(acct.name || acct.email));

    // Dispositivo recordado: un toque y entra, sin pasar por Google.
    let direct = null;
    if (until) {
      const label = h('strong', {}, t('Continuar como {name}', { name: shortName }));
      direct = h(
        'button',
        {
          class: 'remembered go',
          type: 'button',
          onclick: async () => {
            if (direct.disabled) return;
            direct.disabled = true;
            direct.setAttribute('aria-busy', 'true');
            label.textContent = t('Entrando…');
            err.textContent = '';
            try {
              const { user, rememberUntil } = await api('/api/auth/device', { method: 'POST' });
              onLoggedIn(user, rememberUntil);
            } catch (e) {
              if (e.status === 401) {
                // Ya no está recordado en el servidor: ahora sí, con Google.
                storage.set(ACCOUNT_KEY, JSON.stringify({ ...acct, until: null }));
                renderLogin(e.message);
              } else {
                direct.disabled = false;
                direct.removeAttribute('aria-busy');
                label.textContent = t('Continuar como {name}', { name: shortName });
                err.textContent = e.message;
              }
            }
          },
        },
        avatar(),
        h('span', { class: 'who' }, label, h('span', {}, acct.email)),
        h('span', { class: 'go-arrow', 'aria-hidden': 'true' }, '→')
      );
    }

    const actions = h(
      'div',
      { class: 'login-actions' },
      direct,
      direct
        ? h('p', { class: 'direct-note' }, t('En este dispositivo entras directo hasta el {date}. Después te pediremos entrar con Google otra vez.', { date: until.toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) }))
        : null,
      acct && !direct
        ? h('div', { class: 'remembered' }, avatar(), h('div', { class: 'who' }, h('strong', {}, t('Hola de nuevo, {name}', { name: shortName })), h('span', {}, acct.email)))
        : null,
      direct ? null : slot,
      acct
        ? h(
            'button',
            {
              class: 'btn-text',
              type: 'button',
              onclick: () => {
                forgetAccount();
                renderLogin();
              },
            },
            t('Usar otra cuenta de Google')
          )
        : null,
      devBox,
      err
    );

    getConfig()
      .then((cfg) => {
        if (!slot.isConnected) return; // ya cambió de pantalla
        if (cfg.devLogin) devBox.replaceWith(devLoginForm(err));
        if (direct) return; // entra directo: no hace falta el botón de Google
        if (cfg.googleClientId) {
          mountGoogleButton(slot, cfg.googleClientId, err, { hint: acct && acct.email, auto: !!acct && storage.get(SIGNED_OUT) !== '1' });
        }
        else {
          slot.remove();
          if (!cfg.devLogin) err.textContent = t('El servidor no tiene configurado GOOGLE_CLIENT_ID. Revisa las variables de entorno.');
        }
      })
      .catch((e) => {
        slot.remove();
        err.textContent = e.message;
      });

    // Si llegó con el enlace del grupo, le decimos a qué lo invitaron.
    const r = currentRoute();
    let banner = null;
    if (r.name === 'join') {
      banner = h('div', { class: 'invite-banner' }, t('Revisando tu invitación…'));
      api(`/api/invites/${r.token}`)
        .then((inv) =>
          banner.replaceChildren(
            h('strong', {}, t('{org} te invitó a “{group}”', { org: inv.organizerName, group: inv.groupName })),
            h('span', {}, t('Entra con la cuenta de Google que quieras usar y después elige tu nombre de la lista.'))
          )
        )
        .catch((e) => banner.replaceChildren(h('span', {}, e.message)));
    }

    $app.replaceChildren(
      h(
        'div',
        { class: 'login' },
        h(
          'section',
          { class: 'login-copy' },
          h('h1', {}, t('Intercambio navideño')),
          h('p', {}, t('Entra con tu cuenta de Google para ver a quién le regalas y qué le gustaría recibir.')),
          banner,
          actions,
          h(
            'p',
            { class: 'legal-links' },
            h('a', { href: lang === 'en' ? '/privacy.html' : '/privacidad.html' }, t('Política de privacidad')),
            h('a', { href: lang === 'en' ? '/terms.html' : '/terminos.html' }, t('Términos de servicio'))
          )
        ),
        h('div', { class: 'login-art', 'aria-hidden': 'true' }, giftTag({ from: t('Tú'), to: '***' })),
        langSwitch()
      )
    );
  }

  // Interruptor ES / EN. Cambia todo al momento y se recuerda en este dispositivo.
  function langSwitch() {
    const opt = (code, label, name) =>
      h('button', { type: 'button', class: 'lang-opt', lang: code, title: name, 'aria-pressed': String(lang === code), onclick: () => setLang(code) }, label);
    return h('div', { class: 'lang-switch', role: 'group', 'aria-label': t('Idioma') }, opt('es', 'ES', 'Español'), opt('en', 'EN', 'English'));
  }

  function setLang(code) {
    if (!LANGS.includes(code) || code === lang) return;
    lang = code;
    document.documentElement.lang = code;
    storage.set('idioma', code);
    if (state.user && state.$side) route(); // vuelve a dibujar la barra, la página y el panel si está abierto
    else renderLogin();
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* igual cerramos */
    }
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
    storage.set(SIGNED_OUT, '1');
    setSessionHint(false);
    $toasts.replaceChildren(); // los avisos de antes no se quedan en la pantalla de entrada
    state.user = null;
    state.groups = [];
    state.detail = null;
    history.replaceState(null, '', location.pathname);
    renderLogin();
  }

  // -------------------------------------------------------------------------
  // Estructura y navegación
  // -------------------------------------------------------------------------
  async function startApp() {
    state.$side = h('aside', { class: 'side', 'aria-label': t('Tus intercambios') });
    state.$main = h('div', { class: 'main-inner', id: 'main' });
    $app.replaceChildren(h('div', { class: 'shell' }, state.$side, h('main', { class: 'main' }, state.$main)));
    try {
      await loadGroups();
    } catch (e) {
      toast(e.message, 'error');
    }
    route();
  }

  async function loadGroups() {
    const { groups } = await api('/api/groups');
    state.groups = groups;
    renderSide();
  }

  function currentRoute() {
    const m = location.hash.match(/^#\/g\/(\d+)$/);
    if (m) return { name: 'group', id: Number(m[1]) };
    if (location.hash === '#/nuevo') return { name: 'create' };
    const inv = location.hash.match(/^#\/unirse\/([A-Za-z0-9_-]{16,64})$/);
    if (inv) return { name: 'join', token: inv[1] };
    return { name: 'home' };
  }

  function route() {
    if (!state.user) return;
    const r = currentRoute();
    const adminDlg = document.getElementById('admin-dialog');
    if (adminDlg && !(r.name === 'group' && state.detail && state.detail.group.id === r.id)) adminDlg.close();
    renderSide();
    if (r.name === 'create') return renderCreate();
    if (r.name === 'join') return renderJoin(r.token);
    if (r.name === 'group') return showGroup(r.id);
    if (state.groups.length) return location.replace(`#/g/${state.groups[0].id}`);
    renderWelcome();
  }
  window.addEventListener('hashchange', route);

  function renderSide() {
    const r = currentRoute();
    const u = state.user;
    const list = state.groups.length
      ? h(
          'ul',
          { class: 'group-list' },
          state.groups.map((g) => {
            const sub = [g.eventDate ? fmtShort(g.eventDate) : null, g.isOrganizer ? t('organizas') : null].filter(Boolean).join(', ');
            return h(
              'li',
              {},
              h(
                'a',
                { class: 'group-link', href: `#/g/${g.id}`, 'aria-current': r.name === 'group' && r.id === g.id ? 'page' : null },
                h('strong', {}, g.name),
                sub ? h('span', {}, sub.charAt(0).toUpperCase() + sub.slice(1)) : null
              )
            );
          })
        )
      : h('p', { class: 'side-empty' }, t('Todavía no tienes intercambios.'));

    state.$side.replaceChildren(
      h(
        'div',
        { class: 'side-top' },
        h('div', { class: 'brand' }, svg(BRAND_TAG), h('span', { class: 'brand-name' }, t('Intercambio'))),
        h(
          'div',
          { class: 'user-box' },
          h('div', { class: 'avatar' }, u.picture ? h('img', { src: u.picture, alt: '', referrerpolicy: 'no-referrer' }) : initial(u.name || u.email)),
          h('div', { class: 'who' }, h('span', {}, u.name || u.email.split('@')[0]), h('span', { class: 'email' }, u.email)),
          h('button', { class: 'btn-text', type: 'button', onclick: logout }, t('Salir'))
        ),
        langSwitch()
      ),
      h('h2', {}, t('Tus intercambios')),
      list,
      h('a', { class: 'btn btn-new', href: '#/nuevo' }, t('+ Crear intercambio'))
    );
  }

  function renderWelcome() {
    document.title = t('Intercambio navideño');
    state.$main.replaceChildren(
      h(
        'section',
        { class: 'welcome' },
        h('h1', {}, t('Aún no estás en ningún intercambio')),
        h('p', {}, t('Si alguien te invitó, abre el enlace que te mandó y elige tu nombre.')),
        h('p', {}, t('O crea uno y comparte el enlace con tu grupo.')),
        h('div', {}, h('a', { class: 'btn', href: '#/nuevo' }, t('Crear intercambio')))
      )
    );
  }

  // Pantalla a la que llega alguien con el enlace del grupo (#/unirse/TOKEN):
  // elige su nombre de la lista que escribió el organizador.
  async function renderJoin(token) {
    document.title = `${t('Invitación')} · ${t('Intercambio navideño')}`;
    state.detail = null;
    state.$main.replaceChildren(h('p', { class: 'loading' }, t('Revisando tu invitación…')));
    const message = (title, ...body) =>
      state.$main.replaceChildren(h('section', { class: 'welcome join' }, h('h1', {}, title), ...body));
    let inv;
    try {
      inv = await api(`/api/invites/${token}`);
    } catch (e) {
      return message(t('Este enlace ya no sirve'), h('p', {}, e.message), h('div', {}, h('a', { class: 'btn btn-ghost', href: '#/' }, t('Ir a mis intercambios'))));
    }
    if (inv.myName) {
      toast(t('Ya estás en “{group}” como {name}', { group: inv.groupName, name: inv.myName }));
      return location.replace(`#/g/${inv.groupId}`);
    }
    if (!inv.names.some((n) => !n.taken && !n.reserved)) {
      return message(
        t('Ya no quedan nombres por elegir'),
        h('p', {}, t('Todos los nombres de “{group}” ya fueron elegidos. Si falta el tuyo, pídele a {org} que te agregue.', { group: inv.groupName, org: inv.organizerName })),
        h('div', {}, h('a', { class: 'btn btn-ghost', href: '#/' }, t('Ir a mis intercambios')))
      );
    }

    const choose = async (n, btn) => {
      const ok = await confirmDialog({
        title: t('¿Eres {name}?', { name: n.name }),
        text: t('Tu cuenta {email} quedará ligada a este nombre y no podrás cambiarlo tú. Si te equivocas, solo {org} puede corregirlo.', { email: state.user.email, org: inv.organizerName }),
        confirm: t('Sí, soy {name}', { name: n.name }),
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await api(`/api/invites/${token}/claim`, { method: 'POST', body: { memberId: n.id } });
        await loadGroups();
        toast(t('¡Listo, {name}! Ya estás en “{group}”', { name: n.name, group: inv.groupName }));
        location.hash = `#/g/${inv.groupId}`;
      } catch (e) {
        toast(e.message, 'error');
        renderJoin(token); // la lista pudo cambiar: alguien más eligió ese nombre
      }
    };

    message(
      t('Te invitaron a “{group}”', { group: inv.groupName }),
      h('p', {}, t('{org} organiza este intercambio. Elige tu nombre: cada nombre se puede elegir una sola vez.', { org: inv.organizerName })),
      h(
        'ul',
        { class: 'name-picker' },
        inv.names.map((n) => {
          const btn = h(
            'button',
            { class: `name-tag${n.reserved ? ' reserved' : ''}`, type: 'button', disabled: n.taken || n.reserved },
            h('span', { class: 'name-tag-name' }, n.name),
            h('span', { class: 'name-tag-status' }, n.taken ? t('Ya lo eligieron') : n.reserved ? t('Reservado para otra cuenta') : t('Soy yo'))
          );
          if (!n.taken && !n.reserved) btn.addEventListener('click', () => choose(n, btn));
          return h('li', {}, btn);
        })
      ),
      h('p', { class: 'join-foot' }, t('Si tu nombre no aparece, está reservado para otra cuenta o alguien ya eligió el tuyo, avísale a {org}.', { org: inv.organizerName }))
    );
  }

  // -------------------------------------------------------------------------
  // Vista de un grupo
  // -------------------------------------------------------------------------
  async function showGroup(id) {
    if (!state.detail || state.detail.group.id !== id) {
      state.$main.replaceChildren(h('p', { class: 'loading' }, t('Cargando intercambio…')));
    }
    try {
      state.detail = await api(`/api/groups/${id}`);
    } catch (e) {
      state.detail = null;
      if (e.status === 404) {
        state.$main.replaceChildren(
          h('section', { class: 'welcome' }, h('h1', {}, t('No encontramos ese intercambio')), h('p', {}, e.message), h('div', {}, h('a', { class: 'btn', href: '#/' }, t('Ir a mis intercambios'))))
        );
      } else if (e.status !== 401) {
        state.$main.replaceChildren(h('p', { class: 'loading' }, e.message));
      }
      return;
    }
    renderGroup();
  }

  async function refreshGroup({ groups = false } = {}) {
    if (groups) await loadGroups();
    if (state.detail) await showGroup(state.detail.group.id);
  }

  function renderGroup() {
    const d = state.detail;
    document.title = `${d.group.name} · ${t('Intercambio navideño')}`;
    state.$main.replaceChildren(
      ...[
        groupHead(d),
        myTag(d),
        participantsSection(d),
        d.me ? myWishlistSection(d) : null,
        d.receiver ? receiverWishlistSection(d) : null,
      ].filter(Boolean)
    );
    // El panel del organizador vive en una ventana aparte; si está abierta, se actualiza.
    const dlg = document.getElementById('admin-dialog');
    if (dlg && dlg.open) {
      if (d.group.isOrganizer) fillAdmin(dlg);
      else dlg.close();
    }
    if (state.openAdmin && d.group.isOrganizer) {
      const msg = state.openAdmin;
      state.openAdmin = false;
      openAdmin();
      if (typeof msg === 'string') toast(msg);
    }
  }

  function groupHead(d) {
    const g = d.group;
    const meta = [];
    if (g.eventDate) meta.push([t('Fecha'), `${fmtDate(g.eventDate)} (${countdown(g.eventDate)})`]);
    if (g.budget !== null) meta.push([t('Presupuesto por regalo'), fmtMoney(g.budget, g.currency)]);
    meta.push([t('Organiza'), g.isOrganizer ? t('{name} (tú)', { name: g.organizerName }) : g.organizerName]);
    return h(
      'header',
      { class: 'group-head' },
      h(
        'div',
        { class: 'group-head-top' },
        h('h1', {}, g.name),
        g.isOrganizer ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: openAdmin }, t('Administrar intercambio')) : null
      ),
      h('dl', { class: 'group-meta' }, meta.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      g.description ? h('p', { class: 'group-desc' }, g.description) : null
    );
  }

  function myTag(d) {
    const g = d.group;
    if (!d.me) {
      return h(
        'section',
        { 'aria-label': t('Tu papel en el intercambio') },
        giftTag({
          single: t('Organizas este intercambio'),
          note: t('No estás entre los participantes, así que no entras al sorteo. Si quieres participar, abre “Administrar intercambio”, agrega tu nombre y pulsa “Soy yo”.'),
        })
      );
    }
    if (!d.receiver) {
      const who = g.isOrganizer ? t('Cuando hagas el sorteo') : t('Cuando {name} haga el sorteo', { name: g.organizerName });
      return h(
        'section',
        { 'aria-label': t('Tu asignación') },
        giftTag({ from: d.me.name, to: t('¿?'), pending: true, note: t('{who}, aquí verás a quién le regalas.', { who }) })
      );
    }
    const key = `visto:${g.id}:${d.receiver.id}`;
    const reveal = !storage.get(key);
    storage.set(key, '1');
    return h(
      'section',
      { 'aria-label': t('Tu asignación') },
      giftTag({
        from: d.me.name,
        to: d.receiver.name,
        reveal,
        note: t('Es secreto: solo tú puedes ver a quién le regalas.'),
      })
    );
  }

  function participantsSection(d) {
    const others = d.participants.filter((p) => !p.isMe);
    const total = d.participants.length;
    return h(
      'section',
      {},
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, t('Participantes')),
        h('p', {}, t(total === 1 ? '{n} persona. Nadie puede ver a quién le tocó a los demás.' : '{n} personas. Nadie puede ver a quién le tocó a los demás.', { n: total }))
      ),
      others.length
        ? h(
            'ul',
            { class: 'mini-tags' },
            others.map((p) =>
              h(
                'li',
                { class: 'mini-tag' },
                h('div', { class: 'mini-line' }, h('span', { class: 'k' }, t('De:')), h('span', { class: 'v' }, p.name)),
                h(
                  'div',
                  { class: 'mini-line' },
                  h('span', { class: 'k' }, t('Para:')),
                  d.group.drawn
                    ? h('span', { class: 'secret', 'aria-label': t('Oculto') }, '***')
                    : h('span', { class: 'k', style: 'width:auto' }, t('sin sortear'))
                ),
                h('p', { class: `mini-status${p.joined ? ' in' : ''}` }, p.joined ? t('Ya entró') : t('Aún no entra'))
              )
            )
          )
        : h('p', { class: 'empty' }, t('Todavía no hay más participantes en este intercambio.'))
    );
  }

  // ---- Wishlist ----
  function itemRow(item, { own, currency, rank }) {
    const li = h('li', { class: `item${own ? ' own' : ''}`, 'data-id': item.id });
    const thumb = h(
      'div',
      { class: 'thumb' },
      item.photoUrl
        ? h(
            'button',
            { class: 'thumb-btn', type: 'button', 'aria-label': t('Ver foto de {name}', { name: item.name }), onclick: () => showPhoto(item.photoUrl, item.name) },
            h('img', { src: item.photoUrl, alt: '', loading: 'lazy' })
          )
        : svg(ICON_GIFT)
    );
    const sub = h(
      'div',
      { class: 'item-sub' },
      item.cost !== null ? h('span', { class: 'item-cost' }, fmtMoney(item.cost, currency)) : h('span', {}, t('Sin precio')),
      item.link ? h('a', { href: item.link, target: '_blank', rel: 'noopener noreferrer nofollow' }, t('Ver en {host}', { host: hostOf(item.link) })) : null
    );
    li.append(h('span', { class: 'rank', 'aria-label': t('Preferencia {n}', { n: rank }) }, String(rank)), thumb, h('div', { class: 'item-info' }, h('p', { class: 'item-name' }, item.name), sub));
    if (!own) return li;

    li.append(
      h(
        'div',
        { class: 'item-actions' },
        h(
          'button',
          {
            class: 'btn-text',
            type: 'button',
            onclick: () =>
              openItemDialog({
                item,
                currency,
                title: t('Editar regalo'),
                submitText: t('Guardar cambios'),
                save: (fd) => api(`/api/wishlist/${item.id}`, { method: 'PATCH', form: fd }),
                doneMsg: t('Cambios guardados'),
              }),
          },
          t('Editar')
        ),
        h(
          'button',
          {
            class: 'btn-text danger',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: t('¿Borrar este regalo?'),
                text: t('“{name}” se quitará de tu wishlist.', { name: item.name }),
                confirm: t('Borrar regalo'),
                danger: true,
              });
              if (!ok) return;
              try {
                await api(`/api/wishlist/${item.id}`, { method: 'DELETE' });
                toast(t('Regalo borrado'));
                await refreshGroup();
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          },
          t('Borrar')
        )
      ),
      h(
        'div',
        { class: 'order-ctl' },
        h('button', { class: 'order-btn', type: 'button', 'data-move': '-1', 'aria-label': t('Subir “{name}”', { name: item.name }) }, svg(ICON_UP)),
        h('button', { class: 'order-btn', type: 'button', 'data-move': '1', 'aria-label': t('Bajar “{name}”', { name: item.name }) }, svg(ICON_DOWN)),
        h('span', { class: 'drag-handle', title: t('Arrastra para cambiar el orden'), 'aria-hidden': 'true' }, svg(ICON_GRIP))
      )
    );
    return li;
  }

  // Renumera la lista y apaga las flechas que no se pueden usar.
  function renumber(list) {
    const items = [...list.children];
    items.forEach((li, i) => {
      const rank = li.querySelector('.rank');
      if (rank) {
        rank.textContent = String(i + 1);
        rank.setAttribute('aria-label', t('Preferencia {n}', { n: i + 1 }));
      }
      const up = li.querySelector('[data-move="-1"]');
      const down = li.querySelector('[data-move="1"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === items.length - 1;
    });
  }

  // Arrastrar con mouse o dedo desde la manija, o usar las flechas.
  function makeSortable(list, onReorder) {
    const ids = () => [...list.children].map((li) => Number(li.dataset.id));
    let drag = null;
    list.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle || e.button > 0) return;
      e.preventDefault();
      drag = { li: handle.closest('li'), before: ids().join(), pointerId: e.pointerId };
      handle.setPointerCapture(e.pointerId);
      drag.li.classList.add('dragging');
    });
    list.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const target = [...list.children].find((li) => {
        if (li === drag.li) return false;
        const r = li.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (target) {
        if (target !== drag.li.nextElementSibling) list.insertBefore(drag.li, target);
      } else if (list.lastElementChild !== drag.li) {
        list.append(drag.li);
      }
      renumber(list);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.li.classList.remove('dragging');
      const changed = ids().join() !== drag.before;
      drag = null;
      if (changed) onReorder(ids());
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-move]');
      if (!btn) return;
      const li = btn.closest('li');
      if (btn.dataset.move === '-1' && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling);
      else if (btn.dataset.move === '1' && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li);
      else return;
      renumber(list);
      btn.disabled ? li.querySelector('.order-btn:not(:disabled)')?.focus() : btn.focus();
      onReorder(ids());
    });
    renumber(list);
  }

  let orderSave = Promise.resolve();
  function saveOrder(d, ids) {
    const byId = new Map(d.myWishlist.map((i) => [i.id, i]));
    d.myWishlist = ids.map((id) => byId.get(id));
    // Se guardan en fila para que dos cambios rápidos no lleguen desordenados.
    orderSave = orderSave.then(async () => {
      try {
        await api(`/api/groups/${d.group.id}/wishlist/order`, { method: 'PUT', body: { ids } });
      } catch (e) {
        toast(e.message, 'error');
        await refreshGroup();
      }
    });
  }

  function itemForm({ item = null, currency, submitText, onSubmit, onCancel }) {
    const err = h('p', { class: 'form-error full', role: 'alert' });
    const name = h('input', { class: 'input', name: 'name', required: true, maxlength: 120, value: item ? item.name : '', placeholder: t('Ej. Audífonos inalámbricos') });
    const cost = h('input', { class: 'input', name: 'cost', inputmode: 'decimal', value: item && item.cost !== null ? String(item.cost) : '', placeholder: '0' });
    const link = h('input', { class: 'input', name: 'link', inputmode: 'url', maxlength: 2000, value: item ? item.link || '' : '', placeholder: 'https://…' });
    const file = h('input', { type: 'file', accept: 'image/*', 'aria-label': t('Foto del regalo') });
    const preview = h('div', { class: 'thumb' }, item && item.photoUrl ? h('img', { src: item.photoUrl, alt: '' }) : svg(ICON_GIFT));
    let removePhoto = null;
    if (item && item.photoUrl) {
      removePhoto = h('input', { type: 'checkbox' });
    }
    let previewUrl = null;
    file.addEventListener('change', () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const f = file.files[0];
      if (f) {
        previewUrl = URL.createObjectURL(f);
        preview.replaceChildren(h('img', { src: previewUrl, alt: '' }));
        if (removePhoto) removePhoto.checked = false;
      }
    });
    const submit = h('button', { class: 'btn', type: 'submit' }, submitText);

    return h(
      'form',
      {
        class: 'add-form',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const fd = new FormData();
          fd.append('name', name.value);
          fd.append('cost', cost.value);
          fd.append('link', link.value);
          busy(submit, true);
          try {
            const photo = await prepareImage(file.files[0]);
            if (photo) fd.append('photo', photo);
            if (removePhoto && removePhoto.checked && !photo) fd.append('removePhoto', 'true');
            await onSubmit(fd);
          } catch (ex) {
            err.textContent = ex.message;
            busy(submit, false);
          }
        },
      },
      h('label', { class: 'field' }, h('span', {}, t('Nombre del regalo')), name),
      h('label', { class: 'field' }, h('span', {}, t('Costo aproximado ({currency})', { currency })), cost),
      h('label', { class: 'field full' }, h('span', {}, t('Link')), link, h('small', {}, t('Opcional. Dónde se puede comprar.'))),
      h(
        'div',
        { class: 'field full' },
        h('span', {}, t('Foto')),
        h(
          'div',
          { class: 'photo-pick' },
          preview,
          h(
            'div',
            {},
            file,
            removePhoto ? h('label', { class: 'form-row', style: 'margin-top:6px;font-size:14px;gap:6px' }, removePhoto, t('Quitar la foto actual')) : null
          )
        )
      ),
      err,
      h('div', { class: 'dialog-actions full' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: onCancel }, t('Cancelar')), submit)
    );
  }

  // Ventana para agregar o editar un regalo de la wishlist.
  function openItemDialog({ item = null, currency, title, submitText, save, doneMsg }) {
    const dlg = h('dialog', { class: 'item-dialog', 'aria-labelledby': 'item-dlg-title' });
    const close = () => dlg.close();
    const form = itemForm({
      item,
      currency,
      submitText,
      onCancel: close,
      onSubmit: async (fd) => {
        await save(fd);
        close(); // primero se cierra, para que el aviso no se vaya con la ventana
        toast(doneMsg);
        await refreshGroup();
      },
    });
    dlg.append(
      h(
        'div',
        { class: 'item-dlg-top' },
        h('h2', { id: 'item-dlg-title' }, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Cerrar'), onclick: close }, svg(ICON_X))
      ),
      form
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input[name=name]').focus();
  }

  function myWishlistSection(d) {
    const cur = d.group.currency;
    const items = d.myWishlist;
    const addBtn = h(
      'button',
      {
        class: 'btn add-gift',
        type: 'button',
        onclick: () =>
          openItemDialog({
            currency: cur,
            title: t('Agregar una idea de regalo'),
            submitText: t('Agregar a mi wishlist'),
            save: (fd) => api(`/api/groups/${d.group.id}/wishlist`, { method: 'POST', form: fd }),
            doneMsg: t('Regalo agregado a tu wishlist'),
          }),
      },
      svg(ICON_PLUS),
      t('Agregar una idea de regalo')
    );
    let list = null;
    if (items.length) {
      list = h('ol', { class: 'items sortable' }, items.map((i, n) => itemRow(i, { own: true, currency: cur, rank: n + 1 })));
      makeSortable(list, (ids) => saveOrder(d, ids));
    }
    return h(
      'section',
      {},
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, t('Mi wishlist')),
        h('p', {}, t('Solo la ve la persona a la que le tocas.'))
      ),
      items.length > 1 ? h('p', { class: 'list-hint' }, t('Ordénala por preferencia: la número 1 es la que más quieres. Arrastra desde ⠿ o usa las flechas.')) : null,
      list || h('p', { class: 'empty' }, t('Agrega ideas de regalo para que la persona a la que le tocaste sepa qué darte.')),
      addBtn
    );
  }

  function receiverWishlistSection(d) {
    const cur = d.group.currency;
    const name = d.receiver.name;
    const items = d.receiverWishlist;
    return h(
      'section',
      {},
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, t('Wishlist de {name}', { name })),
        h('p', {}, items.length > 1 ? t('En orden de preferencia: la número 1 es la que más le gustaría.') : t('Ideas que le gustaría recibir.'))
      ),
      items.length
        ? h('ol', { class: 'items' }, items.map((i, n) => itemRow(i, { own: false, currency: cur, rank: n + 1 })))
        : h('p', { class: 'empty' }, t('{name} todavía no agrega ideas. Vuelve a revisar más tarde.', { name }))
    );
  }

  // -------------------------------------------------------------------------
  // Panel del organizador (ventana)
  // -------------------------------------------------------------------------
  function openAdmin() {
    let dlg = document.getElementById('admin-dialog');
    if (!dlg) {
      dlg = h('dialog', { id: 'admin-dialog', class: 'admin-dialog', 'aria-labelledby': 'admin-title' });
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg);
    }
    fillAdmin(dlg);
    if (!dlg.open) dlg.showModal();
    dlg.querySelector('.admin-close')?.focus();
  }

  // Dibuja (o vuelve a dibujar) el contenido conservando la posición del scroll.
  function fillAdmin(dlg) {
    const d = state.detail;
    const prev = dlg.querySelector('.admin-body');
    const scroll = prev ? prev.scrollTop : 0;
    const body = h('div', { class: 'admin-body' }, adminSections(d));
    dlg.replaceChildren(
      h(
        'header',
        { class: 'admin-top' },
        h('div', {}, h('h2', { id: 'admin-title' }, t('Administrar intercambio')), h('p', {}, d.group.name)),
        h('button', { class: 'icon-btn admin-close', type: 'button', 'aria-label': t('Cerrar'), onclick: () => dlg.close() }, svg(ICON_X))
      ),
      body
    );
    body.scrollTop = scroll;
  }

  function adminSections(d) {
    const g = d.group;
    const gid = g.id;
    const n = d.participants.length;
    const pending = d.participants.filter((p) => !p.joined).length;

    // --- Enlace del grupo ---
    const url = inviteUrl(g.inviteToken);
    const waText = t('🎁 Te invito al intercambio “{group}”. Entra con tu cuenta de Google y elige tu nombre: {url}', { group: g.name, url });
    const inviteBlock = h(
      'div',
      { class: 'admin-block' },
      h('h3', {}, t('Invita al grupo')),
      h('p', { class: 'admin-note' }, t('Manda este enlace al grupo. Cada quien entra con su cuenta de Google y elige su nombre de la lista; cada nombre se puede elegir una sola vez.')),
      h(
        'div',
        { class: 'share' },
        h('code', {}, url),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(url, t('Enlace copiado')) }, t('Copiar enlace')),
        h('a', { class: 'btn btn-ghost btn-sm', href: `https://wa.me/?text=${encodeURIComponent(waText)}`, target: '_blank', rel: 'noopener noreferrer' }, t('Enviar por WhatsApp'))
      ),
      h(
        'p',
        { class: 'admin-note' },
        n ? t('{done} de {n} ya eligieron su nombre. ', { done: n - pending, n }) : '',
        h(
          'button',
          {
            class: 'btn-text',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: t('¿Cambiar el enlace?'),
                text: t('El enlace actual dejará de servir y tendrás que mandar el nuevo a quienes aún no entran. Quienes ya eligieron su nombre no se ven afectados.'),
                confirm: t('Cambiar enlace'),
              });
              if (!ok) return;
              try {
                await api(`/api/groups/${gid}/invite`, { method: 'POST' });
                toast(t('Enlace nuevo listo'));
                await refreshGroup();
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          },
          t('Cambiar enlace')
        )
      )
    );

    // --- Participantes ---
    const addErr = h('p', { class: 'form-error', role: 'alert' });
    const addName = h('input', { class: 'input', placeholder: t('Nombre que verá el grupo'), maxlength: 60, required: true });
    const addEmail = h('input', { class: 'input', type: 'email', placeholder: t('Opcional'), maxlength: 254 });
    const addBtn = h('button', { class: 'btn', type: 'submit' }, t('Agregar'));
    const addForm = h(
      'form',
      {
        class: 'add-person',
        onsubmit: async (e) => {
          e.preventDefault();
          addErr.textContent = '';
          busy(addBtn, true, t('Agregando…'));
          try {
            await api(`/api/groups/${gid}/members`, { method: 'POST', body: { name: addName.value, email: addEmail.value } });
            toast(t('{name} se agregó a la lista', { name: addName.value.trim() }));
            await refreshGroup({ groups: true });
            document.querySelector('#admin-dialog .add-person input')?.focus();
          } catch (ex) {
            addErr.textContent = ex.message;
            busy(addBtn, false);
          }
        },
      },
      h('label', { class: 'field' }, h('span', {}, t('Agregar a alguien')), addName),
      h('label', { class: 'field' }, h('span', {}, t('Correo de Google (opcional)')), addEmail),
      addBtn
    );
    const peopleBlock = h(
      'div',
      { class: 'admin-block' },
      h('h3', {}, t('Participantes')),
      h('p', { class: 'admin-note' }, t('El nombre que escribas es el que verá todo el grupo. Si registras el correo de Google de alguien, entra directo a su nombre; los demás lo eligen con el enlace. Si alguien eligió un nombre que no era el suyo, usa “Liberar”.')),
      n
        ? h(
            'table',
            { class: 'people' },
            h('thead', {}, h('tr', {}, h('th', {}, t('Nombre')), h('th', {}, t('Quién lo eligió')), h('th', {}, h('span', { class: 'sr-only' }, t('Acciones'))))),
            h('tbody', {}, d.participants.map((p) => personRow(d, p)))
          )
        : h('p', { class: 'empty' }, t('Todavía no hay nadie en la lista.')),
      g.drawn ? h('p', { class: 'admin-note' }, t('Para agregar o quitar personas, primero reinicia el sorteo.')) : addForm,
      addErr
    );

    // --- Sorteo ---
    const drawBox = g.drawn
      ? h(
          'div',
          { class: 'draw-box' },
          h('p', {}, t('El sorteo ya se hizo. Cada quien puede ver a quién le regala.')),
          h(
            'button',
            {
              class: 'btn btn-ghost',
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: t('¿Reiniciar el sorteo?'),
                  text: t('Se borrarán todas las asignaciones y tendrás que sortear de nuevo. Las wishlists se conservan. Avísale al grupo, porque a varios les tocará otra persona.'),
                  confirm: t('Reiniciar sorteo'),
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api(`/api/groups/${gid}/draw/reset`, { method: 'POST' });
                  toast(t('Sorteo reiniciado'));
                  await refreshGroup({ groups: true });
                } catch (e) {
                  toast(e.message, 'error');
                }
              },
            },
            t('Reiniciar sorteo')
          )
        )
      : h(
          'div',
          { class: 'draw-box' },
          h(
            'p',
            {},
            n < 3
              ? t(n === 1 ? 'Hay {n} participante. Se necesitan al menos 3 para sortear.' : 'Hay {n} participantes. Se necesitan al menos 3 para sortear.', { n })
              : pending
                ? t(
                    pending === 1
                      ? 'Hay {n} participantes y {p} aún no elige su nombre. Puedes sortear ya: verán a quién le regalan en cuanto entren.'
                      : 'Hay {n} participantes y {p} aún no eligen su nombre. Puedes sortear ya: verán a quién le regalan en cuanto entren.',
                    { n, p: pending }
                  )
                : t('Los {n} participantes ya eligieron su nombre. A cada quien le tocará otra persona al azar y nadie podrá ver las asignaciones de los demás.', { n })
          ),
          h(
            'button',
            {
              class: 'btn btn-red',
              type: 'button',
              disabled: n < 3,
              onclick: async (e) => {
                const btn = e.currentTarget;
                const ok = await confirmDialog({
                  title: t('¿Hacer el sorteo?'),
                  text: t('Se sortearán {n} participantes. Después ya no podrás agregar ni quitar personas, a menos que reinicies el sorteo.', { n }),
                  confirm: t('Hacer el sorteo'),
                });
                if (!ok) return;
                busy(btn, true, t('Sorteando…'));
                try {
                  await api(`/api/groups/${gid}/draw`, { method: 'POST' });
                  toast(t('¡Sorteo hecho! Ya cada quien puede ver a quién le regala.'));
                  await refreshGroup({ groups: true });
                } catch (ex) {
                  toast(ex.message, 'error');
                  busy(btn, false);
                }
              },
            },
            t('Hacer el sorteo')
          )
        );

    // --- Datos del intercambio ---
    const infoErr = h('p', { class: 'form-error', role: 'alert' });
    const fName = h('input', { class: 'input', required: true, maxlength: 80, value: g.name });
    const fDate = h('input', { class: 'input', type: 'date', value: g.eventDate || '' });
    const fBudget = h('input', { class: 'input', inputmode: 'decimal', value: g.budget !== null ? String(g.budget) : '', placeholder: t('Sin límite') });
    const fCur = currencySelect(g.currency);
    const fDesc = h('textarea', { class: 'input', maxlength: 500 }, g.description || '');
    const infoBtn = h('button', { class: 'btn', type: 'submit' }, t('Guardar cambios'));
    const infoForm = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (e) => {
          e.preventDefault();
          infoErr.textContent = '';
          busy(infoBtn, true);
          try {
            await api(`/api/groups/${gid}`, {
              method: 'PATCH',
              body: { name: fName.value, eventDate: fDate.value, budget: fBudget.value, currency: fCur.value, description: fDesc.value },
            });
            toast(t('Cambios guardados'));
            await refreshGroup({ groups: true });
          } catch (ex) {
            infoErr.textContent = ex.message;
            busy(infoBtn, false);
          }
        },
      },
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, t('Nombre del intercambio')), fName), h('label', { class: 'field' }, h('span', {}, t('Fecha')), fDate)),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, t('Presupuesto por regalo')), fBudget), h('label', { class: 'field' }, h('span', {}, t('Moneda')), fCur)),
      h('label', { class: 'field' }, h('span', {}, t('Notas para el grupo')), fDesc),
      h('div', { class: 'form-row' }, infoBtn),
      infoErr
    );

    return [
      inviteBlock,
      peopleBlock,
      h('div', { class: 'admin-block' }, h('h3', {}, t('Sorteo')), drawBox),
      h('div', { class: 'admin-block' }, h('h3', {}, t('Datos del intercambio')), infoForm),
      h(
        'div',
        { class: 'danger-zone' },
        h('p', {}, t('Borrar el intercambio elimina participantes, sorteo y wishlists. No se puede deshacer.')),
        h(
          'button',
          {
            class: 'btn btn-ghost danger-btn',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: t('¿Borrar “{name}”?', { name: g.name }),
                text: t('Se eliminarán participantes, sorteo y wishlists. No se puede deshacer.'),
                confirm: t('Borrar intercambio'),
                danger: true,
              });
              if (!ok) return;
              try {
                await api(`/api/groups/${gid}`, { method: 'DELETE' });
                toast(t('Intercambio borrado'));
                state.detail = null;
                await loadGroups();
                location.hash = '#/';
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          },
          t('Borrar intercambio')
        )
      ),
    ];
  }

  function personRow(d, p) {
    const g = d.group;
    const tr = h('tr');
    const act = async (fn, okMsg) => {
      try {
        await fn();
        toast(okMsg);
        await refreshGroup({ groups: true });
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    const release = async () => {
      const extra = g.drawn ? t(' Esa cuenta ya pudo ver a quién le regala este nombre; si fue un error, considera reiniciar el sorteo.') : '';
      const ok = await confirmDialog({
        title: t('¿Liberar “{name}”?', { name: p.name }),
        text: t('{account} dejará de estar ligada a este nombre, y el nombre volverá a aparecer en el enlace del grupo para que la persona correcta lo elija.{extra}', { account: p.account || t('La cuenta actual'), extra }),
        confirm: t('Liberar nombre'),
        danger: true,
      });
      if (ok) act(() => api(`/api/groups/${g.id}/members/${p.id}/release`, { method: 'POST' }), t('“{name}” quedó libre', { name: p.name }));
    };
    const claimMine = async () => {
      const ok = await confirmDialog({
        title: t('¿Eres {name}?', { name: p.name }),
        text: t('Tu cuenta {email} quedará ligada a este nombre y entrarás al sorteo.', { email: state.user.email }),
        confirm: t('Sí, soy {name}', { name: p.name }),
      });
      if (ok) act(() => api(`/api/invites/${g.inviteToken}/claim`, { method: 'POST', body: { memberId: p.id } }), t('Ya participas como {name}', { name: p.name }));
    };
    const remove = async () => {
      const ok = await confirmDialog({
        title: t('¿Quitar a {name}?', { name: p.name }),
        text: t('Se quitará del intercambio junto con su wishlist.'),
        confirm: t('Quitar'),
        danger: true,
      });
      if (ok) act(() => api(`/api/groups/${g.id}/members/${p.id}`, { method: 'DELETE' }), t('{name} ya no está en el intercambio', { name: p.name }));
    };
    const view = () => {
      tr.replaceChildren(
        h('td', { class: 'person-name' }, h('div', {}, p.name, p.isMe ? t(' (tú)') : ''), !p.joined && p.email ? h('small', { class: 'muted' }, t('Entra con {email}', { email: p.email })) : null),
        h('td', { class: 'email' }, p.joined ? h('span', { class: 'pill in' }, p.account || t('Ya entró')) : h('span', { class: 'pill' }, t('Pendiente'))),
        h(
          'td',
          { class: 'actions' },
          h('button', { class: 'btn-text', type: 'button', onclick: edit }, t('Editar')),
          !d.me && !p.joined ? h('button', { class: 'btn-text', type: 'button', onclick: claimMine }, t('Soy yo')) : null,
          p.joined ? h('button', { class: 'btn-text', type: 'button', onclick: release }, t('Liberar')) : null,
          h(
            'button',
            { class: 'btn-text danger', type: 'button', disabled: g.drawn, title: g.drawn ? t('Reinicia el sorteo para quitar a alguien') : null, onclick: remove },
            t('Quitar')
          )
        )
      );
    };
    const edit = () => {
      const nameInput = h('input', { class: 'input', value: p.name, maxlength: 60, 'aria-label': t('Nombre') });
      const emailInput = h('input', { class: 'input', type: 'email', value: p.email || '', maxlength: 254, placeholder: t('Correo de Google (opcional)'), 'aria-label': t('Correo de Google (opcional)') });
      const save = h('button', { class: 'btn-text', type: 'button' }, t('Guardar'));
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(`/api/groups/${g.id}/members/${p.id}`, { method: 'PATCH', body: { name: nameInput.value, email: emailInput.value } });
          toast(t('Nombre actualizado'));
          await refreshGroup({ groups: true });
        } catch (e) {
          toast(e.message, 'error');
          save.disabled = false;
        }
      });
      for (const i of [nameInput, emailInput]) {
        i.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') save.click();
        });
      }
      tr.replaceChildren(
        h('td', { colspan: 2 }, h('div', { class: 'edit-person' }, nameInput, emailInput)),
        h('td', { class: 'actions' }, save, h('button', { class: 'btn-text', type: 'button', onclick: view }, t('Cancelar')))
      );
      nameInput.focus();
    };
    view();
    return tr;
  }

  function currencySelect(value) {
    return h(
      'select',
      { class: 'input' },
      [
        ['MXN', t('Pesos mexicanos (MXN)')],
        ['USD', t('Dólares (USD)')],
        ['EUR', t('Euros (EUR)')],
        ['GBP', t('Libras (GBP)')],
      ].map(([v, t]) => h('option', { value: v, selected: v === value }, t))
    );
  }

  // -------------------------------------------------------------------------
  // Crear intercambio
  // -------------------------------------------------------------------------
  function renderCreate() {
    document.title = `${t('Crear intercambio')} · ${t('Intercambio navideño')}`;
    state.detail = null;
    const err = h('p', { class: 'form-error', role: 'alert' });
    const fName = h('input', { class: 'input', required: true, maxlength: 80, placeholder: t('Ej. Posada de la familia') });
    const fDate = h('input', { class: 'input', type: 'date' });
    const fBudget = h('input', { class: 'input', inputmode: 'decimal', placeholder: t('Sin límite') });
    const fCur = currencySelect('MXN');
    const fDesc = h('textarea', { class: 'input', maxlength: 500, placeholder: t('Lugar, hora o reglas. Ej. nada de ropa.') });
    const rowsBox = h('div', { class: 'person-rows' });
    const count = h('p', { class: 'hint' });

    const meCheck = h('input', { type: 'checkbox', checked: true });
    const meName = h('input', { class: 'input', value: state.user.name || '', maxlength: 60, placeholder: t('Tu nombre en el grupo'), 'aria-label': t('Tu nombre en el grupo') });

    const updateCount = () => {
      const others = [...rowsBox.querySelectorAll('input[name=pname]')].filter((i) => i.value.trim()).length;
      const total = others + (meCheck.checked ? 1 : 0);
      count.textContent = t(
        total === 1
          ? '{n} persona en total. Se necesitan al menos 3 para el sorteo; puedes agregar más después.'
          : '{n} personas en total. Se necesitan al menos 3 para el sorteo; puedes agregar más después.',
        { n: total }
      );
    };
    meCheck.addEventListener('change', () => {
      meName.disabled = !meCheck.checked;
      updateCount();
    });
    meName.addEventListener('input', updateCount);

    // "Ana", "Ana, ana@gmail.com", "Ana <ana@gmail.com>" o "Ana	ana@gmail.com" → { name, email }
    const parseLine = (line) => {
      const m = line.match(/[^\s<>,;]+@[^\s<>,;]+\.[^\s<>,;]+/);
      const email = m ? m[0] : '';
      const name = (m ? line.replace(m[0], '') : line).replace(/[<>,;\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      return { name, email };
    };
    const addRow = ({ name = '', email = '' } = {}, after = null, focus = false) => {
      const input = h('input', { class: 'input', name: 'pname', value: name, maxlength: 60, placeholder: t('Nombre'), 'aria-label': t('Nombre de un participante'), oninput: updateCount });
      const mail = h('input', { class: 'input', name: 'pemail', type: 'email', value: email, maxlength: 254, placeholder: t('Correo de Google (opcional)'), 'aria-label': t('Correo de Google (opcional)') });
      const row = h(
        'div',
        { class: 'person-row' },
        input,
        mail,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Quitar de la lista'), onclick: () => { row.remove(); updateCount(); } }, svg(ICON_X))
      );
      // Pegar una lista (una persona por línea, con o sin correo) crea una fila por persona.
      input.addEventListener('paste', (e) => {
        const lines = (e.clipboardData?.getData('text') || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2 && !(lines[0] && parseLine(lines[0]).email)) return;
        e.preventDefault();
        const [first, ...rest] = lines.map(parseLine);
        input.value = first.name;
        if (first.email) mail.value = first.email;
        let prev = row;
        for (const l of rest) prev = addRow(l, prev);
        updateCount();
      });
      if (after) after.after(row);
      else rowsBox.append(row);
      if (focus) input.focus();
      updateCount();
      return row;
    };
    addRow();
    addRow();

    const submit = h('button', { class: 'btn', type: 'submit' }, t('Crear intercambio'));
    const form = h(
      'form',
      {
        class: 'stack-form roomy',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const participants = [];
          for (const r of rowsBox.children) {
            const name = r.querySelector('[name=pname]').value.trim();
            const email = r.querySelector('[name=pemail]').value.trim();
            if (!name && !email) continue;
            if (!name) {
              err.textContent = t('Falta el nombre de {email}.', { email });
              return;
            }
            participants.push({ name, email });
          }
          busy(submit, true, t('Creando…'));
          try {
            const { id } = await api('/api/groups', {
              method: 'POST',
              body: {
                name: fName.value,
                eventDate: fDate.value,
                budget: fBudget.value,
                currency: fCur.value,
                description: fDesc.value,
                me: { participate: meCheck.checked, name: meName.value },
                participants,
              },
            });
            await loadGroups();
            state.openAdmin = t('Intercambio creado. Ahora comparte el enlace con el grupo.');
            location.hash = `#/g/${id}`;
          } catch (ex) {
            err.textContent = ex.message;
            busy(submit, false);
          }
        },
      },
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, t('El evento')),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, t('Nombre del intercambio')), fName), h('label', { class: 'field' }, h('span', {}, t('Fecha')), fDate)),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, t('Presupuesto por regalo')), fBudget), h('label', { class: 'field' }, h('span', {}, t('Moneda')), fCur)),
        h('label', { class: 'field' }, h('span', {}, t('Notas para el grupo')), fDesc)
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, t('Tú')),
        h('label', { class: 'check-row' }, meCheck, t('Yo también participo en el sorteo')),
        meName
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, t('Los demás participantes')),
        h('p', { class: 'hint' }, t('Escribe cada nombre tal como quieres que lo vea el grupo. Si sabes el correo de Google de alguien, agrégalo: entrará directo a su nombre sin tener que elegirlo. Puedes pegar una lista, una persona por línea.')),
        rowsBox,
        count,
        h('div', {}, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => addRow({}, null, true) }, t('+ Agregar otra persona')))
      ),
      h('div', { class: 'create-actions' }, submit, h('a', { class: 'btn btn-ghost', href: '#/' }, t('Cancelar'))),
      err
    );

    state.$main.replaceChildren(
      h(
        'section',
        { class: 'create' },
        h('h1', {}, t('Crear intercambio')),
        h('p', {}, t('Escribe los nombres del grupo. Después tendrás un enlace para compartir: cada quien entra con su cuenta de Google y elige su nombre. Quien tenga correo registrado entra directo.')),
        form
      )
    );
    fName.focus();
  }

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------
  async function boot() {
    // Todo en paralelo: sesión, configuración y (si hará falta) el script de Google.
    const hadSession = storage.get(SESSION_HINT) === '1';
    const meP = api('/api/me').catch(() => ({}));
    getConfig()
      .then((cfg) => {
        // Si se abrió desde otra dirección de Vercel (de un deploy o de una rama),
        // pasa a la principal: ahí funciona Google y la sesión de siempre.
        const main = cfg.publicUrl;
        if (main && location.hostname.endsWith('.vercel.app') && location.origin !== main) {
          location.replace(main + location.pathname + location.search + location.hash);
        }
      })
      .catch(() => {});
    if (hadSession) {
      $app.replaceChildren(h('div', { class: 'boot' }, svg(BRAND_TAG), h('span', {}, t('Cargando tus intercambios…'))));
    } else {
      // Lo más probable es que no haya sesión: la pantalla de entrada aparece de inmediato.
      if (!directUntil(rememberedAccount())) loadGoogleScript().catch(() => {});
      renderLogin();
    }
    const { user, rememberUntil } = await meP;
    if (user) onLoggedIn(user, rememberUntil);
    else {
      setSessionHint(false);
      if (hadSession) renderLogin();
    }
  }
  boot();
})();
