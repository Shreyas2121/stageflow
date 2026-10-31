import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { env } from '../config/env';
import { User } from '../users/user.entity';
import { Room } from '../rooms/room.entity';
import { CreateUsersAndRooms1730332800000 } from '../migrations/1730332800000-CreateUsersAndRooms';

export const databaseOptions: DataSourceOptions = {
  type: 'postgres',
  url: env.DATABASE_URL,
  uuidExtension: 'pgcrypto',
  installExtensions: false,
  entities: [User, Room],
  migrations: [CreateUsersAndRooms1730332800000],
  synchronize: false,
  migrationsRun: false,
};

export default new DataSource(databaseOptions);
