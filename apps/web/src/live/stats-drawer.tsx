import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '@stageflow/shared';
import type { PeerManager } from './peer-manager';
import { StatsCollector, type ConnectionStats } from './stats-collector';

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
    <details className="stats-drawer">
      <summary>Connection stats</summary>
      {stats.size === 0 ? (
        <p className="muted stats-empty">The stage has no remote connections yet.</p>
      ) : (
        <div
          className="stats-table-scroll"
          role="region"
          aria-label="Connection stats"
          tabIndex={0}
        >
          <table className="stats-table">
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
