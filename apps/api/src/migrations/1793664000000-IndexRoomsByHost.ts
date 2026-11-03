import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexRoomsByHost1793664000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX rooms_host_created_idx ON rooms (host_id, created_at DESC, id DESC)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX rooms_host_created_idx');
  }
}
