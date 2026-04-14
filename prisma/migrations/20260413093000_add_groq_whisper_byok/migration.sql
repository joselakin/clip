DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SttProvider') THEN
    CREATE TYPE "SttProvider" AS ENUM ('groq');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CredentialMode') THEN
    CREATE TYPE "CredentialMode" AS ENUM ('user_supplied', 'system_managed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "api_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "SttProvider" NOT NULL,
  "owner_ref" TEXT NOT NULL,
  "encrypted_api_key" TEXT NOT NULL,
  "key_fingerprint" CHAR(16) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "last_used_at" TIMESTAMPTZ(6),
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_credentials_owner_ref_provider_key_fingerprint_key'
  ) THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_owner_ref_provider_key_fingerprint_key"
      UNIQUE ("owner_ref", "provider", "key_fingerprint");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "api_credentials_owner_ref_provider_idx"
  ON "api_credentials" ("owner_ref", "provider");

ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "stt_provider" "SttProvider",
  ADD COLUMN IF NOT EXISTS "stt_model" TEXT,
  ADD COLUMN IF NOT EXISTS "credential_mode" "CredentialMode",
  ADD COLUMN IF NOT EXISTS "credential_fingerprint" CHAR(16),
  ADD COLUMN IF NOT EXISTS "credential_id" UUID,
  ADD COLUMN IF NOT EXISTS "provider_request_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_credential_id_fkey'
  ) THEN
    ALTER TABLE "jobs"
      ADD CONSTRAINT "jobs_credential_id_fkey"
      FOREIGN KEY ("credential_id") REFERENCES "api_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "jobs_job_type_stt_provider_created_at_idx"
  ON "jobs" ("job_type", "stt_provider", "created_at");

ALTER TABLE "transcript_segments"
  ADD COLUMN IF NOT EXISTS "stt_provider" "SttProvider",
  ADD COLUMN IF NOT EXISTS "stt_model" TEXT,
  ADD COLUMN IF NOT EXISTS "segment_raw" JSONB;
