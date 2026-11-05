import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRoomSchedule1794182400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE rooms ADD COLUMN scheduled_start_at timestamptz');
    await runner.query(
      'ALTER TABLE rooms ADD COLUMN require_admission boolean NOT NULL DEFAULT false',
    );
    await runner.query('ALTER TABLE rooms DROP CONSTRAINT rooms_status_check');
    await runner.query(
      `ALTER TABLE rooms ADD CONSTRAINT rooms_status_check CHECK (status IN ('SCHEDULED', 'LIVE', 'ENDED'))`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE rooms DROP CONSTRAINT rooms_status_check');
    await runner.query(
      `ALTER TABLE rooms ADD CONSTRAINT rooms_status_check CHECK (status IN ('LIVE', 'ENDED'))`,
    );
    await runner.query('ALTER TABLE rooms DROP COLUMN require_admission');
    await runner.query('ALTER TABLE rooms DROP COLUMN scheduled_start_at');
  }
}
