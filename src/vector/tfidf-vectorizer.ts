// tfidf-vectorizer.ts

import { porterStem } from "./porter-stemmer";

/**
 * A BM25-enhanced TF-IDF vectorizer with Porter stemming and optional bigrams.
 *
 * This class builds a vocabulary from a set of documents and calculates
 * inverse document frequencies (IDF) for similarity analysis.
 *
 * Features:
 * - BM25 scoring (industry standard for keyword retrieval)
 * - Porter stemming (normalizes word variants)
 * - Optional bigram tokens (captures two-word phrases)
 * - Customizable stop word filtering
 */
class TfidfVectorizer {
  private stopWords: Set<string>;
  /**
   * Whether to include bigram tokens (two-word phrases) in addition to unigrams.
   * Approximately doubles vocabulary size but improves phrase matching.
   */
  includeBigrams: boolean;
  /**
   * Maps token strings to column indices in the TF-IDF matrix.
   */
  vocabulary: Map<string, number>;
  /**
   * Array of IDF (Inverse Document Frequency) values for each term in the vocabulary.
   */
  idf: number[];
  /**
   * Average document length across the corpus (for BM25 normalization).
   */
  avgDocLength: number = 0;
  /**
   * BM25 saturation parameter (typical range: 1.2–2.0).
   * Controls how quickly term frequency saturates.
   */
  k1: number = 1.5;
  /**
   * BM25 length normalization parameter (0 = none, 1 = full).
   * Controls how much document length affects scoring.
   */
  b: number = 0.75;

  /**
   * @param includeBigrams - Whether to include bigram tokens (default: true)
   */
  constructor(includeBigrams: boolean = true) {
    this.vocabulary = new Map();
    this.idf = [];
    this.includeBigrams = includeBigrams;
    this.stopWords = new Set([
      // Articles and basic connectors
      "a", "an", "the", "is", "are", "to", "of", "and",
      "in", "on", "for", "with", "as", "by", "at", "this", "that",
      "it", "its", "be", "was", "were", "not", "but", "or", "if",
      "so", "such", "all", "any", "no", "yes", "do", "does", "did",
      "doing", "done", "can", "could", "will", "would", "shall",
      "should", "may", "might", "must", "like", "just", "now", "then",
      "than", "more", "most", "less", "least", "some", "many", "much",
      "few", "fewer", "each", "every", "either", "neither",
      "both", "other", "another", "same", "own",
      // Pronouns
      "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
      "you", "your", "yours", "yourself", "yourselves",
      "he", "him", "his", "himself", "she", "her", "hers", "herself",
      "they", "them", "their", "theirs", "themselves",
      "what", "which", "who", "whom", "when", "where", "why", "how",
      // Common verbs
      "have", "has", "had", "having", "been", "being",
      "get", "gets", "got", "getting",
      // Conjunctions and prepositions
      "from", "into", "through", "during", "before", "after",
      "above", "below", "between", "under", "over", "out", "off",
      "again", "further", "once", "here", "there", "about",
    ]);
  }

  /**
   * Splits input text into lowercased, stemmed tokens, excluding stop words.
   * Applies Porter stemming to normalize word variants (e.g., "kingdoms" → "kingdom").
   * Optionally includes bigram tokens (two-word phrases) for better phrase matching.
   *
   * @param text - The raw input string.
   * @returns An array of filtered and stemmed tokens (unigrams and optionally bigrams).
   */
  tokenize(text: string): string[] {
    // Extract unigrams: lowercased, stop-word filtered, stemmed
    const unigrams = (text.toLowerCase().match(/\b\w+\b/g) || [])
      .filter(token => !this.stopWords.has(token))
      .map(token => porterStem(token));

    // Optionally add bigrams (two consecutive stemmed tokens joined with underscore)
    if (!this.includeBigrams || unigrams.length < 2) {
      return unigrams;
    }

    const bigrams: string[] = [];
    for (let i = 0; i < unigrams.length - 1; i++) {
      bigrams.push(`${unigrams[i]}_${unigrams[i + 1]}`);
    }

    return [...unigrams, ...bigrams];
  }

  /**
   * Builds the vocabulary and computes IDF values from the given corpus.
   * Also calculates average document length for BM25 scoring.
   * @param corpus - Array of documents to process.
   */
  fit(corpus: string[]): void {
    const df: Map<string, number> = new Map();
    let totalLength = 0;

    corpus.forEach((doc) => {
      const allTokens = this.tokenize(doc);
      totalLength += allTokens.length;
      const uniqueTokens = new Set(allTokens);
      uniqueTokens.forEach(token => {
        df.set(token, (df.get(token) || 0) + 1);
      });
    });

    // Calculate average document length for BM25
    this.avgDocLength = corpus.length > 0 ? totalLength / corpus.length : 0;

    Array.from(df.keys()).forEach((token, idx) => {
      this.vocabulary.set(token, idx);
    });

    const totalDocs = corpus.length;
    this.idf = Array.from(this.vocabulary.keys()).map(token => {
      return Math.log((1 + totalDocs) / (1 + (df.get(token) ?? 0))) + 1;
    });
  }
}

export { TfidfVectorizer };
