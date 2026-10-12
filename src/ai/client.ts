// The one model interface. Live and record use the Anthropic SDK; tests can
// pass any ModelClient.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type ModelRequest = { model: string; system: string; input: unknown; schema: z.ZodType };

export interface ModelClient {
  // Returns the model's structured answer, not yet checked against the schema.
  complete(req: ModelRequest): Promise<unknown>;
}

export function anthropicClient(client: Anthropic = new Anthropic()): ModelClient {
  return {
    async complete({ model, system, input, schema }) {
      const res = await client.messages.parse({
        model,
        max_tokens: 16000,
        output_config: { effort: "medium", format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: JSON.stringify(input, null, 2) }],
      });
      if (res.stop_reason === "refusal") throw new Error("The model declined this request");
      if (res.parsed_output == null) throw new Error(`No structured output (stop_reason ${res.stop_reason})`);
      return res.parsed_output;
    },
  };
}
