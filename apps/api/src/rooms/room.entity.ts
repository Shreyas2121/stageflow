import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import type { RoomMode, RoomStatus } from '@stageflow/shared';
import { BaseEntity } from '../database/base.entity';
import { User } from '../users/user.entity';

@Entity('rooms')
@Check('rooms_mode_check', `"mode" IN ('MEETING', 'WEBINAR')`)
@Check('rooms_status_check', `"status" IN ('SCHEDULED', 'LIVE', 'ENDED')`)
@Index('rooms_host_created_idx', ['hostId', 'createdAt', 'id'])
export class Room extends BaseEntity {
  @Column({ type: 'varchar', length: 12, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 80 })
  title: string;

  @Column({ type: 'text' })
  mode: RoomMode;

  @Column({ type: 'text' })
  status: RoomStatus;

  @Column({ name: 'scheduled_start_at', type: 'timestamptz', nullable: true })
  scheduledStartAt: Date | null;

  @Column({ name: 'require_admission', type: 'boolean', default: false })
  requireAdmission: boolean;

  @Column({ name: 'host_id', type: 'uuid' })
  hostId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'host_id' })
  host: User;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;
}
