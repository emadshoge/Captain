-- Database-enforced rules that Drizzle cannot express:
-- ledger balance, append-only history, immutable pricing/ride/device facts,
-- runtime role grants, and reference data (roles, permissions, system accounts).
-- Business values (prices, zones) are NOT seeded here.

-- 1. Balanced journals --------------------------------------------------------
CREATE FUNCTION captain_assert_journal_balanced(jid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
  line_count int;
BEGIN
  SELECT coalesce(sum(amount_santim), 0), count(*) INTO total, line_count
  FROM ledger_lines WHERE journal_id = jid;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal % must have at least two ledger lines (has %)', jid, line_count
      USING ERRCODE = 'check_violation';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced (sum % santim)', jid, total
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION captain_journal_balanced_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    PERFORM captain_assert_journal_balanced(NEW.id);
  ELSE
    PERFORM captain_assert_journal_balanced(NEW.journal_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION captain_journal_balanced_trg();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_lines_balanced
  AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION captain_journal_balanced_trg();
--> statement-breakpoint

-- 2. Append-only history -------------------------------------------------------
CREATE FUNCTION captain_append_only_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed (write a compensating entry instead)',
    TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER ride_events_append_only BEFORE UPDATE OR DELETE ON ride_events
  FOR EACH ROW EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER device_command_acks_append_only BEFORE UPDATE OR DELETE ON device_command_acks
  FOR EACH ROW EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER journal_truncate_block BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_truncate_block BEFORE TRUNCATE ON ledger_lines
  FOR EACH STATEMENT EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint
CREATE TRIGGER audit_log_truncate_block BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION captain_append_only_trg();
--> statement-breakpoint

-- Payment events: raw data is immutable; only processing fields may be set.
CREATE FUNCTION captain_payment_events_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_events is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR (OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id) THEN
    RAISE EXCEPTION 'payment_events raw fields are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_events_guard BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION captain_payment_events_trg();
--> statement-breakpoint

-- 3. Immutable facts ------------------------------------------------------------
-- Pricing plans: numbers are frozen once the plan leaves draft.
CREATE FUNCTION captain_pricing_plans_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft pricing plans can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.name, NEW.currency, NEW.is_dev_fixture, NEW.unlock_fee_santim, NEW.per_minute_santim,
       NEW.billing_increment_seconds, NEW.pause_per_minute_santim, NEW.max_pause_minutes,
       NEW.min_start_balance_santim, NEW.hold_amount_santim, NEW.reservation_minutes,
       NEW.reservation_fee_santim, NEW.max_ride_minutes, NEW.low_balance_floor_santim,
       NEW.created_at, NEW.created_by_staff_id
     ) IS DISTINCT FROM (
       OLD.name, OLD.currency, OLD.is_dev_fixture, OLD.unlock_fee_santim, OLD.per_minute_santim,
       OLD.billing_increment_seconds, OLD.pause_per_minute_santim, OLD.max_pause_minutes,
       OLD.min_start_balance_santim, OLD.hold_amount_santim, OLD.reservation_minutes,
       OLD.reservation_fee_santim, OLD.max_ride_minutes, OLD.low_balance_floor_santim,
       OLD.created_at, OLD.created_by_staff_id
     ) THEN
    RAISE EXCEPTION 'pricing plan % is % and immutable; create a new plan version', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (
       NEW.status = OLD.status
       OR (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
       OR (OLD.status = 'active' AND NEW.status = 'retired')
     ) THEN
    RAISE EXCEPTION 'invalid pricing plan transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pricing_plans_guard BEFORE UPDATE OR DELETE ON pricing_plans
  FOR EACH ROW EXECUTE FUNCTION captain_pricing_plans_trg();
--> statement-breakpoint

-- Rides: who, what and the price snapshot never change after creation.
CREATE FUNCTION captain_rides_immutable_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rides cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.rider_id, NEW.scooter_id, NEW.device_id, NEW.pricing_plan_id, NEW.pricing_snapshot,
      NEW.is_simulated, NEW.requested_at, NEW.currency)
     IS DISTINCT FROM
     (OLD.rider_id, OLD.scooter_id, OLD.device_id, OLD.pricing_plan_id, OLD.pricing_snapshot,
      OLD.is_simulated, OLD.requested_at, OLD.currency) THEN
    RAISE EXCEPTION 'ride % identity/pricing fields are immutable', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('completed', 'start_failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'ride % is in terminal state %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rides_guard BEFORE UPDATE OR DELETE ON rides
  FOR EACH ROW EXECUTE FUNCTION captain_rides_immutable_trg();
--> statement-breakpoint

-- Devices: simulated vs real can never be flipped.
CREATE FUNCTION captain_devices_immutable_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_simulated IS DISTINCT FROM OLD.is_simulated OR NEW.adapter IS DISTINCT FROM OLD.adapter THEN
    RAISE EXCEPTION 'device % adapter/is_simulated are immutable', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER devices_guard BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION captain_devices_immutable_trg();
--> statement-breakpoint

-- 4. Reference data (not business policy) ------------------------------------------
INSERT INTO roles (key, description) VALUES
  ('admin', 'Captain administrator: business configuration, finance, staff'),
  ('operator', 'Field/fleet operator: scooters, maintenance, incidents');
--> statement-breakpoint
INSERT INTO permissions (key, description) VALUES
  ('fleet.read', 'View scooters, devices, telemetry and alerts'),
  ('fleet.status.update', 'Change scooter operational status'),
  ('fleet.manage', 'Onboard/retire scooters, register devices, assign devices'),
  ('device.command.service', 'Send service commands documented by the supplier'),
  ('maintenance.manage', 'Create and update maintenance and repositioning tasks'),
  ('alerts.manage', 'Acknowledge and resolve operational alerts'),
  ('incidents.read', 'View incidents'),
  ('incidents.resolve', 'Work and resolve incidents'),
  ('rides.read', 'View rides and ride events'),
  ('rides.review', 'Resolve rides in operator review'),
  ('riders.read', 'View rider accounts'),
  ('riders.manage', 'Suspend/unsuspend riders, process deletion requests'),
  ('wallet.read', 'View wallets and ledger history'),
  ('wallet.adjust', 'Post wallet adjustments with a reason'),
  ('refunds.approve', 'Approve or reject refunds'),
  ('payments.read', 'View payment attempts and provider events'),
  ('payments.reconcile', 'Trigger payment verification/reconciliation'),
  ('pricing.manage', 'Create and activate pricing plans'),
  ('zones.manage', 'Create and change zones'),
  ('staff.manage', 'Provision staff and assign roles'),
  ('audit.read', 'View the audit log'),
  ('reports.export', 'Export CSV reports');
--> statement-breakpoint
INSERT INTO role_permissions (role_key, permission_key)
SELECT 'admin', key FROM permissions;
--> statement-breakpoint
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('operator', 'fleet.read'),
  ('operator', 'fleet.status.update'),
  ('operator', 'device.command.service'),
  ('operator', 'maintenance.manage'),
  ('operator', 'alerts.manage'),
  ('operator', 'incidents.read'),
  ('operator', 'incidents.resolve'),
  ('operator', 'rides.read'),
  ('operator', 'rides.review');
--> statement-breakpoint
INSERT INTO ledger_accounts (type, rider_id, currency) VALUES
  ('provider_clearing', NULL, 'ETB'),
  ('ride_revenue', NULL, 'ETB'),
  ('reservation_revenue', NULL, 'ETB'),
  ('refunds', NULL, 'ETB'),
  ('adjustments', NULL, 'ETB');
--> statement-breakpoint

-- 5. Runtime role ------------------------------------------------------------------
-- `captain_app` is a NOLOGIN group role. Runtime login users (the API, the
-- worker) are granted membership; the migration owner keeps DDL rights.
-- Creating it needs CREATEROLE; managed databases may require an admin to
-- create it first (docs/deployment.md). Without it, grants are skipped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'captain_app') THEN
    BEGIN
      CREATE ROLE captain_app NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'role captain_app not created (insufficient privilege); runtime grants skipped';
    END;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'captain_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO captain_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO captain_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO captain_app';
    -- History tables: insert and read only.
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, ledger_lines, audit_log, ride_events, device_command_acks FROM captain_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON payment_events, rides, pricing_plans FROM captain_app';
    -- Reference data is managed by migrations only.
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON roles, permissions, role_permissions, ledger_accounts FROM captain_app';
    EXECUTE 'GRANT INSERT ON ledger_accounts TO captain_app';
    -- Readiness check reads migration status.
    EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO captain_app';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO captain_app';
    -- Future tables get ordinary DML by default; migrations that add history
    -- tables must REVOKE UPDATE/DELETE explicitly (CLAUDE.md).
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO captain_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO captain_app';
  END IF;
END $$;
