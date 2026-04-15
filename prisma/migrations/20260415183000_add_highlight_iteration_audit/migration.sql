CREATE TABLE "highlight_selection_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "video_id" UUID NOT NULL,
    "job_id" UUID,
    "pipeline_version" VARCHAR(40) NOT NULL,
    "pipeline_mode" VARCHAR(20) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'running',
    "clip_count_target" INTEGER NOT NULL,
    "duration_preset" VARCHAR(40) NOT NULL,
    "max_iterations" INTEGER NOT NULL,
    "executed_iterations" INTEGER NOT NULL DEFAULT 0,
    "seed_candidate_count" INTEGER NOT NULL DEFAULT 0,
    "pass_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "degraded_quality_fill" BOOLEAN NOT NULL DEFAULT FALSE,
    "token_usage_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "notes_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "latency_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "highlight_selection_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "highlight_candidate_reviews" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "highlight_candidate_id" BIGINT,
    "iteration" INTEGER NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "topic" TEXT,
    "overall_score" INTEGER NOT NULL,
    "hook_score" INTEGER NOT NULL,
    "value_score" INTEGER NOT NULL,
    "clarity_score" INTEGER NOT NULL,
    "emotion_score" INTEGER NOT NULL,
    "novelty_score" INTEGER NOT NULL,
    "shareability_score" INTEGER NOT NULL,
    "is_pass" BOOLEAN NOT NULL DEFAULT FALSE,
    "failure_reasons_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "fix_guidance" TEXT,
    "model_name" TEXT,
    "raw_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "highlight_candidate_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "highlight_candidate_reviews_start_end_check" CHECK ("start_ms" < "end_ms")
);

ALTER TABLE "highlight_selection_runs"
  ADD CONSTRAINT "highlight_selection_runs_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "highlight_selection_runs"
  ADD CONSTRAINT "highlight_selection_runs_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "highlight_candidate_reviews"
  ADD CONSTRAINT "highlight_candidate_reviews_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "highlight_selection_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "highlight_candidate_reviews"
  ADD CONSTRAINT "highlight_candidate_reviews_highlight_candidate_id_fkey"
  FOREIGN KEY ("highlight_candidate_id") REFERENCES "highlight_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "highlight_selection_runs_video_id_created_at_idx"
  ON "highlight_selection_runs" ("video_id", "created_at");

CREATE INDEX "highlight_selection_runs_job_id_idx"
  ON "highlight_selection_runs" ("job_id");

CREATE INDEX "highlight_selection_runs_status_created_at_idx"
  ON "highlight_selection_runs" ("status", "created_at");

CREATE INDEX "highlight_candidate_reviews_run_id_iteration_idx"
  ON "highlight_candidate_reviews" ("run_id", "iteration");

CREATE INDEX "highlight_candidate_reviews_run_id_action_idx"
  ON "highlight_candidate_reviews" ("run_id", "action");

CREATE INDEX "highlight_candidate_reviews_highlight_candidate_id_idx"
  ON "highlight_candidate_reviews" ("highlight_candidate_id");
