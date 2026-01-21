/**
 * Vector search types for F9 Lore MCP
 */

import type { EmbeddingProviderType } from "./provider";
import type { TfidfState } from "./tfidf";

/** Schema version for future migrations */
export const EMBEDDING_INDEX_VERSION = 4;

/**
 * Sparse vector representation for memory-efficient TF-IDF storage.
 * Indices must be sorted in ascending order for efficient similarity computation.
 */
export interface SparseVector {
  /** Sorted array of non-zero indices */
  indices: number[];
  /** Values corresponding to each index */
  values: number[];
}

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
  /** The embedding vector (dense, for Ollama/OpenAI providers) */
  embedding: number[];
  /** Sparse embedding (for TF-IDF provider - more memory efficient) */
  sparseEmbedding?: SparseVector;
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
  /** Map of file path -> content hash (SHA-256, hex) when last indexed */
  fileHashes: Record<string, string>;
  /** All chunk embeddings */
  chunks: ChunkEmbedding[];
  /** TF-IDF state (vocabulary + IDF weights) - only present when using TF-IDF provider */
  tfidfState?: TfidfState;
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
  /** Per-file debounce delay in ms - file must be quiescent for this duration before indexing */
  debounceMs: number;

  // TF-IDF settings
  /** Auto-rebuild entire index when vocabulary drift is detected (TF-IDF only) */
  tfidfAutoRebuild: boolean;
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
  debounceMs: 10000,
  tfidfAutoRebuild: true,
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
    fileHashes: {},
    chunks: [],
  };
}

/** Plugin health state for status display */
export type PluginHealthState = "ok" | "busy" | "warning" | "error";

/** Structured error for display */
export interface IndexingError {
  timestamp: number;
  filePath?: string;
  message: string;
}

/** Extended indexing status with progress and error info */
export interface ExtendedIndexingStatus {
  isIndexing: boolean;
  pendingCount: number;
  progress?: {
    current: number;
    total: number;
    currentFile: string;
  };
  lastError?: IndexingError;
  healthState: PluginHealthState;
}
