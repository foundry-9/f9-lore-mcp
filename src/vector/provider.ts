/**
 * Embedding provider abstraction
 *
 * Defines a common interface for embedding providers (Ollama, OpenAI, etc.)
 * allowing the VectorIndexer to work with any provider.
 */

/** Supported embedding provider types */
export type EmbeddingProviderType = "ollama" | "openai";

/**
 * Common interface for embedding providers.
 */
export interface EmbeddingProvider {
  /**
   * Generate embeddings for one or more texts.
   *
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (one per input text)
   * @throws Error if the embedding request fails
   */
  embed(texts: string[]): Promise<number[][]>;

  /**
   * Check if the provider is available and configured.
   *
   * @returns true if the provider is ready to use
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get a unique key identifying this provider configuration.
   * Used to detect when provider settings change and the index needs rebuilding.
   *
   * @returns A string like "ollama:http://localhost:11434:nomic-embed-text" or "openai:text-embedding-3-small"
   */
  getProviderKey(): string;
}

/** Configuration for creating an embedding provider */
export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderType;
  // Ollama-specific
  ollamaUrl?: string;
  ollamaModel?: string;
  // OpenAI-specific
  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
}

/**
 * Factory function to create an embedding provider based on configuration.
 *
 * @param config - Provider configuration
 * @returns An EmbeddingProvider instance
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig
): EmbeddingProvider {
  switch (config.provider) {
    case "openai": {
      const { OpenAIClient } = require("./openai");
      return new OpenAIClient(
        config.openaiApiKey ?? "",
        config.openaiModel ?? "text-embedding-3-small",
        config.openaiBaseUrl
      );
    }
    case "ollama":
    default: {
      const { OllamaClient } = require("./ollama");
      return new OllamaClient(
        config.ollamaUrl ?? "http://localhost:11434",
        config.ollamaModel ?? "nomic-embed-text:latest"
      );
    }
  }
}
