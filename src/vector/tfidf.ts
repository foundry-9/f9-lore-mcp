/**
 * TF-IDF Embedding Client
 *
 * Implements the EmbeddingProvider interface using TF-IDF (Term Frequency-Inverse Document Frequency).
 *
 * Architecture:
 * - During reindex: fitCorpus() is called with all chunks to build vocabulary and IDF weights
 * - During indexing: embed() transforms chunks using the existing vocabulary
 * - During search: embed() transforms query, then standard cosine similarity is used
 * - State (vocabulary + IDF) is persisted alongside the embedding index
 *
 * Benefits of TF-IDF:
 * - No external API required (works fully offline)
 * - No local LLM needed (unlike Ollama)
 * - Fast search (pre-computed vectors, just cosine similarity)
 * - Simple and deterministic
 *
 * Trade-offs:
 * - Less semantic understanding than neural embeddings
 * - Incremental indexing uses existing vocabulary (new terms ignored until reindex)
 * - Works best for exact/keyword matching
 */

import type { EmbeddingProvider } from "./provider";
import { TfidfVectorizer } from "./tfidf-vectorizer";

/** Serializable TF-IDF state for persistence */
export interface TfidfState {
  /** Vocabulary as array of [term, index] pairs (Map can't be JSON serialized) */
  vocabulary: [string, number][];
  /** IDF weights for each term in vocabulary order */
  idf: number[];
  /** Unknown terms encountered since last reindex */
  unknownTerms?: string[];
}

/**
 * TF-IDF client implementing EmbeddingProvider interface.
 */
export class TfidfClient implements EmbeddingProvider {
  private vectorizer: TfidfVectorizer;
  private isFitted: boolean = false;
  private vocabularySize: number = 0;
  /** Unique unknown terms encountered since last reindex */
  private unknownTerms: Set<string> = new Set();

  constructor() {
    this.vectorizer = new TfidfVectorizer();
  }

  /**
   * Load TF-IDF state from persisted data.
   * Call this after loading the embedding index.
   *
   * @param state - Previously saved TF-IDF state
   */
  loadState(state: TfidfState): void {
    this.vectorizer.vocabulary = new Map(state.vocabulary);
    this.vectorizer.idf = state.idf;
    this.vocabularySize = state.vocabulary.length;
    this.unknownTerms = new Set(state.unknownTerms ?? []);
    this.isFitted = true;
  }

  /**
   * Get current TF-IDF state for persistence.
   * Call this before saving the embedding index.
   *
   * @returns TF-IDF state to persist, or undefined if not fitted
   */
  getState(): TfidfState | undefined {
    if (!this.isFitted) {
      return undefined;
    }
    return {
      vocabulary: Array.from(this.vectorizer.vocabulary.entries()),
      idf: this.vectorizer.idf,
      unknownTerms: Array.from(this.unknownTerms),
    };
  }

  /**
   * Check if the vectorizer has been fitted with a vocabulary.
   */
  hasFittedVocabulary(): boolean {
    return this.isFitted;
  }

  /**
   * Fit the TF-IDF model on the entire corpus.
   * This builds the vocabulary and calculates IDF weights.
   * Call this during reindexVault() before embedding individual chunks.
   *
   * @param corpus - All document texts to fit on
   */
  fitCorpus(corpus: string[]): void {
    this.vectorizer.fit(corpus);
    this.vocabularySize = this.vectorizer.vocabulary.size;
    this.unknownTerms.clear(); // Reset unknown terms after reindex
    this.isFitted = true;
  }

  /**
   * Generate embeddings for texts using the fitted vocabulary.
   *
   * If not fitted, returns empty arrays (caller should call fitCorpus first).
   * Unknown words (not in vocabulary) are ignored during transformation.
   *
   * @param texts - Array of text strings to embed
   * @returns Array of dense TF-IDF vectors (one per input text)
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.isFitted) {
      // Not fitted yet - return empty arrays
      // This happens during incremental indexing before first reindex
      console.warn("F9 MCP: TF-IDF not fitted, returning empty embeddings. Run reindex to build vocabulary.");
      return texts.map(() => []);
    }

    // Transform texts to TF-IDF vectors using existing vocabulary
    return texts.map((text) => this.transformToDense(text));
  }

  /**
   * Transform a single text to a dense TF-IDF vector.
   * Tracks unknown terms for vocabulary drift detection.
   *
   * @param text - Text to transform
   * @param trackUnknown - Whether to track unknown terms (default: true)
   * @returns Dense vector of length vocabularySize
   */
  private transformToDense(text: string, trackUnknown: boolean = true): number[] {
    const tokens = this.vectorizer.tokenize(text);
    const tf: Record<number, number> = {};

    // Calculate term frequencies for known vocabulary terms
    for (const token of tokens) {
      if (this.vectorizer.vocabulary.has(token)) {
        const index = this.vectorizer.vocabulary.get(token)!;
        tf[index] = (tf[index] || 0) + 1;
      } else if (trackUnknown) {
        // Track unknown terms for vocabulary drift detection
        this.unknownTerms.add(token);
      }
    }

    // Build dense vector
    const vector = new Array(this.vocabularySize).fill(0);
    const docLength = tokens.length || 1; // Avoid division by zero

    for (const [indexStr, count] of Object.entries(tf)) {
      const index = parseInt(indexStr);
      // TF-IDF = (term frequency / doc length) * IDF
      vector[index] = (count / docLength) * this.vectorizer.idf[index];
    }

    return vector;
  }

  /**
   * Get the number of unique unknown terms encountered since last reindex.
   */
  getUnknownTermsCount(): number {
    return this.unknownTerms.size;
  }

  /**
   * Get vocabulary size (number of known terms).
   */
  getVocabularySize(): number {
    return this.vocabularySize;
  }

  /**
   * Get vocabulary drift statistics.
   * Returns info about unknown terms relative to vocabulary size.
   */
  getVocabularyDriftStats(): {
    unknownTermsCount: number;
    vocabularySize: number;
    driftPercentage: number;
    sampleUnknownTerms: string[];
  } {
    const unknownCount = this.unknownTerms.size;
    const vocabSize = this.vocabularySize || 1;
    const driftPct = (unknownCount / vocabSize) * 100;

    // Get a sample of unknown terms (up to 10) for display
    const sample = Array.from(this.unknownTerms).slice(0, 10);

    return {
      unknownTermsCount: unknownCount,
      vocabularySize: this.vocabularySize,
      driftPercentage: Math.round(driftPct * 10) / 10, // Round to 1 decimal
      sampleUnknownTerms: sample,
    };
  }

  /**
   * Check if the provider is available.
   * TF-IDF is always available since it requires no external services.
   *
   * @returns Always true
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Get a unique key identifying this provider configuration.
   * Used to detect when provider settings change and the index needs rebuilding.
   *
   * @returns "tfidf" (no configuration options)
   */
  getProviderKey(): string {
    return "tfidf";
  }
}
