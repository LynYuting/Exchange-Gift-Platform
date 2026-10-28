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

  function toast(msg, kind = '') {
    const t = h('div', { class: `toast ${kind}` }, msg);
    $toasts.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 5000 : 3000);
  }

  function confirmDialog({ title, text, confirm = 'Confirmar', danger = false }) {
    return new Promise((resolve) => {
      const dlg = h(
        'dialog',
        { 'aria-labelledby': 'dlg-title' },
        h('h2', { id: 'dlg-title' }, title),
        h('p', {}, text),
        h(
          'div',
          { class: 'actions' },
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

  function showPhoto(src, alt) {
    const dlg = h(
      'dialog',
      { class: 'photo', 'aria-label': alt },
      h('img', { src, alt }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => dlg.close() }, 'Cerrar')
    );
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
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

    $app.replaceChildren(
      h(
        'div',
        { class: 'login' },
        h(
          'section',
          { class: 'login-copy' },
          h('h1', {}, 'Intercambio navideño'),
          h('p', {}, 'Entra con tu cuenta de Google para ver a quién le regalas y qué le gustaría recibir.'),
          actions
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
    return { name: 'home' };
  }

  function route() {
    if (!state.user) return;
    const r = currentRoute();
    renderSide();
    if (r.name === 'create') return renderCreate();
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
        h('p', {}, 'Si alguien te invitó, pídele que te registre con este correo: ', h('code', {}, state.user.email)),
        h('p', {}, 'O crea uno y agrega a tu grupo.'),
        h('div', {}, h('a', { class: 'btn', href: '#/nuevo' }, 'Crear intercambio'))
      )
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
        d.group.isOrganizer ? adminSection(d) : null,
      ].filter(Boolean)
    );
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
      h('h1', {}, g.name),
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
          note: 'No estás en la lista de participantes, así que no entras al sorteo. Si quieres participar, agrégate abajo con tu correo.',
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
  function itemRow(item, { own, currency }) {
    const li = h('li', { class: 'item' });
    const thumb = h(
      'div',
      { class: 'thumb' },
      item.photoUrl
        ? h('img', {
            src: item.photoUrl,
            alt: `Foto de ${item.name}`,
            loading: 'lazy',
            onclick: () => showPhoto(item.photoUrl, `Foto de ${item.name}`),
          })
        : svg(ICON_GIFT)
    );
    const sub = h(
      'div',
      { class: 'item-sub' },
      item.cost !== null ? h('span', { class: 'item-cost' }, fmtMoney(item.cost, currency)) : h('span', {}, 'Sin precio'),
      item.link ? h('a', { href: item.link, target: '_blank', rel: 'noopener noreferrer nofollow' }, `Ver en ${hostOf(item.link)}`) : null
    );
    li.append(thumb, h('div', {}, h('p', { class: 'item-name' }, item.name), sub));
    if (own) {
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
        )
      );
    }
    return li;
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
    return h(
      'section',
      {},
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, 'Mi wishlist'),
        h('p', {}, 'Solo la ve la persona a la que le tocas.')
      ),
      items.length
        ? h('ul', { class: 'items' }, items.map((i) => itemRow(i, { own: true, currency: cur })))
        : h('p', { class: 'empty' }, 'Agrega ideas de regalo para que la persona a la que le tocaste sepa qué darte.'),
      form
    );
  }

  function receiverWishlistSection(d) {
    const cur = d.group.currency;
    const name = d.receiver.name;
    return h(
      'section',
      {},
      h('div', { class: 'section-head' }, h('h2', {}, `Wishlist de ${name}`), h('p', {}, 'Ideas que le gustaría recibir.')),
      d.receiverWishlist.length
        ? h('ul', { class: 'items' }, d.receiverWishlist.map((i) => itemRow(i, { own: false, currency: cur })))
        : h('p', { class: 'empty' }, `${name} todavía no agrega ideas. Vuelve a revisar más tarde.`)
    );
  }

  // -------------------------------------------------------------------------
  // Panel del organizador
  // -------------------------------------------------------------------------
  function adminSection(d) {
    const g = d.group;
    const gid = g.id;
    const n = d.participants.length;

    // --- Participantes ---
    const rows = d.participants.map((p) => personRow(d, p));
    const addErr = h('p', { class: 'form-error', role: 'alert' });
    const addName = h('input', { class: 'input', placeholder: 'Nombre que verá el grupo', maxlength: 60, required: true, disabled: g.drawn });
    const addEmail = h('input', { class: 'input', type: 'email', placeholder: 'correo@gmail.com', maxlength: 254, required: true, disabled: g.drawn });
    const addBtn = h('button', { class: 'btn', type: 'submit', disabled: g.drawn }, 'Agregar participante');
    const addForm = h(
      'form',
      {
        class: 'add-person',
        onsubmit: async (e) => {
          e.preventDefault();
          addErr.textContent = '';
          busy(addBtn, true, 'Agregando…');
          try {
            await api(`/api/groups/${gid}/members`, { method: 'POST', body: { name: addName.value, email: addEmail.value } });
            toast(`${addName.value.trim()} se agregó al intercambio`);
            await refreshGroup({ groups: true });
          } catch (ex) {
            addErr.textContent = ex.message;
            busy(addBtn, false);
          }
        },
      },
      h('label', { class: 'field' }, h('span', {}, 'Nombre'), addName),
      h('label', { class: 'field' }, h('span', {}, 'Correo de Google'), addEmail),
      addBtn
    );

    // --- Sorteo ---
    const drawBox = g.drawn
      ? h(
          'div',
          { class: 'draw-box' },
          h('p', {}, `El sorteo ya se hizo. Cada quien puede ver a quién le regala.`),
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
              : `Hay ${n} participantes. Cuando estén todos, haz el sorteo: a cada quien le tocará otra persona al azar y nadie podrá ver las asignaciones de los demás.`
          ),
          h(
            'button',
            {
              class: 'btn btn-red',
              type: 'button',
              disabled: n < 3,
              onclick: async (e) => {
                const ok = await confirmDialog({
                  title: '¿Hacer el sorteo?',
                  text: `Se sortearán ${n} participantes. Después ya no podrás agregar ni quitar personas, a menos que reinicies el sorteo.`,
                  confirm: 'Hacer el sorteo',
                });
                if (!ok) return;
                busy(e.target, true, 'Sorteando…');
                try {
                  await api(`/api/groups/${gid}/draw`, { method: 'POST' });
                  toast('¡Sorteo hecho! Ya cada quien puede ver a quién le regala.');
                  await refreshGroup({ groups: true });
                } catch (ex) {
                  toast(ex.message, 'error');
                  busy(e.target, false);
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
        style: 'display:flex;flex-direction:column;gap:14px',
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

    const link = location.origin + location.pathname;
    return h(
      'section',
      { class: 'admin', 'aria-labelledby': 'admin-title' },
      h(
        'div',
        {},
        h('h2', { id: 'admin-title' }, 'Administrar intercambio'),
        h('p', { class: 'admin-note' }, 'Solo tú ves esta sección porque organizas el grupo. Aun así, tampoco puedes ver a quién le tocó cada quien.')
      ),
      h(
        'div',
        {},
        h('h3', {}, 'Participantes'),
        h('p', { class: 'admin-note', style: 'margin:-4px 0 14px' }, 'El nombre que escribas es el que verá todo el grupo. Cada persona entra con la cuenta de Google de ese correo.'),
        h(
          'table',
          { class: 'people' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Correo'), h('th', {}, 'Estado'), h('th', {}, h('span', { class: 'sr-only' }, 'Acciones')))),
          h('tbody', {}, rows)
        ),
        g.drawn ? h('p', { class: 'admin-note' }, 'Para agregar o quitar personas, primero reinicia el sorteo.') : addForm,
        addErr
      ),
      h('div', {}, h('h3', {}, 'Sorteo'), drawBox),
      h(
        'div',
        {},
        h('h3', {}, 'Invita al grupo'),
        h(
          'div',
          { class: 'share' },
          h('code', {}, link),
          h(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  toast('Enlace copiado');
                } catch {
                  toast('No se pudo copiar. Selecciona el enlace y cópialo.', 'error');
                }
              },
            },
            'Copiar enlace'
          )
        ),
        h('p', { class: 'admin-note' }, 'Comparte este enlace. Cada quien verá este intercambio al entrar con su correo registrado.')
      ),
      h('div', {}, h('h3', {}, 'Datos del intercambio'), infoForm),
      h(
        'div',
        { class: 'danger-zone' },
        h('p', {}, 'Borrar el intercambio elimina participantes, sorteo y wishlists. No se puede deshacer.'),
        h(
          'button',
          {
            class: 'btn btn-ghost',
            type: 'button',
            style: 'color:var(--noche)',
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
      )
    );
  }

  function personRow(d, p) {
    const g = d.group;
    const tr = h('tr');
    const view = () => {
      tr.replaceChildren(
        h('td', {}, p.name, p.isMe ? ' (tú)' : ''),
        h('td', { class: 'email' }, p.email),
        h('td', {}, h('span', { class: `pill${p.joined ? ' in' : ''}` }, p.joined ? 'Ya entró' : 'Aún no entra')),
        h(
          'td',
          { class: 'actions' },
          h('button', { class: 'btn-text', type: 'button', onclick: edit }, 'Editar'),
          h(
            'button',
            {
              class: 'btn-text danger',
              type: 'button',
              disabled: g.drawn,
              title: g.drawn ? 'Reinicia el sorteo para quitar a alguien' : null,
              onclick: async () => {
                const ok = await confirmDialog({
                  title: `¿Quitar a ${p.name}?`,
                  text: 'Se quitará del intercambio junto con su wishlist.',
                  confirm: 'Quitar',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api(`/api/groups/${g.id}/members/${p.id}`, { method: 'DELETE' });
                  toast(`${p.name} ya no está en el intercambio`);
                  await refreshGroup({ groups: true });
                } catch (e) {
                  toast(e.message, 'error');
                }
              },
            },
            'Quitar'
          )
        )
      );
    };
    const edit = () => {
      const n = h('input', { class: 'input', value: p.name, maxlength: 60, 'aria-label': 'Nombre' });
      const m = h('input', { class: 'input', type: 'email', value: p.email, maxlength: 254, 'aria-label': 'Correo' });
      const save = h('button', { class: 'btn-text', type: 'button' }, 'Guardar');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(`/api/groups/${g.id}/members/${p.id}`, { method: 'PATCH', body: { name: n.value, email: m.value } });
          toast('Participante actualizado');
          await refreshGroup({ groups: true });
        } catch (e) {
          toast(e.message, 'error');
          save.disabled = false;
        }
      });
      tr.replaceChildren(
        h('td', {}, n),
        h('td', {}, m),
        h('td', {}, h('span', { class: `pill${p.joined ? ' in' : ''}` }, p.joined ? 'Ya entró' : 'Aún no entra')),
        h('td', { class: 'actions' }, save, h('button', { class: 'btn-text', type: 'button', onclick: view }, 'Cancelar'))
      );
      n.focus();
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

    const updateCount = () => {
      const filled = [...rowsBox.children].filter((r) => r.querySelector('[name=pname]').value.trim() || r.querySelector('[name=pemail]').value.trim()).length;
      count.textContent = `${filled} ${filled === 1 ? 'persona' : 'personas'} en la lista. Se necesitan al menos 3 para el sorteo; puedes agregar más después.`;
    };
    const addRow = (name = '', email = '', focus = false) => {
      const n = h('input', { class: 'input', name: 'pname', value: name, maxlength: 60, placeholder: 'Nombre que verá el grupo', 'aria-label': 'Nombre', oninput: updateCount });
      const m = h('input', { class: 'input', name: 'pemail', type: 'email', value: email, maxlength: 254, placeholder: 'correo@gmail.com', 'aria-label': 'Correo de Google', oninput: updateCount });
      const row = h(
        'div',
        { class: 'person-row' },
        n,
        m,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Quitar de la lista', onclick: () => { row.remove(); updateCount(); } }, svg(ICON_X))
      );
      rowsBox.append(row);
      if (focus) n.focus();
      updateCount();
    };
    addRow(state.user.name || '', state.user.email);
    addRow();
    addRow();

    const submit = h('button', { class: 'btn', type: 'submit' }, 'Crear intercambio');
    const form = h(
      'form',
      {
        style: 'display:flex;flex-direction:column;gap:22px',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const participants = [];
          for (const r of rowsBox.children) {
            const name = r.querySelector('[name=pname]').value.trim();
            const email = r.querySelector('[name=pemail]').value.trim();
            if (!name && !email) continue;
            if (!name || !email) {
              err.textContent = `Falta ${name ? 'el correo' : 'el nombre'} de ${name || email}.`;
              return;
            }
            participants.push({ name, email });
          }
          busy(submit, true, 'Creando…');
          try {
            const { id } = await api('/api/groups', {
              method: 'POST',
              body: { name: fName.value, eventDate: fDate.value, budget: fBudget.value, currency: fCur.value, description: fDesc.value, participants },
            });
            await loadGroups();
            toast('Intercambio creado');
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
        h('h2', {}, 'Participantes'),
        h('p', { class: 'hint' }, 'Tú ya estás en la lista. Si solo vas a organizar, quítate.'),
        rowsBox,
        count,
        h('div', {}, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => addRow('', '', true) }, '+ Agregar otra persona'))
      ),
      h('div', { class: 'create-actions' }, submit, h('a', { class: 'btn btn-ghost', href: '#/' }, 'Cancelar')),
      err
    );

    state.$main.replaceChildren(
      h(
        'section',
        { class: 'create' },
        h('h1', {}, 'Crear intercambio'),
        h('p', {}, 'Registra a cada persona con su nombre y el correo de Google con el que va a entrar. El nombre que escribas es el que verá el grupo.'),
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
