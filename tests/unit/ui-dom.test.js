// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { html, raw, render, rerender, on, $, $$, uid, debounce, escapeHtml, SafeHtml, fragment, toElement } from '../../src/ui/dom.js';

const parse = (tpl) => {
  const div = document.createElement('div');
  render(div, tpl);
  return div;
};

describe('html escaping', () => {
  it('escapes text interpolations', () => {
    const out = String(html`<p>${'<img src=x onerror=alert(1)>'}</p>`);
    expect(out).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    const div = parse(html`<p>${'<img src=x onerror=alert(1)>'}</p>`);
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('prevents breaking out of double- and single-quoted attributes', () => {
    const payload = '" onmouseover="alert(1)" x="';
    const div = parse(html`<a title="${payload}" data-x='${"' onclick='alert(2)"}'>x</a>`);
    const a = div.querySelector('a');
    expect(a.getAttribute('onmouseover')).toBeNull();
    expect(a.getAttribute('onclick')).toBeNull();
    expect(a.getAttribute('title')).toBe(payload);
    expect(a.getAttribute('data-x')).toBe("' onclick='alert(2)");
  });

  it('quotes and encodes unquoted attribute values', () => {
    const div = parse(html`<a title=${'x onmouseover=alert(1)'} class=${''}>x</a>`);
    const a = div.querySelector('a');
    expect(a.getAttribute('onmouseover')).toBeNull();
    expect(a.getAttribute('title')).toBe('x onmouseover=alert(1)');
    expect(a.hasAttribute('class')).toBe(true);
  });

  it('blocks javascript: and data: URLs at the start of URL attributes', () => {
    for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\u0000script:alert(1)', '\tjavascript:x', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox']) {
      const a = parse(html`<a href="${bad}">x</a>`).querySelector('a');
      expect(a.getAttribute('href')).toBe('about:invalid#blocked');
    }
    expect(parse(html`<a href="${'#/deck'}">x</a>`).querySelector('a').getAttribute('href')).toBe('#/deck');
    expect(parse(html`<img src="${'data:image/png;base64,AAAA'}" alt="">`).querySelector('img').getAttribute('src')).toBe('data:image/png;base64,AAAA');
    // A static prefix fixes the scheme, so the interpolation is only a path.
    expect(parse(html`<a href="#/${'javascript:x'}">x</a>`).querySelector('a').getAttribute('href')).toBe('#/javascript:x');
  });

  it('keeps nested html results and joins arrays', () => {
    const items = ['a', '<b>', 'c'];
    const div = parse(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`);
    expect($$('li', div).map((li) => li.textContent)).toEqual(['a', '<b>', 'c']);
    expect(div.querySelector('b')).toBeNull();
  });

  it('nesting does not double-escape and plain strings stay text', () => {
    const inner = html`<em>${'&'}</em>`;
    expect(String(html`<p>${inner}</p>`)).toBe('<p><em>&amp;</em></p>');
    expect(String(html`<p>${'<em>x</em>'}</p>`)).toBe('<p>&lt;em&gt;x&lt;/em&gt;</p>');
  });

  it('raw() inserts trusted markup in text position', () => {
    const div = parse(html`<p>${raw('<strong>ok</strong>')}</p>`);
    expect(div.querySelector('strong').textContent).toBe('ok');
  });

  it('raw() is still escaped inside attribute values', () => {
    const div = parse(html`<p title="${raw('" onclick="x')}">t</p>`);
    expect(div.querySelector('p').getAttribute('onclick')).toBeNull();
  });

  it('renders nothing for null, undefined, false and true in text', () => {
    expect(String(html`<p>${null}${undefined}${false}${true}${0}</p>`)).toBe('<p>0</p>');
    const cond = false;
    expect(String(html`<div>${cond && html`<span>x</span>`}</div>`)).toBe('<div></div>');
  });

  it('serialises booleans as true/false in attribute values', () => {
    const div = parse(html`<button aria-pressed="${false}" aria-expanded="${true}">x</button>`);
    expect(div.querySelector('button').getAttribute('aria-pressed')).toBe('false');
    expect(div.querySelector('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('supports attribute maps in tag position and drops event handlers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const div = parse(html`<button ${{ disabled: true, hidden: false, 'aria-label': 'Delete "x"', onclick: 'alert(1)', 'bad name': 1, title: null }}>x</button>`);
    const b = div.querySelector('button');
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute('hidden')).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('Delete "x"');
    expect(b.getAttribute('onclick')).toBeNull();
    expect(b.hasAttribute('title')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('allows bare boolean attribute names in tag position but not injected attributes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const div = parse(html`<input ${'disabled'}><input ${'x onfocus=alert(1) autofocus'}><input ${'onfocus'}>`);
    const [a, b, c] = $$('input', div);
    expect(a.disabled).toBe(true);
    expect(b.getAttribute('onfocus')).toBeNull();
    expect(b.hasAttribute('autofocus')).toBe(false);
    expect(c.hasAttribute('onfocus')).toBe(false);
    warn.mockRestore();
  });

  it('writes ARIA states and enumerated attributes as "true"/"false" in attribute maps', () => {
    const div = parse(html`<button ${{ 'aria-pressed': false, 'aria-expanded': true, spellcheck: false, disabled: false, hidden: true, 'aria-describedby': false }}>x</button>`);
    const b = div.querySelector('button');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(b.getAttribute('spellcheck')).toBe('false');
    expect(b.hasAttribute('disabled')).toBe(false);
    expect(b.hasAttribute('hidden')).toBe(true);
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });

  it('blocks unsafe URLs even after leading whitespace in the template', () => {
    const a = parse(html`<a href=" ${'javascript:alert(1)'}">x</a>`).querySelector('a');
    expect(a.getAttribute('href').trim()).toBe('about:invalid#blocked');
  });

  it('never lets an interpolated attribute name complete an event handler', () => {
    const div = parse(html`<b data-${'x'}="1" o${'nclick'}="alert(1)">x</b>`);
    const b = div.querySelector('b');
    expect(b.getAttribute('data-x')).toBe('1');
    expect(b.getAttribute('onclick')).toBeNull();
  });

  it('applies URL sanitising inside attribute maps', () => {
    const a = parse(html`<a ${{ href: 'javascript:alert(1)' }}>x</a>`).querySelector('a');
    expect(a.getAttribute('href')).toBe('about:invalid#blocked');
  });

  it('neutralises comment breakouts', () => {
    const div = parse(html`<div><!-- ${'--><img src=x onerror=alert(1)><!--'} --></div>`);
    expect(div.querySelector('img')).toBeNull();
  });

  it('caches context analysis per call site and stays correct across calls', () => {
    const t = (v) => html`<a title="${v}">${v}</a>`;
    expect(String(t('"'))).toBe('<a title="&quot;">&quot;</a>');
    expect(String(t('<'))).toBe('<a title="&lt;">&lt;</a>');
  });

  it('results are SafeHtml strings', () => {
    const r = html`<b>x</b>`;
    expect(r).toBeInstanceOf(SafeHtml);
    expect(`${r}`).toBe('<b>x</b>');
    expect(escapeHtml('<&>"\'`')).toBe('&lt;&amp;&gt;&quot;&#39;&#96;');
  });
});

describe('render / fragment', () => {
  it('render treats plain strings as text', () => {
    const div = document.createElement('div');
    render(div, '<b>bold</b>');
    expect(div.querySelector('b')).toBeNull();
    expect(div.textContent).toBe('<b>bold</b>');
  });

  it('fragment and toElement parse templates', () => {
    expect(fragment(html`<i>1</i><i>2</i>`).childNodes.length).toBe(2);
    expect(toElement(html`<section id="s"></section>`).id).toBe('s');
  });
});

describe('$, $$, on, uid, debounce', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('queries and delegates events to matching descendants', () => {
    document.body.innerHTML = '<ul id="l"><li><button data-id="1"><span>One</span></button></li><li><button data-id="2">Two</button></li></ul><button id="out">Out</button>';
    const root = $('#l');
    expect($$('button', root)).toHaveLength(2);
    const seen = [];
    const off = on(root, 'click', 'button[data-id]', (e, el) => seen.push(el.dataset.id));
    root.querySelector('span').click();
    $('#out').click();
    root.querySelectorAll('button')[1].click();
    expect(seen).toEqual(['1', '2']);
    off();
    root.querySelector('span').click();
    expect(seen).toEqual(['1', '2']);
  });

  it('uid generates unique ids with a prefix', () => {
    const a = uid('x');
    const b = uid('x');
    expect(a).not.toBe(b);
    expect(a.startsWith('x-')).toBe(true);
  });

  it('debounce delays, cancels and flushes', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1); d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledWith(2);
    d(3); d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    d(4); d.flush();
    expect(fn).toHaveBeenLastCalledWith(4);
    vi.useRealTimers();
  });
});

