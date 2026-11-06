import type { GuestSessionResponse } from '@stageflow/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { useSessionStore } from '../session/session-store';
import { retryReplayDeletion } from './api';
import { useCatalogPages } from './catalog-paging';
import { CatalogPagingControls } from './catalog-paging-controls';
import { replayDeletionsQueryOptions, roomBroadcastsQueryOptions } from './query-options';

export function ReplayDeletions({
  session,
  slug,
  onDeleted,
}: {
  session: GuestSessionResponse;
  slug: string;
  onDeleted: (id: string) => void;
}) {
  const client = useQueryClient();
  const options = replayDeletionsQueryOptions(session, slug);
  const page = useCatalogPages(options);
  const mutation = useMutation({
    mutationFn: (id: string) => retryReplayDeletion(id, session.token),
    onSuccess: (_result, id) => {
      if (useSessionStore.getState().session?.token === session.token) onDeleted(id);
    },
    onSettled: async () => {
      if (useSessionStore.getState().session?.token !== session.token) return;
      await Promise.all([
        client.invalidateQueries({ queryKey: options.queryKey, exact: true }),
        client.invalidateQueries({
          queryKey: roomBroadcastsQueryOptions(session, slug).queryKey,
          exact: true,
        }),
      ]);
    },
  });
  return (
    <section
      aria-label="Unfinished deletions"
      className="mt-3 grid gap-3 border-t border-line pt-3"
    >
      <h4 className="m-0 text-sm font-semibold">Unfinished deletions</h4>
      {page.items.length > 0 && (
        <>
          <p className="m-0 text-sm text-muted">
            These replays are unavailable. Retry to finish removing their remaining files and
            records.
          </p>
          <ul className="m-0 grid list-none gap-3 p-0">
            {page.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3"
              >
                <p className="m-0 text-sm wrap-anywhere">
                  Recording from{' '}
                  <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                </p>
                <Button
                  type="button"
                  variant="danger"
                  disabled={mutation.isPending || page.busy}
                  onClick={() => mutation.mutate(item.id)}
                >
                  {mutation.isPending && mutation.variables === item.id
                    ? 'Retrying deletion…'
                    : 'Retry deletion'}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {mutation.error && (
        <p role="alert" className="m-0 text-sm text-danger wrap-anywhere">
          {mutation.error.message}
        </p>
      )}
      <CatalogPagingControls
        page={page}
        name="unfinished deletions"
        empty="No unfinished deletions."
      />
    </section>
  );
}
