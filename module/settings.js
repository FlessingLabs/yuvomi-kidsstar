/**
 * KidsStar - Einstellungen fuer den Haushalt (Yuvomi zeigt das Blatt nur Admins)
 *
 * Wer Elternfunktionen bekommt, ob Aktionen standardmaessig bestaetigt werden
 * muessen, ob Kinder Wuensche vorschlagen duerfen - und ob der KidsStar-Dienst
 * erreichbar ist. Gespeichert und geprueft wird im Dienst; das Blatt ist nur
 * die Oberflaeche dafuer.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { showToast } from '/utils/toast-show.js';
import { createClient } from './lib/api.js';
import { errorText } from './index.js';

const ID = 'kidsstar';
const tr = (key, params) => t(`extensions.${ID}.${key}`, params);

export async function render(container, { section } = {}) {
  if (section !== 'household') return;
  const ks = createClient();
  container.replaceChildren();
  let me;
  let status = null;
  try {
    me = await ks.get('/me');
    if (me.role === 'parent') status = await ks.get('/tablet-status').catch(() => null);
  } catch (err) {
    container.insertAdjacentHTML('beforeend', `<p role="alert">⚠️ ${esc(errorText(err))}</p><p>${esc(tr('settings.serviceHelp'))}</p>`);
    return;
  }
  const s = me.settings;
  const box = (name, label, hint) => `
    <label class="ks-set">
      <input type="checkbox" name="${name}"${s[name] ? ' checked' : ''}>
      <span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span>
    </label>`;
  container.insertAdjacentHTML('beforeend', `
    <form class="ks-settings">
      ${box('parent_roles', tr('settings.parentRoles'), tr('settings.parentRolesHint'))}
      ${box('default_requires_approval', tr('settings.defaultApproval'), tr('settings.defaultApprovalHint'))}
      ${box('wishes_enabled', tr('settings.wishes'), tr('settings.wishesHint'))}
      <button type="submit" class="btn btn--primary">${esc(tr('action.save'))}</button>
    </form>
    <h3>${esc(tr('settings.service'))}</h3>
    <ul>
      <li>${esc(tr('settings.version', { version: me.version }))}</li>
      <li>${esc(tr('settings.timezone', { tz: me.timezone, day: me.day }))}</li>
      <li>${esc(status?.ok ? tr('settings.tabletOk') : tr(`tablet.status.${status?.reason || 'tablet_not_configured'}`))}</li>
    </ul>`);
  const form = container.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await ks.patch('/settings', {
        parent_roles: form.parent_roles.checked,
        default_requires_approval: form.default_requires_approval.checked,
        wishes_enabled: form.wishes_enabled.checked,
      });
      showToast(tr('saved'), 'success');
    } catch (err) {
      showToast(errorText(err), 'danger');
    }
  });
}
