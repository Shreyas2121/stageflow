import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersAndRooms1730332800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        display_name varchar(40) NOT NULL,
        is_guest boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE rooms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug varchar(12) NOT NULL UNIQUE,
        title varchar(80) NOT NULL,
        mode text NOT NULL CONSTRAINT rooms_mode_check CHECK (mode IN ('MEETING', 'WEBINAR')),
        status text NOT NULL CONSTRAINT rooms_status_check CHECK (status IN ('LIVE', 'ENDED')),
        host_id uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE rooms');
    await queryRunner.query('DROP TABLE users');
  }
}
