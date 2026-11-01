import { describe, expect, it } from 'vitest';
import { audienceFor, roleTransition } from './role-transition';

describe('roleTransition', () => {
  it('treats the first observation as initial membership', () => {
    expect(roleTransition(null, { role: 'ATTENDEE', onStage: false })).toBe('initial');
    expect(roleTransition(null, { role: 'HOST', onStage: true })).toBe('initial');
  });

  it('promotes only when stage membership is gained', () => {
    expect(
      roleTransition({ role: 'ATTENDEE', onStage: false }, { role: 'SPEAKER', onStage: true }),
    ).toBe('promoted');
  });

  it('demotes when stage membership is lost', () => {
    expect(
      roleTransition({ role: 'SPEAKER', onStage: true }, { role: 'ATTENDEE', onStage: false }),
    ).toBe('demoted');
    expect(
      roleTransition({ role: 'SPEAKER', onStage: true }, { role: 'SPEAKER', onStage: false }),
    ).toBe('demoted');
  });

  it('ignores a role rename that stays on stage', () => {
    expect(
      roleTransition({ role: 'SPEAKER', onStage: true }, { role: 'HOST', onStage: true }),
    ).toBe('unchanged');
  });
});

describe('audienceFor', () => {
  it('uses the catalog only before a joined role exists', () => {
    expect(audienceFor(null, true)).toBe('attendee');
    expect(audienceFor(null, false)).toBe('stage');
  });

  it('follows the snapshot role after join, including promotion and demotion', () => {
    expect(audienceFor('SPEAKER', true)).toBe('stage');
    expect(audienceFor('HOST', true)).toBe('stage');
    expect(audienceFor('ATTENDEE', false)).toBe('attendee');
  });
});
