import { createLogger } from "@/lib/logger";
import {
  buildCandidateWindowText,
  buildGroqModelsEndpoint,
  clamp,
  extractJsonObject,
  listGroqModels,
  looksLikeModelNotFound,
  resolveHighlightModelCandidates,
  type GroqChatCompletionResponse,
} from "@/lib/groq/shared";

const logger = createLogger("lib/groq/highlights");

export type TranscriptForSelection = {
  startMs: number;
  endMs: number;
  text: string;
};

export type GroqHighlightCandidate = {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  scoreText: number;
  reason: string;
  topic?: string;
};

export type GroqClipEvaluation = {
  startMs: number;
  endMs: number;
  recommendedTitle: string;
  overallScore: number;
  hookScore: number;
  valueScore: number;
  clarityScore: number;
  emotionScore: number;
  shareabilityScore: number;
  whyThisWorks: string;
  improvementTip: string;
  angle?: string;
};

type HighlightSelectionOptions = {
  durationRule?: string;
  extraRules?: string[];
};

function normalizeCandidates(input: unknown): GroqHighlightCandidate[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const record = input as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];

  return candidates
    .map((candidate): GroqHighlightCandidate | null => {
      if (!candidate || typeof candidate !== "object") {
        return null;
      }

      const item = candidate as Record<string, unknown>;
      const startMs = Number(item.startMs);
      const endMs = Number(item.endMs);

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null;
      }

      const scoreTotal = clamp(Number(item.scoreTotal), 0, 1);
      const scoreTextRaw = Number(item.scoreText);
      const scoreText = Number.isFinite(scoreTextRaw) ? clamp(scoreTextRaw, 0, 1) : scoreTotal;
      const reason = typeof item.reason === "string" ? item.reason.trim() : "Selected by AI";
      const topic = typeof item.topic === "string" ? item.topic.trim() : undefined;

      return {
        startMs: Math.max(0, Math.round(startMs)),
        endMs: Math.max(1, Math.round(endMs)),
        scoreTotal,
        scoreText,
        reason,
        topic,
      };
    })
    .filter((item): item is GroqHighlightCandidate => item !== null)
    .sort((a, b) => {
      if (b.scoreTotal !== a.scoreTotal) {
        return b.scoreTotal - a.scoreTotal;
      }
      return a.startMs - b.startMs;
    });
}

function normalizeScore100(value: unknown, fallback = 70): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  if (raw <= 1) {
    return Math.round(clamp(raw, 0, 1) * 100);
  }

  return Math.round(clamp(raw, 0, 100));
}

function normalizeClipEvaluations(input: unknown): GroqClipEvaluation[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const record = input as Record<string, unknown>;
  const evaluations = Array.isArray(record.evaluations) ? record.evaluations : [];

  return evaluations
    .map((row): GroqClipEvaluation | null => {
      if (!row || typeof row !== "object") {
        return null;
      }

      const item = row as Record<string, unknown>;
      const startMs = Number(item.startMs);
      const endMs = Number(item.endMs);

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null;
      }

      const recommendedTitleRaw =
        typeof item.recommendedTitle === "string"
          ? item.recommendedTitle
          : typeof item.title === "string"
            ? item.title
            : "";
      const recommendedTitle = recommendedTitleRaw.trim();
      if (!recommendedTitle) {
        return null;
      }

      const whyThisWorks =
        typeof item.whyThisWorks === "string"
          ? item.whyThisWorks.trim()
          : typeof item.why === "string"
            ? item.why.trim()
            : "Potensi engagement cukup baik untuk short-form.";

      const improvementTip =
        typeof item.improvementTip === "string"
          ? item.improvementTip.trim()
          : typeof item.improvement === "string"
            ? item.improvement.trim()
            : "Perkuat opening 2 detik pertama agar hook lebih tajam.";

      const angle = typeof item.angle === "string" ? item.angle.trim() : undefined;

      return {
        startMs: Math.max(0, Math.round(startMs)),
        endMs: Math.max(1, Math.round(endMs)),
        recommendedTitle,
        overallScore: normalizeScore100(item.overallScore, 75),
        hookScore: normalizeScore100(item.hookScore, 75),
        valueScore: normalizeScore100(item.valueScore, 75),
        clarityScore: normalizeScore100(item.clarityScore, 75),
        emotionScore: normalizeScore100(item.emotionScore, 75),
        shareabilityScore: normalizeScore100(item.shareabilityScore, 75),
        whyThisWorks,
        improvementTip,
        angle,
      };
    })
    .filter((item): item is GroqClipEvaluation => item !== null);
}

