import { InfiniteQueryObserver, QueryClient, type QueryKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogQueryOptions, CATALOG_GC_TIME_MS } from './catalog-paging';
import { bindSessionCache } from './query-options';
import { useSessionStore } from '../session/session-store';

type Row = { id: string; title: string };
type Page = { items: Row[]; nextCursor: string | null };
const row = (id: string, title = id): Row => ({ id, title });
const page = (items: Row[] = [], nextCursor: string | null = null): Page => ({ items, nextCursor });
const guest = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  token: 'old-token',
  displayName: 'Ava',
};
const clients: QueryClient[] = [];
const cleanups: (() => void)[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe(
  read: (cursor: string | null, signal: AbortSignal) => Promise<Page>,
  key: QueryKey = ['private', guest.userId, 'catalog'],
) {
  const client = new QueryClient();
  clients.push(client);
  const options = catalogQueryOptions(key, read);
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(unsubscribe);
  return { client, observer, options, unsubscribe, result: () => observer.getCurrentResult() };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const client of clients.splice(0)) client.clear();
  useSessionStore.getState().clearSession();
  vi.useRealTimers();
});

describe('catalog infinite paging', () => {
  it('reads an empty first page with a signal and no continuation', async () => {
    const read = vi.fn(async () => page());
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    expect(read).toHaveBeenCalledExactlyOnceWith(null, expect.any(AbortSignal));
    expect(h.result().data?.items).toEqual([]);
    expect(h.result().hasNextPage).toBe(false);
  });

  it('keeps cursor order, earlier duplicate ids, and one observed cache entry across pages', async () => {
    const read = vi.fn(async (cursor: string | null) =>
      cursor === null
        ? page([row('a')], 'one')
        : cursor === 'one'
          ? page([row('a', 'duplicate'), row('b')], 'two')
          : page([row('c')]),
    );
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    await h.observer.fetchNextPage();
    await h.observer.fetchNextPage();
    expect(h.result().data?.items).toEqual([row('a'), row('b'), row('c')]);
    expect(h.result().data?.pageParams).toEqual([null, 'one', 'two']);
    expect(h.result().hasNextPage).toBe(false);
    await h.observer.fetchNextPage();
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'one', 'two']);
    expect(h.client.getQueryCache().getAll()).toHaveLength(1);
    expect(h.client.getQueryCache().getAll()[0]!.getObserversCount()).toBe(1);
  });

  it('stops a repeated cursor instead of fetching the same page forever', async () => {
    const h = observe(async (cursor) =>
      cursor === null ? page([row('a')], 'one') : page([row('b')], 'one'),
    );
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    await h.observer.fetchNextPage();
    expect(h.result().hasNextPage).toBe(false);
    expect(h.result().data?.items).toEqual([row('a'), row('b')]);
  });

  it('waits for explicit initial retry and starts from the initial cursor again', async () => {
    const read = vi
      .fn<(_: string | null, signal: AbortSignal) => Promise<Page>>()
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockResolvedValueOnce(page([row('a')]));
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isLoadingError).toBe(true));
    expect(read).toHaveBeenCalledOnce();
    await h.observer.refetch();
    expect(h.result().data?.items).toEqual([row('a')]);
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, null]);
  });

  it('retains rows after load-more failure and retries only that continuation', async () => {
    const read = vi
      .fn<(_: string | null, signal: AbortSignal) => Promise<Page>>()
      .mockResolvedValueOnce(page([row('a')], 'one'))
      .mockRejectedValueOnce(new Error('more failure'))
      .mockResolvedValueOnce(page([row('b')]));
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    await h.observer.fetchNextPage();
    expect(h.result().isFetchNextPageError).toBe(true);
    expect(h.result().data?.items).toEqual([row('a')]);
    await h.observer.fetchNextPage();
    expect(h.result().data?.items).toEqual([row('a'), row('b')]);
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'one', 'one']);
  });

  it('rebuilds every retained page sequentially using fresh cursors on refetch', async () => {
    let fresh = false;
    const read = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return page([row(fresh ? 'fresh-a' : 'a')], fresh ? 'new-one' : 'one');
      if (cursor === 'one' || cursor === 'new-one')
        return page([row(fresh ? 'fresh-b' : 'b')], fresh ? 'new-two' : 'two');
      return page([row(fresh ? 'fresh-c' : 'c')]);
    });
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    await h.observer.fetchNextPage();
    await h.observer.fetchNextPage();
    fresh = true;
    read.mockClear();
    await h.observer.refetch();
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'new-one', 'new-two']);
    expect(h.result().data?.items).toEqual([row('fresh-a'), row('fresh-b'), row('fresh-c')]);
    expect(h.result().data?.pageParams).toEqual([null, 'new-one', 'new-two']);
  });

  it('discards obsolete later pages if the refreshed catalog now ends sooner', async () => {
    let fresh = false;
    const h = observe(async (cursor) =>
      fresh ? page([row('only')]) : cursor === null ? page([row('a')], 'one') : page([row('b')]),
    );
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    await h.observer.fetchNextPage();
    fresh = true;
    await h.observer.refetch();
    expect(h.result().data?.pages).toHaveLength(1);
    expect(h.result().data?.items).toEqual([row('only')]);
    expect(h.result().hasNextPage).toBe(false);
  });

  it('keeps the prior complete chain when refetch fails and retries the refreshed chain from its start', async () => {
    let fresh = false,
      fail = true;
    const read = vi.fn(async (cursor: string | null) => {
      if (!fresh) return cursor === null ? page([row('a')], 'one') : page([row('b')]);
      if (cursor === null) return page([row('new-a')], 'new-one');
      if (fail) throw new Error('refresh failure');
      return page([row('new-b')]);
    });
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    await h.observer.fetchNextPage();
    fresh = true;
    read.mockClear();
    await h.observer.refetch();
    expect(h.result().isRefetchError).toBe(true);
    expect(h.result().isFetchNextPageError).toBe(false);
    expect(h.result().data?.items).toEqual([row('a'), row('b')]);
    fail = false;
    await h.observer.refetch();
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'new-one', null, 'new-one']);
    expect(h.result().data?.items).toEqual([row('new-a'), row('new-b')]);
  });

  it('shares an ongoing next-page fetch instead of replacing it on repeated clicks', async () => {
    const next = deferred<Page>();
    const read = vi.fn(async (cursor: string | null) =>
      cursor === null ? page([row('a')], 'one') : next.promise,
    );
    const h = observe(read);
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    const first = h.observer.fetchNextPage({ cancelRefetch: false });
    const second = h.observer.fetchNextPage({ cancelRefetch: false });
    next.resolve(page([row('b')]));
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.result().data?.items).toEqual([row('a'), row('b')]);
  });

  it('aborts a pending first page on unmount and ignores a late response', async () => {
    const pending = deferred<Page>();
    let signal!: AbortSignal;
    const h = observe(async (_cursor, nextSignal) => {
      signal = nextSignal;
      return pending.promise;
    });
    h.unsubscribe();
    expect(signal.aborted).toBe(true);
    pending.resolve(page([row('obsolete')]));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.client.getQueryData(h.options.queryKey)).toBeUndefined();
  });

  it('aborts a pending continuation and retains the completed pages', async () => {
    const pending = deferred<Page>();
    let signal!: AbortSignal;
    const h = observe(async (cursor, nextSignal) => {
      signal = nextSignal;
      return cursor === null ? page([row('a')], 'one') : pending.promise;
    });
    await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
    const loading = h.observer.fetchNextPage();
    await h.client.cancelQueries({ queryKey: h.options.queryKey });
    expect(signal.aborted).toBe(true);
    pending.resolve(page([row('obsolete')]));
    await loading;
    expect(h.result().data?.items).toEqual([row('a')]);
  });

  it.each([false, true])(
    'clears private pages and restarts after session replacement (same user: %s)',
    async (sameUser) => {
      useSessionStore.getState().setSession(guest);
      const pending = deferred<Page>();
      let signal!: AbortSignal;
      const h = observe(async (cursor, nextSignal) => {
        signal = nextSignal;
        return cursor === null ? page([row('a')], 'one') : pending.promise;
      });
      cleanups.push(bindSessionCache(h.client));
      h.client.setQueryData(['public'], 'keep');
      await vi.waitFor(() => expect(h.result().isSuccess).toBe(true));
      const loading = h.observer.fetchNextPage();
      const replacement = {
        ...guest,
        userId: sameUser ? guest.userId : 'another-user',
        token: 'new-token',
      };
      useSessionStore.getState().setSession(replacement);
      expect(signal.aborted).toBe(true);
      expect(h.client.getQueryCache().findAll({ queryKey: ['private'] })).toHaveLength(0);
      const read = vi.fn(async () => page([row('new-session')]));
      h.observer.setOptions(catalogQueryOptions(['private', replacement.userId, 'catalog'], read));
      await vi.waitFor(() => expect(h.result().data?.items).toEqual([row('new-session')]));
      expect(read).toHaveBeenCalledExactlyOnceWith(null, expect.any(AbortSignal));
      pending.resolve(page([row('old-session')]));
      await loading;
      expect(h.result().data?.items).toEqual([row('new-session')]);
      expect(h.client.getQueryData(['public'])).toBe('keep');
    },
  );

  it('retains loaded pages without dropping the first, then expires the inactive cache', async () => {
    vi.useFakeTimers();
    const h = observe(async (cursor) => {
      const n = cursor === null ? 0 : Number(cursor);
      return page([row(String(n))], String(n + 1));
    });
    for (let index = 0; index < 20; index++) await Promise.resolve();
    for (let index = 0; index < 6; index++) await h.observer.fetchNextPage();
    expect(h.result().data?.pages).toHaveLength(7);
    expect(h.result().data?.items[0]).toEqual(row('0'));
    h.unsubscribe();
    await vi.advanceTimersByTimeAsync(CATALOG_GC_TIME_MS - 1);
    expect(h.client.getQueryData(h.options.queryKey)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.getQueryData(h.options.queryKey)).toBeUndefined();
  });
});
