CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "JobType" AS ENUM ('TRANSCRIBE', 'FACE_TRACK', 'HIGHLIGHT', 'RENDER_CLIP', 'FULL_PIPELINE');
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'success', 'failed', 'cancelled');
CREATE TYPE "SubtitleMode" AS ENUM ('none', 'soft', 'hard');
CREATE TYPE "ClipStatus" AS ENUM ('rendering', 'ready', 'failed');

CREATE TABLE "videos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_type" TEXT NOT NULL,
    "source_url" TEXT,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT,
    "sha256" CHAR(64) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "fps" DECIMAL(6,3),
    "width" INTEGER,
    "height" INTEGER,
    "audio_sample_rate" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "videos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "videos_source_type_check" CHECK ("source_type" IN ('upload', 'url', 'import'))
);

CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "video_id" UUID NOT NULL,
    "job_type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL,
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "result" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "error_message" TEXT,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "max_attempts" SMALLINT NOT NULL DEFAULT 3,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "worker_name" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transcript_segments" (
    "id" BIGSERIAL NOT NULL,
    "video_id" UUID NOT NULL,
    "job_id" UUID,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "language" VARCHAR(16),
    "confidence" REAL,
    "speaker_label" TEXT,
    "words_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transcript_segments_start_end_check" CHECK ("start_ms" < "end_ms")
);

CREATE TABLE "highlight_candidates" (
    "id" BIGSERIAL NOT NULL,
    "video_id" UUID NOT NULL,
    "job_id" UUID,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "score_total" DECIMAL(6,4) NOT NULL,
    "score_text" DECIMAL(6,4),
    "score_audio" DECIMAL(6,4),
    "score_visual" DECIMAL(6,4),
    "reason_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "rank_order" INTEGER,
    "is_selected" BOOLEAN NOT NULL DEFAULT FALSE,
    "selected_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "highlight_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "highlight_candidates_start_end_check" CHECK ("start_ms" < "end_ms")
);

CREATE TABLE "face_tracks" (
    "id" BIGSERIAL NOT NULL,
    "video_id" UUID NOT NULL,
    "job_id" UUID,
    "track_id" INTEGER NOT NULL,
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    "avg_confidence" REAL,
    "frame_count" INTEGER NOT NULL DEFAULT 0,
    "trajectory_json" JSONB NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "face_tracks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "clips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "video_id" UUID NOT NULL,
    "highlight_candidate_id" BIGINT,
    "render_job_id" UUID,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "target_aspect" VARCHAR(10) NOT NULL DEFAULT '9:16',
    "output_width" INTEGER NOT NULL,
    "output_height" INTEGER NOT NULL,
    "subtitle_mode" "SubtitleMode" NOT NULL DEFAULT 'none',
    "subtitle_file_key" TEXT,
    "output_file_key" TEXT NOT NULL,
    "thumbnail_key" TEXT,
    "transcript_snapshot" TEXT,
    "status" "ClipStatus" NOT NULL DEFAULT 'rendering',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    CONSTRAINT "clips_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clips_start_end_check" CHECK ("start_ms" < "end_ms")
);

ALTER TABLE "videos"
  ADD CONSTRAINT "videos_storage_key_key" UNIQUE ("storage_key");
ALTER TABLE "videos"
  ADD CONSTRAINT "videos_sha256_key" UNIQUE ("sha256");

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_idempotency_key_key" UNIQUE ("idempotency_key");

ALTER TABLE "face_tracks"
  ADD CONSTRAINT "face_tracks_video_id_track_id_key" UNIQUE ("video_id", "track_id");

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_segments"
  ADD CONSTRAINT "transcript_segments_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transcript_segments"
  ADD CONSTRAINT "transcript_segments_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "highlight_candidates"
  ADD CONSTRAINT "highlight_candidates_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "highlight_candidates"
  ADD CONSTRAINT "highlight_candidates_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "face_tracks"
  ADD CONSTRAINT "face_tracks_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "face_tracks"
  ADD CONSTRAINT "face_tracks_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "clips"
  ADD CONSTRAINT "clips_video_id_fkey"
  FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clips"
  ADD CONSTRAINT "clips_highlight_candidate_id_fkey"
  FOREIGN KEY ("highlight_candidate_id") REFERENCES "highlight_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "clips"
  ADD CONSTRAINT "clips_render_job_id_fkey"
  FOREIGN KEY ("render_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "jobs_status_priority_queued_at_idx" ON "jobs" ("status", "priority", "queued_at");
CREATE INDEX "transcript_segments_video_id_start_ms_idx" ON "transcript_segments" ("video_id", "start_ms");
CREATE INDEX "highlight_candidates_video_id_score_total_desc_idx" ON "highlight_candidates" ("video_id", "score_total" DESC);
CREATE INDEX "face_tracks_video_id_start_ms_end_ms_idx" ON "face_tracks" ("video_id", "start_ms", "end_ms");
CREATE INDEX "clips_video_id_created_at_desc_idx" ON "clips" ("video_id", "created_at" DESC);
