// tfidf-vectorizer.ts

import { genericVectorizer, ItfidfMatrix } from "./tfidf-types";

/**
 * A simple sparse matrix representation using coordinate list (COO) format.
 * Stores non-zero values with their corresponding row and column indices.
 */
class SparseMatrix {
    /**
     * Row indices for non-zero values.
     */
    rows: number[];
    /**
     * Column indices for non-zero values.
     */
    cols: number[];
    /**
     * Non-zero values corresponding to (row, col) pairs.
     */
    values: number[];
    /**
     * Shape of the matrix as a tuple: [number of rows, number of columns].
     */
    shape: [ number, number ];

    constructor() {
        this.rows = [];
        this.cols = [];
        this.values = [];
        this.shape = [ 0, 0 ];
    }

    /**
     * Adds a non-zero value to the matrix at the specified row and column.
     * @param row - The row index.
     * @param col - The column index.
     * @param value - The non-zero value to store.
     */
    add(row: number, col: number, value: number): void {
        this.rows.push(row);
        this.cols.push(col);
        this.values.push(value);
        this.shape[ 0 ] = Math.max(this.shape[ 0 ], row + 1);
        this.shape[ 1 ] = Math.max(this.shape[ 1 ], col + 1);
    }

    /**
     * Retrieves a sparse vector (as an object) representing a specific row.
     * @param row - The row index to retrieve.
     * @returns An object mapping column indices to their corresponding values in the given row.
     */
    getRow(row: number): Record<number, number> {
        const result: Record<number, number> = {};
        for (let i = 0; i < this.rows.length; i++) {
            if (this.rows[ i ] === row) {
                result[ this.cols[ i ] ] = this.values[ i ];
            }
        }
        return result;
    }

    /**
     * Converts the sparse matrix to a dense 2D array representation.
     * @returns A dense matrix as a 2D array of numbers.
     */
    toDense(): Record<number, number[]> {
        const denseMatrix: number[][] = Array.from({ length: this.shape[ 0 ] },
            () => Array(this.shape[ 1 ]).fill(0));
        for (let i = 0; i < this.rows.length; i++) {
            denseMatrix[ this.rows[ i ] ][ this.cols[ i ] ] = this.values[ i ];
        }
        return denseMatrix;
    }

    toData(): ItfidfMatrix {
        return {
            matrix: this.rows.map((row, i) => ({
                row,
                col: this.cols[ i ],
                value: this.values[ i ]
            })),
            shape: this.shape
        };
    }

    toJSON(): string {
        return JSON.stringify(this.toData());
    }
}

