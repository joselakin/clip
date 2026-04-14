DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IngestStatus') THEN
    CREATE TYPE "IngestStatus" AS ENUM ('uploaded', 'probing', 'ready', 'failed');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProbeStatus') THEN
    CREATE TYPE "ProbeStatus" AS ENUM ('pending', 'processing', 'done', 'failed');
  END IF;
END $$;

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROBE';

ALTER TABLE "videos"
  RENAME COLUMN "audio_sample_rate" TO "sample_rate";

ALTER TABLE "videos"
  ADD COLUMN "mime_type" TEXT,
  ADD COLUMN "size_bytes" BIGINT,
  ADD COLUMN "ingest_status" "IngestStatus" NOT NULL DEFAULT 'uploaded',
  ADD COLUMN "probe_status" "ProbeStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "probe_error" TEXT,
  ADD COLUMN "probed_at" TIMESTAMPTZ(6),
  ADD COLUMN "next_retry_at" TIMESTAMPTZ(6),
  ADD COLUMN "rotation" INTEGER,
  ADD COLUMN "video_codec" TEXT,
  ADD COLUMN "audio_codec" TEXT,
  ADD COLUMN "bitrate_kbps" INTEGER,
  ADD COLUMN "channels" INTEGER,
  ADD COLUMN "probe_raw_json" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "jobs"
  RENAME COLUMN "idempotency_key" TO "dedupe_key";

ALTER TABLE "jobs"
  ADD COLUMN "next_retry_at" TIMESTAMPTZ(6),
  ADD COLUMN "locked_by" TEXT,
  ADD COLUMN "locked_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_error" TEXT;

ALTER TABLE "jobs"
  DROP CONSTRAINT IF EXISTS "jobs_idempotency_key_key";

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_dedupe_key_key" UNIQUE ("dedupe_key");

CREATE INDEX "videos_ingest_status_created_at_idx"
  ON "videos" ("ingest_status", "created_at");

CREATE INDEX "videos_probe_status_next_retry_at_idx"
  ON "videos" ("probe_status", "next_retry_at");

CREATE INDEX "jobs_video_id_idx"
  ON "jobs" ("video_id");
