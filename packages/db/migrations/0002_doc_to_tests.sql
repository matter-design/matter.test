CREATE TABLE "client_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid,
	"question" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"source_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "review_state" text DEFAULT 'needs-review' NOT NULL;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD COLUMN "locator" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "file_uri" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "automation_candidate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "source_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_questions" ADD CONSTRAINT "client_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_questions" ADD CONSTRAINT "client_questions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_project_key_idx" ON "requirements" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "source_chunks_source_idx" ON "source_chunks" USING btree ("source_id","position");--> statement-breakpoint
CREATE INDEX "sources_project_idx" ON "sources" USING btree ("project_id");