import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import type { BroadcastPlayerProps } from './broadcast-player';
import { Button } from '../../../components/ui/button';

const alertClass =
  'mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere';

export function loadBroadcastPlayer(): Promise<{ default: ComponentType<BroadcastPlayerProps> }> {
  return import('./broadcast-player').then((module) => ({ default: module.BroadcastPlayer }));
}

function createPlayer() {
  return lazy(loadBroadcastPlayer);
}

class PlayerLoadError extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mt-3">
        <p className={alertClass} role="alert">
          The broadcast player could not be loaded.
        </p>
        <Button className="mt-3" type="button" onClick={this.props.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
}

/** Loads the HLS runtime only after a live or finished playlist is actually shown. */
export function BroadcastPlayerGate(props: BroadcastPlayerProps) {
  const [{ attempt, Player }, setGate] = useState(() => ({
    attempt: 0,
    Player: createPlayer(),
  }));
  return (
    <PlayerLoadError
      key={attempt}
      onRetry={() => setGate((value) => ({ attempt: value.attempt + 1, Player: createPlayer() }))}
    >
      <Suspense
        fallback={
          <p className="mt-3 text-sm text-muted" role="status">
            Loading the broadcast…
          </p>
        }
      >
        <Player {...props} />
      </Suspense>
    </PlayerLoadError>
  );
}
