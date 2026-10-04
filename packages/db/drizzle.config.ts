import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm db:generate`, which diffs the schema against the
// migration history on disk. It never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
