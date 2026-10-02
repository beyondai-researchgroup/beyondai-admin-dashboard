// Same pattern as rei40-andrejkatin/server.mjs and bigfive-andrejkatin/server.mjs: a lazily
// created neon() HTTP client shared by every route module in this backend.
//
// Dual-mode (2026-09-08): DB_MODE=local (set via .env.local, npm run serve:api:local) swaps in
// a local Postgres client instead — see local-db.mjs's own header comment and
// docs/local-dev-database.md. Plain `npm run serve:api` (.env, DATABASE_URL, no DB_MODE) is
// completely untouched — production always takes the neon() branch exactly as before.
import { neon } from '@neondatabase/serverless';
import { createLocalSql } from './local-db.mjs';

let sql;

export function getDb() {
  if (!sql) {
    if (process.env.DB_MODE === 'local') {
      const url = process.env.LOCAL_DATABASE_URL;
      if (!url) throw new Error('LOCAL_DATABASE_URL environment variable is not set (DB_MODE=local)');
      sql = createLocalSql(url);
      console.log('[db] developer mode: local Postgres');
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL environment variable is not set');
      sql = neon(url);
    }
  }
  return sql;
}
