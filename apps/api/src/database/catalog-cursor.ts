import { Raw } from 'typeorm';

/** Next page of `created_at DESC, id DESC`, preserving the timestamp text and UUID ordering. */
export function beforeHistoryCursor(createdAt: string, id: string) {
  return Raw(
    (alias) => {
      const dot = alias.lastIndexOf('.');
      const table = `"${alias.slice(0, dot).replaceAll('"', '')}"`;
      return `(${table}."created_at", ${table}."id") < (CAST(:cursorCreatedAt AS timestamptz), CAST(:cursorId AS uuid))`;
    },
    { cursorCreatedAt: createdAt, cursorId: id },
  );
}
