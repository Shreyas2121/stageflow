import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBroadcasts1793577600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE broadcasts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id uuid NOT NULL REFERENCES rooms(id),
        status text NOT NULL DEFAULT 'STARTING'
          CONSTRAINT broadcasts_status_check CHECK (status IN ('STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED')),
        playlist_path text NULL,
        thumbnail_path text NULL,
        error_message text NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX broadcasts_room_created_idx ON broadcasts (room_id, created_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE broadcasts');
  }
}
