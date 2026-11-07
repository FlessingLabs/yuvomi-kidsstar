/**
 * KidsStar - Seite in Yuvomi
 *
 * Kinder sammeln mit Aktionen Sterne und loesen sie im Sterneshop ein. Die
 * Seite zeigt je nach Rolle - die der KidsStar-Dienst aus Yuvomis /auth/me
 * ableitet, nie die Seite selbst - die Kinderansicht (Heute, Meine Sterne,
 * Sterneshop, Meine Wuensche) oder die Elternansicht (Uebersicht, Aktionen,
 * Shop, Verlauf, Tablet).
 *
 * Alles, was zaehlt (Sterne, Preise, wer was darf), entscheidet der Dienst.
 * Was hier ausgeblendet wird, ist nur Bequemlichkeit.
 */

import { t, getFormatLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderPageHeader, renderPageTitle, renderPageActions, renderPageBody, renderPageSection } from '/utils/page-layout.js';
import { showToast } from '/utils/toast-show.js';
import { createClient, requestId, BASE } from './lib/api.js';
import {
  ACTION_TEMPLATES, ACTION_ICONS, REWARD_ICONS, CODE_SYMBOLS, CODE_LENGTH, PROFILE_SYMBOLS, PROFILE_COLORS,
  ALL_DAYS, WEEKDAYS, starRow, progress, defaultLook, sameCode,
} from './lib/kidsstar.js';
import { shrinkImage } from './lib/image.js';

const ID = 'kidsstar';
const tr = (key, params) => t(`extensions.${ID}.${key}`, params);
const TAB_KEY = `${ID}:tab`;
const STATUS_ICON = { pending: '⏳', proposed: '⏳', approved: '✅', fulfilled: '🎉', rejected: '✖️', cancelled: '↩️', withdrawn: '↩️' };

function readTab(role) {
  try { return localStorage.getItem(`${TAB_KEY}:${role}`); } catch { return null; }
}
function storeTab(role, tab) {
  try { localStorage.setItem(`${TAB_KEY}:${role}`, tab); } catch { /* privates Fenster */ }
}

/** Fehler in einen verstaendlichen Satz; der Grund kommt vom Dienst. */
export function errorText(err) {
  const reason = err?.reason;
  const known = [
    'unreachable', 'yuvomi_unavailable', 'module_forbidden', 'read_only', 'parent_required', 'insufficient_stars',
    'limit_reached', 'not_due_today', 'action_inactive', 'already_decided', 'already_requested', 'price_changed',
    'reward_unavailable', 'required', 'too_long', 'out_of_range', 'invalid_url', 'no_children', 'already_reversed',
    'not_reversible', 'wishes_disabled', 'too_many_wishes', 'unsupported_image', 'body_too_large', 'admin_required',
    'invalid_code', 'tablet_not_configured',
  ];
  return known.includes(reason) ? tr(`error.${reason}`) : tr('error.generic');
}

