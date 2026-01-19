/**
 * Vector similarity functions for search
 */

import type { ChunkEmbedding, SearchResult, SparseVector } from "./types";

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

/**
 * Compute cosine similarity between two sparse vectors.
 * Both vectors must have indices sorted in ascending order.
 *
 * @param a - First sparse vector
 * @param b - Second sparse vector
 * @returns Cosine similarity score between -1 and 1
 */
export function sparseCosineSimilarity(a: SparseVector, b: SparseVector): number {
  let dotProduct = 0;
  let i = 0;
  let j = 0;

  // Merge-join on sorted indices
  while (i < a.indices.length && j < b.indices.length) {
    if (a.indices[i] === b.indices[j]) {
      dotProduct += a.values[i] * b.values[j];
      i++;
      j++;
    } else if (a.indices[i] < b.indices[j]) {
      i++;
    } else {
      j++;
    }
  }

  const normA = Math.sqrt(a.values.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.values.reduce((sum, v) => sum + v * v, 0));

  return normA && normB ? dotProduct / (normA * normB) : 0;
}

/**
 * Find the top K most similar chunks using sparse vectors.
 * Used for TF-IDF search where sparse representation is more memory-efficient.
 *
 * @param queryEmbedding - The query sparse vector to compare against
 * @param chunks - Array of chunk embeddings to search (must have sparseEmbedding)
 * @param k - Number of top results to return
 * @returns Array of SearchResult sorted by descending similarity score
 */
export function sparseTopK(
  queryEmbedding: SparseVector,
  chunks: ChunkEmbedding[],
  k: number
): SearchResult[] {
  if (chunks.length === 0) {
    return [];
  }

  const scored = chunks
    .filter(chunk => chunk.sparseEmbedding) // Only chunks with sparse embeddings
    .map(chunk => ({
      chunk,
      score: sparseCosineSimilarity(queryEmbedding, chunk.sparseEmbedding!),
    }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, k);
}
