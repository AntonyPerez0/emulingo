// TEMPORARY stub so the shell runs; replaced by the Play view (VIEW-PLAY).
import { html, render } from '../../dom.js';
import { emptyState } from '../../components.js';

export default {
  id: 'play',
  title: 'Play',
  icon: 'gamepad',
  mount(section) {
    render(section, html`<div class="page">
      <div class="page-header">
        <div class="page-header__text">
          <h1 tabindex="-1">Play</h1>
          <p class="page-header__subtitle">Play a game you own and learn the language as you go.</p>
        </div>
      </div>
      <div class="card">
        ${emptyState({
          icon: 'gamepad',
          title: 'Load a game to start',
          body: 'Your game stays on this device. Nothing is uploaded.',
        })}
      </div>
    </div>`);
  },
  show() {},
  hide() {},
};
