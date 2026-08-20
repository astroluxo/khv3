import { requiredEnv } from "./env.ts";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export type OpenAIEmbeddingErrorKind =
  "authentication" | "rate_limit" | "transient_upstream" | "malformed_response" | "configuration";

export type OpenAIResponseErrorKind =
  | "authentication"
  | "rate_limit"
  | "transient_upstream"
  | "malformed_response"
  | "refusal"
  | "incomplete";

export class OpenAIEmbeddingError extends Error {
  readonly kind: OpenAIEmbeddingErrorKind;
  readonly status?: number;

  constructor(
    kind: OpenAIEmbeddingErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenAIEmbeddingError";
    this.kind = kind;
    this.status = options.status;
  }
}

export class OpenAIResponseError extends Error {
  readonly kind: OpenAIResponseErrorKind;
  readonly status?: number;

  constructor(
    kind: OpenAIResponseErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenAIResponseError";
    this.kind = kind;
    this.status = options.status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EnvReader = { get(name: string): string | undefined };

export type JsonSchemaResponseFormat = {
  type: "json_schema";
  name: string;
  description?: string;
  strict: true;
  schema: Record<string, unknown>;
};

export type OpenAIResponseRequest = Record<string, unknown> & {
  text?: {
    format: JsonSchemaResponseFormat;
  };
};

export type OpenAIResponsePayload = {
  output_text?: string;
  usage?: unknown;
};

export type EmbeddingClient = {
  readonly dimensions: number;
  embedMany(inputs: string[]): Promise<number[][]>;
};

export type EmbeddingConfig = {
  model: string;
  dimensions: number;
};

export type OpenAIEmbeddingClientOptions = {
  apiKey: string;
  model?: string;
  dimensions?: number;
  fetchImpl?: FetchLike;
  baseUrl?: string;
};

export class OpenAIEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  readonly dimensions: number;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: OpenAIEmbeddingClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? OPENAI_API_BASE_URL;
  }

  async embedMany(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          dimensions: this.dimensions,
          input: inputs,
        }),
      });
    } catch (error) {
      throw new OpenAIEmbeddingError(
        "transient_upstream",
        "OpenAI embedding request failed before a response",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw mapEmbeddingHttpError(response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new OpenAIEmbeddingError(
        "malformed_response",
        "OpenAI embedding response was not valid JSON",
        { cause: error },
      );
    }

    return parseEmbeddingResponse(payload, inputs.length, this.dimensions);
  }
}