/**
 * A Term Frequency-Inverse Document Frequency (TF-IDF) vectorizer.
 * 
 * This class builds a vocabulary from a set of documents, calculates inverse document frequencies (IDF),
 * and transforms documents into sparse TF-IDF vectors for similarity analysis.
 * 
 * Features:
 * - Customizable stop word filtering
 * - Tokenization and vector transformation
 * - Cosine similarity computation
 * - Synchronous and asynchronous APIs for fitting and querying
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
    /**
     * Sparse matrix representing the TF-IDF scores of the last fitted corpus.
     */
    tfidfMatrix: SparseMatrix;
    /**
     * Array of input documents used in the most recent fit or transform.
     */
    documents: string[];
    /**
     * Logging function
     */
    log: (message: string) => void;

    constructor() {
        this.vocabulary = new Map();
        this.idf = [];
        this.tfidfMatrix = new SparseMatrix();
        this.documents = [];
        this.stopWords = new Set([ 'a', 'an', 'the', 'is', 'are', 'to', 'of', 'and',
            'in', 'on', 'for', 'with', 'as', 'by', 'at', 'this', 'that',
            'it', 'its', 'be', 'was', 'were', 'not', 'but', 'or', 'if',
            'so', 'such', 'all', 'any', 'no', 'yes', 'do', 'does', 'did',
            'doing', 'done', 'can', 'could', 'will', 'would', 'shall',
            'should', 'may', 'might', 'must', 'like', 'just', 'now', 'then',
            'than', 'more', 'most', 'less', 'least', 'some', 'many', 'much',
            'few', 'fewer', 'least', 'each', 'every', 'either', 'neither',
            'both', 'other', 'another', 'such', 'same', 'own', 'other' ]);
        this.log = (message: string) => {
            console.log(message);
        };
    }

    /**
     * Sets the list of stop words to ignore during tokenization.
     * @param stopWords - Array of lowercase words to exclude from processing.
     */
    set StopWords(stopWords: string[]) {
        this.stopWords.clear();
        stopWords.forEach(word => {
            this.stopWords.add(word.toLowerCase());
        });
    }

    /**
     * Gets the current list of stop words.
     * @returns An array of stop words.
     */
    get StopWords(): string[] {
        return Array.from(this.stopWords);
    }

    toData(): genericVectorizer {
        return {
            vocabulary: this.vocabulary,
            idf: this.idf,
            tfidfMatrix: this.tfidfMatrix.toData(),
            documents: this.documents,
            stopWords: this.stopWords
        };
    }

    toJSON(): string {
        return JSON.stringify(this.toData());
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
        this.documents = corpus;
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

    /**
     * Computes the TF-IDF sparse matrix for the provided documents using the existing vocabulary.
     * @param corpus - Array of documents to transform.
     * @returns A SparseMatrix representing the TF-IDF scores.
     */
    transform(corpus: string[]): SparseMatrix {
        const matrix = new SparseMatrix();

        corpus.forEach((doc, docIndex) => {
            const tokens = this.tokenize(doc);
            const tf: Record<number, number> = {};

            tokens.forEach(token => {
                if (this.vocabulary.has(token)) {
                    const index = this.vocabulary.get(token)!;
                    tf[ index ] = (tf[ index ] || 0) + 1;
                }
            });

            const docLength = tokens.length;
            Object.keys(tf).forEach(index => {
                const idx = parseInt(index);
                const tfidf = (tf[ idx ] / docLength) * this.idf[ idx ];
                matrix.add(docIndex, idx, tfidf);
            });
        });

        return matrix;
    }

    /**
     * Builds the vocabulary and transforms the corpus into a TF-IDF matrix (synchronously).
     * @param corpus - Array of documents to fit and transform.
     * @returns A SparseMatrix of TF-IDF values.
     */
    fitTransformSync(corpus: string[]): SparseMatrix {
        this.fit(corpus);
        this.tfidfMatrix = this.transform(corpus);
        return this.tfidfMatrix;
    }

    /**
     * Asynchronously fits the vocabulary and computes TF-IDF matrix for the corpus.
     * @param corpus - Array of documents to process.
     * @returns A Promise resolving to a SparseMatrix of TF-IDF values.
     */
    fitTransform(corpus: string[]): Promise<SparseMatrix> {
        return new Promise((resolve) => {
            this.fit(corpus);
            this.tfidfMatrix = this.transform(corpus);
            resolve(this.tfidfMatrix);
        });
    }

    /**
     * Calculates cosine similarity between two sparse vectors.
     * @param vecA - First vector represented as index-value pairs.
     * @param vecB - Second vector represented as index-value pairs.
     * @returns A similarity score between 0 and 1.
     */
    cosineSimilarity(vecA: Record<number, number>, vecB: Record<number, number>): number {
        let dot = 0, normA = 0, normB = 0;

        const keys = new Set([ ...Object.keys(vecA), ...Object.keys(vecB) ]);
        keys.forEach(key => {
            const k = parseInt(key);
            const a = vecA[ k ] || 0;
            const b = vecB[ k ] || 0;
            dot += a * b;
            normA += a * a;
            normB += b * b;
        });

        return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
    }

    /**
     * Asynchronously searches for documents most similar to the query string.
     * @param query - A string to search against the corpus.
     * @param topN - Number of top results to return. Default is 3.
     * @returns A Promise resolving to an array of matching documents and their scores.
     */
    Search(query: string, topN = 3): Promise<{ document: string; score: number; }[]> {
        console.log(`Searching for: ${ query }`);
        return new Promise(resolve => {
            resolve(this.SearchSync(query, topN));
        });
    }

    /**
     * Searches the corpus for documents most similar to the query (synchronously).
     * @param query - A string to search against the corpus.
     * @param topN - Number of top results to return. Default is 3.
     * @returns An array of matching documents and their similarity scores.
     */
    SearchSync(query: string, topN = 3): { document: string; score: number; }[] {
        console.log(`Searching for: ${ query }`);
        const queryVec: Record<number, number> = {};
        const tokens = this.tokenize(query);

        tokens.forEach(token => {
            if (this.vocabulary.has(token)) {
                const index = this.vocabulary.get(token)!;
                queryVec[ index ] = (queryVec[ index ] || 0) + 1;
            }
        });

        const total = tokens.length;
        Object.keys(queryVec).forEach(index => {
            const idx = parseInt(index);
            queryVec[ idx ] = (queryVec[ idx ] / total) * this.idf[ idx ];
        });

        const scores: { index: number; score: number; }[] = [];

        for (let i = 0; i < this.tfidfMatrix.shape[ 0 ]; i++) {
            const docVec = this.tfidfMatrix.getRow(i);
            const score = this.cosineSimilarity(queryVec, docVec);
            scores.push({ index: i, score });
        }

        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topN).map(r => ({
            document: this.documents[ r.index ],
            score: r.score
        }));
    }
}

export { TfidfVectorizer, SparseMatrix };
