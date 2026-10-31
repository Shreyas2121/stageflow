import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../database/base.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ name: 'display_name', type: 'varchar', length: 40 })
  displayName: string;

  @Column({ name: 'is_guest', type: 'boolean', default: true })
  isGuest: boolean;
}
