/**
 * KidsStar - Flurtablet "Wer bist du?"
 *
 * Fuer Kinder, die (noch) nicht lesen: alles Wichtige ist ein Bild, ein Symbol
 * oder eine Zahl mit Sternen; Text steht daneben fuer die, die lesen koennen,
 * und fuer Screenreader. Keine fremden Dateien, keine Bibliotheken.
 *
 * Wer das aktive Kind ist, weiss nur der Server (Kindersitzung). Die Seite
 * merkt sich nichts im Browser-Speicher. Beim Profilwechsel und nach Leerlauf
 * wird die Kindersitzung beendet und der gesamte Zustand dieser Seite verworfen.
 */

const API = './api';
// Dieselbe Reihenfolge wie in der Elternansicht (module/lib/tablet.js).
const CODE_SYMBOLS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐸', '🦁', '🐵'];
const CODE_LENGTH = 4;

// ---------------------------------------------------------------------------
// Texte (Deutsch, Englisch) - nur Beiwerk zu Bildern und Symbolen
// ---------------------------------------------------------------------------
const TEXT = {
  de: {
    who: 'Wer bist du?', switch: 'Profil wechseln', today: 'Heute', stars: 'Meine Sterne', shop: 'Sterneshop', wishes: 'Meine Wünsche',
    done: 'Erledigt!', waiting: 'Wartet auf Bestätigung', allDone: 'Alles geschafft für heute!', nothingToday: 'Heute gibt es nichts zu tun.',
    available: 'Sterne', reserved: 'reserviert', history: 'Verlauf', goal: 'Mein Sparziel', setGoal: 'Darauf sparen', goalSet: 'Das ist dein Sparziel',
    have: (a, b) => `Du hast ${a} von ${b} Sternen.`, missing: (n) => `Es fehlen noch ${n}.`, enough: 'Du hast genug Sterne!',
    redeem: 'Einlösen', redeemQ: 'Möchtest du das einlösen?', after: (n) => `Danach hast du noch ${n} Sterne.`, yes: 'Ja', no: 'Nein',
    requested: 'Gewünscht! Deine Eltern schauen es sich an.', notEnough: 'Dafür reichen deine Sterne noch nicht.',
    myRequests: 'Meine Einlösungen', wishNew: 'Neuer Wunsch', wishTitle: 'Was wünschst du dir?', wishDesc: 'Mehr dazu (optional)', wishLink: 'Link (optional)',
    send: 'Senden', cancel: 'Abbrechen', wishSent: 'Wunsch gesendet!', noWishes: 'Noch keine Wünsche.', noRewards: 'Im Shop ist gerade nichts.',
    codeTitle: 'Dein Bildcode', codeWrong: 'Das war nicht richtig.', codeLocked: 'Zu viele Versuche. Bitte später noch einmal.', back: 'Zurück', erase: 'Löschen',
    pairTitle: 'Tablet koppeln', pairHelp: 'Ein Elternteil erzeugt den Code in Yuvomi unter KidsStar → Tablet.', pairCode: 'Kopplungscode', pair: 'Koppeln',
    pairWrong: 'Der Code ist unbekannt oder abgelaufen.', offline: 'KidsStar ist gerade nicht erreichbar.', retry: 'Nochmal', off: 'KidsStar ist ausgeschaltet.',
    notConfigured: 'Das Tablet ist noch nicht eingerichtet (API-Token fehlt).', noProfiles: 'Für dieses Tablet sind noch keine Kinder freigegeben.',
    status: { pending: 'wartet', approved: 'genehmigt', rejected: 'abgelehnt', cancelled: 'zurückgezogen', fulfilled: 'erfüllt', proposed: 'wartet', withdrawn: 'zurückgezogen' },
    kinds: { earn: 'erledigt', bonus: 'Extra-Sterne', correction: 'Korrektur', reserve: 'reserviert', release: 'zurück', redeem: 'eingelöst', refund: 'zurück' },
    undo: 'Zurücknehmen', limit: 'Schon geschafft!', error: 'Das hat nicht geklappt.',
  },
  en: {
    who: 'Who are you?', switch: 'Switch profile', today: 'Today', stars: 'My stars', shop: 'Star shop', wishes: 'My wishes',
    done: 'Done!', waiting: 'Waiting for approval', allDone: 'All done for today!', nothingToday: 'Nothing to do today.',
    available: 'stars', reserved: 'reserved', history: 'History', goal: 'My savings goal', setGoal: 'Save for this', goalSet: 'This is your goal',
    have: (a, b) => `You have ${a} of ${b} stars.`, missing: (n) => `${n} more to go.`, enough: 'You have enough stars!',
    redeem: 'Redeem', redeemQ: 'Do you want this?', after: (n) => `You will have ${n} stars left.`, yes: 'Yes', no: 'No',
    requested: 'Wished! Your parents will have a look.', notEnough: 'Not enough stars yet.',
    myRequests: 'My requests', wishNew: 'New wish', wishTitle: 'What do you wish for?', wishDesc: 'More about it (optional)', wishLink: 'Link (optional)',
    send: 'Send', cancel: 'Cancel', wishSent: 'Wish sent!', noWishes: 'No wishes yet.', noRewards: 'The shop is empty right now.',
    codeTitle: 'Your picture code', codeWrong: 'That was not right.', codeLocked: 'Too many tries. Please try again later.', back: 'Back', erase: 'Erase',
    pairTitle: 'Pair this tablet', pairHelp: 'A parent creates the code in Yuvomi under KidsStar → Tablet.', pairCode: 'Pairing code', pair: 'Pair',
    pairWrong: 'Unknown or expired code.', offline: 'KidsStar is not reachable right now.', retry: 'Retry', off: 'KidsStar is switched off.',
    notConfigured: 'This tablet is not set up yet (API token missing).', noProfiles: 'No children are enabled for this tablet yet.',
    status: { pending: 'waiting', approved: 'approved', rejected: 'declined', cancelled: 'withdrawn', fulfilled: 'fulfilled', proposed: 'waiting', withdrawn: 'withdrawn' },
    kinds: { earn: 'done', bonus: 'bonus stars', correction: 'correction', reserve: 'reserved', release: 'returned', redeem: 'redeemed', refund: 'returned' },
    undo: 'Undo', limit: 'Already done!', error: 'That did not work.',
  },
};
const LANG = (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
const T = TEXT[LANG];
document.documentElement.lang = LANG;

const STATUS_ICON = { pending: '⏳', proposed: '⏳', approved: '✅', fulfilled: '🎉', rejected: '✖️', cancelled: '↩️', withdrawn: '↩️' };

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function rid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function setHtml(el, html) {
  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', html);
}
function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.className = ''; }, 2600);
}
function starRow(n, { max = 10 } = {}) {
  return n <= max ? '⭐'.repeat(n) : `⭐ × ${n}`;
}
function fmtDate(iso) {
  try {
    return new Intl.DateTimeFormat(LANG, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return '';
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.reason = body?.reason ?? (status >= 502 || status === 0 ? 'unreachable' : null);
    this.body = body ?? {};
  }
}

let csrf = '';
async function call(path, { method = 'GET', body } = {}, retried = false) {
  const write = method !== 'GET';
  // Die Kopplung ist der eine Schreibweg ohne CSRF-Paar: vor ihr gibt es kein
  // Geraet, also auch kein /csrf. Der Dienst prueft dort Origin und Fehlversuche.
  const needsCsrf = write && path !== '/pair';
  if (needsCsrf && !csrf) {
    const r = await call('/csrf');
    csrf = r.token;
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(needsCsrf ? { 'X-KidsStar-CSRF': csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, null);
  }
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    if (needsCsrf && res.status === 403 && data?.reason === 'csrf_invalid' && !retried) {
      csrf = '';
      return call(path, { method, body }, true);
    }
    throw new ApiError(res.status, data);
  }
  return data?.data;
}

// ---------------------------------------------------------------------------
// Zustand. `kid` ist alles, was zum aktiven Kind gehoert; ein Profilwechsel
// ersetzt das Objekt vollstaendig, statt Felder zu leeren.
// ---------------------------------------------------------------------------
let device = null;   // { name, idle_seconds }
let profiles = [];
let kid = null;      // { child_id, name, tab, today, ledger, rewards, wishes, redemptions }
let idleTimer = null;

function freshKid(profile) {
  return { child_id: profile.child_id, name: profile.name, profile, tab: 'today', today: null, ledger: null, rewards: null, wishes: null, redemptions: null };
}

/** Jede Antwort zum Kind muss zum aktiven Kind gehoeren - sonst verwerfen. */
function mine(data) {
  if (!kid || data?.child_id !== kid.child_id) throw new ApiError(401, { reason: 'kid_session_required' });
  return data;
}

function armIdle() {
  clearTimeout(idleTimer);
  if (!kid || !device) return;
  idleTimer = setTimeout(() => endKid('idle'), device.idle_seconds * 1000);
}
for (const type of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(type, () => { if (kid) armIdle(); }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  // Wieder sichtbar nach langer Pause: der Server entscheidet, ob die Sitzung noch gilt.
  if (document.visibilityState === 'visible') start();
});

async function endKid(reason = 'switched') {
  clearTimeout(idleTimer);
  kid = null;
  closeDialog();
  renderProfiles();
  try {
    await call(`/session?reason=${reason}`, { method: 'DELETE' });
  } catch { /* der Server beendet sie spaetestens nach der Leerlaufzeit */ }
  start();
}

function handle(err) {
  if (err.reason === 'kid_session_required') return endKid('idle');
  if (err.reason === 'device_unpaired') { device = null; kid = null; return renderPair(); }
  if (err.reason === 'module_forbidden') return renderMessage('🚫', T.off);
  if (['tablet_not_configured', 'tablet_token_invalid', 'tablet_token_scope'].includes(err.reason)) return renderMessage('🛠️', T.notConfigured);
  if (err.reason === 'unreachable' || err.reason === 'yuvomi_unavailable') return renderMessage('📡', T.offline, true);
  toast(T.error, 'bad');
  return null;
}

// ---------------------------------------------------------------------------
// Start, Koppeln, Profile
// ---------------------------------------------------------------------------
async function start() {
  app.setAttribute('aria-busy', 'true');
  try {
    const st = await call('/state');
    if (!st.paired) { device = null; kid = null; return renderPair(); }
    device = st.device;
    profiles = st.profiles;
    if (st.active && kid?.child_id === st.active.child_id) return renderKid();
    if (kid && !st.active) kid = null;
    // Neu geladen, waehrend ein Kind angemeldet war: die Seite weiss nicht mehr,
    // wer es war, also endet auch die Sitzung - sonst bliebe sie bis zum Leerlauf offen.
    if (!kid && st.active) call('/session?reason=switched', { method: 'DELETE' }).catch(() => {});
    if (!kid) renderProfiles();
  } catch (err) {
    handle(err);
  } finally {
    app.removeAttribute('aria-busy');
  }
}

function renderMessage(icon, text, retry = false) {
  clearTimeout(idleTimer);
  setHtml(app, `
    <section class="message">
      <div class="big" aria-hidden="true">${icon}</div>
      <p>${esc(text)}</p>
      ${retry ? `<button class="btn" data-retry>🔄 ${esc(T.retry)}</button>` : ''}
    </section>`);
  app.querySelector('[data-retry]')?.addEventListener('click', start);
}

function renderPair() {
  setHtml(app, `
    <section class="pair">
      <h1><span aria-hidden="true">🔗</span> ${esc(T.pairTitle)}</h1>
      <p>${esc(T.pairHelp)}</p>
      <form data-pair>
        <label for="pair-code">${esc(T.pairCode)}</label>
        <input id="pair-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required placeholder="ABCD-EFGH">
        <button class="btn primary" type="submit">${esc(T.pair)}</button>
      </form>
    </section>`);
  const form = app.querySelector('[data-pair]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call('/pair', { method: 'POST', body: { code: form.code.value } });
      csrf = '';
      start();
    } catch (err) {
      if (err.reason === 'pairing_invalid' || err.reason === 'invalid_pairing_code' || err.reason === 'rate_limited') toast(T.pairWrong, 'bad');
      else handle(err);
    }
  });
}

