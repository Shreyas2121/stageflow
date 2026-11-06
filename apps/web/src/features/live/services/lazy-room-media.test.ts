import { expect, it, vi } from 'vitest';
import { lazyRoomMedia } from './lazy-room-media';
import { LocalMedia } from './local-media';

it('defers capture-owner construction through waiting and creates it on explicit preparation', async () => {
  const owner = new LocalMedia();
  const prepare = vi.spyOn(owner, 'prepare').mockResolvedValue(true);
  const flags = vi.spyOn(owner, 'applyFlags');
  const create = vi.fn(() => owner);
  const media = lazyRoomMedia(create);
  media.setEndedListener(null);
  media.setLevelListener(null);
  media.applyFlags(true, true);
  media.releaseLobby();
  media.stop();
  media.stopScreenShare();
  await media.setSpeaker('');
  expect(media.ready).toBe(false);
  expect(media.previewStream()).toBeNull();
  expect(media.cameraTrack()).toBeNull();
  expect(create).not.toHaveBeenCalled();
  await media.prepare({} as HTMLVideoElement, { cameraId: '', microphoneId: '' });
  expect(create).toHaveBeenCalledOnce();
  expect(flags).toHaveBeenCalledWith(true, true);
  expect(prepare).toHaveBeenCalledOnce();
});
