/**
 * KidsStar - Kachel fuer die Yuvomi-Uebersicht
 *
 * Kind: verfuegbare Sterne, offene Aktionen von heute, Sparziel.
 * Eltern: je Kind der Sternestand und was auf eine Entscheidung wartet.
 * Die Rolle sagt der Dienst (/summary), nicht die Kachel.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createClient } from './lib/api.js';
import { progress } from './lib/kidsstar.js';
import { errorText } from './index.js';

const ID = 'kidsstar';
const ROUTE = `/m/${ID}`;
const tr = (key, params) => t(`extensions.${ID}.${key}`, params);

// Modul-CSS laedt Yuvomi nur auf der Modulseite; die Kachel bringt ihr
// Weniges selbst mit (nur Yuvomi-Tokens).
const CSS = `
.ksw { display: grid; gap: var(--space-2, 8px); }
.ksw-big { font-size: var(--text-xl, 1.4rem); font-weight: 700; color: var(--color-text-primary); }
.ksw-muted { color: var(--color-text-secondary); font-size: var(--text-sm, 0.875rem); }
.ksw-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ksw-list li { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; color: var(--color-text-primary); }
.ksw-meter { height: 8px; border-radius: 999px; background: var(--color-border-subtle); overflow: hidden; }
.ksw-meter span { display: block; height: 100%; background: var(--active-module-accent, var(--color-accent)); }
.ksw a { color: inherit; text-decoration: none; }
.ksw-pill { font-size: var(--text-xs, 0.75rem); padding: 1px 8px; border-radius: 999px; background: var(--color-surface-2); color: var(--color-text-secondary); }
`;

export async function renderWidget(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `<style>${CSS}</style><div class="ksw" aria-busy="true"></div>`);
  const root = container.querySelector('.ksw');
  const fill = (markup) => { root.replaceChildren(); root.insertAdjacentHTML('beforeend', markup); root.removeAttribute('aria-busy'); };
  let s;
  try {
    s = await createClient().get('/summary');
  } catch (err) {
    return fill(`<p class="ksw-muted">⚠️ ${esc(errorText(err))}</p>`);
  }

  if (s.role === 'child') {
    const open = s.open.slice(0, 4);
    const g = s.goal ? progress(s.balance.available, s.goal.stars) : null;
    return fill(`
      <a href="${ROUTE}" class="ksw-big" aria-label="${esc(tr('widget.stars', { n: s.balance.available }))}">⭐ ${s.balance.available}${s.balance.reserved ? ` <span class="ksw-pill">🔒 ${s.balance.reserved}</span>` : ''}</a>
      ${open.length ? `<ul class="ksw-list">${open.map((a) => `<li><span>${esc(a.icon || '⭐')} ${esc(a.title)}</span><span>+${a.stars} ⭐</span></li>`).join('')}</ul>`
        : `<p class="ksw-muted">${esc(tr('widget.allDone'))}</p>`}
      ${s.open.length > open.length ? `<p class="ksw-muted">${esc(tr('widget.more', { n: s.open.length - open.length }))}</p>` : ''}
      ${s.pending ? `<p class="ksw-muted">⏳ ${esc(tr('widget.pending', { n: s.pending }))}</p>` : ''}
      ${g ? `<div><span class="ksw-muted">🎯 ${esc(s.goal.title)} · ${g.have}/${s.goal.stars}</span><div class="ksw-meter" role="meter" aria-valuemin="0" aria-valuemax="${s.goal.stars}" aria-valuenow="${g.have}"><span style="width:${g.pct}%"></span></div></div>` : ''}`);
  }

  if (s.role === 'parent') {
    const waiting = s.counts.completions + s.counts.wishes + s.counts.redemptions;
    return fill(`
      ${s.children.length ? `<ul class="ksw-list">${s.children.map((c) => `<li><span>${esc(c.name)}</span>
        <span>⭐ ${c.balance.available}${c.pending ? ` <span class="ksw-pill">⏳ ${c.pending}</span>` : ''} <span class="ksw-muted">${c.today_done}/${c.today_total}</span></span></li>`).join('')}</ul>`
        : `<p class="ksw-muted">${esc(tr('parent.noChildren'))}</p>`}
      <a href="${ROUTE}" class="ksw-muted">${esc(waiting ? tr('widget.waiting', { n: waiting }) : tr('widget.nothingWaiting'))}${s.counts.to_fulfil ? ` · 📦 ${s.counts.to_fulfil}` : ''}</a>`);
  }

  return fill(`<p class="ksw-muted">${esc(tr('other.text'))}</p>`);
}
