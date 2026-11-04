const TABLES = { rooms: 'rooms', broadcasts: 'broadcasts' } as const;

// JavaScript Date and the public ISO field stop at milliseconds. PostgreSQL timestamptz stores
// microseconds, so the keyset cursor reads that UTC text back unchanged.
const ORDERING_INSTANT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readOrderingInstant(
  query: (sql: string, parameters: unknown[]) => Promise<unknown>,
  table: keyof typeof TABLES,
  id: string,
): Promise<string | null> {
  const rows: unknown = await query(
    `SELECT ${ORDERING_INSTANT} AS ordering FROM ${TABLES[table]} WHERE id = $1`,
    [id],
  );
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null || !('ordering' in row)) return null;
  const ordering = row.ordering;
  return typeof ordering === 'string' ? ordering : null;
}
