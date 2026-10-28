'use strict';
/* Intercambio navideño — interfaz (JavaScript sin dependencias). */
(() => {
  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');
  const state = { config: null, user: null, groups: [], detail: null, $side: null, $main: null };

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
  const ICON_GRIP =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
  const ICON_UP =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  const ICON_DOWN =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const BRAND_TAG =
    '<svg width="28" height="22" viewBox="0 0 32 26" aria-hidden="true"><path d="M9 1h22v24H9L1 13z" fill="#C21F3A"/><circle cx="9" cy="13" r="2.6" fill="#17392F"/></svg>';

  async function api(path, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
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
      throw new Error('No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/me' && state.user) {
      state.user = null;
      renderLogin('Tu sesión terminó. Vuelve a entrar.');
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Algo falló. Intenta de nuevo.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const fmtMoney = (n, cur = 'MXN') => {
    if (n === null || n === undefined) return '';
    const s = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(n);
    return cur === 'MXN' ? `${s} MXN` : s;
  };
  const parseDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const fmtDate = (s) =>
    parseDate(s).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = (s) => parseDate(s).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  function countdown(s) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const n = Math.round((parseDate(s) - today) / 864e5);
    if (n > 1) return `faltan ${n} días`;
    if (n === 1) return 'es mañana';
    if (n === 0) return 'es hoy';
    return 'ya pasó';
  }
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'la tienda';
    }
  };
  const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();

  const inviteUrl = (token) => `${location.origin}/#/unirse/${token}`;
  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      toast('No se pudo copiar automáticamente. Intenta de nuevo.', 'error');
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

  function confirmDialog({ title, text, confirm = 'Confirmar', danger = false }) {
    return new Promise((resolve) => {
      const dlg = h(
        'dialog',
        { class: 'confirm', 'aria-labelledby': 'dlg-title' },
        h('h2', { id: 'dlg-title' }, title),
        h('p', {}, text),
        h(
          'div',
          { class: 'dialog-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close('no') }, 'Cancelar'),
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
      h('button', { class: 'photo-close', type: 'button', 'aria-label': 'Cerrar foto', onclick: () => dlg.close() }, svg(ICON_X))
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
      btn.textContent = text || 'Guardando…';
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
  };

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
          h('div', { class: 'tag-line' }, h('span', { class: 'tag-label' }, 'De:'), h('span', { class: 'tag-name' }, from)),
          h('div', { class: 'tag-line para' }, h('span', { class: 'tag-label' }, 'Para:'), h('span', { class: 'tag-name' }, to)),
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
  function loadGoogleScript() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('No se pudo cargar el inicio de sesión de Google.'));
      document.head.append(s);
    });
  }

  function renderLogin(message) {
    document.title = 'Intercambio navideño';
    const err = h('p', { class: 'form-error', role: 'alert' }, message || '');
    const slot = h('div', { class: 'gsi-slot' });
    const actions = h('div', { class: 'login-actions' }, slot);
    const { googleClientId, devLogin } = state.config || {};

    if (googleClientId) {
      loadGoogleScript()
        .then(() => {
          window.google.accounts.id.initialize({
            client_id: googleClientId,
            ux_mode: 'popup',
            auto_select: false,
            callback: async (resp) => {
              err.textContent = '';
              try {
                const { user } = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } });
                state.user = user;
                startApp();
              } catch (e) {
                err.textContent = e.message;
              }
            },
          });
          window.google.accounts.id.renderButton(slot, {
            theme: 'filled_black',
            size: 'large',
            shape: 'pill',
            text: 'signin_with',
            locale: 'es-419',
            width: 280,
          });
        })
        .catch((e) => (err.textContent = e.message));
    } else if (!devLogin) {
      err.textContent = 'El servidor no tiene configurado GOOGLE_CLIENT_ID. Revisa el archivo .env.';
    }

    if (devLogin) {
      const input = h('input', { class: 'input', type: 'email', placeholder: 'correo@ejemplo.com', required: true, 'aria-label': 'Correo de prueba' });
      actions.append(
        h(
          'div',
          { class: 'dev-login' },
          h('p', {}, 'Modo de prueba (DEV_LOGIN): entra con cualquier correo, sin Google.'),
          h(
            'form',
            {
              onsubmit: async (e) => {
                e.preventDefault();
                try {
                  const { user } = await api('/api/auth/dev', { method: 'POST', body: { email: input.value } });
                  state.user = user;
                  startApp();
                } catch (ex) {
                  err.textContent = ex.message;
                }
              },
            },
            input,
            h('button', { class: 'btn', type: 'submit' }, 'Entrar')
          )
        )
      );
    }
    actions.append(err);

    // Si llegó con el enlace del grupo, le decimos a qué lo invitaron.
    const r = currentRoute();
    let banner = null;
    if (r.name === 'join') {
      banner = h('div', { class: 'invite-banner' }, 'Revisando tu invitación…');
      api(`/api/invites/${r.token}`)
        .then((inv) =>
          banner.replaceChildren(
            h('strong', {}, `${inv.organizerName} te invitó a “${inv.groupName}”`),
            h('span', {}, 'Entra con la cuenta de Google que quieras usar y después elige tu nombre de la lista.')
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
          h('h1', {}, 'Intercambio navideño'),
          h('p', {}, 'Entra con tu cuenta de Google para ver a quién le regalas y qué le gustaría recibir.'),
          banner,
          actions,
          h(
            'p',
            { class: 'legal-links' },
            h('a', { href: '/privacidad.html' }, 'Política de privacidad'),
            h('a', { href: '/terminos.html' }, 'Términos de servicio')
          )
        ),
        h('div', { class: 'login-art', 'aria-hidden': 'true' }, giftTag({ from: 'Tú', to: '***' }))
      )
    );
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* igual cerramos */
    }
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
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
    state.$side = h('aside', { class: 'side', 'aria-label': 'Tus intercambios' });
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
            const sub = [g.eventDate ? fmtShort(g.eventDate) : null, g.isOrganizer ? 'organizas' : null].filter(Boolean).join(', ');
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
      : h('p', { class: 'side-empty' }, 'Todavía no tienes intercambios.');

    state.$side.replaceChildren(
      h(
        'div',
        { class: 'side-top' },
        h('div', { class: 'brand' }, svg(BRAND_TAG), 'Intercambio'),
        h(
          'div',
          { class: 'user-box' },
          h('div', { class: 'avatar' }, u.picture ? h('img', { src: u.picture, alt: '', referrerpolicy: 'no-referrer' }) : initial(u.name || u.email)),
          h('div', { class: 'who' }, h('span', {}, u.name || u.email.split('@')[0]), h('span', { class: 'email' }, u.email)),
          h('button', { class: 'btn-text', type: 'button', onclick: logout }, 'Salir')
        )
      ),
      h('h2', {}, 'Tus intercambios'),
      list,
      h('a', { class: 'btn btn-new', href: '#/nuevo' }, '+ Crear intercambio')
    );
  }

  function renderWelcome() {
    document.title = 'Intercambio navideño';
    state.$main.replaceChildren(
      h(
        'section',
        { class: 'welcome' },
        h('h1', {}, 'Aún no estás en ningún intercambio'),
        h('p', {}, 'Si alguien te invitó, abre el enlace que te mandó y elige tu nombre.'),
        h('p', {}, 'O crea uno y comparte el enlace con tu grupo.'),
        h('div', {}, h('a', { class: 'btn', href: '#/nuevo' }, 'Crear intercambio'))
      )
    );
  }

  // Pantalla a la que llega alguien con el enlace del grupo (#/unirse/TOKEN):
  // elige su nombre de la lista que escribió el organizador.
  async function renderJoin(token) {
    document.title = 'Invitación · Intercambio navideño';
    state.detail = null;
    state.$main.replaceChildren(h('p', { class: 'loading' }, 'Revisando tu invitación…'));
    const message = (title, ...body) =>
      state.$main.replaceChildren(h('section', { class: 'welcome join' }, h('h1', {}, title), ...body));
    let inv;
    try {
      inv = await api(`/api/invites/${token}`);
    } catch (e) {
      return message('Este enlace ya no sirve', h('p', {}, e.message), h('div', {}, h('a', { class: 'btn btn-ghost', href: '#/' }, 'Ir a mis intercambios')));
    }
    if (inv.myName) {
      toast(`Ya estás en “${inv.groupName}” como ${inv.myName}`);
      return location.replace(`#/g/${inv.groupId}`);
    }
    if (!inv.names.some((n) => !n.taken)) {
      return message(
        'Ya no quedan nombres por elegir',
        h('p', {}, `Todos los nombres de “${inv.groupName}” ya fueron elegidos. Si falta el tuyo, pídele a ${inv.organizerName} que te agregue.`),
        h('div', {}, h('a', { class: 'btn btn-ghost', href: '#/' }, 'Ir a mis intercambios'))
      );
    }

    const choose = async (n, btn) => {
      const ok = await confirmDialog({
        title: `¿Eres ${n.name}?`,
        text: `Tu cuenta ${state.user.email} quedará ligada a este nombre y no podrás cambiarlo tú. Si te equivocas, solo ${inv.organizerName} puede corregirlo.`,
        confirm: `Sí, soy ${n.name}`,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await api(`/api/invites/${token}/claim`, { method: 'POST', body: { memberId: n.id } });
        await loadGroups();
        toast(`¡Listo, ${n.name}! Ya estás en “${inv.groupName}”`);
        location.hash = `#/g/${inv.groupId}`;
      } catch (e) {
        toast(e.message, 'error');
        renderJoin(token); // la lista pudo cambiar: alguien más eligió ese nombre
      }
    };

    message(
      `Te invitaron a “${inv.groupName}”`,
      h('p', {}, `${inv.organizerName} organiza este intercambio. Elige tu nombre: cada nombre se puede elegir una sola vez.`),
      h(
        'ul',
        { class: 'name-picker' },
        inv.names.map((n) => {
          const btn = h(
            'button',
            { class: 'name-tag', type: 'button', disabled: n.taken },
            h('span', { class: 'name-tag-name' }, n.name),
            h('span', { class: 'name-tag-status' }, n.taken ? 'Ya lo eligieron' : 'Soy yo')
          );
          if (!n.taken) btn.addEventListener('click', () => choose(n, btn));
          return h('li', {}, btn);
        })
      ),
      h('p', { class: 'join-foot' }, `Si tu nombre no aparece o alguien ya eligió el tuyo, avísale a ${inv.organizerName}.`)
    );
  }

  // -------------------------------------------------------------------------
  // Vista de un grupo
  // -------------------------------------------------------------------------
  async function showGroup(id) {
    if (!state.detail || state.detail.group.id !== id) {
      state.$main.replaceChildren(h('p', { class: 'loading' }, 'Cargando intercambio…'));
    }
    try {
      state.detail = await api(`/api/groups/${id}`);
    } catch (e) {
      state.detail = null;
      if (e.status === 404) {
        state.$main.replaceChildren(
          h('section', { class: 'welcome' }, h('h1', {}, 'No encontramos ese intercambio'), h('p', {}, e.message), h('div', {}, h('a', { class: 'btn', href: '#/' }, 'Ir a mis intercambios')))
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
    document.title = `${d.group.name} · Intercambio navideño`;
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
    if (g.eventDate) meta.push(['Fecha', `${fmtDate(g.eventDate)} (${countdown(g.eventDate)})`]);
    if (g.budget !== null) meta.push(['Presupuesto por regalo', fmtMoney(g.budget, g.currency)]);
    meta.push(['Organiza', g.isOrganizer ? `${g.organizerName} (tú)` : g.organizerName]);
    return h(
      'header',
      { class: 'group-head' },
      h(
        'div',
        { class: 'group-head-top' },
        h('h1', {}, g.name),
        g.isOrganizer ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: openAdmin }, 'Administrar intercambio') : null
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
        { 'aria-label': 'Tu papel en el intercambio' },
        giftTag({
          single: 'Organizas este intercambio',
          note: 'No estás entre los participantes, así que no entras al sorteo. Si quieres participar, abre “Administrar intercambio”, agrega tu nombre y pulsa “Soy yo”.',
        })
      );
    }
    if (!d.receiver) {
      const who = g.isOrganizer ? 'Cuando hagas el sorteo' : `Cuando ${g.organizerName} haga el sorteo`;
      return h(
        'section',
        { 'aria-label': 'Tu asignación' },
        giftTag({ from: d.me.name, to: '¿?', pending: true, note: `${who}, aquí verás a quién le regalas.` })
      );
    }
    const key = `visto:${g.id}:${d.receiver.id}`;
    const reveal = !storage.get(key);
    storage.set(key, '1');
    return h(
      'section',
      { 'aria-label': 'Tu asignación' },
      giftTag({
        from: d.me.name,
        to: d.receiver.name,
        reveal,
        note: 'Es secreto: solo tú puedes ver a quién le regalas.',
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
        h('h2', {}, 'Participantes'),
        h('p', {}, `${total} ${total === 1 ? 'persona' : 'personas'}. Nadie puede ver a quién le tocó a los demás.`)
      ),
      others.length
        ? h(
            'ul',
            { class: 'mini-tags' },
            others.map((p) =>
              h(
                'li',
                { class: 'mini-tag' },
                h('div', { class: 'mini-line' }, h('span', { class: 'k' }, 'De:'), h('span', { class: 'v' }, p.name)),
                h(
                  'div',
                  { class: 'mini-line' },
                  h('span', { class: 'k' }, 'Para:'),
                  d.group.drawn
                    ? h('span', { class: 'secret', 'aria-label': 'Oculto' }, '***')
                    : h('span', { class: 'k', style: 'width:auto' }, 'sin sortear')
                ),
                h('p', { class: `mini-status${p.joined ? ' in' : ''}` }, p.joined ? 'Ya entró' : 'Aún no entra')
              )
            )
          )
        : h('p', { class: 'empty' }, 'Todavía no hay más participantes en este intercambio.')
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
            { class: 'thumb-btn', type: 'button', 'aria-label': `Ver foto de ${item.name}`, onclick: () => showPhoto(item.photoUrl, item.name) },
            h('img', { src: item.photoUrl, alt: '', loading: 'lazy' })
          )
        : svg(ICON_GIFT)
    );
    const sub = h(
      'div',
      { class: 'item-sub' },
      item.cost !== null ? h('span', { class: 'item-cost' }, fmtMoney(item.cost, currency)) : h('span', {}, 'Sin precio'),
      item.link ? h('a', { href: item.link, target: '_blank', rel: 'noopener noreferrer nofollow' }, `Ver en ${hostOf(item.link)}`) : null
    );
    li.append(h('span', { class: 'rank', 'aria-label': `Preferencia ${rank}` }, String(rank)), thumb, h('div', { class: 'item-info' }, h('p', { class: 'item-name' }, item.name), sub));
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
            onclick: () => {
              li.classList.add('editing');
              li.replaceChildren(
                h(
                  'div',
                  { class: 'edit-row' },
                  itemForm({
                    item,
                    currency,
                    title: 'Editar regalo',
                    submitText: 'Guardar cambios',
                    onCancel: () => renderGroup(),
                    onSubmit: async (fd) => {
                      await api(`/api/wishlist/${item.id}`, { method: 'PATCH', form: fd });
                      toast('Cambios guardados');
                      await refreshGroup();
                    },
                  })
                )
              );
              li.querySelector('input')?.focus();
            },
          },
          'Editar'
        ),
        h(
          'button',
          {
            class: 'btn-text danger',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: '¿Borrar este regalo?',
                text: `“${item.name}” se quitará de tu wishlist.`,
                confirm: 'Borrar regalo',
                danger: true,
              });
              if (!ok) return;
              try {
                await api(`/api/wishlist/${item.id}`, { method: 'DELETE' });
                toast('Regalo borrado');
                await refreshGroup();
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          },
          'Borrar'
        )
      ),
      h(
        'div',
        { class: 'order-ctl' },
        h('button', { class: 'order-btn', type: 'button', 'data-move': '-1', 'aria-label': `Subir “${item.name}”` }, svg(ICON_UP)),
        h('button', { class: 'order-btn', type: 'button', 'data-move': '1', 'aria-label': `Bajar “${item.name}”` }, svg(ICON_DOWN)),
        h('span', { class: 'drag-handle', title: 'Arrastra para cambiar el orden', 'aria-hidden': 'true' }, svg(ICON_GRIP))
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
        rank.setAttribute('aria-label', `Preferencia ${i + 1}`);
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
      if (!handle || e.button > 0 || list.querySelector('.editing')) return;
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

  function itemForm({ item = null, currency, title, submitText, onSubmit, onCancel }) {
    const err = h('p', { class: 'form-error full', role: 'alert' });
    const name = h('input', { class: 'input', name: 'name', required: true, maxlength: 120, value: item ? item.name : '', placeholder: 'Ej. Audífonos inalámbricos' });
    const cost = h('input', { class: 'input', name: 'cost', inputmode: 'decimal', value: item && item.cost !== null ? String(item.cost) : '', placeholder: '0' });
    const link = h('input', { class: 'input', name: 'link', inputmode: 'url', maxlength: 2000, value: item ? item.link || '' : '', placeholder: 'https://…' });
    const file = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Foto del regalo' });
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
      h('h3', { class: 'full' }, title),
      h('label', { class: 'field' }, h('span', {}, 'Nombre del regalo'), name),
      h('label', { class: 'field' }, h('span', {}, `Costo aproximado (${currency})`), cost),
      h('label', { class: 'field full' }, h('span', {}, 'Link'), link, h('small', {}, 'Opcional. Dónde se puede comprar.')),
      h(
        'div',
        { class: 'field full' },
        h('span', {}, 'Foto'),
        h(
          'div',
          { class: 'photo-pick' },
          preview,
          h(
            'div',
            {},
            file,
            removePhoto ? h('label', { class: 'form-row', style: 'margin-top:6px;font-size:14px;gap:6px' }, removePhoto, 'Quitar la foto actual') : null
          )
        )
      ),
      h(
        'div',
        { class: 'form-row full' },
        submit,
        onCancel ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: onCancel }, 'Cancelar') : null
      ),
      err
    );
  }

  function myWishlistSection(d) {
    const cur = d.group.currency;
    const items = d.myWishlist;
    const form = itemForm({
      currency: cur,
      title: 'Agregar una idea de regalo',
      submitText: 'Agregar a mi wishlist',
      onSubmit: async (fd) => {
        await api(`/api/groups/${d.group.id}/wishlist`, { method: 'POST', form: fd });
        toast('Regalo agregado a tu wishlist');
        await refreshGroup();
      },
    });
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
        h('h2', {}, 'Mi wishlist'),
        h('p', {}, 'Solo la ve la persona a la que le tocas.')
      ),
      items.length > 1 ? h('p', { class: 'list-hint' }, 'Ordénala por preferencia: la número 1 es la que más quieres. Arrastra desde ⠿ o usa las flechas.') : null,
      list || h('p', { class: 'empty' }, 'Agrega ideas de regalo para que la persona a la que le tocaste sepa qué darte.'),
      form
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
        h('h2', {}, `Wishlist de ${name}`),
        h('p', {}, items.length > 1 ? 'En orden de preferencia: la número 1 es la que más le gustaría.' : 'Ideas que le gustaría recibir.')
      ),
      items.length
        ? h('ol', { class: 'items' }, items.map((i, n) => itemRow(i, { own: false, currency: cur, rank: n + 1 })))
        : h('p', { class: 'empty' }, `${name} todavía no agrega ideas. Vuelve a revisar más tarde.`)
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
        h('div', {}, h('h2', { id: 'admin-title' }, 'Administrar intercambio'), h('p', {}, d.group.name)),
        h('button', { class: 'icon-btn admin-close', type: 'button', 'aria-label': 'Cerrar', onclick: () => dlg.close() }, svg(ICON_X))
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
    const waText = `🎁 Te invito al intercambio “${g.name}”. Entra con tu cuenta de Google y elige tu nombre: ${url}`;
    const inviteBlock = h(
      'div',
      { class: 'admin-block' },
      h('h3', {}, 'Invita al grupo'),
      h('p', { class: 'admin-note' }, 'Manda este enlace al grupo. Cada quien entra con su cuenta de Google y elige su nombre de la lista; cada nombre se puede elegir una sola vez.'),
      h(
        'div',
        { class: 'share' },
        h('code', {}, url),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(url, 'Enlace copiado') }, 'Copiar enlace'),
        h('a', { class: 'btn btn-ghost btn-sm', href: `https://wa.me/?text=${encodeURIComponent(waText)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Enviar por WhatsApp')
      ),
      h(
        'p',
        { class: 'admin-note' },
        n ? `${n - pending} de ${n} ya eligieron su nombre. ` : '',
        h(
          'button',
          {
            class: 'btn-text',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: '¿Cambiar el enlace?',
                text: 'El enlace actual dejará de servir y tendrás que mandar el nuevo a quienes aún no entran. Quienes ya eligieron su nombre no se ven afectados.',
                confirm: 'Cambiar enlace',
              });
              if (!ok) return;
              try {
                await api(`/api/groups/${gid}/invite`, { method: 'POST' });
                toast('Enlace nuevo listo');
                await refreshGroup();
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          },
          'Cambiar enlace'
        )
      )
    );

    // --- Participantes ---
    const addErr = h('p', { class: 'form-error', role: 'alert' });
    const addName = h('input', { class: 'input', placeholder: 'Nombre que verá el grupo', maxlength: 60, required: true });
    const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Agregar');
    const addForm = h(
      'form',
      {
        class: 'add-person',
        onsubmit: async (e) => {
          e.preventDefault();
          addErr.textContent = '';
          busy(addBtn, true, 'Agregando…');
          try {
            await api(`/api/groups/${gid}/members`, { method: 'POST', body: { name: addName.value } });
            toast(`${addName.value.trim()} se agregó a la lista`);
            await refreshGroup({ groups: true });
            document.querySelector('#admin-dialog .add-person input')?.focus();
          } catch (ex) {
            addErr.textContent = ex.message;
            busy(addBtn, false);
          }
        },
      },
      h('label', { class: 'field' }, h('span', {}, 'Agregar a alguien'), addName),
      addBtn
    );
    const peopleBlock = h(
      'div',
      { class: 'admin-block' },
      h('h3', {}, 'Participantes'),
      h('p', { class: 'admin-note' }, 'El nombre que escribas es el que verá todo el grupo. Si alguien eligió un nombre que no era el suyo, usa “Liberar” para que la persona correcta lo elija.'),
      n
        ? h(
            'table',
            { class: 'people' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Quién lo eligió'), h('th', {}, h('span', { class: 'sr-only' }, 'Acciones')))),
            h('tbody', {}, d.participants.map((p) => personRow(d, p)))
          )
        : h('p', { class: 'empty' }, 'Todavía no hay nadie en la lista.'),
      g.drawn ? h('p', { class: 'admin-note' }, 'Para agregar o quitar personas, primero reinicia el sorteo.') : addForm,
      addErr
    );

    // --- Sorteo ---
    const drawBox = g.drawn
      ? h(
          'div',
          { class: 'draw-box' },
          h('p', {}, 'El sorteo ya se hizo. Cada quien puede ver a quién le regala.'),
          h(
            'button',
            {
              class: 'btn btn-ghost',
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: '¿Reiniciar el sorteo?',
                  text: 'Se borrarán todas las asignaciones y tendrás que sortear de nuevo. Las wishlists se conservan. Avísale al grupo, porque a varios les tocará otra persona.',
                  confirm: 'Reiniciar sorteo',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api(`/api/groups/${gid}/draw/reset`, { method: 'POST' });
                  toast('Sorteo reiniciado');
                  await refreshGroup({ groups: true });
                } catch (e) {
                  toast(e.message, 'error');
                }
              },
            },
            'Reiniciar sorteo'
          )
        )
      : h(
          'div',
          { class: 'draw-box' },
          h(
            'p',
            {},
            n < 3
              ? `Hay ${n} ${n === 1 ? 'participante' : 'participantes'}. Se necesitan al menos 3 para sortear.`
              : pending
                ? `Hay ${n} participantes y ${pending} aún no ${pending === 1 ? 'elige' : 'eligen'} su nombre. Puedes sortear ya: verán a quién le regalan en cuanto entren.`
                : `Los ${n} participantes ya eligieron su nombre. A cada quien le tocará otra persona al azar y nadie podrá ver las asignaciones de los demás.`
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
                  title: '¿Hacer el sorteo?',
                  text: `Se sortearán ${n} participantes. Después ya no podrás agregar ni quitar personas, a menos que reinicies el sorteo.`,
                  confirm: 'Hacer el sorteo',
                });
                if (!ok) return;
                busy(btn, true, 'Sorteando…');
                try {
                  await api(`/api/groups/${gid}/draw`, { method: 'POST' });
                  toast('¡Sorteo hecho! Ya cada quien puede ver a quién le regala.');
                  await refreshGroup({ groups: true });
                } catch (ex) {
                  toast(ex.message, 'error');
                  busy(btn, false);
                }
              },
            },
            'Hacer el sorteo'
          )
        );

    // --- Datos del intercambio ---
    const infoErr = h('p', { class: 'form-error', role: 'alert' });
    const fName = h('input', { class: 'input', required: true, maxlength: 80, value: g.name });
    const fDate = h('input', { class: 'input', type: 'date', value: g.eventDate || '' });
    const fBudget = h('input', { class: 'input', inputmode: 'decimal', value: g.budget !== null ? String(g.budget) : '', placeholder: 'Sin límite' });
    const fCur = currencySelect(g.currency);
    const fDesc = h('textarea', { class: 'input', maxlength: 500 }, g.description || '');
    const infoBtn = h('button', { class: 'btn', type: 'submit' }, 'Guardar cambios');
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
            toast('Cambios guardados');
            await refreshGroup({ groups: true });
          } catch (ex) {
            infoErr.textContent = ex.message;
            busy(infoBtn, false);
          }
        },
      },
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Nombre del intercambio'), fName), h('label', { class: 'field' }, h('span', {}, 'Fecha'), fDate)),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Presupuesto por regalo'), fBudget), h('label', { class: 'field' }, h('span', {}, 'Moneda'), fCur)),
      h('label', { class: 'field' }, h('span', {}, 'Notas para el grupo'), fDesc),
      h('div', { class: 'form-row' }, infoBtn),
      infoErr
    );

    return [
      inviteBlock,
      peopleBlock,
      h('div', { class: 'admin-block' }, h('h3', {}, 'Sorteo'), drawBox),
      h('div', { class: 'admin-block' }, h('h3', {}, 'Datos del intercambio'), infoForm),
      h(
        'div',
        { class: 'danger-zone' },
        h('p', {}, 'Borrar el intercambio elimina participantes, sorteo y wishlists. No se puede deshacer.'),
        h(
          'button',
          {
            class: 'btn btn-ghost danger-btn',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: `¿Borrar “${g.name}”?`,
                text: 'Se eliminarán participantes, sorteo y wishlists. No se puede deshacer.',
                confirm: 'Borrar intercambio',
                danger: true,
              });
              if (!ok) return;
              try {
                await api(`/api/groups/${gid}`, { method: 'DELETE' });
                toast('Intercambio borrado');
                state.detail = null;
                await loadGroups();
                location.hash = '#/';
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          },
          'Borrar intercambio'
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
      const extra = g.drawn ? ' Esa cuenta ya pudo ver a quién le regala este nombre; si fue un error, considera reiniciar el sorteo.' : '';
      const ok = await confirmDialog({
        title: `¿Liberar “${p.name}”?`,
        text: `${p.account || 'La cuenta actual'} dejará de estar ligada a este nombre, y el nombre volverá a aparecer en el enlace del grupo para que la persona correcta lo elija.${extra}`,
        confirm: 'Liberar nombre',
        danger: true,
      });
      if (ok) act(() => api(`/api/groups/${g.id}/members/${p.id}/release`, { method: 'POST' }), `“${p.name}” quedó libre`);
    };
    const claimMine = async () => {
      const ok = await confirmDialog({
        title: `¿Eres ${p.name}?`,
        text: `Tu cuenta ${state.user.email} quedará ligada a este nombre y entrarás al sorteo.`,
        confirm: `Sí, soy ${p.name}`,
      });
      if (ok) act(() => api(`/api/invites/${g.inviteToken}/claim`, { method: 'POST', body: { memberId: p.id } }), `Ya participas como ${p.name}`);
    };
    const remove = async () => {
      const ok = await confirmDialog({
        title: `¿Quitar a ${p.name}?`,
        text: 'Se quitará del intercambio junto con su wishlist.',
        confirm: 'Quitar',
        danger: true,
      });
      if (ok) act(() => api(`/api/groups/${g.id}/members/${p.id}`, { method: 'DELETE' }), `${p.name} ya no está en el intercambio`);
    };
    const view = () => {
      tr.replaceChildren(
        h('td', { class: 'person-name' }, p.name, p.isMe ? ' (tú)' : ''),
        h('td', { class: 'email' }, p.joined ? h('span', { class: 'pill in' }, p.account || 'Ya entró') : h('span', { class: 'pill' }, 'Pendiente')),
        h(
          'td',
          { class: 'actions' },
          h('button', { class: 'btn-text', type: 'button', onclick: edit }, 'Editar'),
          !d.me && !p.joined ? h('button', { class: 'btn-text', type: 'button', onclick: claimMine }, 'Soy yo') : null,
          p.joined ? h('button', { class: 'btn-text', type: 'button', onclick: release }, 'Liberar') : null,
          h(
            'button',
            { class: 'btn-text danger', type: 'button', disabled: g.drawn, title: g.drawn ? 'Reinicia el sorteo para quitar a alguien' : null, onclick: remove },
            'Quitar'
          )
        )
      );
    };
    const edit = () => {
      const nameInput = h('input', { class: 'input', value: p.name, maxlength: 60, 'aria-label': 'Nombre' });
      const save = h('button', { class: 'btn-text', type: 'button' }, 'Guardar');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(`/api/groups/${g.id}/members/${p.id}`, { method: 'PATCH', body: { name: nameInput.value } });
          toast('Nombre actualizado');
          await refreshGroup({ groups: true });
        } catch (e) {
          toast(e.message, 'error');
          save.disabled = false;
        }
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save.click();
      });
      tr.replaceChildren(
        h('td', { colspan: 2 }, nameInput),
        h('td', { class: 'actions' }, save, h('button', { class: 'btn-text', type: 'button', onclick: view }, 'Cancelar'))
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
        ['MXN', 'Pesos mexicanos (MXN)'],
        ['USD', 'Dólares (USD)'],
        ['EUR', 'Euros (EUR)'],
        ['GBP', 'Libras (GBP)'],
      ].map(([v, t]) => h('option', { value: v, selected: v === value }, t))
    );
  }

  // -------------------------------------------------------------------------
  // Crear intercambio
  // -------------------------------------------------------------------------
  function renderCreate() {
    document.title = 'Crear intercambio · Intercambio navideño';
    state.detail = null;
    const err = h('p', { class: 'form-error', role: 'alert' });
    const fName = h('input', { class: 'input', required: true, maxlength: 80, placeholder: 'Ej. Posada de la familia' });
    const fDate = h('input', { class: 'input', type: 'date' });
    const fBudget = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'Sin límite' });
    const fCur = currencySelect('MXN');
    const fDesc = h('textarea', { class: 'input', maxlength: 500, placeholder: 'Lugar, hora o reglas. Ej. nada de ropa.' });
    const rowsBox = h('div', { class: 'person-rows' });
    const count = h('p', { class: 'hint' });

    const meCheck = h('input', { type: 'checkbox', checked: true });
    const meName = h('input', { class: 'input', value: state.user.name || '', maxlength: 60, placeholder: 'Tu nombre en el grupo', 'aria-label': 'Tu nombre en el grupo' });

    const updateCount = () => {
      const others = [...rowsBox.querySelectorAll('input')].filter((i) => i.value.trim()).length;
      const total = others + (meCheck.checked ? 1 : 0);
      count.textContent = `${total} ${total === 1 ? 'persona' : 'personas'} en total. Se necesitan al menos 3 para el sorteo; puedes agregar más después.`;
    };
    meCheck.addEventListener('change', () => {
      meName.disabled = !meCheck.checked;
      updateCount();
    });
    meName.addEventListener('input', updateCount);

    const addRow = (name = '', after = null, focus = false) => {
      const input = h('input', { class: 'input', value: name, maxlength: 60, placeholder: 'Nombre', 'aria-label': 'Nombre de un participante', oninput: updateCount });
      const row = h(
        'div',
        { class: 'person-row' },
        input,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Quitar de la lista', onclick: () => { row.remove(); updateCount(); } }, svg(ICON_X))
      );
      // Pegar una lista (un nombre por línea) crea una fila por nombre.
      input.addEventListener('paste', (e) => {
        const lines = (e.clipboardData?.getData('text') || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) return;
        e.preventDefault();
        input.value = lines[0];
        let prev = row;
        for (const l of lines.slice(1)) prev = addRow(l, prev);
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

    const submit = h('button', { class: 'btn', type: 'submit' }, 'Crear intercambio');
    const form = h(
      'form',
      {
        class: 'stack-form roomy',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const participants = [...rowsBox.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean).map((name) => ({ name }));
          busy(submit, true, 'Creando…');
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
            state.openAdmin = 'Intercambio creado. Ahora comparte el enlace con el grupo.';
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
        h('h2', {}, 'El evento'),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Nombre del intercambio'), fName), h('label', { class: 'field' }, h('span', {}, 'Fecha'), fDate)),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Presupuesto por regalo'), fBudget), h('label', { class: 'field' }, h('span', {}, 'Moneda'), fCur)),
        h('label', { class: 'field' }, h('span', {}, 'Notas para el grupo'), fDesc)
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Tú'),
        h('label', { class: 'check-row' }, meCheck, 'Yo también participo en el sorteo'),
        meName
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Los demás participantes'),
        h('p', { class: 'hint' }, 'Escribe solo los nombres, tal como quieres que los vea el grupo. Puedes pegar una lista con un nombre por línea.'),
        rowsBox,
        count,
        h('div', {}, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => addRow('', null, true) }, '+ Agregar otra persona'))
      ),
      h('div', { class: 'create-actions' }, submit, h('a', { class: 'btn btn-ghost', href: '#/' }, 'Cancelar')),
      err
    );

    state.$main.replaceChildren(
      h(
        'section',
        { class: 'create' },
        h('h1', {}, 'Crear intercambio'),
        h('p', {}, 'Escribe los nombres del grupo. Después tendrás un enlace para compartir: cada quien entra con su cuenta de Google y elige su nombre.'),
        form
      )
    );
    fName.focus();
  }

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------
  async function boot() {
    try {
      state.config = await api('/api/config');
    } catch (e) {
      $app.replaceChildren(h('p', { class: 'loading', style: 'padding:32px' }, e.message));
      return;
    }
    try {
      state.user = (await api('/api/me')).user;
    } catch {
      state.user = null;
    }
    if (state.user) startApp();
    else renderLogin();
  }
  boot();
})();
