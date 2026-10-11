import { describe, it, expect } from 'vitest';
import { formatInterval, formatCount, formatBytes, formatRelative } from '../../src/ui/format.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatInterval', () => {
  it('formats SRS intervals compactly', () => {
    expect(formatInterval(0)).toBe('<1 min');
    expect(formatInterval(30 * 1000)).toBe('<1 min');
    expect(formatInterval(10 * MIN)).toBe('10 min');
    expect(formatInterval(3 * HOUR)).toBe('3 h');
    expect(formatInterval(DAY)).toBe('1 day');
    expect(formatInterval(4 * DAY)).toBe('4 days');
    expect(formatInterval(60 * DAY)).toBe('2 mo');
    expect(formatInterval(548 * DAY)).toBe('1.5 yr');
    expect(formatInterval(-5)).toBe('<1 min');
    expect(formatInterval('nope')).toBe('<1 min');
  });

  it('hands over to the next unit instead of showing 60 min, 24 h or 30 days', () => {
    expect(formatInterval(59.6 * MIN)).toBe('1 h');
    expect(formatInterval(23.6 * HOUR)).toBe('1 day');
    expect(formatInterval(29.6 * DAY)).toBe('1 mo');
    expect(formatInterval(355 * DAY)).toBe('1 yr');
  });
});

describe('formatCount', () => {
  it('pluralises and groups thousands', () => {
    expect(formatCount(1, 'card')).toBe('1 card');
    expect(formatCount(0, 'card')).toBe('0 cards');
    expect(formatCount(1234, 'card')).toBe('1,234 cards');
    expect(formatCount(1, ['entry', 'entries'])).toBe('1 entry');
    expect(formatCount(2, ['entry', 'entries'])).toBe('2 entries');
  });
});

describe('formatBytes', () => {
  it('uses binary units with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(13 * 1024 * 1024)).toBe('13 MB');
    expect(formatBytes(4.8 * 1024 * 1024)).toBe('4.8 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
    expect(formatBytes(1023.7 * 1024)).toBe('1 MB');
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 9, 11, 12, 0, 0).getTime();
  it('describes past and future times in words', () => {
    expect(formatRelative(now - 10 * 1000, now)).toBe('just now');
    expect(formatRelative(now - 5 * MIN, now)).toBe('5 minutes ago');
    expect(formatRelative(now - 3 * HOUR, now)).toBe('3 hours ago');
    expect(formatRelative(now - DAY, now)).toBe('yesterday');
    expect(formatRelative(now + 3 * HOUR, now)).toBe('in 3 hours');
    expect(formatRelative(now - 14 * DAY, now)).toBe('2 weeks ago');
    expect(formatRelative(new Date(2026, 1, 3).getTime(), now)).toBe('Feb 3');
    expect(formatRelative(new Date(2024, 1, 3).getTime(), now)).toBe('Feb 3, 2024');
    expect(formatRelative(NaN, now)).toBe('');
  });

  it('never says 60 minutes or 24 hours', () => {
    expect(formatRelative(now - 59.7 * MIN, now)).toBe('1 hour ago');
    expect(formatRelative(now + 23.7 * HOUR, now)).toBe('tomorrow');
  });
});