function tileVisual(p, cls = 'tile-visual') {
  const style = p.color ? ` style="--tile:${esc(p.color)}"` : '';
  if (p.image) return `<span class="${cls}"${style}><img src="${API}/profile-images/${esc(p.image)}" alt="" draggable="false"></span>`;
  return `<span class="${cls} symbol"${style} aria-hidden="true">${esc(p.symbol || '🙂')}</span>`;
}

function renderProfiles() {
  clearTimeout(idleTimer);
  if (!profiles.length) return renderMessage('🧸', T.noProfiles);
  setHtml(app, `
    <section class="who">
      <h1><span aria-hidden="true">👋</span> ${esc(T.who)}</h1>
      <ul class="tiles" role="list">
        ${profiles.map((p) => `
          <li><button class="tile" data-child="${p.child_id}" aria-label="${esc(p.name)}">
            ${tileVisual(p)}
            <span class="tile-name">${esc(p.name)}</span>
            ${p.has_code ? '<span class="tile-lock" aria-hidden="true">🔒</span>' : ''}
          </button></li>`).join('')}
      </ul>
    </section>`);
  for (const b of app.querySelectorAll('[data-child]')) {
    b.addEventListener('click', () => {
      const p = profiles.find((x) => x.child_id === Number(b.dataset.child));
      if (p.has_code) renderCode(p);
      else openProfile(p);
    });
  }
}

