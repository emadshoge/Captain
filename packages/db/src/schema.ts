import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Configurable settings that are not tied to a pricing plan (data-model.md).
 * Values are set by later phases; no business values are seeded here.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (table) => [check('app_settings_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_.]*$'`)],
);
