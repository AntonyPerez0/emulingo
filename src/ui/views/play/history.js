// Recent lines: the latest captures as a list of buttons (PLAY-22, A11Y-05).
// Selecting one shows it in the live panel ("Viewing an earlier line").
// Paged with "Show more"; "Clear history" asks first. Re-rendering keeps
// keyboard focus on the same row (data-key).
import { html, render, rerender, debounce } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce } from '../../a11y.js';
import { confirmDialog } from '../../dialog.js';
import { emptyState } from '../../components.js';
import { formatRelative, formatCount } from '../../format.js';
import { dirFor } from '../../../core/language.js';
import * as history from '../../../core/history.js';
import { captureSummary } from './model.js';

const PAGE = 20;

/**
 * createRecentLines(sectionEl, { onOpen(capture), onCleared() }) →
 *   { refresh(), setActive(id|null), destroy() }
 */
export function createRecentLines(section, { onOpen = () => {}, onCleared = () => {} } = {}) {
  let limit = PAGE;
  let active = null;
  let clock = 0;

  render(section, html`<div class="card__header recent__header">
      <h2 class="card__title" id="play-recent-title">Recent lines</h2>
      <button type="button" class="btn btn--sm btn--ghost" data-action="clear-history" hidden>${icon('trash-2', { size: 16 })}<span class="btn__label">Clear history</span></button>
    </div>
    <div class="recent__body" data-recent-body></div>`);
  section.setAttribute('aria-labelledby', 'play-recent-title');
  const body = section.querySelector('[data-recent-body]');
  const clearBtn = section.querySelector('[data-action="clear-history"]');

  function item(c) {
    const { text, translation } = captureSummary(c);
    const current = c.id === active;
    return html`<li class="recent-item" data-key="${c.id}">
      <button type="button" class="recent-item__btn" data-action="open-line" ${{ 'aria-current': current ? 'true' : null }}>
        <span class="recent-item__orig" lang="${c.src}" dir="${dirFor(c.src)}">${text}</span>
        ${translation ? html`<span class="recent-item__trans" lang="${c.tgt}" dir="${dirFor(c.tgt)}">${translation}</span>` : ''}
        <span class="recent-item__time"><time datetime="${new Date(c.time).toISOString()}">${formatRelative(c.time)}</time></span>
      </button>
    </li>`;
  }

  function draw() {
    const all = history.list();
    clearBtn.hidden = all.length === 0;
    if (!all.length) {
      render(body, emptyState({
        icon: 'history',
        level: 3,
        title: 'No lines yet',
        body: 'Lines you meet in the game appear here, so you can read them again later.'
      }));
      return;
    }
    const shown = all.slice(0, limit);
    render(body, html`<ul class="recent-list" role="list">${shown.map(item)}</ul>
      ${all.length > shown.length ? html`<div class="recent__more">
        <button type="button" class="btn btn--sm btn--ghost" data-action="more-lines">${icon('chevron-down', { size: 16 })}<span class="btn__label">Show more</span></button>
        <span class="text-sm text-muted">Showing ${shown.length} of ${formatCount(all.length, 'line')}</span>
      </div>` : ''}`);
  }

  const refresh = debounce(() => rerender(section, draw), 150);

  section.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'open-line') {
      const key = btn.closest('[data-key]').dataset.key;
      const c = history.get(key);
      if (c) onOpen(c);
    } else if (btn.dataset.action === 'more-lines') {
      const before = history.list().slice(0, limit).length;
      limit += PAGE;
      rerender(section, draw);
      // the first new row, so keyboard users carry on where the list grew
      const next = body.querySelectorAll('.recent-item__btn')[before];
      if (next) next.focus();
      announce(`Showing ${Math.min(limit, history.list().length)} lines.`);
    } else if (btn.dataset.action === 'clear-history') {
      const ok = await confirmDialog({
        title: 'Clear recent lines?',
        body: 'This removes the list of lines you’ve met. Your deck and dictionary stay as they are.',
        confirmLabel: 'Clear history',
        danger: true
      });
      if (!ok) return;
      history.clear();
      limit = PAGE;
      active = null;
      refresh.cancel();
      draw();
      onCleared();
      announce('Recent lines cleared.');
      const heading = section.querySelector('h2');
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
    }
  });

  draw();
  // relative times ("2 minutes ago") stay current
  clock = setInterval(() => {
    for (const t of body.querySelectorAll('time[datetime]')) {
      const ts = Date.parse(t.getAttribute('datetime'));
      const txt = formatRelative(ts);
      if (t.textContent !== txt) t.textContent = txt;
    }
  }, 30000);

  return {
    refresh,
    setActive(id) {
      active = id || null;
      for (const b of body.querySelectorAll('.recent-item__btn')) {
        const on = b.closest('[data-key]').dataset.key === active;
        if (on) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
    },
    destroy() { clearInterval(clock); refresh.cancel(); }
  };
}