async function openProfile(p, code) {
  try {
    await call('/session', { method: 'POST', body: { child_id: p.child_id, ...(code ? { code } : {}) } });
    kid = freshKid(p);
    armIdle();
    renderKid();
    return true;
  } catch (err) {
    if (err.reason === 'code_wrong') return { wrong: true, remaining: err.body.remaining };
    if (err.reason === 'code_locked') return { locked: true };
    if (err.reason === 'code_required') { renderCode(p); return false; }
    if (err.reason === 'profile_not_found') { start(); return false; }
    handle(err);
    return false;
  }
}

function renderCode(p) {
  let entered = [];
  setHtml(app, `
    <section class="code">
      <div class="code-head">
        <button class="btn icon" data-back aria-label="${esc(T.back)}">⬅️</button>
        ${tileVisual(p, 'tile-visual small')}
        <h1 class="sr-only">${esc(T.codeTitle)}: ${esc(p.name)}</h1>
      </div>
      <div class="dots" aria-hidden="true">${'<span></span>'.repeat(CODE_LENGTH)}</div>
      <p class="code-msg" role="alert"></p>
      <div class="pad">
        ${CODE_SYMBOLS.map((s, i) => `<button class="pad-key" data-key="${i}" aria-label="${esc(s)}">${s}</button>`).join('')}
      </div>
      <button class="btn icon erase" data-erase aria-label="${esc(T.erase)}">⌫</button>
    </section>`);
  const dots = [...app.querySelectorAll('.dots span')];
  const msg = app.querySelector('.code-msg');
  const keys = [...app.querySelectorAll('[data-key]')];
  const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < entered.length));
  app.querySelector('[data-back]').addEventListener('click', renderProfiles);
  app.querySelector('[data-erase]').addEventListener('click', () => { entered.pop(); paint(); });
  for (const k of keys) {
    k.addEventListener('click', async () => {
      if (entered.length >= CODE_LENGTH) return;
      entered.push(Number(k.dataset.key));
      paint();
      if (entered.length < CODE_LENGTH) return;
      keys.forEach((x) => { x.disabled = true; });
      const r = await openProfile(p, entered);
      if (r === true || r === false) return;
      entered = [];
      paint();
      app.querySelector('.dots').classList.add('wrong');
      setTimeout(() => app.querySelector('.dots')?.classList.remove('wrong'), 600);
      if (r.locked) {
        msg.textContent = `⏳ ${T.codeLocked}`;
        return;
      }
      msg.textContent = `✖️ ${T.codeWrong}`;
      keys.forEach((x) => { x.disabled = false; });
    });
  }
}

