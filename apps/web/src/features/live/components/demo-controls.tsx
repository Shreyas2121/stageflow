export function DemoControls({
  count,
  starting,
  spawnDisabled,
  onSpawn,
  onRemove,
}: {
  count: number;
  starting: boolean;
  spawnDisabled: boolean;
  onSpawn: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="demo-controls" aria-label="Demo peers" aria-busy={starting}>
      <button
        id="spawn-demo-peer"
        className="button button-secondary"
        disabled={spawnDisabled}
        onClick={onSpawn}
      >
        Spawn demo peer
      </button>
      <button
        id="remove-demo-peers"
        className="button button-secondary"
        disabled={count === 0}
        onClick={onRemove}
      >
        Remove demo peers
      </button>
      <span className="muted" role="status">
        {starting ? 'Starting demo peer…' : `${count} of 3 demo peers`}
      </span>
    </div>
  );
}
