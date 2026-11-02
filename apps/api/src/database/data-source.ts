import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { parseDatabaseConfig } from '../config/parse-config';
import { User } from '../users/user.entity';
import { Room } from '../rooms/room.entity';
import { CreateUsersAndRooms1730332800000 } from '../migrations/1730332800000-CreateUsersAndRooms';

export const databaseOptions: DataSourceOptions = {
  type: 'postgres',
  url: parseDatabaseConfig(process.env).DATABASE_URL,
  uuidExtension: 'pgcrypto',
  installExtensions: false,
  entities: [User, Room],
  migrations: [CreateUsersAndRooms1730332800000],
  synchronize: false,
  migrationsRun: false,
};

export default new DataSource(databaseOptions);
