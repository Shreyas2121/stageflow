import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGoogleSubject1794009600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE users ADD COLUMN google_subject varchar(255) NULL');
    await runner.query(
      'CREATE UNIQUE INDEX users_google_subject_unique ON users (google_subject) WHERE google_subject IS NOT NULL',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX users_google_subject_unique');
    await runner.query('ALTER TABLE users DROP COLUMN google_subject');
  }
}
