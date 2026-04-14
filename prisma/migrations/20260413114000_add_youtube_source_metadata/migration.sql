ALTER TABLE "videos"
  ADD COLUMN IF NOT EXISTS "source_platform" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "external_video_id" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "source_title" TEXT;

CREATE INDEX IF NOT EXISTS "videos_source_platform_external_video_id_idx"
  ON "videos" ("source_platform", "external_video_id");
