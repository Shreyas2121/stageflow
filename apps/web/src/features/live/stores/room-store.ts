import { create } from 'zustand';
import type { IceServer, RoomSnapshot } from '@stageflow/shared';

type RoomStore = {
  roomId: string | null;
  snapshot: RoomSnapshot | null;
  selfParticipantId: string | null;
  iceServers: IceServer[];
  begin: (roomId: string) => void;
  receive: (snapshot: RoomSnapshot) => void;
  joined: (selfParticipantId: string, iceServers: IceServer[]) => void;
  resumed: (selfParticipantId: string, iceServers: IceServer[], snapshot: RoomSnapshot) => void;
  clear: () => void;
};

const initial = { roomId: null, snapshot: null, selfParticipantId: null, iceServers: [] };
export const useRoomStore = create<RoomStore>((set) => ({
  ...initial,
  begin: (roomId) => set({ ...initial, roomId }),
  receive: (snapshot) =>
    set((current) =>
      snapshot.roomId === current.roomId && snapshot.revision > (current.snapshot?.revision ?? -1)
        ? { snapshot }
        : current,
    ),
  joined: (selfParticipantId, iceServers) => set({ selfParticipantId, iceServers }),
  resumed: (selfParticipantId, iceServers, snapshot) =>
    set({ roomId: snapshot.roomId, selfParticipantId, iceServers, snapshot }),
  clear: () => set(initial),
}));
