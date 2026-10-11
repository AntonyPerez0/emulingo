// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { icon, ICON_NAMES } from '../../src/ui/icons.js';
import { html, SafeHtml } from '../../src/ui/dom.js';

const parse = (markup) => {
  const div = document.createElement('div');
  div.innerHTML = String(markup);
  return div.firstElementChild;
};

describe('icon', () => {
  it('is decorative by default and sized with currentColor strokes', () => {
    const svg = parse(icon('trash-2', { size: 16 }));
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.classList.contains('icon-trash-2')).toBe(true);
  });

  it('becomes an image with an escaped name when labelled', () => {
    const svg = parse(icon('flame', { label: 'Streak "4" days' }));
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Streak "4" days');
    expect(svg.hasAttribute('aria-hidden')).toBe(false);
  });

  it('is trusted markup inside html templates and still works as a string', () => {
    const out = icon('x');
    expect(out).toBeInstanceOf(SafeHtml);
    expect(String(html`<button>${out}</button>`)).toContain('<svg');
    expect(`<b>${out}</b>`).toContain('<svg');
  });

  it('falls back safely for unknown names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svg = parse(icon('"><img src=x onerror=alert(1)>'));
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('img')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ships the icons the views rely on', () => {
    for (const name of ['gamepad', 'play', 'book-open', 'layers', 'rotate-ccw', 'settings', 'upload', 'save', 'folder-open', 'scan-text', 'log-out', 'volume-2', 'plus', 'trash-2', 'x', 'check', 'search', 'languages', 'download', 'alert-triangle', 'info', 'chevron-down', 'flame', 'more-horizontal', 'sun', 'moon', 'monitor', 'keyboard', 'refresh-cw', 'eye', 'eye-off', 'pause', 'mic', 'graduation-cap', 'eject', 'square-dashed', 'stop', 'volume-x', 'maximize']) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});
