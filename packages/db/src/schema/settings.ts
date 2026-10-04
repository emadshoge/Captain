import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './_common';

/**
 * Configurable settings that are not tied to a pricing plan (data-model.md).
 * No business values are seeded here.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (table) => [check('app_settings_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_.]*$'`)],
);
