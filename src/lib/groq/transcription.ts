import { readFile } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logger";

const logger = createLogger("lib/groq/transcription");

export type GroqWord = {
  word: string;
  start?: number;
  end?: number;
};

export type GroqSegment = {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  words?: GroqWord[];
};

export type GroqTranscriptionResponse = {
  text?: string;
  language?: string;
  segments?: GroqSegment[];
};

export async function transcribeAudioWithGroq(audioPath: string, apiKey: string) {
  const model = process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";
  const endpoint =
    process.env.GROQ_TRANSCRIBE_ENDPOINT?.trim() ||
    "https://api.groq.com/openai/v1/audio/transcriptions";

  logger.info("transcribe_request_started", { model, endpoint, audioPath });

  const fileBuffer = await readFile(audioPath);

  const formData = new FormData();
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");
  formData.append("timestamp_granularities[]", "word");
  const language = process.env.GROQ_TRANSCRIBE_LANGUAGE?.trim();
  if (language) {
    formData.append("language", language);
  }

  formData.append("file", new Blob([fileBuffer], { type: "audio/wav" }), path.basename(audioPath));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  logger.info("transcribe_response_received", { model, status: response.status });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("transcribe_request_failed", { model, status: response.status, errorText });
    throw new Error(`Groq transcription gagal (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as GroqTranscriptionResponse;
  logger.info("transcribe_request_completed", {
    model,
    segments: json.segments?.length || 0,
    language: json.language || null,
  });

  return { model, result: json };
}
