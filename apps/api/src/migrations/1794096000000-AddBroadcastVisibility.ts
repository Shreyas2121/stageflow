import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBroadcastVisibility1794096000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE broadcasts ADD COLUMN visibility text NOT NULL DEFAULT 'LINK' CONSTRAINT broadcasts_visibility_check CHECK (visibility IN ('LINK', 'HOST'))`,
    );
    await runner.query('ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check');
    await runner.query(
      `ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check CHECK (status IN ('STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED', 'DELETING'))`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check');
    await runner.query(
      `ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check CHECK (status IN ('STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'))`,
    );
    await runner.query('ALTER TABLE broadcasts DROP COLUMN visibility');
  }
}
