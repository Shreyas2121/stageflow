import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '../components/ui/button';
import { PageState } from '../components/ui/page-state';

type BoundaryProps = {
  children: ReactNode;
  resetKey: number;
  onRetry: () => void;
};

type BoundaryState = { error: Error | null };

export class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <PageState eyebrow="Page did not load" title="This page could not be loaded.">
        <p className="text-sm text-muted" role="alert">
          The room page failed to download. Check the connection and try again.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button type="button" onClick={this.props.onRetry}>
            Try again
          </Button>
          <Link
            className="inline-flex text-sm text-accent underline-offset-4 hover:underline"
            to="/"
          >
            Back to home <span aria-hidden="true">&#8599;</span>
          </Link>
        </div>
      </PageState>
    );
  }
}

export function RoomRoute() {
  const [attempt, setAttempt] = useState(0);
  const RoomPage = useMemo(
    () => lazy(() => import('../pages/RoomPage').then((module) => ({ default: module.RoomPage }))),
    [attempt],
  );
  return (
    <RouteErrorBoundary resetKey={attempt} onRetry={() => setAttempt((value) => value + 1)}>
      <Suspense
        fallback={
          <p className="py-16 text-sm text-muted" role="status">
            Loading room…
          </p>
        }
      >
        <RoomPage />
      </Suspense>
    </RouteErrorBoundary>
  );
}
