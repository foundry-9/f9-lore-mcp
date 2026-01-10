/**
 * Vector similarity functions for search
 */

import type { ChunkEmbedding, SearchResult } from "./types";

/**
 * Compute cosine similarity between two vectors.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity score between -1 and 1
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Find the top K most similar chunks to a query embedding.
 *
 * @param queryEmbedding - The query vector to compare against
 * @param chunks - Array of chunk embeddings to search
 * @param k - Number of top results to return
 * @returns Array of SearchResult sorted by descending similarity score
 */
export function topK(
  queryEmbedding: number[],
  chunks: ChunkEmbedding[],
  k: number
): SearchResult[] {
  if (chunks.length === 0) {
    return [];
  }

  const scored = chunks.map(chunk => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, k);
}