// ---------------------------------------------------------------------------
// Kinderansicht
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'today', icon: '☀️', label: () => T.today },
  { id: 'stars', icon: '⭐', label: () => T.stars },
  { id: 'shop', icon: '🎁', label: () => T.shop },
  { id: 'wishes', icon: '💭', label: () => T.wishes },
];

function renderKid() {
  if (!kid) return renderProfiles();
  const balance = kid.today?.balance?.available ?? kid.ledger?.balance?.available;
  setHtml(app, `
    <header class="bar">
      ${tileVisual(kid.profile, 'tile-visual tiny')}
      <span class="bar-name">${esc(kid.name)}</span>
      <span class="bar-stars" aria-label="${balance ?? ''} ${esc(T.available)}">⭐ <b data-balance>${balance ?? '…'}</b></span>
      <button class="btn icon switch" data-switch aria-label="${esc(T.switch)}" title="${esc(T.switch)}">🔄</button>
    </header>
    <section class="view" data-view></section>
    <nav class="tabs" role="tablist" aria-label="KidsStar">
      ${TABS.map((t) => `<button role="tab" class="tab" data-tab="${t.id}" aria-selected="${kid.tab === t.id}" aria-label="${esc(t.label())}">
        <span aria-hidden="true">${t.icon}</span><small>${esc(t.label())}</small></button>`).join('')}
    </nav>`);
  app.querySelector('[data-switch]').addEventListener('click', () => endKid('switched'));
  for (const b of app.querySelectorAll('[data-tab]')) {
    b.addEventListener('click', () => { kid.tab = b.dataset.tab; renderKid(); });
  }
  loadTab();
}

