import { create } from 'zustand';
import type { IceServer, RoomSnapshot } from '@stageflow/shared';

type RoomStore = {
  roomId: string | null;
  snapshot: RoomSnapshot | null;
  selfSocketId: string | null;
  iceServers: IceServer[];
  begin: (roomId: string) => void;
  receive: (snapshot: RoomSnapshot) => void;
  joined: (selfSocketId: string, iceServers: IceServer[]) => void;
  clear: () => void;
};

const initial = { roomId: null, snapshot: null, selfSocketId: null, iceServers: [] };
export const useRoomStore = create<RoomStore>((set) => ({
  ...initial,
  begin: (roomId) => set({ ...initial, roomId }),
  receive: (snapshot) =>
    set((current) =>
      snapshot.roomId === current.roomId && snapshot.revision > (current.snapshot?.revision ?? -1)
        ? { snapshot }
        : current,
    ),
  joined: (selfSocketId, iceServers) => set({ selfSocketId, iceServers }),
  clear: () => set(initial),
}));
