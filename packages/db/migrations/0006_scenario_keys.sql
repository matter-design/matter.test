ALTER TABLE "scenarios" ADD COLUMN "key" text;--> statement-breakpoint
-- Number the scenarios of every plan still in use (not superseded): SC-001… per project, by plan version then position.
WITH numbered AS (
  SELECT s.id, row_number() OVER (PARTITION BY p.project_id ORDER BY p.version, s.position) AS n
  FROM "scenarios" s JOIN "test_plans" p ON p.id = s.plan_id
  WHERE p.status <> 'superseded'
)
UPDATE "scenarios" s SET "key" = 'SC-' || lpad(numbered.n::text, 3, '0') FROM numbered WHERE numbered.id = s.id;