function setBalance(b) {
  if (!kid || !b) return;
  if (kid.today) kid.today.balance = b;
  const el = app.querySelector('[data-balance]');
  if (el) el.textContent = String(b.available);
}

async function loadTab() {
  const owner = kid;
  const view = app.querySelector('[data-view]');
  try {
    if (kid.tab === 'today') {
      owner.today = mine(await call('/today'));
      if (kid !== owner) return;
      setBalance(owner.today.balance);
      return renderToday(view);
    }
    if (kid.tab === 'stars') {
      const [ledger, today] = await Promise.all([call('/ledger?limit=30'), call('/today')]);
      owner.ledger = mine(ledger);
      owner.today = mine(today);
      if (kid !== owner) return;
      setBalance(owner.ledger.balance);
      return renderStars(view);
    }
    if (kid.tab === 'shop') {
      const [rewards, redemptions, today] = await Promise.all([call('/rewards'), call('/redemptions'), call('/today')]);
      owner.rewards = mine(rewards).items;
      owner.redemptions = mine(redemptions).items;
      owner.today = mine(today);
      if (kid !== owner) return;
      setBalance(owner.today.balance);
      return renderShop(view);
    }
    if (kid.tab === 'wishes') {
      owner.wishes = mine(await call('/wishes')).items;
      if (kid !== owner) return;
      return renderWishes(view);
    }
  } catch (err) {
    if (kid === owner) handle(err);
  }
}

