import type { CreateRoomRequest, GuestSessionResponse, RoomResponse } from '@stageflow/shared';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '');

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!apiBaseUrl) throw new Error('The API address is missing. Set VITE_API_BASE_URL and restart the web app.');
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, options);
  } catch {
    throw new Error('Unable to reach StageFlow. Check that the API is running and try again.');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
      ? body.message : `The request failed (${response.status}). Please try again.`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function createGuest(displayName: string): Promise<GuestSessionResponse> {
  return request('/sessions/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

export function createRoom(input: CreateRoomRequest, token: string): Promise<RoomResponse> {
  return request('/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
}

export function getRoom(slug: string, token: string): Promise<RoomResponse> {
  return request(`/rooms/${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
