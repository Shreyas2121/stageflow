import { Button } from '../../../components/ui/button';
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
    <div
      className="mb-6 flex flex-wrap items-center gap-2.5"
      aria-label="Demo peers"
      aria-busy={starting}
    >
      <Button type="button" id="spawn-demo-peer" disabled={spawnDisabled} onClick={onSpawn}>
        Spawn demo peer
      </Button>
      <Button type="button" id="remove-demo-peers" disabled={count === 0} onClick={onRemove}>
        Remove demo peers
      </Button>
      <span className="ml-1 text-xs text-muted" role="status">
        {starting ? 'Starting demo peer…' : `${count} of 3 demo peers`}
      </span>
    </div>
  );
}
