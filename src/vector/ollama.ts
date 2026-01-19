/**
 * Ollama API client for embeddings
 */

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

    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama embed failed (${response.status}): ${errorText}`);
    }

    const data: OllamaEmbedResponse = await response.json();

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
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
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