describe('rerender focus restore', () => {
  let root;
  const list = (items) => html`<h2 id="h">Cards</h2><ul>${items.map((i) => html`<li data-key="${i}"><span>${i}</span><button data-action="speak">Speak ${i}</button><button data-action="delete">Delete ${i}</button></li>`)}</ul>`;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div><button id="elsewhere">x</button>';
    root = $('#root');
  });

  it('restores focus to the same control in the same keyed row', () => {
    render(root, list(['a', 'b', 'c']));
    root.querySelector('[data-key="b"] [data-action="delete"]').focus();
    rerender(root, () => render(root, list(['a', 'b', 'c'])));
    expect(document.activeElement.textContent).toBe('Delete b');
  });

  it('moves to the row that took a deleted row’s place', () => {
    render(root, list(['a', 'b', 'c']));
    root.querySelector('[data-key="b"] [data-action="delete"]').focus();
    rerender(root, () => render(root, list(['a', 'c'])));
    expect(document.activeElement.textContent).toBe('Delete c');
  });

  it('falls back to the last row, then the heading', () => {
    render(root, list(['a', 'b']));
    root.querySelector('[data-key="b"] [data-action="speak"]').focus();
    rerender(root, () => render(root, list(['a'])));
    expect(document.activeElement.textContent).toBe('Speak a');
    rerender(root, () => render(root, list([])));
    expect(document.activeElement.id).toBe('h');
    expect(document.activeElement.getAttribute('tabindex')).toBe('-1');
  });

  it('uses the index when the focused element has no key', () => {
    render(root, html`<button>One</button><button>Two</button>`);
    root.querySelectorAll('button')[1].focus();
    rerender(root, () => render(root, html`<button>Uno</button><button>Dos</button>`));
    expect(document.activeElement.textContent).toBe('Dos');
  });

  it('keeps text selection in a re-rendered input', () => {
    render(root, html`<input data-key="q" value="hello">`);
    const input = root.querySelector('input');
    input.focus();
    input.setSelectionRange(2, 4);
    rerender(root, () => render(root, html`<input data-key="q" value="hello">`));
    expect(document.activeElement.selectionStart).toBe(2);
    expect(document.activeElement.selectionEnd).toBe(4);
  });

  it('does nothing when focus is outside root or was not lost', () => {
    render(root, list(['a']));
    $('#elsewhere').focus();
    rerender(root, () => render(root, list(['a'])));
    expect(document.activeElement.id).toBe('elsewhere');
    const btn = root.querySelector('[data-action="speak"]');
    btn.focus();
    rerender(root, () => { btn.textContent = 'Speak again'; });
    expect(document.activeElement).toBe(btn);
  });

  it('awaits async render functions', async () => {
    render(root, list(['a', 'b']));
    root.querySelector('[data-key="b"] [data-action="speak"]').focus();
    const result = await rerender(root, async () => { render(root, list(['b'])); return 42; });
    expect(result).toBe(42);
    expect(document.activeElement.textContent).toBe('Speak b');
  });
});
