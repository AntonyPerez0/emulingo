// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/core/store.js', () => ({ store: { get: () => undefined, set: () => true, subscribe: () => () => {} } }));

window.scrollTo = () => {};
const router = await import('../../src/ui/router.js');
const { initRouter, navigate, currentView, onViewChange, setNavBadge, parseHash, buildHash, _resetRouter } = router;

const SHELL = `
  <nav aria-label="Primary">
    <a href="#/play" data-nav="play"><span class="app-nav__label">Play</span></a>
    <a href="#/review" data-nav="review"><span class="app-nav__label">Review</span><span class="nav-badge" data-badge="review" hidden></span><span data-badge-label="review"></span></a>
    <a href="#/deck" data-nav="deck"><span class="app-nav__label">Deck</span></a>
  </nav>
  <main id="main">
    <section data-view="play" hidden></section>
    <section data-view="review" hidden></section>
    <section data-view="deck" hidden></section>
  </main>`;

function makeView(id, title) {
  return {
    id,
    title,
    mount: vi.fn((el) => { el.innerHTML = `<div class="page"><h1 tabindex="-1">${title}</h1><button>Act</button></div>`; }),
    show: vi.fn(),
    hide: vi.fn(),
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const go = async (hash) => {
  const changed = new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
  location.hash = hash;
  await changed;
  await settle();
};

let play;
let review;
let deck;

beforeEach(() => {
  _resetRouter();
  history.replaceState(null, '', '/');
  document.body.innerHTML = SHELL;
  play = makeView('play', 'Play');
  review = makeView('review', 'Review');
  deck = makeView('deck', 'Deck');
});

afterEach(() => _resetRouter());

describe('hash helpers', () => {
  it('parses and builds routes with params', () => {
    expect(parseHash('#/deck?q=hallo&kind=word')).toEqual({ id: 'deck', params: { q: 'hallo', kind: 'word' } });
    expect(parseHash('#/review')).toEqual({ id: 'review', params: {} });
    expect(parseHash('#main')).toBeNull();
    expect(parseHash('')).toBeNull();
    expect(buildHash('deck', { q: 'a b' })).toBe('#/deck?q=a+b');
    expect(buildHash('play')).toBe('#/play');
    expect(buildHash('deck', { q: undefined, kind: null, page: 2, empty: '' })).toBe('#/deck?page=2');
  });
});

describe('initRouter', () => {
  it('shows the default view on first load without moving focus and fixes the URL', async () => {
    const before = document.activeElement;
    await initRouter([play, review, deck], { defaultView: 'play' });
    expect(location.hash).toBe('#/play');
    expect(play.mount).toHaveBeenCalledTimes(1);
    expect(play.show).toHaveBeenCalledWith({});
    expect(document.querySelector('section[data-view="play"]').hidden).toBe(false);
    expect(document.querySelector('section[data-view="review"]').hidden).toBe(true);
    expect(document.activeElement).toBe(before);
    expect(document.title).toBe('Play · Spritespeak');
    expect(document.body.dataset.view).toBe('play');
    expect(document.querySelector('[data-nav="play"]').getAttribute('aria-current')).toBe('page');
    expect(currentView()).toBe('play');
  });

  it('honours a deep link on first load', async () => {
    history.replaceState(null, '', '/#/review');
    await initRouter([play, review, deck]);
    expect(currentView()).toBe('review');
    expect(play.mount).not.toHaveBeenCalled();
  });

  it('mounts once, hides the previous view, updates chrome and focuses the h1 on navigation', async () => {
    await initRouter([play, review, deck]);
    const changes = [];
    onViewChange((id, prev, params) => changes.push([id, prev, params]));
    await go('#/review');
    expect(play.hide).toHaveBeenCalledTimes(1);
    expect(review.mount).toHaveBeenCalledTimes(1);
    expect(document.querySelector('section[data-view="play"]').hidden).toBe(true);
    expect(document.querySelector('[data-nav="review"]').getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-nav="play"]').hasAttribute('aria-current')).toBe(false);
    expect(document.title).toBe('Review · Spritespeak');
    expect(document.activeElement.textContent).toBe('Review');
    await go('#/play');
    await go('#/review?card=3');
    expect(review.mount).toHaveBeenCalledTimes(1);
    expect(review.show).toHaveBeenLastCalledWith({ card: '3' });
    expect(changes.map((c) => c[0])).toEqual(['review', 'play', 'review']);
    expect(changes[2][1]).toBe('play');
  });

  it('back/forward (hash changes) route without adding views twice', async () => {
    await initRouter([play, review, deck]);
    await go('#/deck');
    await go('#/play');
    expect(deck.mount).toHaveBeenCalledTimes(1);
    expect(currentView()).toBe('play');
  });

  it('navigate() changes the hash and re-shows the current view when already there', async () => {
    await initRouter([play, review, deck]);
    navigate('deck');
    await new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
    await settle();
    expect(currentView()).toBe('deck');
    deck.show.mockClear();
    document.body.focus();
    await navigate('deck');
    expect(deck.show).toHaveBeenCalledTimes(1);
    expect(document.activeElement.textContent).toBe('Deck');
  });

  it('falls back to the default view for unknown routes', async () => {
    await initRouter([play, review, deck]);
    await go('#/review');
    await go('#/nonsense');
    expect(currentView()).toBe('play');
    expect(location.hash).toBe('#/play');
  });

  it('treats plain fragments as in-page anchors: stays on the view, restores the route and focuses the target', async () => {
    await initRouter([play, review, deck]);
    await go('#/review?card=2');
    const section = document.querySelector('section[data-view="review"]');
    section.insertAdjacentHTML('beforeend', '<h2 id="about">About</h2>');
    review.show.mockClear();
    await go('#about');
    expect(currentView()).toBe('review');
    expect(location.hash).toBe('#/review?card=2');
    expect(review.show).not.toHaveBeenCalled();
    expect(document.activeElement.id).toBe('about');
    await go('#');
    expect(currentView()).toBe('review');
    expect(location.hash).toBe('#/review?card=2');
  });

  it('keeps a mounted view (and its DOM) when show() throws, and still updates focus', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await initRouter([play, review, deck]);
    await go('#/review');
    review.show.mockImplementationOnce(() => { throw new Error('boom'); });
    await go('#/play');
    await go('#/review');
    const section = document.querySelector('section[data-view="review"]');
    expect(section.querySelector('[role="alert"]')).toBeNull();
    expect(section.querySelector('button').textContent).toBe('Act');
    expect(document.activeElement.textContent).toBe('Review');
    expect(document.querySelector('.toast')).not.toBeNull();
    await go('#/play');
    await go('#/review');
    expect(review.show).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it('lazy-loads views and renders an error panel with a reload button when a view fails', async () => {
    const lazy = { id: 'review', title: 'Review', load: vi.fn(async () => ({ default: review })) };
    const broken = { id: 'deck', load: vi.fn(async () => { throw new Error('chunk missing'); }) };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await initRouter([play, lazy, broken]);
    await go('#/review');
    expect(lazy.load).toHaveBeenCalledTimes(1);
    expect(review.mount).toHaveBeenCalledTimes(1);
    await go('#/deck');
    const section = document.querySelector('section[data-view="deck"]');
    expect(section.querySelector('[role="alert"]').textContent).toContain('This page couldn’t load');
    expect(section.querySelector('[data-router-reload]')).not.toBeNull();
    expect(document.activeElement.tagName).toBe('H1');
    expect(document.title).toBe('Deck · Spritespeak');
    err.mockRestore();
  });

  it('accepts an object map of views', async () => {
    await initRouter({ play, review });
    expect(currentView()).toBe('play');
  });
});

describe('setNavBadge', () => {
  it('shows a count with an accessible label and hides at zero', () => {
    setNavBadge('review', 3);
    const badge = document.querySelector('[data-badge="review"]');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3');
    expect(document.querySelector('[data-badge-label="review"]').textContent).toBe(', 3 cards due');
    setNavBadge('review', 1);
    expect(document.querySelector('[data-badge-label="review"]').textContent).toBe(', 1 card due');
    setNavBadge('review', 250);
    expect(badge.textContent).toBe('99+');
    setNavBadge('review', 0);
    expect(badge.hidden).toBe(true);
    expect(document.querySelector('[data-badge-label="review"]').textContent).toBe('');
  });
});