function renderToday(view) {
  const t = kid.today;
  const items = t.actions;
  const open = items.filter((a) => a.remaining > 0);
  setHtml(view, `
    <h2 class="sr-only">${esc(T.today)}</h2>
    ${!items.length ? `<p class="empty"><span aria-hidden="true">🌙</span> ${esc(T.nothingToday)}</p>` : ''}
    ${items.length && !open.length && !items.some((a) => a.pending) ? `<p class="empty cheer"><span aria-hidden="true">🎉</span> ${esc(T.allDone)}</p>` : ''}
    <ul class="actions" role="list">
      ${items.map((a) => `
        <li class="action ${a.remaining ? '' : 'is-done'}">
          <span class="action-icon" aria-hidden="true">${esc(a.icon || '⭐')}</span>
          <span class="action-text">
            <span class="action-title">${esc(a.title)}</span>
            <span class="action-stars" aria-label="${a.stars} ${esc(T.available)}">${starRow(a.stars)}</span>
            <span class="action-state">
              ${'✅'.repeat(a.approved)}${'⏳'.repeat(a.pending)}
              ${a.pending ? `<span class="sr-only">${esc(T.waiting)}</span>` : ''}
            </span>
          </span>
          ${a.remaining ? `<button class="done-btn" data-done="${a.id}" aria-label="${esc(T.done)}: ${esc(a.title)}">✓</button>` : '<span class="done-mark" aria-hidden="true">👍</span>'}
        </li>`).join('')}
    </ul>
    ${t.pending.length ? `<h3 class="sub"><span aria-hidden="true">⏳</span> ${esc(T.waiting)}</h3>
      <ul class="mini" role="list">${t.pending.map((c) => `<li><span aria-hidden="true">${esc(c.icon || '⭐')}</span> ${esc(c.title)}
        <button class="btn small" data-undo="${c.id}" aria-label="${esc(T.undo)}">↩️</button></li>`).join('')}</ul>` : ''}
    ${t.rejected?.length ? `<ul class="mini" role="list">${t.rejected.map((c) => `<li class="bad"><span aria-hidden="true">✖️</span> ${esc(c.title)}${c.feedback ? ` - ${esc(c.feedback)}` : ''}</li>`).join('')}</ul>` : ''}
    ${goalCard(t.goal)}`);
  for (const b of view.querySelectorAll('[data-done]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      const owner = kid;
      try {
        const r = await call('/completions', { method: 'POST', body: { action_id: Number(b.dataset.done), request_id: rid() } });
        if (kid !== owner) return;
        celebrate(r.completion.status === 'approved' ? `⭐ +${r.completion.stars}` : `⏳ ${T.waiting}`);
        setBalance(r.balance);
      } catch (err) {
        if (err.reason === 'limit_reached') toast(`👍 ${T.limit}`);
        else handle(err);
      }
      if (kid === owner) loadTab();
    });
  }
  for (const b of view.querySelectorAll('[data-undo]')) {
    b.addEventListener('click', async () => {
      try { await call(`/completions/${b.dataset.undo}/cancel`, { method: 'POST', body: {} }); } catch (err) { handle(err); }
      loadTab();
    });
  }
}

function goalCard(g) {
  if (!g) return '';
  const pct = Math.min(100, Math.round((g.have / g.stars) * 100));
  return `
    <section class="goal" aria-label="${esc(T.goal)}">
      <span class="goal-visual" aria-hidden="true">${g.image ? `<img src="${API}/images/${esc(g.image)}" alt="">` : esc(g.icon || '🎯')}</span>
      <div class="goal-body">
        <span class="goal-title">🎯 ${esc(g.title)}</span>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${g.stars}" aria-valuenow="${g.have}" aria-label="${esc(T.have(g.have, g.stars))}"><span style="width:${pct}%"></span></div>
        <span class="goal-text">⭐ ${g.have} / ${g.stars} · ${esc(g.missing ? `${T.have(g.have, g.stars)} ${T.missing(g.missing)}` : T.enough)}</span>
      </div>
    </section>`;
}

function renderStars(view) {
  const l = kid.ledger;
  setHtml(view, `
    <h2 class="sr-only">${esc(T.stars)}</h2>
    <div class="bignum"><span aria-hidden="true">⭐</span> <b>${l.balance.available}</b>
      ${l.balance.reserved ? `<span class="reserved">🔒 ${l.balance.reserved} <span class="sr-only">${esc(T.reserved)}</span></span>` : ''}</div>
    ${goalCard(kid.today?.goal)}
    <h3 class="sub"><span aria-hidden="true">📜</span> ${esc(T.history)}</h3>
    <ul class="history" role="list">
      ${l.entries.map((e) => {
        const n = e.delta || -e.reserved_delta;
        const plus = e.delta > 0;
        return `<li class="${plus ? 'plus' : e.delta < 0 ? 'minus' : 'neutral'}">
          <span class="h-icon" aria-hidden="true">${esc(e.icon || ({ bonus: '🎁', correction: '✏️', reserve: '🔒', release: '🔓', redeem: '🎉', refund: '↩️' }[e.kind] || '⭐'))}</span>
          <span class="h-text"><span>${esc(e.reason)}</span><small>${esc(T.kinds[e.kind] || '')} · ${esc(fmtDate(e.created_at))}</small></span>
          <span class="h-n">${e.delta ? `${plus ? '+' : '−'}${Math.abs(e.delta)} ⭐` : `${Math.abs(n)} ⭐ ✓`}</span>
        </li>`;
      }).join('')}
    </ul>`);
}

