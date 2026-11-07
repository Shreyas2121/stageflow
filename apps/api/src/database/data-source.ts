import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { parseDatabaseConfig } from '../config/parse-config';
import { User } from '../users/user.entity';
import { Room } from '../rooms/room.entity';
import { Broadcast } from '../broadcasts/broadcast.entity';
import { CreateUsersAndRooms1730332800000 } from '../migrations/1730332800000-CreateUsersAndRooms';
import { CreateBroadcasts1793577600000 } from '../migrations/1793577600000-CreateBroadcasts';
import { IndexRoomsByHost1793664000000 } from '../migrations/1793664000000-IndexRoomsByHost';
import { AddHostCredentials1793923200000 } from '../migrations/1793923200000-AddHostCredentials';
import { AddGoogleSubject1794009600000 } from '../migrations/1794009600000-AddGoogleSubject';

import { AddBroadcastVisibility1794096000000 } from '../migrations/1794096000000-AddBroadcastVisibility';

import { AddRoomSchedule1794182400000 } from '../migrations/1794182400000-AddRoomSchedule';

const databaseConfig = parseDatabaseConfig(process.env);

export const databaseOptions: DataSourceOptions = {
  type: 'postgres',
  url: databaseConfig.DATABASE_URL,
  // Omit poolSize when unset so node-postgres keeps its default of 10.
  ...(databaseConfig.DATABASE_POOL_MAX === undefined
    ? {}
    : { poolSize: databaseConfig.DATABASE_POOL_MAX }),
  uuidExtension: 'pgcrypto',
  installExtensions: false,
  entities: [User, Room, Broadcast],
  migrations: [
    CreateUsersAndRooms1730332800000,
    CreateBroadcasts1793577600000,
    IndexRoomsByHost1793664000000,
    AddHostCredentials1793923200000,
    AddGoogleSubject1794009600000,
    AddBroadcastVisibility1794096000000,
    AddRoomSchedule1794182400000,
  ],
  synchronize: false,
  migrationsRun: false,
};

export default new DataSource(databaseOptions);
