# Prisma Migration Pipeline

## Core Tables
This migration creates:
- `videos`
- `jobs`
- `transcript_segments`
- `highlight_candidates`
- `face_tracks`
- `clips`

Extended in follow-up migration:
- ingest/probe lifecycle columns on `videos`
- ffprobe debug/technical columns on `videos`
- retry/lock/dedup columns on `jobs`
- BYOK (bring your own key) support for Groq Whisper via `api_credentials`
- STT provider/model traceability fields in `jobs` and `transcript_segments`

## Indexing Strategy
Applied indexes:
- `jobs(status, priority, queued_at)`
- `jobs(video_id)`
- `transcript_segments(video_id, start_ms)`
- `highlight_candidates(video_id, score_total DESC)`
- `face_tracks(video_id, start_ms, end_ms)`
- `clips(video_id, created_at DESC)`
- `videos(ingest_status, created_at)`
- `videos(probe_status, next_retry_at)`
- `api_credentials(owner_ref, provider)`
- `jobs(job_type, stt_provider, created_at)`
- uniques on `videos.sha256`, `videos.storage_key`
- unique on `jobs.dedupe_key`
- unique on `api_credentials(owner_ref, provider, key_fingerprint)`

## Groq Whisper Notes
- For timestamp output, use `response_format="verbose_json"` with `timestamp_granularities` (`segment`, `word`, or both).
- Recommended job metadata storage:
   - `jobs.stt_provider = groq`
   - `jobs.stt_model` (example: `whisper-large-v3-turbo`)
   - `jobs.provider_request_id` from provider response headers/body when available
- Never store plaintext API keys; store encrypted value in `api_credentials.encrypted_api_key` and only keep fingerprint in `key_fingerprint`.

## Command Pipeline
1. Install dependencies:
   - `npm install`
2. Generate client:
   - `npm run prisma:generate`
3. Apply migrations in development:
   - `npm run prisma:migrate:dev`
4. Apply migrations in deployment/CI:
   - `npm run prisma:migrate:deploy`
5. Check migration state:
   - `npm run prisma:migrate:status`

## Environment
Set `DATABASE_URL` in `.env`:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/clipper_web?schema=public"
```
