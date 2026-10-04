import { sql } from 'drizzle-orm';
import { bigint, char, check, timestamp } from 'drizzle-orm/pg-core';

/** All timestamps are timestamptz (stored in UTC). */
export const ts = (name: string) => timestamp(name, { withTimezone: true });
export const createdAt = () => ts('created_at').notNull().defaultNow();
export const updatedAt = () => ts('updated_at').notNull().defaultNow();

/** Money: integer santim (1 ETB = 100 santim). Read as JS number (safe-integer range). */
export const santim = (name: string) => bigint(name, { mode: 'number' });

/** ISO 4217 currency. Captain operates in ETB only (decision R-08). */
export const currency = () => char('currency', { length: 3 }).notNull().default('ETB');
export const currencyIsEtb = (table: { currency: unknown }, name: string) =>
  check(name, sql`${table.currency} = 'ETB'`);

/** Latitude/longitude range checks (WGS84). */
export const latCheck = (name: string, column: unknown) =>
  check(name, sql`${column} is null or (${column} between -90 and 90)`);
export const lngCheck = (name: string, column: unknown) =>
  check(name, sql`${column} is null or (${column} between -180 and 180)`);