export async function selectHighlightsWithGroq(
  transcriptSegments: TranscriptForSelection[],
  apiKey: string,
  options?: HighlightSelectionOptions
) {
  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  logger.info("highlight_request_started", {
    requestedModel,
    endpoint,
    transcriptCount: transcriptSegments.length,
    candidateModels,
  });

  const compactTranscript = transcriptSegments
    .slice(0, 220)
    .map((segment, index) => {
      return `${index + 1}. [${segment.startMs}-${segment.endMs}] ${segment.text}`;
    })
    .join("\n");

  const systemPrompt =
    "Kamu adalah AI editor untuk social media short clips. Pilih segmen dengan potensi engagement tinggi dari transcript. Keluaran HARUS JSON valid tanpa markdown.";

  const userPrompt = [
    "Pilih maksimal 6 kandidat clip dengan aturan:",
    options?.durationRule || "- Durasi target tiap clip 20-45 detik",
    "- Prioritaskan hook kuat, novelty, emosi, value, CTA",
    "- Hindari overlap berat antar kandidat",
    "- Gunakan timestamp yang ada pada transcript",
    ...(options?.extraRules || []),
    "",
    "Format JSON wajib:",
    '{"candidates":[{"startMs":1234,"endMs":34567,"scoreTotal":0.92,"scoreText":0.90,"reason":"...","topic":"..."}] }',
    "",
    "Transcript:",
    compactTranscript,
  ].join("\n");

  let lastError: string | null = null;

  for (const model of candidateModels) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    logger.info("highlight_response_received", { model, status: response.status });

    if (!response.ok) {
      const errorText = await response.text();
      lastError = `Groq highlight selection gagal (${response.status}): ${errorText}`;

      if (looksLikeModelNotFound(response.status, errorText)) {
        logger.warn("highlight_model_unavailable", { model, status: response.status });
        continue;
      }

      logger.error("highlight_request_failed", { model, status: response.status, errorText });
      throw new Error(lastError);
    }

    const json = (await response.json()) as GroqChatCompletionResponse;
    const rawContent = json.choices?.[0]?.message?.content?.trim();

    if (!rawContent) {
      throw new Error("Respons highlight selection kosong");
    }

    const parsed = JSON.parse(extractJsonObject(rawContent)) as unknown;
    const candidates = normalizeCandidates(parsed);

    if (candidates.length === 0) {
      logger.warn("highlight_candidates_empty", { model });
      throw new Error("AI tidak menghasilkan kandidat highlight valid");
    }

    logger.info("highlight_request_completed", { model, candidates: candidates.length });
    return { model, candidates };
  }

  throw new Error(
    lastError ||
      "Groq highlight selection gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}

export async function evaluateClipRecommendationsWithGroq(
  transcriptSegments: TranscriptForSelection[],
  candidates: GroqHighlightCandidate[],
  apiKey: string
) {
  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  const compactCandidates = candidates.slice(0, 6).map((candidate, index) => {
    return {
      index: index + 1,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      currentReason: candidate.reason,
      transcriptWindow: buildCandidateWindowText(
        transcriptSegments,
        candidate.startMs,
        candidate.endMs
      ),
    };
  });

  const systemPrompt = [
    "Kamu adalah Senior Short-Form Content Strategist untuk TikTok/Reels/Shorts.",
    "Tugasmu menilai setiap kandidat clip dan membuat judul rekomendasi yang klik-able tetapi tetap jujur.",
    "Fokus scoring: hook strength, value density, clarity, emotional pull, shareability.",
    "Skor wajib 0-100 bilangan bulat.",
    "Output HARUS JSON valid tanpa markdown, tanpa komentar, tanpa teks tambahan.",
    "Jangan mengubah timestamp kandidat yang diberikan.",
  ].join(" ");

  const userPrompt = [
    "Nilai semua kandidat berikut.",
    "Setiap kandidat harus dikembalikan dalam evaluations.",
    "Format JSON wajib:",
    '{"evaluations":[{"startMs":1234,"endMs":34567,"recommendedTitle":"...","overallScore":90,"hookScore":92,"valueScore":88,"clarityScore":84,"emotionScore":86,"shareabilityScore":89,"whyThisWorks":"...","improvementTip":"...","angle":"..."}]}',
    "Aturan:",
    "- recommendedTitle: 5-12 kata, bahasa Indonesia natural, kuat di hook",
    "- whyThisWorks: 1 kalimat ringkas dan spesifik",
    "- improvementTip: 1 kalimat actionable",
    "- angle: optional, boleh kosong",
    "Candidates:",
    JSON.stringify(compactCandidates),
  ].join("\n");

  let lastError: string | null = null;

  for (const model of candidateModels) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    logger.info("clip_eval_response_received", { model, status: response.status });

    if (!response.ok) {
      const errorText = await response.text();
      lastError = `Groq clip evaluation gagal (${response.status}): ${errorText}`;

      if (looksLikeModelNotFound(response.status, errorText)) {
        logger.warn("clip_eval_model_unavailable", { model, status: response.status });
        continue;
      }

      logger.error("clip_eval_request_failed", { model, status: response.status, errorText });
      throw new Error(lastError);
    }

    const json = (await response.json()) as GroqChatCompletionResponse;
    const rawContent = json.choices?.[0]?.message?.content?.trim();

    if (!rawContent) {
      throw new Error("Respons evaluasi clip kosong");
    }

    const parsed = JSON.parse(extractJsonObject(rawContent)) as unknown;
    const evaluations = normalizeClipEvaluations(parsed);

    if (evaluations.length === 0) {
      throw new Error("AI tidak menghasilkan evaluasi clip yang valid");
    }

    logger.info("clip_eval_request_completed", { model, evaluations: evaluations.length });
    return { model, evaluations };
  }

  throw new Error(
    lastError ||
      "Groq clip evaluation gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}
