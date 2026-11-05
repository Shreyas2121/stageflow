import { useCatalogPages } from './catalog-paging';
import { CatalogPagingControls } from './catalog-paging-controls';
import type { BroadcastResponse, GuestSessionResponse } from '@stageflow/shared';
import { useState } from 'react';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { replayHref, updateBroadcastPages } from './history';
import { deleteBroadcast, setBroadcastVisibility, type BroadcastPage } from './api';
import { useSessionStore } from '../session/session-store';
import { roomBroadcastsQueryOptions } from './query-options';
import { Thumbnail } from './thumbnail';

function trimmed(message: string | null): string {
  return message?.trim() ?? '';
}

export function RoomHistory({
  session,
  slug,
  title,
  isHost = false,
}: {
  session: GuestSessionResponse;
  slug: string;
  title: string;
  isHost?: boolean;
}) {
  const client = useQueryClient();
  const options = roomBroadcastsQueryOptions(session, slug);
  const page = useCatalogPages(options);
  const { items } = page;
  const mutation = useMutation({
    mutationFn: (action: ReplayAction) =>
      action.kind === 'delete'
        ? deleteBroadcast(action.broadcast.id, session.token).then(() => null)
        : setBroadcastVisibility(
            action.broadcast.id,
            action.broadcast.visibility === 'LINK' ? 'HOST' : 'LINK',
            session.token,
          ),
    onSuccess: async (replacement, action) => {
      if (useSessionStore.getState().session?.token !== session.token) return;
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      if (useSessionStore.getState().session?.token !== session.token) return;
      client.setQueryData<InfiniteData<BroadcastPage, string | null>>(options.queryKey, (data) =>
        updateBroadcastPages(data, action.broadcast.id, replacement),
      );
      void client.invalidateQueries({
        queryKey: ['private', session.userId, 'broadcast', action.broadcast.id],
        exact: true,
      });
    },
    onError: async () => {
      if (useSessionStore.getState().session?.token === session.token)
        await client.invalidateQueries({ queryKey: options.queryKey, exact: true });
    },
  });

  return (
    <div role="region" aria-label={`Recordings for ${title}`} className="mt-4 grid gap-3">
      {items.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((broadcast) => (
            <BroadcastRow
              key={broadcast.id}
              broadcast={broadcast}
              token={session.token}
              isHost={isHost}
              busy={mutation.isPending}
              onAction={(action) => mutation.mutate(action)}
            />
          ))}
        </ul>
      )}
      {mutation.error && (
        <p className="m-0 text-sm text-danger wrap-anywhere" role="alert">
          {mutation.error.message}
        </p>
      )}
      <CatalogPagingControls
        page={page}
        name="recordings"
        empty="This room has no broadcast attempts."
      />
    </div>
  );
}

type ReplayAction = { kind: 'visibility' | 'delete'; broadcast: BroadcastResponse };

function BroadcastRow({
  broadcast,
  token,
  isHost,
  busy,
  onAction,
}: {
  broadcast: BroadcastResponse;
  token: string;
  isHost: boolean;
  busy: boolean;
  onAction: (action: ReplayAction) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canManage = isHost && (broadcast.status === 'READY' || broadcast.status === 'FAILED');
  const href = replayHref(broadcast);
  const reason = trimmed(broadcast.errorMessage);
  return (
    <li className="flex items-start gap-3 rounded-control border border-line p-3">
      <Thumbnail url={broadcast.thumbnailUrl} token={token} status={broadcast.status} />
      <div className="min-w-0">
        <p className="m-0 text-xs font-semibold tracking-wide">{broadcast.status}</p>
        <p className="mt-1 mb-0 text-sm text-muted">
          {broadcast.visibility === 'LINK' ? 'Anyone with the link' : 'Only you'}
        </p>
        {reason && <p className="mt-1 mb-0 text-sm text-muted wrap-anywhere">{reason}</p>}
        {href && (
          <Link
            to={href}
            className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-accent underline-offset-4 hover:underline"
          >
            Watch replay
          </Link>
        )}
        {canManage && (
          <div className="mt-3 flex flex-wrap gap-2">
            {confirmDelete ? (
              <>
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDelete(false);
                    onAction({ kind: 'delete', broadcast });
                  }}
                >
                  Delete this replay
                </Button>
                <Button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction({ kind: 'visibility', broadcast })}
                >
                  {broadcast.visibility === 'LINK' ? 'Hide replay' : 'Share replay'}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete replay
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
