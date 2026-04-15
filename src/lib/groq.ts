export type { GroqWord, GroqSegment, GroqTranscriptionResponse } from "@/lib/groq/transcription";
export { transcribeAudioWithGroq } from "@/lib/groq/transcription";

export type {
  TranscriptForSelection,
  GroqHighlightCandidate,
  GroqClipEvaluation,
  HighlightCriticEvaluation,
} from "@/lib/groq/highlights";
export {
  selectHighlightsWithGroq,
  evaluateClipRecommendationsWithGroq,
  selectHighlightsForWindowWithGroq,
  criticEvaluateHighlightsWithGroq,
  regenerateHighlightsFromFailuresWithGroq,
} from "@/lib/groq/highlights";

export type { TranscriptForSpeakerLabeling, SpeakerLabeledSegment } from "@/lib/groq/speaker-labeling";
export { labelTwoSpeakerSegmentsWithGroq } from "@/lib/groq/speaker-labeling";
