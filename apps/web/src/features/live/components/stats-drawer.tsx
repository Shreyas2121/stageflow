import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '@stageflow/shared';
import type { PeerManager } from '../services/peer-manager';
import { StatsCollector, type ConnectionStats } from '../services/stats-collector';

function metric(value: number | null, unit: string): string {
  return value === null
    ? '—'
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

export function StatsDrawer({
  manager,
  snapshot,
}: {
  manager: PeerManager;
  snapshot: RoomSnapshot;
}) {
  const [stats, setStats] = useState<ConnectionStats>(new Map());

  useEffect(() => {
    const collector = new StatsCollector(() => manager.statsConnections(), setStats);
    return () => collector.close();
  }, [manager]);

  return (
    <details className="group mb-7 min-w-0 rounded-lg border border-line bg-field">
      <summary className="cursor-pointer p-4 text-[13px] font-semibold text-accent group-open:border-b group-open:border-line">
        Connection stats
      </summary>
      {stats.size === 0 ? (
        <p className="m-0 p-4 text-sm text-muted">The stage has no remote connections yet.</p>
      ) : (
        <div
          className="max-w-full overflow-x-auto"
          role="region"
          aria-label="Connection stats"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-left text-xs tabular-nums [&_th]:px-4 [&_th]:py-3.5 [&_td]:px-4 [&_td]:py-3.5 [&_td]:whitespace-nowrap [&_thead_th]:font-medium [&_thead_th]:whitespace-nowrap [&_thead_th]:text-muted [&_tbody_th]:min-w-30 [&_tbody_th]:max-w-55 [&_tbody_th]:font-medium [&_tbody_th]:wrap-anywhere [&_tbody_tr]:border-t [&_tbody_tr]:border-line">
            <caption className="sr-only">Live connection statistics, updated every second</caption>
            <thead>
              <tr>
                <th scope="col">Participant</th>
                <th scope="col">Outbound bitrate</th>
                <th scope="col">Inbound bitrate</th>
                <th scope="col">Packet loss</th>
                <th scope="col">Jitter</th>
                <th scope="col">Round-trip time</th>
                <th scope="col">Frame rate</th>
                <th scope="col">ICE type</th>
              </tr>
            </thead>
            <tbody>
              {[...stats].map(([socketId, view]) => (
                <tr key={socketId}>
                  <th scope="row">
                    {snapshot.participants.find((participant) => participant.socketId === socketId)
                      ?.displayName ?? 'Participant'}
                  </th>
                  <td>{metric(view.outboundBitrate, 'bit/s')}</td>
                  <td>{metric(view.inboundBitrate, 'bit/s')}</td>
                  <td>{metric(view.packetLossPercent, '%')}</td>
                  <td>{metric(view.jitterMs, 'ms')}</td>
                  <td>{metric(view.roundTripTimeMs, 'ms')}</td>
                  <td>{metric(view.framesPerSecond, 'fps')}</td>
                  <td>{view.iceType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
