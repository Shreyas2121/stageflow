import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHostCredentials1793923200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN email varchar(254) NULL,
        ADD COLUMN password_hash text NULL,
        ADD COLUMN session_version integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE email IS NOT NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX users_email_unique');
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN session_version,
        DROP COLUMN password_hash,
        DROP COLUMN email
    `);
  }
}
