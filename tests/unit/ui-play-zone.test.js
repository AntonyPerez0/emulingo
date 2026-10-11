// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampZone, isZone, zoneFromPoints, moveZone, resizeZone, pointInBox, zoneToPercent,
  zoneFromPercent, sameZone, describeZone, createZoneEditor, MIN_SIZE, DEFAULT_ZONE
} from '../../src/ui/views/play/zone.js';

describe('zone geometry', () => {
  it('clamps into the frame with a minimum size', () => {
    expect(clampZone({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(clampZone({ x: 0.5, y: 0.5, w: 0.001, h: 2 })).toEqual({ x: 0.5, y: 0, w: MIN_SIZE, h: 1 });
    expect(clampZone(null)).toBe(null);
  });

  it('validates stored zones', () => {
    expect(isZone(DEFAULT_ZONE)).toBe(true);
    expect(isZone({ x: 0.5, y: 0, w: 0.6, h: 0.2 })).toBe(false);
    expect(isZone({ x: 'a', y: 0, w: 1, h: 1 })).toBe(false);
    expect(isZone(null)).toBe(false);
  });

  it('builds a rect from two points in any order', () => {
    expect(zoneFromPoints({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.6 })).toEqual({ x: 0.2, y: 0.6, w: 0.6, h: 0.3 });
  });

  it('grows a tap to the minimum size around the point', () => {
    const z = zoneFromPoints({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 });
    expect(z.w).toBe(MIN_SIZE);
    expect(z.h).toBe(MIN_SIZE);
    expect(z.x).toBeCloseTo(0.475, 4);
  });

  it('moves without leaving the frame', () => {
    expect(moveZone({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 0.9, -1)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });

  it('resizes from the bottom-right corner within the frame', () => {
    expect(resizeZone({ x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, 0.5, -0.5)).toEqual({ x: 0.6, y: 0.6, w: 0.4, h: MIN_SIZE });
  });

  it('maps pointer coordinates into the box', () => {
    const box = { left: 100, top: 50, width: 200, height: 100 };
    expect(pointInBox(200, 100, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointInBox(0, 500, box)).toEqual({ x: 0, y: 1 });
    expect(pointInBox(10, 10, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('round-trips through percentages', () => {
    const p = zoneToPercent({ x: 0.03, y: 0.64, w: 0.94, h: 0.33 });
    expect(p).toEqual({ left: 3, top: 64, width: 94, height: 33 });
    const { zone, errors } = zoneFromPercent({ left: '3', top: '64', width: '94', height: '33' });
    expect(errors).toEqual({});
    expect(sameZone(zone, { x: 0.03, y: 0.64, w: 0.94, h: 0.33 })).toBe(true);
    expect(describeZone(zone)).toBe('Left 3%, top 64%, width 94%, height 33%.');
  });

  it('accepts a decimal comma', () => {
    expect(zoneFromPercent({ left: '2,5', top: '60', width: '90', height: '30' }).zone.x).toBeCloseTo(0.025, 4);
  });

  it('explains invalid fields', () => {
    const r = zoneFromPercent({ left: '', top: '-1', width: '2', height: '50' });
    expect(r.zone).toBe(null);
    expect(Object.keys(r.errors).sort()).toEqual(['left', 'top', 'width']);
    expect(r.errors.left).toMatch(/Enter a number/);
    const over = zoneFromPercent({ left: '60', top: '0', width: '50', height: '50' });
    expect(over.errors.width).toMatch(/can’t be more than 100%/);
  });
});

describe('createZoneEditor', () => {
  let overlay;
  let panel;
  let saved;
  let opened;
  let closed;
  let editor;

  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">Text area</button><div id="overlay" hidden></div><div id="panel" hidden></div>';
    overlay = document.getElementById('overlay');
    panel = document.getElementById('panel');
    saved = [];
    opened = 0;
    closed = [];
    editor = createZoneEditor({
      overlayEl: overlay,
      panelEl: panel,
      onOpen: () => { opened++; },
      onClose: (info) => { closed.push(info); },
      onSave: async (z) => { saved.push(z); }
    });
    document.getElementById('opener').focus();
  });

  const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('opens on the default area with filled fields and focus on the area', () => {
    editor.open(null);
    expect(opened).toBe(1);
    expect(overlay.hidden).toBe(false);
    expect(panel.hidden).toBe(false);
    const rect = overlay.querySelector('[data-zone-rect]');
    expect(document.activeElement).toBe(rect);
    expect(rect.getAttribute('role')).toBe('application');
    expect(panel.querySelector('input[name="left"]').value).toBe('3');
    expect(panel.querySelector('input[name="height"]').value).toBe('33');
    // every field has a visible label
    for (const input of panel.querySelectorAll('input')) {
      expect(panel.querySelector(`label[for="${input.id}"]`)).not.toBe(null);
    }
  });

  it('moves with arrows, resizes with Shift+arrows and saves with Enter', async () => {
    editor.open({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    const rect = overlay.querySelector('[data-zone-rect]');
    key(rect, 'ArrowRight');
    key(rect, 'ArrowDown');
    key(rect, 'ArrowRight', { shiftKey: true });
    expect(editor.rect).toEqual({ x: 0.11, y: 0.11, w: 0.51, h: 0.5 });
    expect(panel.querySelector('input[name="left"]').value).toBe('11');
    key(rect, 'Enter');
    await flush();
    expect(saved).toEqual([{ x: 0.11, y: 0.11, w: 0.51, h: 0.5 }]);
    expect(closed).toEqual([{ cancelled: false }]);
    expect(overlay.hidden).toBe(true);
    expect(document.activeElement.id).toBe('opener');
  });

  it('cancels with Escape without saving', () => {
    editor.open(null);
    key(overlay.querySelector('[data-zone-rect]'), 'Escape');
    expect(saved).toEqual([]);
    expect(closed).toEqual([{ cancelled: true }]);
    expect(editor.isOpen()).toBe(false);
  });

  it('validates the % fields before saving', async () => {
    editor.open(null);
    const width = panel.querySelector('input[name="width"]');
    width.value = '200';
    panel.querySelector('[data-zone-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(saved).toEqual([]);
    expect(width.getAttribute('aria-invalid')).toBe('true');
    const err = panel.querySelector(`#${width.id}-error`);
    expect(err.hidden).toBe(false);
    expect(width.getAttribute('aria-describedby')).toContain(err.id);
    expect(document.activeElement).toBe(width);
    width.value = '50';
    panel.querySelector('[data-zone-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0].w).toBe(0.5);
  });

  it('"Use automatic detection" saves null', async () => {
    editor.open({ x: 0, y: 0.5, w: 1, h: 0.5 });
    panel.querySelector('[data-action="zone-auto"]').click();
    await flush();
    expect(saved).toEqual([null]);
  });

  it('removes its listeners when closed', () => {
    editor.open(null);
    editor.close();
    // a key on the (now empty) overlay does nothing
    key(overlay, 'Enter');
    expect(saved).toEqual([]);
    expect(overlay.innerHTML).toBe('');
  });
});
