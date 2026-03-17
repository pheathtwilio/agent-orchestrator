import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;
import { randomUUID } from "node:crypto";
import type { MessageBus, BusMessage, MessageHandler, OutputHandler } from "./types.js";

const STREAM_MAX_LEN = 1000;
const DEFAULT_REDIS_URL = "redis://localhost:6379";

/**
 * Redis-backed message bus.
 *
 * Uses Redis Streams for durable, ordered message delivery.
 * Each recipient has its own stream: `ao:inbox:<recipient>`
 *
 * Why Streams over Pub/Sub:
 * - Messages persist even if the recipient is temporarily down
 * - History is queryable (getHistory)
 * - Consumer groups possible for future scaling
 */
export function createMessageBus(redisUrl?: string): MessageBus {
  const url = redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

  // Separate connections for publishing and subscribing (Redis requirement)
  const pub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  const sub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  // Dedicated connection for pub/sub output streaming (can't share with XREAD)
  const outputSub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });

  let connected = false;
  let outputSubConnected = false;
  const subscriptions = new Map<string, { polling: boolean }>();
  const outputSubscriptions = new Map<string, OutputHandler>();

  async function ensureConnected(): Promise<void> {
    if (!connected) {
      await Promise.all([pub.connect(), sub.connect()]);
      connected = true;
    }
  }

  function streamKey(recipient: string): string {
    return `ao:inbox:${recipient}`;
  }

  function serializeMessage(msg: BusMessage): Record<string, string> {
    return {
      id: msg.id,
      type: msg.type,
      from: msg.from,
      to: msg.to,
      timestamp: String(msg.timestamp),
      payload: JSON.stringify(msg.payload),
    };
  }

  function deserializeMessage(fields: Record<string, string>): BusMessage {
    return {
      id: fields.id,
      type: fields.type as BusMessage["type"],
      from: fields.from,
      to: fields.to,
      timestamp: parseInt(fields.timestamp, 10),
      payload: JSON.parse(fields.payload),
    };
  }

  return {
    async publish(message): Promise<string> {
      await ensureConnected();

      const fullMessage: BusMessage = {
        ...message,
        id: randomUUID(),
        timestamp: Date.now(),
      };

      const key = streamKey(message.to);
      await pub.xadd(
        key,
        "MAXLEN", "~", String(STREAM_MAX_LEN),
        "*",
        ...Object.entries(serializeMessage(fullMessage)).flat(),
      );

      return fullMessage.id;
    },

    async subscribe(recipient: string, handler: MessageHandler): Promise<void> {
      await ensureConnected();

      const key = streamKey(recipient);
      const entry = { polling: true };
      subscriptions.set(recipient, entry);

      // Start polling loop — reads new messages from the stream
      let lastId = "$"; // Only new messages from this point

      (async () => {
        while (entry.polling) {
          try {
            // XREAD with BLOCK waits for new messages (5s timeout to check polling flag)
            const results = await sub.xread(
              "COUNT", "10",
              "BLOCK", "5000",
              "STREAMS", key, lastId,
            );

            if (!results) continue;

            for (const [, messages] of results) {
              for (const [streamId, fields] of messages) {
                lastId = streamId;
                // Convert flat array to key-value pairs
                const obj: Record<string, string> = {};
                for (let i = 0; i < fields.length; i += 2) {
                  obj[fields[i]] = fields[i + 1];
                }
                try {
                  await handler(deserializeMessage(obj));
                } catch {
                  // Handler error — don't crash the polling loop
                }
              }
            }
          } catch {
            // Connection issue — back off and retry
            if (entry.polling) {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }
      })();
    },

    async unsubscribe(recipient: string): Promise<void> {
      const entry = subscriptions.get(recipient);
      if (entry) {
        entry.polling = false;
        subscriptions.delete(recipient);
      }
    },

    async getHistory(recipient: string, count = 50): Promise<BusMessage[]> {
      await ensureConnected();

      const key = streamKey(recipient);
      const results = await pub.xrevrange(key, "+", "-", "COUNT", count);

      return results.map(([, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        return deserializeMessage(obj);
      }).reverse();
    },

    async subscribeOutput(sessionId: string, handler: OutputHandler): Promise<void> {
      if (!outputSubConnected) {
        await outputSub.connect();
        outputSubConnected = true;

        // Single message handler for all output subscriptions
        outputSub.on("message", (channel: string, message: string) => {
          // Extract session ID from channel: ao:output:<sessionId>
          const sid = channel.replace("ao:output:", "");
          const h = outputSubscriptions.get(sid);
          if (h) {
            try {
              h(JSON.parse(message));
            } catch { /* ignore parse errors */ }
          }
        });
      }

      outputSubscriptions.set(sessionId, handler);
      await outputSub.subscribe(`ao:output:${sessionId}`);
    },

    async unsubscribeOutput(sessionId: string): Promise<void> {
      outputSubscriptions.delete(sessionId);
      if (outputSubConnected) {
        await outputSub.unsubscribe(`ao:output:${sessionId}`);
      }
    },

    async disconnect(): Promise<void> {
      // Stop all subscriptions
      for (const [, entry] of subscriptions) {
        entry.polling = false;
      }
      subscriptions.clear();
      outputSubscriptions.clear();

      connected = false;
      outputSubConnected = false;
      await Promise.all([
        pub.quit().catch(() => pub.disconnect()),
        sub.quit().catch(() => sub.disconnect()),
        outputSub.quit().catch(() => outputSub.disconnect()),
      ]);
    },
  };
}