function renderShop(view) {
  const avail = kid.today.balance.available;
  const goalId = kid.today.goal?.reward_id;
  const open = kid.redemptions.filter((r) => r.status === 'pending' || r.status === 'approved');
  setHtml(view, `
    <h2 class="sr-only">${esc(T.shop)}</h2>
    ${open.length ? `<h3 class="sub"><span aria-hidden="true">📦</span> ${esc(T.myRequests)}</h3>
      <ul class="mini" role="list">${open.map((r) => `<li><span aria-hidden="true">${STATUS_ICON[r.status]}</span> ${esc(r.title)} · ${r.stars} ⭐ <span class="sr-only">${esc(T.status[r.status])}</span>
        ${r.status === 'pending' ? `<button class="btn small" data-cancel-red="${r.id}" aria-label="${esc(T.undo)}">↩️</button>` : ''}</li>`).join('')}</ul>` : ''}
    ${!kid.rewards.length ? `<p class="empty"><span aria-hidden="true">🛒</span> ${esc(T.noRewards)}</p>` : ''}
    <ul class="shop" role="list">
      ${kid.rewards.map((r) => {
        const pct = Math.min(100, Math.round((avail / r.stars) * 100));
        const can = r.available && avail >= r.stars;
        return `<li><button class="card ${can ? 'can' : 'cannot'}" data-reward="${r.id}" aria-label="${esc(r.title)}, ${r.stars} ⭐">
          <span class="card-visual" aria-hidden="true">${r.image ? `<img src="${API}/images/${esc(r.image)}" alt="">` : esc(r.icon || '🎁')}</span>
          <span class="card-title">${esc(r.title)}</span>
          <span class="card-price">⭐ ${r.stars}${r.id === goalId ? ' 🎯' : ''}</span>
          <span class="meter" aria-hidden="true"><span style="width:${pct}%"></span></span>
        </button></li>`;
      }).join('')}
    </ul>`);
  for (const b of view.querySelectorAll('[data-reward]')) {
    b.addEventListener('click', () => confirmRedeem(kid.rewards.find((r) => r.id === Number(b.dataset.reward))));
  }
  for (const b of view.querySelectorAll('[data-cancel-red]')) {
    b.addEventListener('click', async () => {
      try { const r = await call(`/redemptions/${b.dataset.cancelRed}/cancel`, { method: 'POST', body: {} }); setBalance(r.balance); } catch (err) { handle(err); }
      loadTab();
    });
  }
}

let dialog = null;
function closeDialog() {
  dialog?.close();
  dialog?.remove();
  dialog = null;
}

