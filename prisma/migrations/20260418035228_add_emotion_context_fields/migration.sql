-- CreateEnum
CREATE TYPE "EmotionContext" AS ENUM ('general', 'sadness', 'anger', 'tenderness', 'anxiety', 'joy', 'nostalgia', 'motivation', 'disappointment');

-- DropIndex
DROP INDEX "clips_video_id_created_at_desc_idx";

-- DropIndex
DROP INDEX "highlight_candidates_video_id_score_total_desc_idx";

-- AlterTable
ALTER TABLE "api_credentials" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "clips" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "highlight_candidates" ADD COLUMN     "emotion_fallback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emotion_fit_reason" TEXT,
ADD COLUMN     "emotion_fit_score" INTEGER,
ADD COLUMN     "matched_emotion_context" "EmotionContext",
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "highlight_selection_runs" ADD COLUMN     "requested_emotion_context" "EmotionContext" NOT NULL DEFAULT 'general',
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "jobs" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "videos" ADD COLUMN     "requested_emotion_context" "EmotionContext" NOT NULL DEFAULT 'general',
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "clips_video_id_created_at_idx" ON "clips"("video_id", "created_at");

-- CreateIndex
CREATE INDEX "highlight_candidates_video_id_score_total_idx" ON "highlight_candidates"("video_id", "score_total");
