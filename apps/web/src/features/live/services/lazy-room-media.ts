import { LocalMedia } from './local-media';
import type { RoomMedia } from './room-session';

/** Membership and waiting never instantiate the capture owner. Explicit device actions do. */
export function lazyRoomMedia(create: () => RoomMedia = () => new LocalMedia()): RoomMedia {
  let owner: RoomMedia | undefined;
  let ended: Parameters<RoomMedia['setEndedListener']>[0] = null;
  let level: Parameters<RoomMedia['setLevelListener']>[0] = null;
  let muted = true,
    videoOff = true;
  const active = () => {
    if (!owner) {
      owner = create();
      owner.setEndedListener(ended);
      owner.setLevelListener(level);
      owner.applyFlags(muted, videoOff);
    }
    return owner;
  };
  return {
    get ready() {
      return owner?.ready ?? false;
    },
    prepare: (video, choices) => active().prepare(video, choices),
    stop: () => owner?.stop(),
    releaseLobby: () => owner?.releaseLobby(),
    applyFlags: (audio, video) => {
      muted = audio;
      videoOff = video;
      owner?.applyFlags(audio, video);
    },
    replaceInput: (kind, id) => active().replaceInput(kind, id),
    commitInput: (kind, track) => (owner ? owner.commitInput(kind, track) : track.stop()),
    abortInput: (track) => (owner ? owner.abortInput(track) : track.stop()),
    setEndedListener: (listener) => {
      ended = listener;
      owner?.setEndedListener(listener);
    },
    setLevelListener: (listener) => {
      level = listener;
      owner?.setLevelListener(listener);
    },
    setSpeaker: (deviceId) =>
      owner?.setSpeaker(deviceId) ??
      Promise.resolve({ ok: true, supported: false, deviceId: '', message: '' }),
    previewStream: () => owner?.previewStream() ?? null,
    microphoneTrack: () => owner?.microphoneTrack() ?? null,
    cameraTrack: () => owner?.cameraTrack() ?? null,
    screenTrack: () => owner?.screenTrack() ?? null,
    startScreenShare: () => active().startScreenShare(),
    stopScreenShare: () => owner?.stopScreenShare(),
  };
}