function confirmRedeem(r) {
  const avail = kid.today.balance.available;
  const enough = avail >= r.stars;
  const isGoal = kid.today.goal?.reward_id === r.id;
  closeDialog();
  dialog = document.createElement('dialog');
  dialog.className = 'confirm';
  dialog.insertAdjacentHTML('beforeend', `
    <div class="confirm-visual" aria-hidden="true">${r.image ? `<img src="${API}/images/${esc(r.image)}" alt="">` : esc(r.icon || '🎁')}</div>
    <h2>${esc(r.title)}</h2>
    ${r.description ? `<p>${esc(r.description)}</p>` : ''}
    <p class="price">⭐ ${r.stars}</p>
    ${enough
      ? `<p>${esc(T.redeemQ)}</p><p class="after" aria-label="${esc(T.after(avail - r.stars))}">⭐ ${avail} → ${avail - r.stars}</p>
         <div class="row"><button class="btn big no" data-no aria-label="${esc(T.no)}">✖️</button><button class="btn big yes" data-yes aria-label="${esc(T.yes)}">✔️</button></div>`
      : `<p>${esc(T.notEnough)}</p><p class="after">${esc(T.have(avail, r.stars))} ${esc(T.missing(r.stars - avail))}</p>
         <div class="row"><button class="btn big no" data-no aria-label="${esc(T.back)}">⬅️</button>
         ${isGoal ? `<span class="goal-flag">🎯 ${esc(T.goalSet)}</span>` : `<button class="btn big" data-goal aria-label="${esc(T.setGoal)}">🎯</button>`}</div>`}`);
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('cancel', closeDialog);
  dialog.querySelector('[data-no]').addEventListener('click', closeDialog);
  const owner = kid;
  dialog.querySelector('[data-goal]')?.addEventListener('click', async () => {
    try { await call('/goal', { method: 'PUT', body: { reward_id: r.id } }); celebrate('🎯'); } catch (err) { handle(err); }
    closeDialog();
    if (kid === owner) loadTab();
  });
  dialog.querySelector('[data-yes]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const res = await call('/redemptions', { method: 'POST', body: { reward_id: r.id, request_id: rid(), expected_stars: r.stars } });
      setBalance(res.balance);
      celebrate(`🎁 ${T.requested}`);
    } catch (err) {
      if (err.reason === 'price_changed' || err.reason === 'insufficient_stars' || err.reason === 'already_requested' || err.reason === 'reward_unavailable') toast(T.error, 'bad');
      else handle(err);
    }
    closeDialog();
    if (kid === owner) loadTab();
  });
}

function renderWishes(view) {
  setHtml(view, `
    <h2 class="sr-only">${esc(T.wishes)}</h2>
    <button class="btn primary wide" data-new>➕ 💭 ${esc(T.wishNew)}</button>
    ${!kid.wishes.length ? `<p class="empty"><span aria-hidden="true">💭</span> ${esc(T.noWishes)}</p>` : ''}
    <ul class="mini wishes" role="list">
      ${kid.wishes.map((w) => `<li><span aria-hidden="true">${STATUS_ICON[w.status]}</span>
        <span>${esc(w.title)}${w.feedback ? `<small>${esc(w.feedback)}</small>` : ''}</span>
        <span class="sr-only">${esc(T.status[w.status])}</span></li>`).join('')}
    </ul>`);
  view.querySelector('[data-new]').addEventListener('click', () => {
    closeDialog();
    dialog = document.createElement('dialog');
    dialog.className = 'confirm';
    dialog.insertAdjacentHTML('beforeend', `
      <form method="dialog" data-wish>
        <h2><span aria-hidden="true">💭</span> ${esc(T.wishNew)}</h2>
        <label for="w-title">${esc(T.wishTitle)}</label><input id="w-title" name="title" maxlength="80" required>
        <label for="w-desc">${esc(T.wishDesc)}</label><textarea id="w-desc" name="description" maxlength="500" rows="3"></textarea>
        <label for="w-url">${esc(T.wishLink)}</label><input id="w-url" name="url" type="url" maxlength="500" inputmode="url">
        <div class="row"><button class="btn big no" type="button" data-no aria-label="${esc(T.cancel)}">✖️</button><button class="btn big yes" type="submit" aria-label="${esc(T.send)}">✔️</button></div>
      </form>`);
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-no]').addEventListener('click', closeDialog);
    const form = dialog.querySelector('[data-wish]');
    const requestId = rid();
    const owner = kid;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await call('/wishes', { method: 'POST', body: { title: form.title.value, description: form.description.value, url: form.url.value, request_id: requestId } });
        celebrate(`💭 ${T.wishSent}`);
        closeDialog();
        if (kid === owner) loadTab();
      } catch (err) {
        if (err.status === 400) toast(T.error, 'bad');
        else { closeDialog(); handle(err); }
      }
    });
  });
}

function celebrate(text) {
  toast(text, 'good');
}

start();
