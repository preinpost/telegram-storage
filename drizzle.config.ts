import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — schema source: src/db/schema.ts.
 *
 * Used to generate migrations for a fresh SQLite deployment (Node/Docker):
 *   npx drizzle-kit generate   → ./drizzle/*.sql
 *   npx drizzle-kit migrate    → apply
 *
 * For the Cloudflare D1 target later, a separate config pointing at the same
 * schema is used with `wrangler d1 migrations apply` (schema stays the same;
 * only the output format differs).
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
