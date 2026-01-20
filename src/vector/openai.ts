/**
 * OpenAI API client for embeddings
 */

import { requestUrl, RequestUrlResponse } from "obsidian";
import type { EmbeddingProvider } from "./provider";

/** Response from OpenAI /v1/embeddings endpoint */
interface OpenAIEmbedResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Error response from OpenAI API */
interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

/**
 * Client for interacting with OpenAI's embedding API.
 */
export class OpenAIClient implements EmbeddingProvider {
  private baseUrl: string;

  constructor(
    private apiKey: string,
    private model: string,
    baseUrl?: string
  ) {
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
  }

  /**
   * Generate embeddings for one or more texts.
   *
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (one per input text)
   * @throws Error if the OpenAI API request fails
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (!this.apiKey) {
      throw new Error("OpenAI API key is not configured");
    }

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url: `${this.baseUrl}/embeddings`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
        }),
      });
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      // Try to extract OpenAI error message from the error
      if (err instanceof Error && "json" in err) {
        try {
          const errorData = (err as { json: OpenAIErrorResponse }).json;
          if (errorData?.error?.message) {
            message = errorData.error.message;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
      throw new Error(`OpenAI embed failed: ${message}`);
    }

    const data: OpenAIEmbedResponse = response.json;

    if (!data.data || data.data.length !== texts.length) {
      throw new Error(
        `Unexpected OpenAI response: expected ${texts.length} embeddings, got ${data.data?.length ?? 0}`
      );
    }

    // Sort by index to ensure correct order (OpenAI may return out of order)
    data.data.sort((a, b) => a.index - b.index);
    return data.data.map((item) => item.embedding);
  }

  /**
   * Check if OpenAI API is available with the configured key.
   *
   * @returns true if the API key is set (actual validation happens on first embed)
   */
  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }

    try {
      // Do a minimal embed to verify the API key works
      await requestUrl({
        url: `${this.baseUrl}/embeddings`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: ["test"],
          model: this.model,
        }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a unique key identifying this provider configuration.
   */
  getProviderKey(): string {
    // Include base URL in key for Azure/custom endpoints
    const urlPart =
      this.baseUrl !== "https://api.openai.com/v1" ? `:${this.baseUrl}` : "";
    return `openai:${this.model}${urlPart}`;
  }
}
