import { describe, expect, it } from 'vitest';
import { demoPeerNames, nextDemoPeerName } from './index';

describe('nextDemoPeerName', () => {
  it('returns the first name when none are used', () => {
    expect(nextDemoPeerName([])).toBe('Demo Peer 1');
  });

  it('skips used names and reuses the first available gap', () => {
    expect(nextDemoPeerName(['Demo Peer 1'])).toBe('Demo Peer 2');
    expect(nextDemoPeerName(new Set(['Demo Peer 1', 'Demo Peer 3']))).toBe('Demo Peer 2');
    expect(nextDemoPeerName(['Demo Peer 2', 'Demo Peer 3'])).toBe('Demo Peer 1');
  });

  it('returns null when all three names are used', () => {
    expect(nextDemoPeerName(demoPeerNames)).toBeNull();
  });
});
