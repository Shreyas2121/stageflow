import { Link, Route, Routes } from 'react-router';
import { HomePage } from './pages/HomePage';
import { RoomPage } from './pages/RoomPage';
import { PageState } from './components/ui/page-state';

export function App() {
  return (
    <div className="mx-auto flex min-h-svh w-[calc(100%-36px)] max-w-shell flex-col layout:w-[calc(100%-72px)]">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-control bg-accent px-4 py-3 text-sm font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        Skip to content
      </a>
      <header className="flex min-h-[82px] items-center justify-between gap-5 border-b border-divider layout:min-h-26">
        <Link
          to="/"
          className="inline-flex items-center gap-3 text-[22px] font-semibold tracking-[-0.05em]"
          aria-label="StageFlow home"
        >
          <span
            className="inline-flex size-[34px] items-center justify-center rounded-lg border border-accent pr-0.5 text-2xl font-medium tracking-[-2px] text-focus"
            aria-hidden="true"
          >
            s<span className="-translate-y-[3px]">f</span>
          </span>
          StageFlow
        </Link>
        <span className="text-right text-[10px] text-muted layout:text-xs">
          Meetings &amp; webinars
        </span>
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/r/:slug" element={<RoomPage />} />
          <Route
            path="*"
            element={
              <PageState eyebrow="404 / Not found" title="This page does not exist.">
                <Link
                  className="mt-4 inline-flex text-sm text-accent underline-offset-4 hover:underline"
                  to="/"
                >
                  Back to home <span aria-hidden="true">&#8599;</span>
                </Link>
              </PageState>
            }
          />
        </Routes>
      </main>
      <footer className="flex flex-wrap justify-between gap-3 border-t border-divider py-6 text-[10px] text-subtle layout:text-[11px]">
        <span>StageFlow</span>
        <span>Guest sessions &middot; Live stage &middot; Screen sharing</span>
      </footer>
    </div>
  );
}
