import OpenAI from "npm:openai";
import { requiredEnv } from "./env.ts";

export const openai = new OpenAI({ apiKey: requiredEnv("OPENAI_API_KEY") });

export async function embedText(text: string): Promise<number[]> {
  const model = Deno.env.get("OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small";
  const response = await openai.embeddings.create({ model, input: text });
  return response.data[0].embedding;
}
