// Applies pending migrations to DATABASE_URL (see migrate-command.ts).
import { runMigrateCommand } from './migrate-command';

process.exitCode = await runMigrateCommand(process.argv.slice(2), process.env);
