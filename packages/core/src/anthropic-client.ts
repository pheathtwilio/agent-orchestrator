import Anthropic from "@anthropic-ai/sdk";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromSSO } from "@aws-sdk/credential-providers";

/**
 * Create the appropriate Anthropic client based on environment.
 *
 * - If CLAUDE_CODE_USE_BEDROCK=1, returns a Bedrock-backed wrapper
 * - Otherwise, returns a standard Anthropic client (needs ANTHROPIC_API_KEY)
 */
export function createAnthropicClient(): Anthropic {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return createBedrockClient() as unknown as Anthropic;
  }

  return new Anthropic();
}

/**
 * Minimal Bedrock wrapper that implements the subset of the Anthropic SDK
 * that the planner and decomposer use (messages.create only).
 *
 * Uses @aws-sdk/client-bedrock-runtime directly to avoid the broken
 * @anthropic-ai/bedrock-sdk prepareRequest compatibility issue.
 */
function createBedrockClient() {
  const region = process.env.AWS_REGION ?? "us-west-2";
  const profile = process.env.AWS_PROFILE ?? undefined;

  const bedrock = new BedrockRuntimeClient({
    region,
    credentials: fromSSO({ profile }),
  });

  return {
    messages: {
      async create(params: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: Array<{ role: string; content: string }>;
      }) {
        const body = {
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: params.max_tokens,
          ...(params.system && { system: params.system }),
          messages: params.messages,
        };

        const command = new InvokeModelCommand({
          modelId: params.model,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        });

        const response = await bedrock.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.body));

        return result;
      },
    },
  };
}