export function createEmbeddingConfig(env: EnvReader = runtimeEnv()): EmbeddingConfig {
  return {
    model: env.get("OPENAI_EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL,
    dimensions: parseEmbeddingDimensions(env.get("OPENAI_EMBEDDING_DIMENSIONS")),
  };
}

export function createDefaultEmbeddingClient(): OpenAIEmbeddingClient {
  const config = createEmbeddingConfig();
  return new OpenAIEmbeddingClient({
    apiKey: requiredEnv("OPENAI_API_KEY"),
    model: config.model,
    dimensions: config.dimensions,
  });
}

export async function embedTexts(
  inputs: string[],
  client: EmbeddingClient = createDefaultEmbeddingClient(),
): Promise<number[][]> {
  return client.embedMany(inputs);
}

export async function embedText(
  text: string,
  client: EmbeddingClient = createDefaultEmbeddingClient(),
): Promise<number[]> {
  const [embedding] = await embedTexts([text], client);
  if (!embedding) {
    throw new OpenAIEmbeddingError("malformed_response", "OpenAI did not return an embedding");
  }
  return embedding;
}

export const openai = {
  responses: {
    async create(request: OpenAIResponseRequest): Promise<OpenAIResponsePayload> {
      let response: Response;
      try {
        response = await fetch(`${OPENAI_API_BASE_URL}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new OpenAIResponseError(
          "transient_upstream",
          "OpenAI response request failed before a response",
          { cause: error },
        );
      }

      if (!response.ok) throw mapResponseHttpError(response.status);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new OpenAIResponseError(
          "malformed_response",
          "OpenAI response payload was not valid JSON",
          { cause: error },
        );
      }

      return parseOpenAIResponsePayload(payload);
    },
  },
};

function mapEmbeddingHttpError(status: number): OpenAIEmbeddingError {
  if (status === 401 || status === 403) {
    return new OpenAIEmbeddingError(
      "authentication",
      "OpenAI embedding request was not authorized",
      {
        status,
      },
    );
  }
  if (status === 429) {
    return new OpenAIEmbeddingError("rate_limit", "OpenAI embedding rate limit was exceeded", {
      status,
    });
  }
  if (status >= 500) {
    return new OpenAIEmbeddingError("transient_upstream", "OpenAI embedding upstream failed", {
      status,
    });
  }
  return new OpenAIEmbeddingError("malformed_response", "OpenAI embedding request failed", {
    status,
  });
}

function mapResponseHttpError(status: number): OpenAIResponseError {
  if (status === 401 || status === 403) {
    return new OpenAIResponseError("authentication", "OpenAI response request was not authorized", {
      status,
    });
  }
  if (status === 429) {
    return new OpenAIResponseError("rate_limit", "OpenAI response rate limit was exceeded", {
      status,
    });
  }
  if (status >= 500) {
    return new OpenAIResponseError("transient_upstream", "OpenAI response upstream failed", {
      status,
    });
  }
  return new OpenAIResponseError("malformed_response", "OpenAI response request failed", {
    status,
  });
}

export function validateEmbeddingDimensions(embedding: number[], expectedDimensions: number): void {
  if (embedding.length !== expectedDimensions) {
    throw new OpenAIEmbeddingError(
      "malformed_response",
      `OpenAI embedding dimension mismatch: expected ${expectedDimensions}, received ${embedding.length}`,
    );
  }
}

function parseEmbeddingResponse(
  payload: unknown,
  expectedCount: number,
  expectedDimensions: number,
): number[][] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new OpenAIEmbeddingError(
      "malformed_response",
      "OpenAI embedding response is missing data",
    );
  }

  const embeddings = payload.data.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new OpenAIEmbeddingError("malformed_response", "OpenAI embedding item is malformed");
    }
    if (!item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new OpenAIEmbeddingError(
        "malformed_response",
        "OpenAI embedding contains non-numeric values",
      );
    }
    validateEmbeddingDimensions(item.embedding, expectedDimensions);
    return item.embedding;
  });

  if (embeddings.length !== expectedCount) {
    throw new OpenAIEmbeddingError(
      "malformed_response",
      "OpenAI embedding response count does not match request count",
    );
  }

  return embeddings;
}

function parseEmbeddingDimensions(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_EMBEDDING_DIMENSIONS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new OpenAIEmbeddingError(
      "configuration",
      "OPENAI_EMBEDDING_DIMENSIONS must be a positive integer",
    );
  }
  return parsed;
}

function parseOpenAIResponsePayload(payload: unknown): OpenAIResponsePayload {
  if (!isRecord(payload)) {
    throw new OpenAIResponseError("malformed_response", "OpenAI response payload is malformed");
  }

  if (payload.status === "incomplete") {
    throw new OpenAIResponseError("incomplete", "OpenAI response was incomplete");
  }
  if (payload.status === "failed" || payload.status === "cancelled") {
    throw new OpenAIResponseError(
      "transient_upstream",
      `OpenAI response ended with status ${String(payload.status)}`,
    );
  }
  if (payload.error !== undefined && payload.error !== null) {
    throw new OpenAIResponseError("transient_upstream", "OpenAI response returned an error");
  }
  if (containsRefusal(payload.output)) {
    throw new OpenAIResponseError("refusal", "OpenAI response contained a refusal");
  }

  const outputText = parseOutputText(payload);
  if (!outputText) {
    throw new OpenAIResponseError(
      "malformed_response",
      "OpenAI response did not include output text",
    );
  }

  return {
    output_text: outputText,
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
  };
}

function containsRefusal(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (!isRecord(item)) return false;
    if (typeof item.refusal === "string") return true;
    if (!Array.isArray(item.content)) return false;
    return item.content.some(
      (content) =>
        isRecord(content) && (content.type === "refusal" || typeof content.refusal === "string"),
    );
  });
}

function parseOutputText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return undefined;

  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.length > 0 ? parts.join("") : undefined;
}

function runtimeEnv(): EnvReader {
  const maybeDeno = globalThis as typeof globalThis & { Deno?: { env: EnvReader } };
  return maybeDeno.Deno?.env ?? { get: () => undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
