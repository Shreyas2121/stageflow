import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deviceSelects } from './device-controls';

const panel = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../components/device-panel.tsx'),
  'utf8',
);

describe('deviceSelects', () => {
  it('shows camera, microphone, and speaker to a joined stage member', () => {
    expect(
      deviceSelects({ phase: 'joined', audience: 'stage', needsCaptureConsent: false }),
    ).toEqual({ camera: true, microphone: true, speaker: true });
  });

  it('shows only the speaker to a joined attendee', () => {
    expect(
      deviceSelects({ phase: 'joined', audience: 'attendee', needsCaptureConsent: false }),
    ).toEqual({ camera: false, microphone: false, speaker: true });
  });

  it('shows nothing while capture consent is still required', () => {
    expect(
      deviceSelects({ phase: 'joined', audience: 'stage', needsCaptureConsent: true }),
    ).toEqual({ camera: false, microphone: false, speaker: false });
  });

  it('does not let the device panel acquire capture or move focus', () => {
    expect(panel).not.toMatch(/local-media|LocalMedia|getUserMedia/);
    expect(panel).not.toMatch(/\.focus\(/);
  });
});
