// tfidf-vectorizer.ts

/**
 * A Term Frequency-Inverse Document Frequency (TF-IDF) vectorizer.
 *
 * This class builds a vocabulary from a set of documents and calculates
 * inverse document frequencies (IDF) for similarity analysis.
 *
 * Features:
 * - Customizable stop word filtering
 * - Tokenization and IDF weight calculation
 */
class TfidfVectorizer {
  private stopWords: Set<string>;
  /**
   * Maps token strings to column indices in the TF-IDF matrix.
   */
  vocabulary: Map<string, number>;
  /**
   * Array of IDF (Inverse Document Frequency) values for each term in the vocabulary.
   */
  idf: number[];

  constructor() {
    this.vocabulary = new Map();
    this.idf = [];
    this.stopWords = new Set([
      "a", "an", "the", "is", "are", "to", "of", "and",
      "in", "on", "for", "with", "as", "by", "at", "this", "that",
      "it", "its", "be", "was", "were", "not", "but", "or", "if",
      "so", "such", "all", "any", "no", "yes", "do", "does", "did",
      "doing", "done", "can", "could", "will", "would", "shall",
      "should", "may", "might", "must", "like", "just", "now", "then",
      "than", "more", "most", "less", "least", "some", "many", "much",
      "few", "fewer", "each", "every", "either", "neither",
      "both", "other", "another", "same", "own",
    ]);
  }

  /**
   * Splits input text into lowercased tokens, excluding stop words.
   * @param text - The raw input string.
   * @returns An array of filtered tokens.
   */
  tokenize(text: string): string[] {
    return (text.toLowerCase().match(/\b\w+\b/g) || [])
      .filter(token => !this.stopWords.has(token));
  }

  /**
   * Builds the vocabulary and computes IDF values from the given corpus.
   * @param corpus - Array of documents to process.
   */
  fit(corpus: string[]): void {
    const df: Map<string, number> = new Map();

    corpus.forEach((doc) => {
      const tokens = new Set(this.tokenize(doc));
      tokens.forEach(token => {
        df.set(token, (df.get(token) || 0) + 1);
      });
    });

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
