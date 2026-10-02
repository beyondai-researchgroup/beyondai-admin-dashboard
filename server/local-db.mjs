// "Developer mode" DB client — a drop-in stand-in for @neondatabase/serverless's neon() when
// DB_MODE=local (see docs/local-dev-database.md). Every route file in this repo does
// `const sql = getDb(); await sql\`SELECT ... ${x} ...\`` — the neon driver's *tagged-template*
// calling convention, plus one spot (consent-andrejkatin's issueSurveyLinks.mjs, not this repo)
// uses `sql.query(text, params)`. Confirmed via grep this repo uses only those two shapes (no
// sql.transaction/sql.unsafe anywhere outside node_modules), so this wrapper only needs to
// support those two — zero changes needed to any route file regardless of which mode is active.
//
// Returns a plain array of row objects either way (never pg's own {rows: [...]} wrapper), same
// shape neon's driver returns, so callers can't tell the difference.
//
// Type-parity note (checked before writing this, not assumed): every BYTEA read in this codebase
// already goes through Buffer.from(row.Col) (works whether pg hands back a Buffer or neon's own
// representation); date-only.mjs's dateOnly() already branches on `v instanceof Date ? v : new
// Date(v)`, i.e. it already tolerates either a Date object or a string — so pg's default
// timestamp-as-Date-object behavior (vs. neon's ISO strings) needs no type-parser overrides here.
import pg from 'pg';

export function createLocalSql(connectionString) {
  const pool = new pg.Pool({ connectionString });

  async function sql(strings, ...values) {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const result = await pool.query(text, values);
    return result.rows;
  }
  sql.query = async (text, params = []) => (await pool.query(text, params)).rows;
  return sql;
}
