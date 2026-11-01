import './green-room.css';
import { Button } from '../../../components/ui/button';
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
      <label className="mt-4 mb-1.5 text-xs text-muted" htmlFor="microphone-level">
        Microphone level
      </label>
      <meter
        className="microphone-meter h-3 w-full accent-accent"
        id="microphone-level"
        min={0}
        max={1}
        value={level}
        aria-label="Microphone level"
      />
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
      <div className="min-w-0">
        <p className="mt-0 mb-4.5 text-[13px] text-muted">
          You will join as an attendee. You can see the roster and raise your hand. No camera or
          microphone is needed.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="min-w-0">
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-line bg-video">
          <video
            className="h-full w-full -scale-x-100 object-cover"
            ref={preview}
            autoPlay
            muted
            playsInline
            aria-label="Your camera preview"
          />
          {(!ready || cameraOff) && (
            <p className="absolute inset-0 m-0 grid place-items-center bg-video p-6 text-center text-[13px] text-muted">
              {ready ? 'Your camera is off' : 'Your preview will appear here'}
            </p>
          )}
          <span className="absolute bottom-3 left-3 max-w-[calc(100%-24px)] rounded bg-overlay px-2 py-1 text-xs wrap-anywhere">
            {displayName} · You
          </span>
        </div>
        <MicrophoneMeter media={media} />
      </div>
      <div className="min-w-0">
        <p className="mt-0 mb-4.5 text-[13px] text-muted">
          Check your camera and microphone before joining. Both permissions are required.
        </p>
        <Button
          type="button"
          id="enable-devices"
          disabled={enableDisabled}
          onClick={() => prepare(choices)}
        >
          {preparing
            ? 'Preparing…'
            : ready
              ? 'Check devices again'
              : 'Enable camera and microphone'}
        </Button>
        <fieldset
          className="mt-5.5 min-w-0 border-0 p-0 [&>label]:mt-3.5 [&>label]:mb-1.75 [&>label:first-of-type]:mt-0"
          disabled={devicesDisabled}
        >
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
            <p className="mt-2 mb-0 text-xs text-hint">
              This browser uses the default speaker output.
            </p>
          )}
          {speakerError && (
            <p
              className="mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
              role="alert"
            >
              {speakerError}
            </p>
          )}
        </fieldset>
      </div>
    </>
  );
}
