import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../database/base.entity';

@Entity('users')
@Index('users_email_unique', ['email'], { unique: true, where: 'email IS NOT NULL' })
export class User extends BaseEntity {
  @Column({ name: 'display_name', type: 'varchar', length: 40 })
  displayName: string;

  @Column({ name: 'is_guest', type: 'boolean', default: true })
  isGuest: boolean;

  @Column({ type: 'varchar', length: 254, nullable: true })
  email: string | null;

  @Column({ name: 'password_hash', type: 'text', nullable: true, select: false })
  passwordHash: string | null;

  @Column({ name: 'session_version', type: 'integer', default: 0 })
  sessionVersion: number;
}
