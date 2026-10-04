CREATE TYPE "public"."contact_kind" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."otp_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('login', 'contact_change');--> statement-breakpoint
CREATE TYPE "public"."rider_status" AS ENUM('active', 'suspended', 'deletion_requested', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."session_client" AS ENUM('mobile', 'web');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('active', 'suspended', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('rider', 'staff');--> statement-breakpoint
CREATE TYPE "public"."token_kind" AS ENUM('access', 'refresh');--> statement-breakpoint
CREATE TYPE "public"."device_adapter" AS ENUM('simulated', 'supplier_tcp');--> statement-breakpoint
CREATE TYPE "public"."maintenance_kind" AS ENUM('inspection', 'repair', 'battery_swap', 'charging', 'reposition', 'other');--> statement-breakpoint
CREATE TYPE "public"."scooter_status" AS ENUM('available', 'reserved', 'in_ride', 'maintenance', 'charging', 'missing', 'retired');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."zone_kind" AS ENUM('service_area', 'parking', 'no_parking', 'restricted', 'slow');--> statement-breakpoint
CREATE TYPE "public"."ack_outcome" AS ENUM('ack', 'nack');--> statement-breakpoint
CREATE TYPE "public"."command_issuer" AS ENUM('system', 'staff', 'rider');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('queued', 'sent', 'acked', 'nacked', 'timed_out', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."command_type" AS ENUM('unlock', 'lock', 'locate');--> statement-breakpoint
CREATE TYPE "public"."completion_source" AS ENUM('device', 'operator');--> statement-breakpoint
CREATE TYPE "public"."event_cause" AS ENUM('rider', 'device', 'timeout', 'operator', 'system');--> statement-breakpoint
CREATE TYPE "public"."parking_status" AS ENUM('ok', 'outside', 'unknown', 'not_checked');--> statement-breakpoint
CREATE TYPE "public"."pricing_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'expired', 'cancelled', 'converted');--> statement-breakpoint
CREATE TYPE "public"."ride_status" AS ENUM('start_requested', 'unlock_pending', 'active', 'paused', 'end_requested', 'completion_pending', 'completed', 'start_failed', 'operator_review');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('system', 'staff', 'rider');--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('active', 'released', 'captured');--> statement-breakpoint
CREATE TYPE "public"."journal_kind" AS ENUM('topup', 'ride_charge', 'reservation_fee', 'refund', 'adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('rider_wallet', 'provider_clearing', 'ride_revenue', 'reservation_revenue', 'refunds', 'adjustments');--> statement-breakpoint
CREATE TYPE "public"."payment_event_source" AS ENUM('webhook', 'verify', 'redirect', 'reconcile');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('chapa', 'fake');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('initiated', 'pending', 'succeeded', 'failed', 'expired', 'review');--> statement-breakpoint
CREATE TYPE "public"."refund_destination" AS ENUM('wallet', 'original_payment');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'approved', 'rejected', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."alert_kind" AS ENUM('low_battery', 'device_offline', 'stale_telemetry', 'outside_service_area', 'command_timeout', 'max_ride_duration', 'low_balance', 'invalid_telemetry');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."incident_kind" AS ENUM('late_unlock_ack', 'unlock_failed', 'completion_timeout', 'completion_nack', 'telemetry_mismatch', 'parking_dispute', 'damage_report', 'billing_dispute', 'safety_report', 'other');--> statement-breakpoint
CREATE TYPE "public"."incident_resolution" AS ENUM('completed_confirmed', 'completed_adjusted', 'cancelled_no_charge', 'no_action', 'other');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'in_progress', 'resolved');--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"rider_id" uuid,
	"staff_id" uuid,
	"client" "session_client" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_subject" CHECK (("auth_sessions"."subject_type" = 'rider' and "auth_sessions"."rider_id" is not null and "auth_sessions"."staff_id" is null)
        or ("auth_sessions"."subject_type" = 'staff' and "auth_sessions"."staff_id" is not null and "auth_sessions"."rider_id" is null))
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"channel" "otp_channel" NOT NULL,
	"destination" text NOT NULL,
	"rider_id" uuid,
	"staff_id" uuid,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"provider" text NOT NULL,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenges_attempts" CHECK ("otp_challenges"."attempts" >= 0 and "otp_challenges"."attempts" <= "otp_challenges"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "rider_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"value" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_contacts_value_format" CHECK (("rider_contacts"."kind" = 'email' and "rider_contacts"."value" = lower("rider_contacts"."value") and "rider_contacts"."value" like '%_@_%')
        or ("rider_contacts"."kind" = 'phone' and "rider_contacts"."value" ~ '^\+[1-9][0-9]{7,14}$'))
);
--> statement-breakpoint
CREATE TABLE "riders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"status" "rider_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"age_attested_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_key" text NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_key_permission_key_pk" PRIMARY KEY("role_key","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "token_kind" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"staff_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"granted_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_roles_staff_id_role_key_pk" PRIMARY KEY("staff_id","role_key")
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"created_by_staff_id" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_email_lower" CHECK ("staff_users"."email" = lower("staff_users"."email") and "staff_users"."email" like '%_@_%')
);
--> statement-breakpoint
CREATE TABLE "device_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"scooter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone,
	"assigned_by_staff_id" uuid
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_device_id" text NOT NULL,
	"adapter" "device_adapter" NOT NULL,
	"is_simulated" boolean NOT NULL,
	"firmware_version" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_simulated_matches_adapter" CHECK ("devices"."is_simulated" = ("devices"."adapter" = 'simulated'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scooter_id" uuid NOT NULL,
	"kind" "maintenance_kind" NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_by_staff_id" uuid,
	"assigned_to_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scooters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"qr_token" text NOT NULL,
	"model" text,
	"status" "scooter_status" DEFAULT 'maintenance' NOT NULL,
	"battery_percent" smallint,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_location_at" timestamp with time zone,
	"last_telemetry_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scooters_code_format" CHECK ("scooters"."code" ~ '^[A-Z0-9-]{3,16}$'),
	CONSTRAINT "scooters_battery_range" CHECK ("scooters"."battery_percent" is null or ("scooters"."battery_percent" between 0 and 100)),
	CONSTRAINT "scooters_lat_range" CHECK ("scooters"."last_lat" is null or ("scooters"."last_lat" between -90 and 90)),
	CONSTRAINT "scooters_lng_range" CHECK ("scooters"."last_lng" is null or ("scooters"."last_lng" between -180 and 180)),
	CONSTRAINT "scooters_location_pair" CHECK (("scooters"."last_lat" is null) = ("scooters"."last_lng" is null))
);
--> statement-breakpoint
CREATE TABLE "device_telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"battery_percent" smallint,
	"speed_kmh" double precision,
	"locked" boolean,
	"valid" boolean NOT NULL,
	"invalid_reason" text,
	"is_simulated" boolean NOT NULL,
	"raw" jsonb,
	CONSTRAINT "device_telemetry_lat" CHECK ("device_telemetry"."lat" is null or ("device_telemetry"."lat" between -90 and 90)),
	CONSTRAINT "device_telemetry_lng" CHECK ("device_telemetry"."lng" is null or ("device_telemetry"."lng" between -180 and 180)),
	CONSTRAINT "device_telemetry_battery" CHECK ("device_telemetry"."battery_percent" is null or ("device_telemetry"."battery_percent" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "zone_kind" NOT NULL,
	"geometry" jsonb NOT NULL,
	"min_lat" double precision NOT NULL,
	"min_lng" double precision NOT NULL,
	"max_lat" double precision NOT NULL,
	"max_lng" double precision NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_dev_fixture" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zones_bbox_order" CHECK ("zones"."min_lat" <= "zones"."max_lat" and "zones"."min_lng" <= "zones"."max_lng"),
	CONSTRAINT "zones_min_lat" CHECK ("zones"."min_lat" is null or ("zones"."min_lat" between -90 and 90)),
	CONSTRAINT "zones_max_lat" CHECK ("zones"."max_lat" is null or ("zones"."max_lat" between -90 and 90)),
	CONSTRAINT "zones_min_lng" CHECK ("zones"."min_lng" is null or ("zones"."min_lng" between -180 and 180)),
	CONSTRAINT "zones_max_lng" CHECK ("zones"."max_lng" is null or ("zones"."max_lng" between -180 and 180))
);
--> statement-breakpoint
CREATE TABLE "device_command_acks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"outcome" "ack_outcome" NOT NULL,
	"late" boolean NOT NULL,
	"duplicate" boolean NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"ride_id" uuid,
	"type" "command_type" NOT NULL,
	"status" "command_status" DEFAULT 'queued' NOT NULL,
	"issued_by" "command_issuer" NOT NULL,
	"issued_by_staff_id" uuid,
	"reason" text,
	"is_simulated" boolean NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"result_code" text,
	"result_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "pricing_status" DEFAULT 'draft' NOT NULL,
	"is_dev_fixture" boolean DEFAULT false NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"unlock_fee_santim" bigint NOT NULL,
	"per_minute_santim" bigint NOT NULL,
	"billing_increment_seconds" integer NOT NULL,
	"pause_per_minute_santim" bigint,
	"max_pause_minutes" integer,
	"min_start_balance_santim" bigint NOT NULL,
	"hold_amount_santim" bigint DEFAULT 0 NOT NULL,
	"reservation_minutes" integer,
	"reservation_fee_santim" bigint,
	"max_ride_minutes" integer,
	"low_balance_floor_santim" bigint DEFAULT 0 NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_plans_currency" CHECK ("pricing_plans"."currency" = 'ETB'),
	CONSTRAINT "pricing_plans_amounts" CHECK ("pricing_plans"."unlock_fee_santim" >= 0 and "pricing_plans"."per_minute_santim" >= 0 and "pricing_plans"."min_start_balance_santim" >= 0
        and "pricing_plans"."hold_amount_santim" >= 0 and coalesce("pricing_plans"."pause_per_minute_santim", 0) >= 0
        and coalesce("pricing_plans"."reservation_fee_santim", 0) >= 0 and "pricing_plans"."low_balance_floor_santim" <= 0),
	CONSTRAINT "pricing_plans_increment" CHECK ("pricing_plans"."billing_increment_seconds" between 1 and 3600),
	CONSTRAINT "pricing_plans_durations" CHECK (coalesce("pricing_plans"."reservation_minutes", 1) > 0 and coalesce("pricing_plans"."max_ride_minutes", 1) > 0
        and coalesce("pricing_plans"."max_pause_minutes", 1) > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"scooter_id" uuid NOT NULL,
	"pricing_plan_id" uuid NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ride_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" uuid NOT NULL,
	"from_status" "ride_status",
	"to_status" "ride_status" NOT NULL,
	"cause" "event_cause" NOT NULL,
	"actor_staff_id" uuid,
	"device_command_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"scooter_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"reservation_id" uuid,
	"pricing_plan_id" uuid NOT NULL,
	"pricing_snapshot" jsonb NOT NULL,
	"status" "ride_status" DEFAULT 'start_requested' NOT NULL,
	"is_simulated" boolean NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlock_confirmed_at" timestamp with time zone,
	"end_requested_at" timestamp with time zone,
	"end_request_lat" double precision,
	"end_request_lng" double precision,
	"completion_confirmed_at" timestamp with time zone,
	"completion_source" "completion_source",
	"billing_cutoff_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"paused_seconds" integer DEFAULT 0 NOT NULL,
	"paused_since" timestamp with time zone,
	"parking_status" "parking_status" DEFAULT 'not_checked' NOT NULL,
	"fare_santim" bigint,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"failure_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rides_currency" CHECK ("rides"."currency" = 'ETB'),
	CONSTRAINT "rides_fare_nonnegative" CHECK ("rides"."fare_santim" is null or "rides"."fare_santim" >= 0),
	CONSTRAINT "rides_paused_seconds" CHECK ("rides"."paused_seconds" >= 0),
	CONSTRAINT "rides_end_lat" CHECK ("rides"."end_request_lat" is null or ("rides"."end_request_lat" between -90 and 90)),
	CONSTRAINT "rides_end_lng" CHECK ("rides"."end_request_lng" is null or ("rides"."end_request_lng" between -180 and 180)),
	CONSTRAINT "rides_completed_fields" CHECK ("rides"."status" <> 'completed' or ("rides"."completed_at" is not null and "rides"."fare_santim" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "journal_kind" NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"description" text NOT NULL,
	"reverses_journal_id" uuid,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"rider_id" uuid,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_id_currency_uq" UNIQUE("id","currency"),
	CONSTRAINT "ledger_accounts_currency" CHECK ("ledger_accounts"."currency" = 'ETB'),
	CONSTRAINT "ledger_accounts_owner" CHECK (("ledger_accounts"."type" = 'rider_wallet') = ("ledger_accounts"."rider_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "ledger_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_santim" bigint NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_lines_nonzero" CHECK ("ledger_lines"."amount_santim" <> 0),
	CONSTRAINT "ledger_lines_currency" CHECK ("ledger_lines"."currency" = 'ETB')
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"tx_ref" text NOT NULL,
	"amount_santim" bigint NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"status" "payment_status" DEFAULT 'initiated' NOT NULL,
	"provider_reference" text,
	"checkout_url" text,
	"verified_at" timestamp with time zone,
	"verified_amount_santim" bigint,
	"verified_currency" text,
	"journal_id" uuid,
	"failure_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_min_topup" CHECK ("payment_attempts"."amount_santim" >= 50000),
	CONSTRAINT "payment_attempts_currency" CHECK ("payment_attempts"."currency" = 'ETB'),
	CONSTRAINT "payment_attempts_success_credited" CHECK ("payment_attempts"."status" <> 'succeeded' or ("payment_attempts"."journal_id" is not null and "payment_attempts"."verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payment_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"source" "payment_event_source" NOT NULL,
	"dedupe_key" text,
	"signature_valid" boolean,
	"payload" jsonb NOT NULL,
	"outcome" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"payment_id" uuid,
	"ride_id" uuid,
	"amount_santim" bigint NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"destination" "refund_destination" NOT NULL,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"reason" text NOT NULL,
	"requested_by_type" "actor_type" NOT NULL,
	"requested_by_staff_id" uuid,
	"decided_by_staff_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"journal_id" uuid,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_positive" CHECK ("refunds"."amount_santim" > 0),
	CONSTRAINT "refunds_reason" CHECK (length(trim("refunds"."reason")) >= 3),
	CONSTRAINT "refunds_currency" CHECK ("refunds"."currency" = 'ETB')
);
--> statement-breakpoint
CREATE TABLE "wallet_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"amount_santim" bigint NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"reason" text NOT NULL,
	"staff_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_adjustments_nonzero" CHECK ("wallet_adjustments"."amount_santim" <> 0),
	CONSTRAINT "wallet_adjustments_reason" CHECK (length(trim("wallet_adjustments"."reason")) >= 3),
	CONSTRAINT "wallet_adjustments_currency" CHECK ("wallet_adjustments"."currency" = 'ETB')
);
--> statement-breakpoint
CREATE TABLE "wallet_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"ride_id" uuid,
	"reservation_id" uuid,
	"amount_santim" bigint NOT NULL,
	"currency" char(3) DEFAULT 'ETB' NOT NULL,
	"status" "hold_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "wallet_holds_positive" CHECK ("wallet_holds"."amount_santim" > 0),
	CONSTRAINT "wallet_holds_currency" CHECK ("wallet_holds"."currency" = 'ETB')
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_staff_id" uuid,
	"actor_rider_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"subject_key" text NOT NULL,
	"endpoint" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_subject_key_endpoint_key_pk" PRIMARY KEY("subject_key","endpoint","key")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "incident_kind" NOT NULL,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"ride_id" uuid,
	"scooter_id" uuid,
	"device_id" uuid,
	"rider_id" uuid,
	"reported_by_type" "actor_type" NOT NULL,
	"description" text NOT NULL,
	"assigned_staff_id" uuid,
	"resolution" "incident_resolution",
	"resolution_note" text,
	"resolved_by_staff_id" uuid,
	"resolved_at" timestamp with time zone,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"scooter_id" uuid,
	"device_id" uuid,
	"ride_id" uuid,
	"dedupe_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_contacts" ADD CONSTRAINT "rider_contacts_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_granted_by_staff_id_staff_users_id_fk" FOREIGN KEY ("granted_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_scooter_id_scooters_id_fk" FOREIGN KEY ("scooter_id") REFERENCES "public"."scooters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_assigned_by_staff_id_staff_users_id_fk" FOREIGN KEY ("assigned_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_scooter_id_scooters_id_fk" FOREIGN KEY ("scooter_id") REFERENCES "public"."scooters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_assigned_to_staff_id_staff_users_id_fk" FOREIGN KEY ("assigned_to_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_telemetry" ADD CONSTRAINT "device_telemetry_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_command_acks" ADD CONSTRAINT "device_command_acks_command_id_device_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."device_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_issued_by_staff_id_staff_users_id_fk" FOREIGN KEY ("issued_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_plans" ADD CONSTRAINT "pricing_plans_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_scooter_id_scooters_id_fk" FOREIGN KEY ("scooter_id") REFERENCES "public"."scooters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_pricing_plan_id_pricing_plans_id_fk" FOREIGN KEY ("pricing_plan_id") REFERENCES "public"."pricing_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_events" ADD CONSTRAINT "ride_events_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_events" ADD CONSTRAINT "ride_events_actor_staff_id_staff_users_id_fk" FOREIGN KEY ("actor_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_scooter_id_scooters_id_fk" FOREIGN KEY ("scooter_id") REFERENCES "public"."scooters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_pricing_plan_id_pricing_plans_id_fk" FOREIGN KEY ("pricing_plan_id") REFERENCES "public"."pricing_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_fk" FOREIGN KEY ("reverses_journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_journal_id_journal_entries_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_account_currency_fk" FOREIGN KEY ("account_id","currency") REFERENCES "public"."ledger_accounts"("id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_journal_id_journal_entries_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payment_attempts_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payment_attempts_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_staff_id_staff_users_id_fk" FOREIGN KEY ("requested_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_decided_by_staff_id_staff_users_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_journal_id_journal_entries_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_journal_id_journal_entries_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_staff_id_staff_users_id_fk" FOREIGN KEY ("actor_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_rider_id_riders_id_fk" FOREIGN KEY ("actor_rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_scooter_id_scooters_id_fk" FOREIGN KEY ("scooter_id") REFERENCES "public"."scooters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assigned_staff_id_staff_users_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_staff_id_staff_users_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_scooter_id_scooters_id_fk" FOREIGN KEY ("scooter_id") REFERENCES "public"."scooters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_acknowledged_by_staff_id_staff_users_id_fk" FOREIGN KEY ("acknowledged_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_rider_idx" ON "auth_sessions" USING btree ("rider_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_staff_idx" ON "auth_sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_destination_idx" ON "otp_challenges" USING btree ("destination","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_window_idx" ON "rate_limit_buckets" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "rider_contacts_kind_value_uq" ON "rider_contacts" USING btree ("kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "rider_contacts_rider_kind_uq" ON "rider_contacts" USING btree ("rider_id","kind");--> statement-breakpoint
CREATE INDEX "session_tokens_session_idx" ON "session_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_uq" ON "staff_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "device_assignments_active_device_uq" ON "device_assignments" USING btree ("device_id") WHERE "device_assignments"."unassigned_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_assignments_active_scooter_uq" ON "device_assignments" USING btree ("scooter_id") WHERE "device_assignments"."unassigned_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_supplier_id_uq" ON "devices" USING btree ("supplier_device_id");--> statement-breakpoint
CREATE INDEX "maintenance_records_scooter_idx" ON "maintenance_records" USING btree ("scooter_id","created_at");--> statement-breakpoint
CREATE INDEX "maintenance_records_open_idx" ON "maintenance_records" USING btree ("assigned_to_staff_id") WHERE "maintenance_records"."status" in ('open','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "scooters_code_uq" ON "scooters" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "scooters_qr_token_uq" ON "scooters" USING btree ("qr_token");--> statement-breakpoint
CREATE INDEX "scooters_status_idx" ON "scooters" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scooters_location_idx" ON "scooters" USING btree ("last_lat","last_lng");--> statement-breakpoint
CREATE INDEX "device_telemetry_device_time_idx" ON "device_telemetry" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "zones_active_bbox_idx" ON "zones" USING btree ("min_lat","max_lat","min_lng","max_lng") WHERE "zones"."active";--> statement-breakpoint
CREATE INDEX "device_command_acks_command_idx" ON "device_command_acks" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "device_commands_pending_idx" ON "device_commands" USING btree ("deadline_at") WHERE "device_commands"."status" in ('queued','sent');--> statement-breakpoint
CREATE INDEX "device_commands_device_idx" ON "device_commands" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "device_commands_ride_idx" ON "device_commands" USING btree ("ride_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_plans_single_active_uq" ON "pricing_plans" USING btree ("status") WHERE "pricing_plans"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_rider_uq" ON "reservations" USING btree ("rider_id") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_scooter_uq" ON "reservations" USING btree ("scooter_id") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "reservations" USING btree ("expires_at") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ride_events_ride_idx" ON "ride_events" USING btree ("ride_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "rides_open_rider_uq" ON "rides" USING btree ("rider_id") WHERE "rides"."status" not in ('completed', 'start_failed');--> statement-breakpoint
CREATE UNIQUE INDEX "rides_open_scooter_uq" ON "rides" USING btree ("scooter_id") WHERE "rides"."status" not in ('completed', 'start_failed');--> statement-breakpoint
CREATE INDEX "rides_rider_history_idx" ON "rides" USING btree ("rider_id","requested_at");--> statement-breakpoint
CREATE INDEX "rides_status_idx" ON "rides" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reference_uq" ON "journal_entries" USING btree ("reference_type","reference_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_rider_uq" ON "ledger_accounts" USING btree ("rider_id") WHERE "ledger_accounts"."type" = 'rider_wallet';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_system_uq" ON "ledger_accounts" USING btree ("type","currency") WHERE "ledger_accounts"."rider_id" is null;--> statement-breakpoint
CREATE INDEX "ledger_lines_account_idx" ON "ledger_lines" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "ledger_lines_journal_idx" ON "ledger_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_tx_ref_uq" ON "payment_attempts" USING btree ("tx_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_journal_uq" ON "payment_attempts" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_rider_idx" ON "payment_attempts" USING btree ("rider_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_open_idx" ON "payment_attempts" USING btree ("created_at") WHERE "payment_attempts"."status" in ('initiated','pending');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_dedupe_uq" ON "payment_events" USING btree ("provider","dedupe_key") WHERE "payment_events"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wallet_holds_active_idx" ON "wallet_holds" USING btree ("rider_id") WHERE "wallet_holds"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_holds_active_ride_uq" ON "wallet_holds" USING btree ("ride_id") WHERE "wallet_holds"."status" = 'active';--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_staff_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_time_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "incidents_open_idx" ON "incidents" USING btree ("created_at") WHERE "incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "incidents_ride_idx" ON "incidents" USING btree ("ride_id");--> statement-breakpoint
CREATE INDEX "incidents_rider_idx" ON "incidents" USING btree ("rider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_alerts_open_dedupe_uq" ON "operational_alerts" USING btree ("dedupe_key") WHERE "operational_alerts"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "operational_alerts_open_idx" ON "operational_alerts" USING btree ("severity","created_at") WHERE "operational_alerts"."status" <> 'resolved';