CREATE TYPE "public"."memory_evidence_relation" AS ENUM('supports', 'contradicts', 'updates');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('semantic', 'procedural');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('candidate', 'active', 'disputed', 'superseded', 'archived');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"domain" varchar(100) NOT NULL,
	"repository" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"title" varchar(240) NOT NULL,
	"summary" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "memory_status" DEFAULT 'candidate' NOT NULL,
	"confidence" varchar(16),
	"authority" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_application_items" (
	"application_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "memory_application_items_application_id_memory_id_pk" PRIMARY KEY("application_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"domain" varchar(100) NOT NULL,
	"repository" text NOT NULL,
	"analysis_id" varchar(255) NOT NULL,
	"result_summary" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"repository" text NOT NULL,
	"source_type" varchar(60) NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"source_url" text,
	"event_type" varchar(100) NOT NULL,
	"actor_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_evidence" (
	"memory_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"relation" "memory_evidence_relation" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_evidence_memory_id_event_id_relation_pk" PRIMARY KEY("memory_id","event_id","relation")
);
--> statement-breakpoint
ALTER TABLE "memory_application_items" ADD CONSTRAINT "memory_application_items_application_id_memory_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."memory_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_application_items" ADD CONSTRAINT "memory_application_items_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_event_id_memory_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_repository_status" ON "memories" USING btree ("tenant_id","repository","status");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_applications_analysis_identity" ON "memory_applications" USING btree ("tenant_id","repository","analysis_id");--> statement-breakpoint
CREATE INDEX "memory_applications_repository_timeline" ON "memory_applications" USING btree ("tenant_id","repository","applied_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_source_identity" ON "memory_events" USING btree ("tenant_id","repository","source_type","source_id");--> statement-breakpoint
CREATE INDEX "memory_events_repository_timeline" ON "memory_events" USING btree ("tenant_id","repository","occurred_at");