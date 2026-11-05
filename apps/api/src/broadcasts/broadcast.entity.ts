import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import type { BroadcastStatus, BroadcastVisibility } from '@stageflow/shared';
import { BaseEntity } from '../database/base.entity';
import { Room } from '../rooms/room.entity';

@Entity('broadcasts')
@Check(
  'broadcasts_status_check',
  `"status" IN ('STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED', 'DELETING')`,
)
@Check('broadcasts_visibility_check', `"visibility" IN ('LINK', 'HOST')`)
@Index('broadcasts_room_created_idx', ['roomId', 'createdAt'])
export class Broadcast extends BaseEntity {
  @Column({ name: 'room_id', type: 'uuid' })
  roomId: string;

  @ManyToOne(() => Room, { nullable: false })
  @JoinColumn({ name: 'room_id', foreignKeyConstraintName: 'broadcasts_room_id_fkey' })
  room: Room;

  @Column({ type: 'text', default: 'STARTING' })
  status: BroadcastStatus | 'DELETING';

  @Column({ type: 'text', default: 'LINK' })
  visibility: BroadcastVisibility;

  @Column({ name: 'playlist_path', type: 'text', nullable: true })
  playlistPath: string | null;

  @Column({ name: 'thumbnail_path', type: 'text', nullable: true })
  thumbnailPath: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;
}
