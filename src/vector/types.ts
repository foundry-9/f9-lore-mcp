/**
 * Vector search types for F9 Obsidian MCP
 */

import type { EmbeddingProviderType } from "./provider";

/** Schema version for future migrations */
export const EMBEDDING_INDEX_VERSION = 2;

/** A single chunk embedding with metadata */
export interface ChunkEmbedding {
  /** Unique identifier: `${filePath}::${chunkIndex}` */
  id: string;
  /** Vault-relative file path */
  filePath: string;
  /** Zero-based chunk index within the file */
  chunkIndex: number;
  /** First 200 characters of chunk for preview */
  preview: string;
  /** Full chunk text */
  content: string;
  /** The embedding vector (768 dimensions for nomic-embed-text) */
  embedding: number[];
  /** File mtime when chunk was embedded (for staleness detection) */
  embeddedAt: number;
}

/** The full embedding index stored in plugin data */
export interface EmbeddingIndex {
  /** Schema version for future migrations */
  version: number;
  /** Provider key for invalidation detection (e.g., "ollama:http://localhost:11434:nomic-embed-text") */
  providerKey: string;
  /** Map of file path -> file mtime when last indexed */
  fileMtimes: Record<string, number>;
  /** All chunk embeddings */
  chunks: ChunkEmbedding[];
}

/** Vector search settings */
export interface VectorSearchSettings {
  /** Enable automatic embedding on file changes */
  autoIndex: boolean;
  /** Embedding provider type */
  embeddingProvider: EmbeddingProviderType;

  // Ollama settings
  /** Ollama API endpoint */
  ollamaUrl: string;
  /** Ollama embedding model name */
  embeddingModel: string;

  // OpenAI settings
  /** OpenAI API key */
  openaiApiKey: string;
  /** OpenAI embedding model name */
  openaiModel: string;
  /** Custom OpenAI-compatible endpoint (optional, for Azure etc.) */
  openaiBaseUrl: string;

  /** Target chunk size in characters (~500 tokens = ~2000 chars) */
  chunkSize: number;
  /** Overlap between chunks in characters */
  chunkOverlap: number;
  /** Debounce delay in ms for batch file changes */
  debounceMs: number;
}

/** Default vector search settings */
export const DEFAULT_VECTOR_SETTINGS: VectorSearchSettings = {
  autoIndex: true,
  embeddingProvider: "ollama",
  ollamaUrl: "http://localhost:11434",
  embeddingModel: "nomic-embed-text:latest",
  openaiApiKey: "",
  openaiModel: "text-embedding-3-small",
  openaiBaseUrl: "",
  chunkSize: 2000,
  chunkOverlap: 200,
  debounceMs: 2000,
};

/** Search result with score */
export interface SearchResult {
  chunk: ChunkEmbedding;
  score: number;
}

/** Create an empty embedding index */
export function createEmptyIndex(providerKey: string): EmbeddingIndex {
  return {
    version: EMBEDDING_INDEX_VERSION,
    providerKey,
    fileMtimes: {},
    chunks: [],
  };
}
