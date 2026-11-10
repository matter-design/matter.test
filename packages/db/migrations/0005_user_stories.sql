CREATE TABLE "user_stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"actor" text NOT NULL,
	"want" text NOT NULL,
	"so_that" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requirement_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" text NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"critical_why" text,
	"position" integer DEFAULT 0 NOT NULL,
	"review_state" text DEFAULT 'needs-review' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "story_id" uuid;--> statement-breakpoint
ALTER TABLE "user_stories" ADD CONSTRAINT "user_stories_plan_id_test_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."test_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_story_id_user_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."user_stories"("id") ON DELETE set null ON UPDATE no action;