export async function render(container, { signal } = {}) {
  const ks = createClient();
  const locale = getFormatLocale?.() || 'de-DE';
  const fmtDate = (iso) => {
    try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; }
  };
  const weekdayName = (d) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(Date.UTC(2026, 10, 1 + d)));

  const state = { me: null, tab: null, data: {}, child: null };

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({
      wrap: true,
      title: renderPageTitle(esc(tr('title'))),
      actions: renderPageActions('<div class="ks-tabs" role="tablist" data-ks="tabs"></div>'),
    })
    + renderPageBody({ className: 'ks', content: renderPageSection({ content: '<div data-ks="main" aria-busy="true"></div>' }) }));
  const main = container.querySelector('[data-ks="main"]');
  const tabs = container.querySelector('[data-ks="tabs"]');

  const html = (el, markup) => { el.replaceChildren(); el.insertAdjacentHTML('beforeend', markup); };
  const toastError = (err) => { if (err?.name !== 'AbortError') showToast(errorText(err), 'danger'); };
  const icons = (el) => { if (window.lucide) window.lucide.createIcons({ el }); };

  // ------------------------------------------------------------------
  // Laden und Reiter
  // ------------------------------------------------------------------

  const TABS = {
    child: [['today', '☀️'], ['stars', '⭐'], ['shop', '🎁'], ['wishes', '💭']],
    parent: [['overview', '🏠'], ['actions', '✅'], ['rewards', '🎁'], ['history', '📜'], ['tablet', '📱']],
  };

  async function boot() {
    main.setAttribute('aria-busy', 'true');
    try {
      state.me = await ks.get('/me', { signal });
      if (signal?.aborted) return;
      const role = state.me.role;
      if (role === 'other') {
        tabs.replaceChildren();
        return html(main, `<div class="ks-empty"><span aria-hidden="true">⭐</span><p>${esc(tr('other.text'))}</p></div>`);
      }
      const list = TABS[role];
      const saved = readTab(role);
      state.tab = list.some(([id]) => id === saved) ? saved : list[0][0];
      renderTabs();
      await show();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return;
      renderLoadError(err);
    } finally {
      main.removeAttribute('aria-busy');
    }
  }

  function renderLoadError(err) {
    const kind = err?.reason === 'module_forbidden' ? 'forbidden' : (err?.reason === 'unreachable' || err?.reason === 'yuvomi_unavailable') ? 'unreachable' : 'failed';
    tabs.replaceChildren();
    html(main, `
      <div class="ks-empty" role="alert">
        <span aria-hidden="true">${kind === 'forbidden' ? '🚫' : '📡'}</span>
        <h2>${esc(tr(`load.${kind}.title`))}</h2>
        <p>${esc(tr(`load.${kind}.text`))}</p>
        <button type="button" class="btn btn--primary" data-act="retry">${esc(tr('action.retry'))}</button>
      </div>`);
  }

  function renderTabs() {
    const role = state.me.role;
    html(tabs, TABS[role].map(([id, icon]) => `
      <button type="button" role="tab" class="ks-tab" data-tab="${id}" aria-selected="${state.tab === id}">
        <span aria-hidden="true">${icon}</span><span>${esc(tr(`tab.${role}.${id}`))}</span>
        <span class="ks-badge" data-badge="${id}" hidden></span>
      </button>`).join(''));
  }

  async function show() {
    const view = state.me.role === 'child' ? CHILD_VIEWS[state.tab] : PARENT_VIEWS[state.tab];
    main.setAttribute('aria-busy', 'true');
    try {
      await view();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return;
      renderLoadError(err);
    } finally {
      main.removeAttribute('aria-busy');
      icons(main);
    }
  }

  function setBadge(id, n) {
    const b = tabs.querySelector(`[data-badge="${id}"]`);
    if (!b) return;
    b.hidden = !n;
    b.textContent = n ? String(n) : '';
  }

  // ------------------------------------------------------------------
  // Dialoge
  // ------------------------------------------------------------------

  /** Native <dialog>: Esc, Fokusfalle und Tastatur bringt der Browser mit. */
  function openDialog(markup, { onSubmit, labelledBy = 'ks-dialog-title' } = {}) {
    const dlg = document.createElement('dialog');
    dlg.className = 'ks-dialog';
    dlg.setAttribute('aria-labelledby', labelledBy);
    dlg.insertAdjacentHTML('beforeend', markup);
    document.body.append(dlg);
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    signal?.addEventListener('abort', close, { once: true });
    const form = dlg.querySelector('form');
    if (form && onSubmit) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const keep = await onSubmit(new FormData(form), form, dlg);
          if (keep !== false) close();
        } catch (err) {
          toastError(err);
          const field = err?.body?.field;
          if (field) form.querySelector(`[name="${field}"]`)?.setAttribute('aria-invalid', 'true');
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }
    dlg.showModal();
    icons(dlg);
    return { dlg, close };
  }

  function dialogShell(title, body, { submit = tr('action.save'), danger = false } = {}) {
    return `
      <form method="dialog" class="ks-form">
        <h2 id="ks-dialog-title">${esc(title)}</h2>
        ${body}
        <div class="ks-form__actions">
          <button type="button" class="btn btn--secondary" data-close>${esc(tr('action.cancel'))}</button>
          <button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${esc(submit)}</button>
        </div>
      </form>`;
  }

  const field = (label, input, hint = '') => `<label class="ks-field"><span>${esc(label)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
  const iconPicker = (name, list, current) => `
    <fieldset class="ks-icons"><legend>${esc(tr('form.icon'))}</legend>
      ${list.map((i) => `<label><input type="radio" name="${name}" value="${esc(i)}"${i === current ? ' checked' : ''}><span aria-hidden="true">${esc(i)}</span><span class="sr-only">${esc(i)}</span></label>`).join('')}
    </fieldset>`;
  const childChecks = (children, selected, name = 'child_ids') => `
    <fieldset class="ks-checks"><legend>${esc(tr('form.children'))}</legend>
      ${children.map((c) => `<label><input type="checkbox" name="${name}" value="${c.id}"${selected.includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('')}
    </fieldset>`;

  // ------------------------------------------------------------------
  // Kinderansicht
  // ------------------------------------------------------------------

  const visual = (item, cls = 'ks-visual') => (item.image
    ? `<span class="${cls}"><img src="${BASE}/images/${esc(item.image)}" alt="" loading="lazy"></span>`
    : `<span class="${cls}" aria-hidden="true">${esc(item.icon || '🎁')}</span>`);

  function goalCard(goal) {
    if (!goal) return '';
    const p = progress(goal.have, goal.stars);
    return `
      <section class="ks-goal" aria-label="${esc(tr('goal.title'))}">
        ${visual(goal, 'ks-visual ks-visual--md')}
        <div class="ks-goal__body">
          <strong>🎯 ${esc(goal.title)}</strong>
          <div class="ks-meter" role="meter" aria-valuemin="0" aria-valuemax="${goal.stars}" aria-valuenow="${goal.have}"><span style="width:${p.pct}%"></span></div>
          <span>${esc(goal.missing ? `${tr('goal.have', { have: goal.have, need: goal.stars })} ${tr('goal.missing', { n: goal.missing })}` : tr('goal.enough'))}</span>
        </div>
      </section>`;
  }

  function balanceBand(b) {
    return `
      <div class="ks-balance">
        <div><span class="ks-balance__n">⭐ ${b.available}</span><span>${esc(tr('balance.available'))}</span></div>
        ${b.reserved ? `<div><span class="ks-balance__n ks-muted">🔒 ${b.reserved}</span><span>${esc(tr('balance.reserved'))}</span></div>` : ''}
      </div>`;
  }

  const CHILD_VIEWS = {
    async today() {
      const d = await ks.get('/today', { signal });
      if (signal?.aborted) return;
      state.data.today = d;
      setBadge('today', d.actions.filter((a) => a.remaining > 0).length);
      const open = d.actions.filter((a) => a.remaining > 0);
      html(main, `
        ${balanceBand(d.balance)}
        <h2 class="ks-h">${esc(tr('child.today'))}</h2>
        ${!d.actions.length ? `<p class="ks-empty"><span aria-hidden="true">🌙</span>${esc(tr('child.nothingToday'))}</p>` : ''}
        ${d.actions.length && !open.length && !d.pending.length ? `<p class="ks-empty"><span aria-hidden="true">🎉</span>${esc(tr('child.allDone'))}</p>` : ''}
        <ul class="ks-actions" role="list">
          ${d.actions.map((a) => `
            <li class="ks-action${a.remaining ? '' : ' is-done'}">
              <span class="ks-action__icon" aria-hidden="true">${esc(a.icon || '⭐')}</span>
              <span class="ks-action__text">
                <strong>${esc(a.title)}</strong>
                <span aria-label="${esc(tr('stars.n', { n: a.stars }))}">${starRow(a.stars)}</span>
                ${a.pending ? `<span class="ks-pill ks-pill--wait">⏳ ${esc(tr('child.waiting'))}</span>` : ''}
                ${a.approved ? `<span class="ks-pill ks-pill--ok">✅ ${esc(tr('child.doneTimes', { n: a.approved }))}</span>` : ''}
              </span>
              ${a.remaining
                ? `<button type="button" class="ks-done" data-act="complete" data-id="${a.id}" aria-label="${esc(tr('child.markDone', { title: a.title }))}">✓</button>`
                : '<span class="ks-done ks-done--off" aria-hidden="true">👍</span>'}
            </li>`).join('')}
        </ul>
        ${d.pending.length ? `
          <h3 class="ks-h3">⏳ ${esc(tr('child.waitingList'))}</h3>
          <ul class="ks-list" role="list">${d.pending.map((c) => `<li><span aria-hidden="true">${esc(c.icon || '⭐')}</span><span>${esc(c.title)} · ${starRow(c.stars)}</span>
            <button type="button" class="btn btn--ghost btn--sm" data-act="cancel-completion" data-id="${c.id}">${esc(tr('action.undo'))}</button></li>`).join('')}</ul>` : ''}
        ${d.rejected.length ? `<ul class="ks-list" role="list">${d.rejected.map((c) => `<li class="ks-bad"><span aria-hidden="true">✖️</span><span>${esc(c.title)}${c.feedback ? ` - ${esc(c.feedback)}` : ''}</span></li>`).join('')}</ul>` : ''}
        ${d.recent.length ? `<h3 class="ks-h3">✨ ${esc(tr('child.recent'))}</h3>
          <ul class="ks-list" role="list">${d.recent.map((e) => `<li><span>+${e.delta} ⭐</span><span>${esc(e.reason)}</span><small>${esc(fmtDate(e.created_at))}</small></li>`).join('')}</ul>` : ''}
        ${goalCard(d.goal)}`);
    },

    async stars() {
      const [l, d] = await Promise.all([ks.get('/ledger?limit=100', { signal }), ks.get('/today', { signal })]);
      if (signal?.aborted) return;
      html(main, `
        ${balanceBand(l.balance)}
        ${goalCard(d.goal)}
        <h2 class="ks-h">${esc(tr('child.history'))}</h2>
        ${ledgerTable(l.entries, { parent: false })}`);
    },

    async shop() {
      const [rewards, redemptions, d] = await Promise.all([ks.get('/rewards', { signal }), ks.get('/redemptions', { signal }), ks.get('/today', { signal })]);
      if (signal?.aborted) return;
      state.data.rewards = rewards;
      state.data.today = d;
      const avail = d.balance.available;
      const open = redemptions.filter((r) => r.status === 'pending' || r.status === 'approved');
      html(main, `
        ${balanceBand(d.balance)}
        ${open.length ? `<h3 class="ks-h3">📦 ${esc(tr('child.myRequests'))}</h3>
          <ul class="ks-list" role="list">${open.map((r) => `<li><span aria-hidden="true">${STATUS_ICON[r.status]}</span><span>${esc(r.title)} · ⭐ ${r.stars}</span><small>${esc(tr(`status.${r.status}`))}</small>
            ${r.status === 'pending' ? `<button type="button" class="btn btn--ghost btn--sm" data-act="cancel-redemption" data-id="${r.id}">${esc(tr('action.withdraw'))}</button>` : ''}</li>`).join('')}</ul>` : ''}
        <h2 class="ks-h">${esc(tr('child.shop'))}</h2>
        ${!rewards.length ? `<p class="ks-empty"><span aria-hidden="true">🛒</span>${esc(tr('child.shopEmpty'))}</p>` : ''}
        <ul class="ks-cards" role="list">
          ${rewards.map((r) => {
            const p = progress(avail, r.stars);
            return `<li><button type="button" class="ks-card${avail >= r.stars && r.available ? ' can' : ''}" data-act="redeem" data-id="${r.id}">
              ${visual(r, 'ks-visual ks-visual--card')}
              <strong>${esc(r.title)}</strong>
              <span class="ks-card__price">⭐ ${r.stars}${d.goal?.reward_id === r.id ? ' 🎯' : ''}</span>
              <span class="ks-meter" aria-hidden="true"><span style="width:${p.pct}%"></span></span>
              ${r.available ? '' : `<small>${esc(tr('child.unavailable'))}</small>`}
            </button></li>`;
          }).join('')}
        </ul>`);
    },

    async wishes() {
      const wishes = await ks.get('/wishes', { signal });
      if (signal?.aborted) return;
      const enabled = state.me.settings.wishes_enabled;
      html(main, `
        <h2 class="ks-h">${esc(tr('child.wishes'))}</h2>
        ${enabled ? `<button type="button" class="btn btn--primary" data-act="new-wish">💭 ${esc(tr('wish.new'))}</button>` : `<p>${esc(tr('error.wishes_disabled'))}</p>`}
        ${!wishes.length ? `<p class="ks-empty"><span aria-hidden="true">💭</span>${esc(tr('wish.none'))}</p>` : ''}
        <ul class="ks-list" role="list">
          ${wishes.map((w) => `<li>
            <span aria-hidden="true">${STATUS_ICON[w.status]}</span>
            <span><strong>${esc(w.title)}</strong>${w.feedback ? `<small>${esc(w.feedback)}</small>` : ''}</span>
            <small>${esc(tr(`status.${w.status}`))}</small>
            ${w.status === 'proposed' ? `<button type="button" class="btn btn--ghost btn--sm" data-act="withdraw-wish" data-id="${w.id}">${esc(tr('action.withdraw'))}</button>` : ''}
          </li>`).join('')}
        </ul>`);
    },
  };

  function ledgerTable(entries, { parent, childId } = {}) {
    if (!entries.length) return `<p class="ks-empty"><span aria-hidden="true">📜</span>${esc(tr('history.empty'))}</p>`;
    return `
      <ul class="ks-ledger" role="list">
        ${entries.map((e) => {
          const amount = e.delta ? `${e.delta > 0 ? '+' : '−'}${Math.abs(e.delta)}` : `(${Math.abs(e.reserved_delta)})`;
          return `<li class="${e.delta > 0 ? 'plus' : e.delta < 0 ? 'minus' : ''}">
            <span class="ks-ledger__n">${amount} ⭐</span>
            <span class="ks-ledger__what"><strong>${esc(e.reason || tr(`kind.${e.kind}`))}</strong>
              <small>${esc(tr(`kind.${e.kind}`))} · ${esc(fmtDate(e.created_at))}${e.reversed ? ` · ${esc(tr('history.reversed'))}` : ''}</small></span>
            ${parent && ['earn', 'bonus', 'correction'].includes(e.kind) && !e.reversed && !e.reverses_id
              ? `<button type="button" class="btn btn--ghost btn--sm" data-act="reverse" data-id="${e.id}" data-child="${childId}" data-n="${e.delta}" data-reason="${esc(e.reason)}">${esc(tr('history.reverse'))}</button>` : ''}
          </li>`;
        }).join('')}
      </ul>`;
  }

  function redeemDialog(r) {
    const avail = state.data.today.balance.available;
    const enough = r.available && avail >= r.stars;
    const isGoal = state.data.today.goal?.reward_id === r.id;
    const body = `
      <div class="ks-confirm">
        ${visual(r, 'ks-visual ks-visual--lg')}
        ${r.description ? `<p>${esc(r.description)}</p>` : ''}
        ${r.url ? `<p><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(tr('reward.link'))}</a></p>` : ''}
        <p class="ks-confirm__price">⭐ ${r.stars}</p>
        <p>${esc(enough ? tr('redeem.after', { n: avail - r.stars }) : `${tr('goal.have', { have: Math.min(avail, r.stars), need: r.stars })} ${tr('goal.missing', { n: Math.max(0, r.stars - avail) })}`)}</p>
        ${isGoal ? `<p>🎯 ${esc(tr('goal.isGoal'))}</p>` : `<button type="button" class="btn btn--secondary" data-act="set-goal" data-id="${r.id}">🎯 ${esc(tr('goal.set'))}</button>`}
      </div>`;
    if (!enough) {
      const { dlg } = openDialog(`<div class="ks-form"><h2 id="ks-dialog-title">${esc(r.title)}</h2>${body}
        <div class="ks-form__actions"><button type="button" class="btn btn--secondary" data-close>${esc(tr('action.close'))}</button></div></div>`);
      dlg.addEventListener('click', (e) => onGoal(e, dlg));
      return;
    }
    const rid = requestId();
    const { dlg } = openDialog(dialogShell(tr('redeem.title', { title: r.title }), body, { submit: tr('redeem.confirm') }), {
      onSubmit: async () => {
        try {
          await ks.post('/redemptions', { reward_id: r.id, request_id: rid, expected_stars: r.stars });
          showToast(tr('redeem.done'), 'success');
        } catch (err) {
          if (err.reason === 'price_changed') showToast(tr('error.price_changed'), 'warning');
          else throw err;
        }
        show();
      },
    });
    dlg.addEventListener('click', (e) => onGoal(e, dlg));
  }

  async function onGoal(e, dlg) {
    const b = e.target.closest('[data-act="set-goal"]');
    if (!b) return;
    try {
      await ks.put('/goal', { reward_id: Number(b.dataset.id) });
      showToast(tr('goal.saved'), 'success');
      dlg.close();
      show();
    } catch (err) { toastError(err); }
  }

  function wishDialog() {
    const rid = requestId();
    openDialog(dialogShell(tr('wish.new'), `
      ${field(tr('wish.title'), '<input class="form-input" name="title" maxlength="80" required>')}
      ${field(tr('wish.description'), '<textarea class="form-input" name="description" maxlength="500" rows="3"></textarea>')}
      ${field(tr('wish.url'), '<input class="form-input" name="url" type="url" maxlength="500" inputmode="url" placeholder="https://">', tr('wish.urlHint'))}`,
    { submit: tr('wish.send') }), {
      onSubmit: async (fd) => {
        await ks.post('/wishes', { title: fd.get('title'), description: fd.get('description'), url: fd.get('url'), request_id: rid });
        showToast(tr('wish.sent'), 'success');
        show();
      },
    });
  }

  // ------------------------------------------------------------------
  // Elternansicht
  // ------------------------------------------------------------------

  async function children() {
    state.data.children ??= await ks.get('/children', { signal });
    return state.data.children;
  }
  const childName = (id) => state.data.children?.find((c) => c.id === id)?.name ?? `#${id}`;

  const PARENT_VIEWS = {
    async overview() {
      const [o, completions, wishes, redemptions] = await Promise.all([
        ks.get('/overview', { signal }), ks.get('/completions?status=pending', { signal }),
        ks.get('/wishes?status=proposed', { signal }), ks.get('/redemptions', { signal }),
      ]);
      if (signal?.aborted) return;
      state.data.children = o.children.map((c) => ({ id: c.id, name: c.name, avatar_color: c.avatar_color }));
      const pendingRed = redemptions.filter((r) => r.status === 'pending');
      const toFulfil = redemptions.filter((r) => r.status === 'approved');
      setBadge('overview', completions.length + wishes.length + pendingRed.length);
      html(main, `
        ${!o.children.length ? `<div class="ks-empty"><span aria-hidden="true">👶</span><p>${esc(tr('parent.noChildren'))}</p></div>` : ''}
        <ul class="ks-kids" role="list">
          ${o.children.map((c) => `<li class="ks-kid">
            <span class="ks-kid__dot" style="background:${esc(c.avatar_color || 'var(--active-module-accent)')}" aria-hidden="true"></span>
            <strong>${esc(c.name)}</strong>
            <span class="ks-kid__n">⭐ ${c.balance.available}${c.balance.reserved ? ` <small>🔒 ${c.balance.reserved}</small>` : ''}</span>
            <small>${esc(tr('parent.todayDone', { done: c.today_done, total: c.today_total }))}${c.pending ? ` · ⏳ ${c.pending}` : ''}</small>
            ${c.goal ? `<small>🎯 ${esc(c.goal.title)}: ${c.goal.have}/${c.goal.stars}</small>` : ''}
            <button type="button" class="btn btn--ghost btn--sm" data-act="bonus" data-child="${c.id}">⭐ ${esc(tr('parent.bonus'))}</button>
          </li>`).join('')}
        </ul>
        ${!o.actions && o.children.length ? `<div class="ks-hint">${esc(tr('parent.startHint'))} <button type="button" class="btn btn--primary btn--sm" data-act="starter">${esc(tr('parent.starter'))}</button></div>` : ''}

        <h2 class="ks-h">⏳ ${esc(tr('parent.inbox.completions'))} <span class="ks-count">${completions.length}</span></h2>
        ${completions.length ? `<ul class="ks-list ks-inbox" role="list">${completions.map((c) => `<li>
          <span aria-hidden="true">${esc(c.icon || '⭐')}</span>
          <span><strong>${esc(c.title)}</strong><small>${esc(childName(c.child_id))} · ${esc(fmtDate(c.created_at))} · ⭐ ${c.stars}</small></span>
          <span class="ks-row-actions">
            <button type="button" class="btn btn--primary btn--sm" data-act="approve-completion" data-id="${c.id}">${esc(tr('action.approve'))}</button>
            <button type="button" class="btn btn--secondary btn--sm" data-act="reject-completion" data-id="${c.id}">${esc(tr('action.reject'))}</button>
          </span></li>`).join('')}</ul>` : `<p class="ks-muted">${esc(tr('parent.inbox.none'))}</p>`}

        <h2 class="ks-h">🎁 ${esc(tr('parent.inbox.redemptions'))} <span class="ks-count">${pendingRed.length}</span></h2>
        ${pendingRed.length ? `<ul class="ks-list ks-inbox" role="list">${pendingRed.map((r) => `<li>
          <span aria-hidden="true">${esc(r.icon || '🎁')}</span>
          <span><strong>${esc(r.title)}</strong><small>${esc(childName(r.child_id))} · ⭐ ${r.stars} · ${esc(fmtDate(r.created_at))}</small></span>
          <span class="ks-row-actions">
            <button type="button" class="btn btn--primary btn--sm" data-act="redemption" data-do="approve" data-id="${r.id}">${esc(tr('action.approve'))}</button>
            <button type="button" class="btn btn--secondary btn--sm" data-act="redemption" data-do="reject" data-id="${r.id}">${esc(tr('action.reject'))}</button>
          </span></li>`).join('')}</ul>` : `<p class="ks-muted">${esc(tr('parent.inbox.none'))}</p>`}

        ${toFulfil.length ? `<h2 class="ks-h">📦 ${esc(tr('parent.inbox.fulfil'))} <span class="ks-count">${toFulfil.length}</span></h2>
          <ul class="ks-list ks-inbox" role="list">${toFulfil.map((r) => `<li>
            <span aria-hidden="true">${esc(r.icon || '🎁')}</span>
            <span><strong>${esc(r.title)}</strong><small>${esc(childName(r.child_id))} · ⭐ ${r.stars} · ${esc(tr('status.approved'))} ${esc(fmtDate(r.decided_at))}</small></span>
            <span class="ks-row-actions">
              <button type="button" class="btn btn--primary btn--sm" data-act="redemption" data-do="fulfill" data-id="${r.id}">${esc(tr('action.fulfil'))}</button>
              <button type="button" class="btn btn--ghost btn--sm" data-act="redemption" data-do="revoke" data-id="${r.id}">${esc(tr('action.revoke'))}</button>
            </span></li>`).join('')}</ul>` : ''}

        <h2 class="ks-h">💭 ${esc(tr('parent.inbox.wishes'))} <span class="ks-count">${wishes.length}</span></h2>
        ${wishes.length ? `<ul class="ks-list ks-inbox" role="list">${wishes.map((w) => `<li>
          <span aria-hidden="true">💭</span>
          <span><strong>${esc(w.title)}</strong><small>${esc(childName(w.child_id))}${w.description ? ` · ${esc(w.description)}` : ''}</small>
            ${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(tr('reward.link'))}</a>` : ''}</span>
          <span class="ks-row-actions">
            <button type="button" class="btn btn--primary btn--sm" data-act="approve-wish" data-id="${w.id}">${esc(tr('wish.approve'))}</button>
            <button type="button" class="btn btn--secondary btn--sm" data-act="reject-wish" data-id="${w.id}">${esc(tr('action.reject'))}</button>
          </span></li>`).join('')}</ul>` : `<p class="ks-muted">${esc(tr('parent.inbox.none'))}</p>`}`);
      state.data.wishes = wishes;
    },

    async actions() {
      const [list, kids] = await Promise.all([ks.get('/actions', { signal }), children()]);
      if (signal?.aborted) return;
      state.data.actions = list;
      html(main, `
        <div class="ks-toolbar">
          <button type="button" class="btn btn--primary" data-act="new-action">＋ ${esc(tr('actions.new'))}</button>
          <button type="button" class="btn btn--secondary" data-act="starter">${esc(tr('parent.starter'))}</button>
        </div>
        ${!list.length ? `<p class="ks-empty"><span aria-hidden="true">✅</span>${esc(tr('actions.none'))}</p>` : ''}
        <ul class="ks-list ks-manage" role="list">
          ${list.map((a) => `<li class="${a.status !== 'active' ? 'is-muted' : ''}">
            <span class="ks-big" aria-hidden="true">${esc(a.icon || '⭐')}</span>
            <span><strong>${esc(a.title)}</strong>
              <small>⭐ ${a.stars} · ${esc(a.repeats ? scheduleText(a) : tr('actions.once'))} · ${esc(a.requires_approval ? tr('actions.withApproval') : tr('actions.direct'))}</small>
              <small>${esc(a.child_ids.map(childName).join(', '))}${a.status !== 'active' ? ` · ${esc(tr(`actions.status.${a.status}`))}` : ''}</small></span>
            <span class="ks-row-actions">
              <button type="button" class="btn btn--ghost btn--sm" data-act="edit-action" data-id="${a.id}">${esc(tr('action.edit'))}</button>
              ${a.status === 'active' ? `<button type="button" class="btn btn--ghost btn--sm" data-act="action-status" data-status="paused" data-id="${a.id}">${esc(tr('actions.pause'))}</button>` : `<button type="button" class="btn btn--ghost btn--sm" data-act="action-status" data-status="active" data-id="${a.id}">${esc(tr('actions.activate'))}</button>`}
              ${a.status !== 'archived' ? `<button type="button" class="btn btn--ghost btn--sm" data-act="action-status" data-status="archived" data-id="${a.id}">${esc(tr('actions.archive'))}</button>` : ''}
            </span>
          </li>`).join('')}
        </ul>`);
      if (!kids.length) main.insertAdjacentHTML('afterbegin', `<p class="ks-hint">${esc(tr('parent.noChildren'))}</p>`);
    },

    async rewards() {
      const [list, kids] = await Promise.all([ks.get('/rewards?archived=1', { signal }), children()]);
      if (signal?.aborted) return;
      state.data.rewardsAll = list;
      html(main, `
        <div class="ks-toolbar"><button type="button" class="btn btn--primary" data-act="new-reward">＋ ${esc(tr('rewards.new'))}</button></div>
        ${!list.length ? `<p class="ks-empty"><span aria-hidden="true">🎁</span>${esc(tr('rewards.none'))}</p>` : ''}
        <ul class="ks-list ks-manage" role="list">
          ${list.map((r) => `<li class="${r.archived || !r.available ? 'is-muted' : ''}">
            ${visual(r, 'ks-visual ks-visual--sm')}
            <span><strong>${esc(r.title)}</strong>
              <small>⭐ ${r.stars} · ${esc(r.all_children ? tr('rewards.allChildren') : r.child_ids.map(childName).join(', '))}${r.available ? '' : ` · ${esc(tr('rewards.unavailable'))}`}${r.archived ? ` · ${esc(tr('rewards.archived'))}` : ''}</small></span>
            <span class="ks-row-actions">
              <button type="button" class="btn btn--ghost btn--sm" data-act="edit-reward" data-id="${r.id}">${esc(tr('action.edit'))}</button>
              <button type="button" class="btn btn--ghost btn--sm" data-act="reward-archive" data-id="${r.id}" data-archived="${r.archived}">${esc(r.archived ? tr('rewards.restore') : tr('rewards.archive'))}</button>
            </span>
          </li>`).join('')}
        </ul>`);
      if (!kids.length) main.insertAdjacentHTML('afterbegin', `<p class="ks-hint">${esc(tr('parent.noChildren'))}</p>`);
    },

    async history() {
      const kids = await children();
      if (signal?.aborted) return;
      if (!kids.length) return html(main, `<p class="ks-empty"><span aria-hidden="true">👶</span>${esc(tr('parent.noChildren'))}</p>`);
      if (!kids.some((c) => c.id === state.child)) state.child = kids[0].id;
      const l = await ks.get(`/ledger?child=${state.child}&limit=200`, { signal });
      if (signal?.aborted) return;
      html(main, `
        <div class="ks-toolbar">
          <label class="ks-field ks-field--inline"><span>${esc(tr('history.child'))}</span>
            <select class="form-input" data-act="pick-child">${kids.map((c) => `<option value="${c.id}"${c.id === state.child ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <button type="button" class="btn btn--primary" data-act="bonus" data-child="${state.child}">⭐ ${esc(tr('parent.bonus'))}</button>
          <button type="button" class="btn btn--secondary" data-act="correction" data-child="${state.child}">✏️ ${esc(tr('history.correction'))}</button>
        </div>
        ${balanceBand(l.balance)}
        ${ledgerTable(l.entries, { parent: true, childId: state.child })}`);
    },

    async tablet() {
      const [kids, profiles, devices, status] = await Promise.all([
        children(), ks.get('/profiles', { signal }), ks.get('/devices', { signal }), ks.get('/tablet-status', { signal }),
      ]);
      if (signal?.aborted) return;
      state.data.profiles = profiles;
      state.data.devices = devices;
      const url = `${location.origin}${BASE}/tablet/`;
      html(main, `
        ${status.ok ? '' : `<div class="ks-hint ks-hint--warn" role="status">⚠️ ${esc(tr(`tablet.status.${status.reason || 'yuvomi_unavailable'}`))}</div>`}
        <p>${esc(tr('tablet.intro'))}</p>
        <p class="ks-mono">${esc(url)}</p>

        <h2 class="ks-h">📱 ${esc(tr('tablet.devices'))}</h2>
        <button type="button" class="btn btn--primary" data-act="new-device"${kids.length ? '' : ' disabled'}>＋ ${esc(tr('tablet.newDevice'))}</button>
        ${!devices.length ? `<p class="ks-muted">${esc(tr('tablet.noDevices'))}</p>` : ''}
        <ul class="ks-list ks-manage" role="list">
          ${devices.map((d) => `<li>
            <span class="ks-big" aria-hidden="true">📱</span>
            <span><strong>${esc(d.name)}</strong>
              <small>${esc(d.paired ? tr('tablet.paired', { date: fmtDate(d.paired_at) }) : tr('tablet.notPaired'))}${d.pairing_open ? ` · ${esc(tr('tablet.codeOpen'))}` : ''}</small>
              <small>${esc(d.child_ids.map(childName).join(', ') || tr('tablet.noProfiles'))} · ${esc(tr('tablet.idle', { n: d.idle_seconds }))}</small></span>
            <span class="ks-row-actions">
              <button type="button" class="btn btn--ghost btn--sm" data-act="edit-device" data-id="${d.id}">${esc(tr('action.edit'))}</button>
              <button type="button" class="btn btn--ghost btn--sm" data-act="pair-device" data-id="${d.id}">${esc(tr('tablet.newCode'))}</button>
              <button type="button" class="btn btn--ghost btn--sm ks-danger" data-act="revoke-device" data-id="${d.id}">${esc(tr('tablet.revoke'))}</button>
            </span>
          </li>`).join('')}
        </ul>

        <h2 class="ks-h">🖼️ ${esc(tr('tablet.profiles'))}</h2>
        <p class="ks-muted">${esc(tr('tablet.profilesIntro'))}</p>
        <ul class="ks-profiles" role="list">
          ${profiles.map((p, i) => {
            const look = defaultLook(i);
            const color = p.color || p.avatar_color || look.color;
            return `<li class="ks-profile">
              <span class="ks-tile" style="--tile:${esc(color)}">${p.image ? `<img src="${BASE}/profile-images/${esc(p.image)}" alt="">` : `<span aria-hidden="true">${esc(p.symbol || look.symbol)}</span>`}</span>
              <strong>${esc(p.name)}</strong>
              <small>${p.has_code ? `🔒 ${esc(tr('tablet.codeOn'))}` : `🔓 ${esc(tr('tablet.codeOff'))}`}</small>
              <span class="ks-row-actions">
                <label class="btn btn--secondary btn--sm ks-upload">${esc(p.image ? tr('tablet.replaceImage') : tr('tablet.uploadImage'))}
                  <input type="file" accept="image/png,image/jpeg,image/webp" data-act="profile-image" data-child="${p.child_id}" class="sr-only"></label>
                ${p.image ? `<button type="button" class="btn btn--ghost btn--sm" data-act="profile-image-remove" data-child="${p.child_id}">${esc(tr('tablet.removeImage'))}</button>` : ''}
                <button type="button" class="btn btn--ghost btn--sm" data-act="profile-look" data-child="${p.child_id}" data-index="${i}">${esc(tr('tablet.look'))}</button>
                <button type="button" class="btn btn--ghost btn--sm" data-act="profile-code" data-child="${p.child_id}">${esc(p.has_code ? tr('tablet.codeChange') : tr('tablet.codeSet'))}</button>
              </span>
            </li>`;
          }).join('')}
        </ul>`);
    },
  };

  function scheduleText(a) {
    const days = a.weekdays === ALL_DAYS ? tr('actions.daily') : WEEKDAYS.filter((d) => a.weekdays & (1 << (d - 1))).map(weekdayName).join(', ');
    return a.per_day > 1 ? `${days} · ${tr('actions.perDay', { n: a.per_day })}` : days;
  }

  // ------------------------------------------------------------------
  // Eltern: Dialoge
  // ------------------------------------------------------------------

  async function actionDialog(a = null, template = null) {
    const kids = await children();
    const base = a ?? {
      title: template ? tr(`template.${template.key}`) : '', description: '', icon: template?.icon ?? '⭐', stars: template?.stars ?? 1,
      repeats: true, weekdays: template?.weekdays ?? ALL_DAYS, per_day: template?.per_day ?? 1,
      requires_approval: template?.requires_approval ?? state.me.settings.default_requires_approval, child_ids: kids.map((c) => c.id),
    };
    const templates = a ? '' : `
      <fieldset class="ks-templates"><legend>${esc(tr('actions.templates'))}</legend>
        ${ACTION_TEMPLATES.map((tp) => `<button type="button" class="btn btn--ghost btn--sm" data-template="${tp.key}">${esc(tp.icon)} ${esc(tr(`template.${tp.key}`))}</button>`).join('')}
      </fieldset>`;
    const { dlg } = openDialog(dialogShell(a ? tr('actions.edit') : tr('actions.new'), `
      ${templates}
      ${field(tr('form.title'), `<input class="form-input" name="title" maxlength="80" required value="${esc(base.title)}">`)}
      ${field(tr('form.description'), `<textarea class="form-input" name="description" maxlength="500" rows="2">${esc(base.description)}</textarea>`)}
      ${iconPicker('icon', ACTION_ICONS.includes(base.icon) ? ACTION_ICONS : [base.icon, ...ACTION_ICONS], base.icon)}
      ${field(tr('form.stars'), `<input class="form-input" name="stars" type="number" min="1" max="1000" step="1" required value="${base.stars}">`)}
      <fieldset class="ks-checks"><legend>${esc(tr('actions.when'))}</legend>
        <label><input type="radio" name="repeats" value="1"${base.repeats ? ' checked' : ''}> ${esc(tr('actions.repeating'))}</label>
        <label><input type="radio" name="repeats" value="0"${base.repeats ? '' : ' checked'}> ${esc(tr('actions.once'))}</label>
      </fieldset>
      <fieldset class="ks-checks ks-days" data-repeat-only><legend>${esc(tr('actions.weekdays'))}</legend>
        ${WEEKDAYS.map((d) => `<label><input type="checkbox" name="day" value="${d}"${base.weekdays & (1 << (d - 1)) ? ' checked' : ''}> ${esc(weekdayName(d))}</label>`).join('')}
      </fieldset>
      <div data-repeat-only>${field(tr('actions.perDayLabel'), `<input class="form-input" name="per_day" type="number" min="1" max="10" step="1" value="${base.per_day}">`)}</div>
      <label class="ks-switch"><input type="checkbox" name="requires_approval"${base.requires_approval ? ' checked' : ''}> ${esc(tr('actions.requiresApproval'))}</label>
      ${childChecks(kids, base.child_ids)}`), {
      onSubmit: async (fd) => {
        const days = fd.getAll('day').map(Number);
        const body = {
          title: fd.get('title'), description: fd.get('description'), icon: fd.get('icon') || '',
          stars: Number(fd.get('stars')), repeats: fd.get('repeats') === '1',
          weekdays: days.reduce((m, d) => m | (1 << (d - 1)), 0) || ALL_DAYS, per_day: Number(fd.get('per_day') || 1),
          requires_approval: fd.get('requires_approval') === 'on', child_ids: fd.getAll('child_ids').map(Number),
        };
        if (a) await ks.patch(`/actions/${a.id}`, body);
        else await ks.post('/actions', body);
        showToast(tr('saved'), 'success');
        show();
      },
    });
    const form = dlg.querySelector('form');
    const syncRepeat = () => {
      const rep = form.querySelector('[name="repeats"]:checked')?.value === '1';
      for (const el of form.querySelectorAll('[data-repeat-only]')) el.hidden = !rep;
    };
    form.addEventListener('change', syncRepeat);
    syncRepeat();
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-template]');
      if (!b) return;
      const tp = ACTION_TEMPLATES.find((x) => x.key === b.dataset.template);
      form.title.value = tr(`template.${tp.key}`);
      form.stars.value = tp.stars;
      form.per_day.value = tp.per_day;
      form.requires_approval.checked = tp.requires_approval;
      const icon = form.querySelector(`[name="icon"][value="${CSS.escape(tp.icon)}"]`);
      if (icon) icon.checked = true;
      for (const box of form.querySelectorAll('[name="day"]')) box.checked = Boolean(tp.weekdays & (1 << (Number(box.value) - 1)));
    });
  }

  async function starterPack() {
    const kids = await children();
    if (!kids.length) return showToast(tr('parent.noChildren'), 'warning');
    openDialog(dialogShell(tr('parent.starter'), `
      <p>${esc(tr('parent.starterText'))}</p>
      <ul class="ks-list">${ACTION_TEMPLATES.map((tp) => `<li><label><input type="checkbox" name="tpl" value="${tp.key}" checked> ${esc(tp.icon)} ${esc(tr(`template.${tp.key}`))} · ⭐ ${tp.stars}</label></li>`).join('')}</ul>
      ${childChecks(kids, kids.map((c) => c.id))}`, { submit: tr('parent.starterCreate') }), {
      onSubmit: async (fd) => {
        const childIds = fd.getAll('child_ids').map(Number);
        for (const key of fd.getAll('tpl')) {
          const tp = ACTION_TEMPLATES.find((x) => x.key === key);
          await ks.post('/actions', {
            title: tr(`template.${tp.key}`), icon: tp.icon, stars: tp.stars, repeats: true, weekdays: tp.weekdays,
            per_day: tp.per_day, requires_approval: tp.requires_approval, child_ids: childIds,
          });
        }
        showToast(tr('saved'), 'success');
        state.tab = 'actions';
        storeTab('parent', 'actions');
        renderTabs();
        show();
      },
    });
  }

  async function rewardDialog(r = null, { wish = null } = {}) {
    const kids = await children();
    const base = r ?? {
      title: wish?.title ?? '', description: wish?.description ?? '', icon: '🎁', url: wish?.url ?? '', stars: 10, available: true,
      all_children: !wish, child_ids: wish ? [wish.child_id] : [],
    };
    const title = wish ? tr('wish.approveTitle', { name: childName(wish.child_id) }) : r ? tr('rewards.edit') : tr('rewards.new');
    const { dlg } = openDialog(dialogShell(title, `
      ${field(tr('form.title'), `<input class="form-input" name="title" maxlength="80" required value="${esc(base.title)}">`)}
      ${field(tr('form.description'), `<textarea class="form-input" name="description" maxlength="500" rows="2">${esc(base.description)}</textarea>`)}
      ${iconPicker('icon', REWARD_ICONS.includes(base.icon) || !base.icon ? REWARD_ICONS : [base.icon, ...REWARD_ICONS], base.icon)}
      ${field(tr('form.price'), `<input class="form-input" name="stars" type="number" min="1" max="100000" step="1" required value="${base.stars}">`)}
      ${field(tr('wish.url'), `<input class="form-input" name="url" type="url" maxlength="500" value="${esc(base.url)}">`)}
      ${r ? field(tr('rewards.image'), '<input class="form-input" name="image" type="file" accept="image/png,image/jpeg,image/webp">', tr('rewards.imageHint')) : ''}
      ${r?.image ? `<label class="ks-switch"><input type="checkbox" name="remove_image"> ${esc(tr('rewards.removeImage'))}</label>` : ''}
      <label class="ks-switch"><input type="checkbox" name="available"${base.available ? ' checked' : ''}> ${esc(tr('rewards.available'))}</label>
      <label class="ks-switch"><input type="checkbox" name="all_children"${base.all_children ? ' checked' : ''}> ${esc(tr('rewards.allChildren'))}</label>
      <div data-some>${childChecks(kids, base.child_ids)}</div>
      ${wish ? field(tr('wish.feedback'), '<input class="form-input" name="feedback" maxlength="200">') : ''}
      ${r ? '' : `<p class="ks-muted">${esc(tr('rewards.imageLater'))}</p>`}`,
    { submit: wish ? tr('wish.approve') : tr('action.save') }), {
      onSubmit: async (fd) => {
        const body = {
          title: fd.get('title'), description: fd.get('description'), icon: fd.get('icon') || '', url: fd.get('url'),
          stars: Number(fd.get('stars')), available: fd.get('available') === 'on', all_children: fd.get('all_children') === 'on',
          child_ids: fd.getAll('child_ids').map(Number),
        };
        if (wish) {
          await ks.post(`/wishes/${wish.id}/approve`, { ...body, feedback: fd.get('feedback') });
        } else if (r) {
          await ks.patch(`/rewards/${r.id}`, body);
          const file = fd.get('image');
          if (file && file.size) await ks.upload(`/rewards/${r.id}/image`, await shrinkImage(file));
          else if (fd.get('remove_image') === 'on') await ks.del(`/rewards/${r.id}/image`);
        } else {
          await ks.post('/rewards', body);
        }
        showToast(tr('saved'), 'success');
        show();
      },
    });
    const form = dlg.querySelector('form');
    const sync = () => { form.querySelector('[data-some]').hidden = form.all_children.checked; };
    form.all_children.addEventListener('change', sync);
    sync();
  }

  function decisionDialog(title, { required = false, submit, onSubmit }) {
    openDialog(dialogShell(title, field(tr('wish.feedback'), `<input class="form-input" name="feedback" maxlength="200"${required ? ' required' : ''}>`, required ? '' : tr('form.optional')), { submit }), {
      onSubmit: async (fd) => { await onSubmit(fd.get('feedback')); show(); },
    });
  }

  async function bonusDialog(childId) {
    await children();
    const rid = requestId();
    openDialog(dialogShell(tr('bonus.title', { name: childName(childId) }), `
      ${field(tr('form.stars'), '<input class="form-input" name="stars" type="number" min="1" max="1000" step="1" required value="1">')}
      ${field(tr('form.reason'), '<input class="form-input" name="reason" maxlength="200" required>')}`, { submit: tr('bonus.give') }), {
      onSubmit: async (fd) => {
        await ks.post('/ledger/bonus', { child_id: childId, stars: Number(fd.get('stars')), reason: fd.get('reason'), request_id: rid });
        showToast(tr('saved'), 'success');
        show();
      },
    });
  }

  async function correctionDialog(childId, reverse = null) {
    await children();
    const rid = requestId();
    const body = reverse
      ? `<p>${esc(tr('history.reverseText', { n: reverse.n, reason: reverse.reason }))}</p>${field(tr('form.reason'), '<input class="form-input" name="reason" maxlength="200" required>')}`
      : `${field(tr('history.amount'), '<input class="form-input" name="stars" type="number" min="-100000" max="100000" step="1" required>', tr('history.amountHint'))}
         ${field(tr('form.reason'), '<input class="form-input" name="reason" maxlength="200" required>')}`;
    openDialog(dialogShell(tr('history.correctionFor', { name: childName(childId) }), body, { submit: tr('history.book') }), {
      onSubmit: async (fd) => {
        await ks.post('/ledger/correction', {
          child_id: childId, reason: fd.get('reason'), request_id: rid,
          ...(reverse ? { reverses_id: reverse.id } : { stars: Number(fd.get('stars')) }),
        });
        showToast(tr('saved'), 'success');
        show();
      },
    });
  }

  async function deviceDialog(d = null) {
    const kids = await children();
    const base = d ?? { name: tr('tablet.defaultName'), child_ids: kids.map((c) => c.id), idle_seconds: 120 };
    openDialog(dialogShell(d ? tr('tablet.editDevice') : tr('tablet.newDevice'), `
      ${field(tr('tablet.name'), `<input class="form-input" name="name" maxlength="60" required value="${esc(base.name)}">`)}
      ${childChecks(kids, base.child_ids)}
      ${field(tr('tablet.idleLabel'), `<input class="form-input" name="idle_seconds" type="number" min="30" max="1800" step="10" required value="${base.idle_seconds}">`, tr('tablet.idleHint'))}
      <p class="ks-hint">${esc(tr('tablet.openWarning'))}</p>`), {
      onSubmit: async (fd) => {
        const body = { name: fd.get('name'), child_ids: fd.getAll('child_ids').map(Number), idle_seconds: Number(fd.get('idle_seconds')) };
        if (d) {
          await ks.patch(`/devices/${d.id}`, body);
          showToast(tr('saved'), 'success');
          show();
        } else {
          const res = await ks.post('/devices', body);
          await show();
          pairingCodeDialog(res.pairing_code);
        }
      },
    });
  }

  function pairingCodeDialog(code) {
    openDialog(`<div class="ks-form">
      <h2 id="ks-dialog-title">${esc(tr('tablet.codeTitle'))}</h2>
      <ol class="ks-steps">
        <li>${esc(tr('tablet.step1'))}<br><span class="ks-mono">${esc(`${location.origin}${BASE}/tablet/`)}</span></li>
        <li>${esc(tr('tablet.step2'))}</li>
      </ol>
      <p class="ks-code" aria-label="${esc(tr('tablet.codeTitle'))}">${esc(code)}</p>
      <p class="ks-muted">${esc(tr('tablet.codeExpires'))}</p>
      <div class="ks-form__actions"><button type="button" class="btn btn--primary" data-close>${esc(tr('action.close'))}</button></div>
    </div>`);
  }

  function lookDialog(p, index) {
    const look = defaultLook(index);
    const sym = p.symbol || look.symbol;
    const col = p.color || p.avatar_color || look.color;
    openDialog(dialogShell(tr('tablet.lookFor', { name: p.name }), `
      <p class="ks-muted">${esc(tr('tablet.lookHint'))}</p>
      <fieldset class="ks-icons ks-icons--big"><legend>${esc(tr('tablet.symbol'))}</legend>
        ${PROFILE_SYMBOLS.map((s) => `<label><input type="radio" name="symbol" value="${esc(s)}"${s === sym ? ' checked' : ''}><span aria-hidden="true">${esc(s)}</span><span class="sr-only">${esc(s)}</span></label>`).join('')}
      </fieldset>
      <fieldset class="ks-colors"><legend>${esc(tr('tablet.color'))}</legend>
        ${PROFILE_COLORS.map((c) => `<label style="--c:${c}"><input type="radio" name="color" value="${c}"${c.toLowerCase() === col.toLowerCase() ? ' checked' : ''}><span class="sr-only">${c}</span></label>`).join('')}
      </fieldset>`), {
      onSubmit: async (fd) => {
        await ks.patch(`/profiles/${p.child_id}`, { symbol: fd.get('symbol'), color: fd.get('color') });
        showToast(tr('saved'), 'success');
        show();
      },
    });
  }

  /** Bildcode einrichten: zweimal eingeben, ohne Text oder Ziffern. */
  function codeDialog(p) {
    let first = null;
    let entered = [];
    const { dlg } = openDialog(`<div class="ks-form">
      <h2 id="ks-dialog-title">${esc(tr('tablet.codeFor', { name: p.name }))}</h2>
      <p class="ks-hint">${esc(tr('tablet.codeExplain'))}</p>
      <p data-code-step>${esc(tr('tablet.codeStep1'))}</p>
      <div class="ks-dots" aria-hidden="true">${'<span></span>'.repeat(CODE_LENGTH)}</div>
      <div class="ks-pad">${CODE_SYMBOLS.map((s, i) => `<button type="button" class="ks-pad__key" data-key="${i}" aria-label="${esc(s)}">${s}</button>`).join('')}</div>
      <div class="ks-form__actions">
        <button type="button" class="btn btn--ghost" data-erase>⌫ ${esc(tr('tablet.erase'))}</button>
        ${p.has_code ? `<button type="button" class="btn btn--secondary" data-remove-code>${esc(tr('tablet.codeRemove'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-close>${esc(tr('action.cancel'))}</button>
      </div>
    </div>`);
    const dots = [...dlg.querySelectorAll('.ks-dots span')];
    const step = dlg.querySelector('[data-code-step]');
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < entered.length));
    dlg.querySelector('[data-erase]').addEventListener('click', () => { entered.pop(); paint(); });
    dlg.querySelector('[data-remove-code]')?.addEventListener('click', async () => {
      try {
        await ks.patch(`/profiles/${p.child_id}`, { code: null });
        showToast(tr('tablet.codeRemoved'), 'success');
        dlg.close();
        show();
      } catch (err) { toastError(err); }
    });
    dlg.querySelector('.ks-pad').addEventListener('click', async (e) => {
      const k = e.target.closest('[data-key]');
      if (!k || entered.length >= CODE_LENGTH) return;
      entered.push(Number(k.dataset.key));
      paint();
      if (entered.length < CODE_LENGTH) return;
      if (!first) {
        first = entered;
        entered = [];
        step.textContent = tr('tablet.codeStep2');
        return paint();
      }
      if (!sameCode(first, entered)) {
        first = null;
        entered = [];
        step.textContent = `${tr('tablet.codeMismatch')} ${tr('tablet.codeStep1')}`;
        return paint();
      }
      try {
        await ks.patch(`/profiles/${p.child_id}`, { code: entered });
        showToast(tr('tablet.codeSaved'), 'success');
        dlg.close();
        show();
      } catch (err) { toastError(err); }
    });
  }

  // ------------------------------------------------------------------
  // Ereignisse
  // ------------------------------------------------------------------

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    storeTab(state.me.role, state.tab);
    for (const x of tabs.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x === b));
    show();
  }, { signal });

  main.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.matches('[data-act="pick-child"]')) {
      state.child = Number(el.value);
      return show();
    }
    if (el.matches('[data-act="profile-image"]') && el.files?.[0]) {
      try {
        await ks.upload(`/profiles/${el.dataset.child}/image`, await shrinkImage(el.files[0]));
        showToast(tr('saved'), 'success');
        show();
      } catch (err) { toastError(err); }
    }
  }, { signal });

  main.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const id = Number(b.dataset.id);
    const act = b.dataset.act;
    try {
      switch (act) {
        case 'retry': return boot();
        // Kind
        case 'complete': {
          b.disabled = true;
          const r = await ks.post('/completions', { action_id: id, request_id: requestId() });
          showToast(r.completion.status === 'approved' ? tr('child.earned', { n: r.completion.stars }) : tr('child.sentForApproval'), 'success');
          return show();
        }
        case 'cancel-completion': await ks.post(`/completions/${id}/cancel`); return show();
        case 'redeem': return redeemDialog(state.data.rewards.find((r) => r.id === id));
        case 'cancel-redemption': await ks.post(`/redemptions/${id}/cancel`); showToast(tr('redeem.withdrawn'), 'success'); return show();
        case 'new-wish': return wishDialog();
        case 'withdraw-wish': await ks.post(`/wishes/${id}/withdraw`); return show();
        // Eltern
        case 'approve-completion': await ks.post(`/completions/${id}/approve`); showToast(tr('saved'), 'success'); return show();
        case 'reject-completion':
          return decisionDialog(tr('completion.rejectTitle'), { submit: tr('action.reject'), onSubmit: (feedback) => ks.post(`/completions/${id}/reject`, { feedback }) });
        case 'redemption': {
          const what = b.dataset.do;
          if (what === 'reject' || what === 'revoke') {
            return decisionDialog(tr(`redemption.${what}Title`), { submit: tr(`action.${what}`), onSubmit: (feedback) => ks.post(`/redemptions/${id}/${what}`, { feedback }) });
          }
          await ks.post(`/redemptions/${id}/${what}`);
          showToast(tr(`redemption.${what}Done`), 'success');
          return show();
        }
        case 'approve-wish': return rewardDialog(null, { wish: state.data.wishes.find((w) => w.id === id) });
        case 'reject-wish':
          return decisionDialog(tr('wish.rejectTitle'), { required: true, submit: tr('action.reject'), onSubmit: (feedback) => ks.post(`/wishes/${id}/reject`, { feedback }) });
        case 'bonus': return bonusDialog(Number(b.dataset.child));
        case 'correction': return correctionDialog(Number(b.dataset.child));
        case 'reverse': return correctionDialog(Number(b.dataset.child), { id, n: Number(b.dataset.n), reason: b.dataset.reason });
        case 'starter': return starterPack();
        case 'new-action': return actionDialog();
        case 'edit-action': return actionDialog(state.data.actions.find((a) => a.id === id));
        case 'action-status': await ks.patch(`/actions/${id}`, { status: b.dataset.status }); return show();
        case 'new-reward': return rewardDialog();
        case 'edit-reward': return rewardDialog(state.data.rewardsAll.find((r) => r.id === id));
        case 'reward-archive': await ks.patch(`/rewards/${id}`, { archived: b.dataset.archived !== 'true' }); return show();
        case 'new-device': return deviceDialog();
        case 'edit-device': return deviceDialog(state.data.devices.find((d) => d.id === id));
        case 'pair-device': { const r = await ks.post(`/devices/${id}/pairing`); await show(); return pairingCodeDialog(r.pairing_code); }
        case 'revoke-device':
          return openDialog(dialogShell(tr('tablet.revokeTitle'), `<p>${esc(tr('tablet.revokeText'))}</p>`, { submit: tr('tablet.revoke'), danger: true }), {
            onSubmit: async () => { await ks.del(`/devices/${id}`); showToast(tr('tablet.revoked'), 'success'); show(); },
          });
        case 'profile-image-remove': await ks.del(`/profiles/${b.dataset.child}/image`); return show();
        case 'profile-look': return lookDialog(state.data.profiles.find((p) => p.child_id === Number(b.dataset.child)), Number(b.dataset.index));
        case 'profile-code': return codeDialog(state.data.profiles.find((p) => p.child_id === Number(b.dataset.child)));
        default: return undefined;
      }
    } catch (err) {
      toastError(err);
      if (act === 'complete') show();
    }
  }, { signal });

  await boot();
}
