import { useEffect, useRef, useState } from 'react';
import type { DeviceChoices } from '../services/local-media';

type LobbyMedia = {
  setLevelListener(listener: ((level: number) => void) | null): void;
  releaseLobby(): void;
};

function MicrophoneMeter({ media }: { media: LobbyMedia }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    media.setLevelListener(setLevel);
    return () => {
      media.setLevelListener(null);
      media.releaseLobby();
    };
  }, [media]);
  return (
    <>
      <label className="meter-label" htmlFor="microphone-level">
        Microphone level
      </label>
      <meter id="microphone-level" min={0} max={1} value={level} aria-label="Microphone level" />
    </>
  );
}

export function GreenRoom({
  attendee,
  media,
  displayName,
  ready,
  preparing,
  devicesDisabled,
  enableDisabled,
  cameraOff,
  choices,
  devices,
  speakerId,
  sinkSupported,
  speakerError,
  onPrepare,
  onSpeaker,
}: {
  attendee: boolean;
  media: LobbyMedia;
  displayName: string;
  ready: boolean;
  preparing: boolean;
  devicesDisabled: boolean;
  enableDisabled: boolean;
  cameraOff: boolean;
  choices: DeviceChoices;
  devices: MediaDeviceInfo[];
  speakerId: string;
  sinkSupported: boolean;
  speakerError: string;
  onPrepare: (video: HTMLVideoElement, choices: DeviceChoices) => void;
  onSpeaker: (deviceId: string) => void;
}) {
  const preview = useRef<HTMLVideoElement>(null);
  const prepare = (next: DeviceChoices) => {
    const video = preview.current;
    if (video) onPrepare(video, next);
  };

  if (attendee) {
    return (
      <div className="device-panel">
        <p className="muted">
          You will join as an attendee. You can see the roster and raise your hand. No camera or
          microphone is needed.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="preview-panel">
        <div className="preview-frame">
          <video ref={preview} autoPlay muted playsInline aria-label="Your camera preview" />
          {(!ready || cameraOff) && (
            <p className="preview-placeholder">
              {ready ? 'Your camera is off' : 'Your preview will appear here'}
            </p>
          )}
          <span className="preview-name">{displayName} · You</span>
        </div>
        <MicrophoneMeter media={media} />
      </div>
      <div className="device-panel">
        <p className="muted">
          Check your camera and microphone before joining. Both permissions are required.
        </p>
        <button
          id="enable-devices"
          className="button button-secondary"
          disabled={enableDisabled}
          onClick={() => prepare(choices)}
        >
          {preparing
            ? 'Preparing…'
            : ready
              ? 'Check devices again'
              : 'Enable camera and microphone'}
        </button>
        <fieldset className="device-fields" disabled={devicesDisabled}>
          <legend className="sr-only">Your devices</legend>
          <label htmlFor="camera-device">Camera</label>
          <select
            id="camera-device"
            value={choices.cameraId}
            onChange={(event) => prepare({ ...choices, cameraId: event.target.value })}
          >
            <option value="">System default</option>
            {devices
              .filter((device) => device.kind === 'videoinput' && device.deviceId)
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
          </select>
          <label htmlFor="microphone-device">Microphone</label>
          <select
            id="microphone-device"
            value={choices.microphoneId}
            onChange={(event) => prepare({ ...choices, microphoneId: event.target.value })}
          >
            <option value="">System default</option>
            {devices
              .filter((device) => device.kind === 'audioinput' && device.deviceId)
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
          </select>
          <label htmlFor="speaker-device">Speaker</label>
          <select
            id="speaker-device"
            value={speakerId}
            disabled={!sinkSupported}
            onChange={(event) => onSpeaker(event.target.value)}
          >
            <option value="">System default</option>
            {sinkSupported &&
              devices
                .filter((device) => device.kind === 'audiooutput' && device.deviceId)
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Speaker ${index + 1}`}
                  </option>
                ))}
          </select>
          {!sinkSupported && (
            <p className="field-hint">This browser uses the default speaker output.</p>
          )}
          {speakerError && (
            <p className="error-message" role="alert">
              {speakerError}
            </p>
          )}
        </fieldset>
      </div>
    </>
  );
}
