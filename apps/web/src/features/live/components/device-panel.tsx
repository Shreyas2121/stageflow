import { Button } from '../../../components/ui/button';
import type { DeviceSelects } from '../services/device-controls';
import { defaultSpeakerSentence } from '../services/output-route';

type InputName = 'camera' | 'microphone';

function lossMessage(kind: InputName): string {
  const name = kind === 'camera' ? 'camera' : 'microphone';
  return `Your ${name} stopped. This room is still open. Another ${name} starts only when you choose one.`;
}

export function SpeakerSelect({
  id,
  devices,
  speakerId,
  sinkSupported,
  speakerError,
  onSpeaker,
}: {
  id: string;
  devices: readonly MediaDeviceInfo[];
  speakerId: string;
  sinkSupported: boolean;
  speakerError: string;
  onSpeaker: (deviceId: string) => void;
}) {
  const outputs = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId);
  const selectedMissing =
    sinkSupported && speakerId !== '' && !outputs.some((device) => device.deviceId === speakerId);
  return (
    <>
      <label htmlFor={id}>Speaker</label>
      <select
        id={id}
        value={sinkSupported ? speakerId : ''}
        disabled={!sinkSupported}
        onChange={(event) => onSpeaker(event.target.value)}
      >
        <option value="">System default</option>
        {selectedMissing && <option value={speakerId}>Selected speaker</option>}
        {sinkSupported &&
          outputs.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `Speaker ${index + 1}`}
            </option>
          ))}
      </select>
      {!sinkSupported && <p className="mt-2 mb-0 text-xs text-hint">{defaultSpeakerSentence}</p>}
      {speakerError && (
        <p
          className="mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
          role="alert"
        >
          {speakerError}
        </p>
      )}
    </>
  );
}

function inputOptions(devices: readonly MediaDeviceInfo[], kind: MediaDeviceKind, label: string) {
  return devices
    .filter((device) => device.kind === kind && device.deviceId)
    .map((device, index) => (
      <option key={device.deviceId} value={device.deviceId}>
        {device.label || `${label} ${index + 1}`}
      </option>
    ));
}

export function DevicePanel({
  selects,
  devices,
  cameraId,
  microphoneId,
  speakerId,
  cameraPending,
  microphonePending,
  cameraUnavailable,
  microphoneUnavailable,
  sinkSupported,
  speakerError,
  onCamera,
  onMicrophone,
  onSpeaker,
}: {
  selects: DeviceSelects;
  devices: readonly MediaDeviceInfo[];
  cameraId: string;
  microphoneId: string;
  speakerId: string;
  cameraPending: boolean;
  microphonePending: boolean;
  cameraUnavailable: boolean;
  microphoneUnavailable: boolean;
  sinkSupported: boolean;
  speakerError: string;
  onCamera: (deviceId: string) => void;
  onMicrophone: (deviceId: string) => void;
  onSpeaker: (deviceId: string) => void;
}) {
  if (!selects.camera && !selects.microphone && !selects.speaker) return null;
  const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
  const microphones = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
  const cameraMissing = cameraId !== '' && !cameras.some((device) => device.deviceId === cameraId);
  const microphoneMissing =
    microphoneId !== '' && !microphones.some((device) => device.deviceId === microphoneId);

  // Keep the selects mounted. A device-list refresh must not move focus.
  return (
    <fieldset className="mt-6 min-w-0 border-0 p-0 [&>label]:mt-3.5 [&>label]:mb-1.75 [&>label:first-of-type]:mt-0">
      <legend className="sr-only">Devices in this room</legend>
      {selects.camera && (
        <>
          <label htmlFor="stage-camera-device">Camera</label>
          <select
            id="stage-camera-device"
            value={cameraId}
            disabled={cameraPending}
            onChange={(event) => onCamera(event.target.value)}
          >
            <option value="">System default</option>
            {cameraMissing && <option value={cameraId}>Unavailable camera</option>}
            {inputOptions(devices, 'videoinput', 'Camera')}
          </select>
          {cameraUnavailable && (
            <>
              <p
                className="mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
                role="alert"
              >
                {lossMessage('camera')}
              </p>
              <Button
                type="button"
                id="retry-stage-camera"
                className="mt-3"
                disabled={cameraPending}
                onClick={() => onCamera(cameraId)}
              >
                Try this camera
              </Button>
            </>
          )}
        </>
      )}
      {selects.microphone && (
        <>
          <label htmlFor="stage-microphone-device">Microphone</label>
          <select
            id="stage-microphone-device"
            value={microphoneId}
            disabled={microphonePending}
            onChange={(event) => onMicrophone(event.target.value)}
          >
            <option value="">System default</option>
            {microphoneMissing && <option value={microphoneId}>Unavailable microphone</option>}
            {inputOptions(devices, 'audioinput', 'Microphone')}
          </select>
          {microphoneUnavailable && (
            <>
              <p
                className="mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
                role="alert"
              >
                {lossMessage('microphone')}
              </p>
              <Button
                type="button"
                id="retry-stage-microphone"
                className="mt-3"
                disabled={microphonePending}
                onClick={() => onMicrophone(microphoneId)}
              >
                Try this microphone
              </Button>
            </>
          )}
        </>
      )}
      {selects.speaker && (
        <SpeakerSelect
          id="stage-speaker-device"
          devices={devices}
          speakerId={speakerId}
          sinkSupported={sinkSupported}
          speakerError={speakerError}
          onSpeaker={onSpeaker}
        />
      )}
    </fieldset>
  );
}
