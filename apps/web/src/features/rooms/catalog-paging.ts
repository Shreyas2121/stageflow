import {
  infiniteQueryOptions,
  skipToken,
  useInfiniteQuery,
  type InfiniteData,
  type QueryKey,
  type SkipToken,
} from '@tanstack/react-query';
import { mergeById } from './history';

type CatalogPage<T> = { items: T[]; nextCursor: string | null };
type PageReader<T> = (cursor: string | null, signal: AbortSignal) => Promise<CatalogPage<T>>;

export const CATALOG_GC_TIME_MS = 5 * 60_000;

function selectCatalog<T extends { id: string }>(
  data: InfiniteData<CatalogPage<T>, string | null>,
) {
  return { ...data, items: mergeById(data.pages.map((page) => page.items)) };
}

export function catalogQueryOptions<T extends { id: string }>(
  queryKey: QueryKey,
  read: PageReader<T> | SkipToken,
) {
  return infiniteQueryOptions({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: read === skipToken ? skipToken : ({ pageParam, signal }) => read(pageParam, signal),
    getNextPageParam: (page, _pages, _lastParam, pageParams) =>
      page.nextCursor !== null && !pageParams.includes(page.nextCursor) ? page.nextCursor : null,
    select: selectCatalog<T>,
    retry: false,
    // Keep loaded rows while browsing. Inactive lists expire, and session changes clear them.
    maxPages: 0,
    gcTime: CATALOG_GC_TIME_MS,
  });
}

export function useCatalogPages<T extends { id: string }>(
  options: ReturnType<typeof catalogQueryOptions<T>>,
) {
  const query = useInfiniteQuery(options);
  return {
    items: query.data?.items ?? [],
    pending: query.isPending,
    error: query.error,
    busy: query.isFetching,
    hasNextPage: query.hasNextPage,
    nextPageError: query.isFetchNextPageError,
    loadingMore: query.isFetchingNextPage,
    retry: () => {
      if (query.isFetching) return;
      if (query.isFetchNextPageError) void query.fetchNextPage({ cancelRefetch: false });
      else void query.refetch({ cancelRefetch: false });
    },
    loadMore: () => {
      if (query.hasNextPage && !query.isFetching)
        void query.fetchNextPage({ cancelRefetch: false });
    },
  };
}
