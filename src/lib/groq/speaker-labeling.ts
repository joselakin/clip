import { createLogger } from "@/lib/logger";
import {
  buildGroqModelsEndpoint,
  chunkArray,
  extractJsonObject,
  listGroqModels,
  looksLikeModelNotFound,
  normalizeSpeakerLabelToken,
  resolveHighlightModelCandidates,
  type GroqChatCompletionResponse,
} from "@/lib/groq/shared";

const logger = createLogger("lib/groq/speaker-labeling");

export type TranscriptForSpeakerLabeling = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type SpeakerLabeledSegment = {
  id: string;
  speakerLabel: "SPEAKER_1" | "SPEAKER_2" | null;
};

function normalizeSpeakerAssignments(
  input: unknown
): Array<{ index: number; speakerLabel: "SPEAKER_1" | "SPEAKER_2" | null }> {
  if (!input || typeof input !== "object") {
    return [];
  }

  const record = input as Record<string, unknown>;
  const labels = Array.isArray(record.labels) ? record.labels : [];

  return labels
    .map((row) => {
      if (!row || typeof row !== "object") {
        return null;
      }

      const item = row as Record<string, unknown>;
      const index = Number(item.index);
      if (!Number.isFinite(index) || index <= 0) {
        return null;
      }

      return {
        index: Math.round(index),
        speakerLabel: normalizeSpeakerLabelToken(item.speaker),
      };
    })
    .filter(
      (
        row
      ): row is {
        index: number;
        speakerLabel: "SPEAKER_1" | "SPEAKER_2" | null;
      } => row !== null
    );
}

export async function labelTwoSpeakerSegmentsWithGroq(
  transcriptSegments: TranscriptForSpeakerLabeling[],
  apiKey: string
) {
  if (transcriptSegments.length === 0) {
    return {
      model: "none",
      segments: [] as SpeakerLabeledSegment[],
    };
  }

  const requestedModel =
    process.env.GROQ_SPEAKER_MODEL?.trim() ||
    process.env.GROQ_HIGHLIGHT_MODEL?.trim() ||
    "openai/gpt-oss-20b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);
  const chunkSizeRaw = Number(process.env.GROQ_SPEAKER_CHUNK_SEGMENTS || "80");
  const chunkSize = Number.isFinite(chunkSizeRaw)
    ? Math.max(25, Math.min(140, Math.floor(chunkSizeRaw)))
    : 80;

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  const sourceRows = transcriptSegments.map((segment, index) => ({
    index: index + 1,
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text.replace(/\s+/g, " ").trim().slice(0, 180),
  }));
  const chunks = chunkArray(sourceRows, chunkSize);

  logger.info("speaker_labeling_started", {
    requestedModel,
    endpoint,
    segmentCount: transcriptSegments.length,
    chunkSize,
    chunks: chunks.length,
    candidateModels,
  });

  const systemPrompt = [
    "Kamu adalah asisten diarization ringan untuk podcast 2 pembicara.",
    "Label tiap segmen ke SPEAKER_1 atau SPEAKER_2 jika yakin.",
    "Jika tidak yakin, isi speaker dengan UNKNOWN.",
    "Jaga konsistensi label: orang yang sama harus tetap label yang sama di seluruh chunk.",
    "Output HARUS JSON valid tanpa markdown.",
  ].join(" ");

  let lastError: string | null = null;

  for (const model of candidateModels) {
    try {
      const labelsByIndex = new Map<number, "SPEAKER_1" | "SPEAKER_2" | null>();

      for (const chunk of chunks) {
        const userPrompt = [
          "Berikan label speaker untuk setiap item berikut.",
          "Format JSON wajib:",
          '{"labels":[{"index":1,"speaker":"SPEAKER_1|SPEAKER_2|UNKNOWN"}]}',
          "Pastikan semua index dari input muncul di output.",
          "Data:",
          JSON.stringify(
            chunk.map((row) => ({
              index: row.index,
              startMs: row.startMs,
              endMs: row.endMs,
              text: row.text,
            }))
          ),
        ].join("\n");

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = `Groq speaker labeling gagal (${response.status}): ${errorText}`;

          if (looksLikeModelNotFound(response.status, errorText)) {
            logger.warn("speaker_label_model_unavailable", { model, status: response.status });
            throw new Error("__MODEL_NOT_FOUND__");
          }

          throw new Error(lastError);
        }

        const json = (await response.json()) as GroqChatCompletionResponse;
        const rawContent = json.choices?.[0]?.message?.content?.trim();

        if (!rawContent) {
          throw new Error("Respons speaker labeling kosong");
        }

        const parsed = JSON.parse(extractJsonObject(rawContent)) as unknown;
        const assignments = normalizeSpeakerAssignments(parsed);

        for (const row of assignments) {
          labelsByIndex.set(row.index, row.speakerLabel);
        }
      }

      const labeledSegments = sourceRows.map((row) => {
        return {
          id: row.id,
          speakerLabel: labelsByIndex.get(row.index) || null,
        } as SpeakerLabeledSegment;
      });

      logger.info("speaker_labeling_completed", {
        model,
        segmentCount: labeledSegments.length,
      });

      return {
        model,
        segments: labeledSegments,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      if (message === "__MODEL_NOT_FOUND__") {
        continue;
      }

      logger.warn("speaker_labeling_model_failed", {
        model,
        message,
      });
      lastError = message;
      continue;
    }
  }

  throw new Error(
    lastError ||
      "Groq speaker labeling gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}
