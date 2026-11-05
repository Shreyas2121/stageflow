import { Button } from '../../components/ui/button';
import type { useCatalogPages } from './catalog-paging';

export function CatalogPagingControls({
  page,
  name,
  empty,
}: {
  page: ReturnType<typeof useCatalogPages>;
  name: 'rooms' | 'recordings';
  empty: string;
}) {
  return (
    <>
      {page.pending && (
        <p className="text-sm text-muted" role="status">
          Loading {name}…
        </p>
      )}
      {!page.pending && !page.error && page.items.length === 0 && (
        <p className="text-sm text-muted">{empty}</p>
      )}
      {page.error && (
        <div className="mt-3">
          <p className="text-sm text-danger wrap-anywhere" role="alert">
            {page.error.message}
          </p>
          <Button type="button" disabled={page.busy} onClick={page.retry}>
            {page.nextPageError ? `Retry loading more ${name}` : `Retry ${name}`}
          </Button>
        </div>
      )}
      {page.loadingMore && (
        <p className="text-sm text-muted" role="status">
          Loading more {name}…
        </p>
      )}
      {page.hasNextPage && !page.error && (
        <Button className="mt-3" type="button" disabled={page.busy} onClick={page.loadMore}>
          Load more
        </Button>
      )}
    </>
  );
}
