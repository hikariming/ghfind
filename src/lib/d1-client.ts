import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Client, InStatement, ResultSet } from "@libsql/client/web";

/**
 * Adapts a Cloudflare D1 binding to the slice of the libsql `Client` interface
 * the data layer uses (`execute`, `batch`). Interactive `transaction()` was
 * eliminated from every live write path (guarded statements / batch instead);
 * the method throws so any resurrected dead code fails loudly rather than
 * corrupting data. `batch()` is an implicit transaction on D1, matching libsql.
 */

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all(): Promise<{
    results: Record<string, unknown>[];
    meta: { changes?: number; last_row_id?: number };
  }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<
    { results: Record<string, unknown>[]; meta: { changes?: number; last_row_id?: number } }[]
  >;
}

function normalizeStatement(stmt: InStatement): { sql: string; args: unknown[] } {
  if (typeof stmt === "string") return { sql: stmt, args: [] };
  const args = Array.isArray(stmt.args) ? stmt.args : Object.values(stmt.args ?? {});
  return { sql: stmt.sql, args: args as unknown[] };
}

function toResultSet(raw: {
  results: Record<string, unknown>[];
  meta: { changes?: number; last_row_id?: number };
}): ResultSet {
  const rows = raw.results ?? [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return {
    rows: rows as ResultSet["rows"],
    columns,
    columnTypes: columns.map(() => ""),
    rowsAffected: raw.meta?.changes ?? 0,
    lastInsertRowid:
      raw.meta?.last_row_id === undefined ? undefined : BigInt(raw.meta.last_row_id),
    toJSON: () => ({ rows, columns }),
  } as ResultSet;
}

/**
 * The GHFIND_D1 binding when running on Cloudflare, else null (local dev,
 * tests and scripts fall back to the Turso client). Schema on D1 is owned by
 * wrangler migrations — callers must skip runtime DDL for this client.
 */
export function getD1Binding(): D1DatabaseLike | null {
  try {
    const env = getCloudflareContext().env as { GHFIND_D1?: D1DatabaseLike };
    return env.GHFIND_D1 ?? null;
  } catch {
    return null;
  }
}

export function d1AsLibsqlClient(d1: D1DatabaseLike): Client {
  const prepare = (stmt: InStatement) => {
    const { sql, args } = normalizeStatement(stmt);
    return d1.prepare(sql).bind(...args);
  };
  const client = {
    async execute(stmt: InStatement): Promise<ResultSet> {
      return toResultSet(await prepare(stmt).all());
    },
    async batch(stmts: InStatement[]): Promise<ResultSet[]> {
      if (stmts.length === 0) return [];
      const results = await d1.batch(stmts.map(prepare));
      return results.map(toResultSet);
    },
    transaction(): never {
      throw new Error(
        "interactive transactions are not supported on D1; use guarded statements or batch()",
      );
    },
    close(): void {},
    closed: false,
  };
  return client as unknown as Client;
}
