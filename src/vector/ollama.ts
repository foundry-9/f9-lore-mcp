/**
 * Ollama API client for embeddings
 */

import { requestUrl, RequestUrlResponse } from "obsidian";
import type { EmbeddingProvider } from "./provider";

/** Response from Ollama /api/embed endpoint */
interface OllamaEmbedResponse {
  embeddings: number[][];
}

/**
 * Client for interacting with Ollama's embedding API.
 */
export class OllamaClient implements EmbeddingProvider {
  constructor(
    private baseUrl: string,
    private model: string
  ) {}

  /**
   * Generate embeddings for one or more texts.
   *
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (one per input text)
   * @throws Error if the Ollama API request fails
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url: `${this.baseUrl}/api/embed`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama embed failed: ${message}`);
    }

    const data: OllamaEmbedResponse = response.json;

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(
        `Unexpected Ollama response: expected ${texts.length} embeddings, got ${data.embeddings?.length ?? 0}`
      );
    }

    return data.embeddings;
  }

  /**
   * Check if Ollama is available and the model is loaded.
   *
   * @returns true if Ollama is reachable
   */
  async isAvailable(): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/tags`,
        method: "GET",
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
    return `ollama:${this.baseUrl}:${this.model}`;
  }
}
