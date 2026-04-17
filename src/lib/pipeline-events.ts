import type { PipelineStatus } from "@/lib/pipeline-status";

export type PipelineEventType = "snapshot" | "status_update" | "heartbeat";

export type PipelineEvent = {
  type: PipelineEventType;
  payload: unknown;
};

type PublishStatusUpdateInput = {
  videoId: string;
  getPipelineStatus: () => Promise<PipelineStatus | null>;
};

type PipelineEventHandler = (event: PipelineEvent) => void;

export function createPipelineEventBus() {
  const subscribersByVideoId = new Map<string, Set<PipelineEventHandler>>();

  return {
    publish(videoId: string, event: PipelineEvent) {
      const subscribers = subscribersByVideoId.get(videoId);
      if (!subscribers) {
        return;
      }

      for (const handler of subscribers) {
        handler(event);
      }
    },
    subscribe(videoId: string, handler: PipelineEventHandler) {
      const subscribers = subscribersByVideoId.get(videoId) ?? new Set<PipelineEventHandler>();
      subscribers.add(handler);
      subscribersByVideoId.set(videoId, subscribers);

      return () => {
        const existingSubscribers = subscribersByVideoId.get(videoId);
        if (!existingSubscribers) {
          return;
        }

        existingSubscribers.delete(handler);

        if (existingSubscribers.size === 0) {
          subscribersByVideoId.delete(videoId);
        }
      };
    },
  };
}

export const pipelineEventBus = createPipelineEventBus();

export async function publishPipelineStatusUpdate(input: PublishStatusUpdateInput): Promise<void> {
  const pipeline = await input.getPipelineStatus();
  if (!pipeline) {
    return;
  }

  pipelineEventBus.publish(input.videoId, {
    type: "status_update",
    payload: {
      ok: true,
      videoId: input.videoId,
      pipeline,
    },
  });
}
