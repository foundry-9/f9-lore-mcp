/**
 * Vector indexer - main orchestrator for embedding and search
 */

import type { App, Plugin, TFile } from "obsidian";
import type {
  EmbeddingIndex,
  VectorSearchSettings,
  SearchResult,
  ChunkEmbedding,
} from "./types";
import { createEmptyIndex, EMBEDDING_INDEX_VERSION } from "./types";
import { chunkMarkdown } from "./chunker";
import type { EmbeddingProvider } from "./provider";
import { createEmbeddingProvider } from "./provider";
import { topK } from "./similarity";

/** Key used to store embedding index in plugin data */
const EMBEDDING_INDEX_KEY = "embeddingIndex";

/**
 * VectorIndexer manages the embedding index for vector search.
 *
 * Responsibilities:
 * - Chunk and embed markdown files
 * - Persist embeddings to plugin data
 * - Handle file change events with debouncing
 * - Provide search functionality
 */
export class VectorIndexer {
  private index: EmbeddingIndex;
  private provider: EmbeddingProvider;
  private pendingFiles: Set<string> = new Set();
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private isIndexing = false;

  constructor(
    private app: App,
    private plugin: Plugin,
    private settings: VectorSearchSettings
  ) {
    this.provider = this.createProvider(settings);
    this.index = createEmptyIndex(this.provider.getProviderKey());
  }

  /**
   * Create an embedding provider based on settings.
   */
  private createProvider(settings: VectorSearchSettings): EmbeddingProvider {
    return createEmbeddingProvider({
      provider: settings.embeddingProvider,
      ollamaUrl: settings.ollamaUrl,
      ollamaModel: settings.embeddingModel,
      openaiApiKey: settings.openaiApiKey,
      openaiModel: settings.openaiModel,
      openaiBaseUrl: settings.openaiBaseUrl || undefined,
    });
  }

  /**
   * Load the embedding index from plugin data.
   * Creates an empty index if none exists or if migration is needed.
   */
  async loadIndex(): Promise<void> {
    const data = await this.plugin.loadData();
    const stored = data?.[EMBEDDING_INDEX_KEY] as EmbeddingIndex | undefined;
    const currentProviderKey = this.provider.getProviderKey();

    if (stored && stored.version === EMBEDDING_INDEX_VERSION) {
      // Check if provider changed - if so, index is invalid
      if (stored.providerKey !== currentProviderKey) {
        console.log(
          `F9 MCP: Embedding provider changed from ${stored.providerKey} to ${currentProviderKey}, index invalidated`
        );
        this.index = createEmptyIndex(currentProviderKey);
      } else {
        this.index = stored;
      }
    } else {
      this.index = createEmptyIndex(currentProviderKey);
    }
  }

  /**
   * Save the embedding index to plugin data.
   */
  async saveIndex(): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    data[EMBEDDING_INDEX_KEY] = this.index;
    await this.plugin.saveData(data);
  }

  /**
   * Update settings and reinitialize provider if needed.
   */
  updateSettings(settings: VectorSearchSettings): void {
    const oldProviderKey = this.provider.getProviderKey();

    this.settings = settings;
    this.provider = this.createProvider(settings);

    const newProviderKey = this.provider.getProviderKey();

    if (oldProviderKey !== newProviderKey) {
      console.log(
        `F9 MCP: Embedding provider changed from ${oldProviderKey} to ${newProviderKey}, index invalidated`
      );
      this.index = createEmptyIndex(newProviderKey);
    }
  }

  /**
   * Check all markdown files for staleness and queue stale ones for reindexing.
   * Called on plugin startup.
   *
   * @returns Number of stale files queued
   */
  async checkForStaleFiles(): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    let staleCount = 0;

    for (const file of files) {
      const storedMtime = this.index.fileMtimes[file.path];
      const currentMtime = file.stat.mtime;

      if (storedMtime === undefined || storedMtime < currentMtime) {
        this.pendingFiles.add(file.path);
        staleCount++;
      }
    }

    // Also check for deleted files in the index
    const currentPaths = new Set(files.map(f => f.path));
    for (const indexedPath of Object.keys(this.index.fileMtimes)) {
      if (!currentPaths.has(indexedPath)) {
        this.handleFileDelete(indexedPath);
      }
    }

    if (staleCount > 0) {
      console.log(`F9 MCP: Found ${staleCount} stale files, queueing for reindex`);
      // Process with a small delay to let Obsidian finish loading
      setTimeout(() => this.processPendingFiles(), 1000);
    }

    return staleCount;
  }

  /**
   * Index a single file: chunk it and generate embeddings.
   *
   * @param file - The file to index
   * @throws Error if embedding fails
   */
  async indexFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const chunks = chunkMarkdown(content, this.settings.chunkSize, this.settings.chunkOverlap);

    if (chunks.length === 0) {
      // Empty file - remove any existing chunks
      this.index.chunks = this.index.chunks.filter(c => c.filePath !== file.path);
      this.index.fileMtimes[file.path] = file.stat.mtime;
      return;
    }

    // Generate embeddings for all chunks
    const embeddings = await this.provider.embed(chunks);

    // Remove old chunks for this file
    this.index.chunks = this.index.chunks.filter(c => c.filePath !== file.path);

    // Add new chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk: ChunkEmbedding = {
        id: `${file.path}::${i}`,
        filePath: file.path,
        chunkIndex: i,
        preview: chunks[i].slice(0, 200),
        content: chunks[i],
        embedding: embeddings[i],
        embeddedAt: file.stat.mtime,
      };
      this.index.chunks.push(chunk);
    }

    this.index.fileMtimes[file.path] = file.stat.mtime;
  }

  /**
   * Force re-embed all markdown files in the vault.
   *
   * @param progressCallback - Optional callback for progress updates
   * @returns Object with indexed count and any errors
   */
  async reindexVault(
    progressCallback?: (file: string, current: number, total: number) => void
  ): Promise<{ indexed: number; errors: string[] }> {
    if (this.isIndexing) {
      return { indexed: 0, errors: ["Indexing already in progress"] };
    }

    this.isIndexing = true;
    const files = this.app.vault.getMarkdownFiles();
    const errors: string[] = [];

    // Clear existing index
    this.index.chunks = [];
    this.index.fileMtimes = {};
    this.index.providerKey = this.provider.getProviderKey();

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        progressCallback?.(file.path, i + 1, files.length);

        try {
          await this.indexFile(file);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${file.path}: ${message}`);
          console.error(`F9 MCP: Failed to index ${file.path}:`, err);
        }
      }

      await this.saveIndex();
    } finally {
      this.isIndexing = false;
    }

    return { indexed: files.length - errors.length, errors };
  }

  /**
   * Perform a vector similarity search.
   *
   * @param query - Natural language query
   * @param k - Number of results to return (default 10)
   * @returns Array of search results sorted by similarity
   * @throws Error if embedding the query fails
   */
  async search(query: string, k: number = 10): Promise<SearchResult[]> {
    if (this.index.chunks.length === 0) {
      return [];
    }

    const [queryEmbedding] = await this.provider.embed([query]);
    return topK(queryEmbedding, this.index.chunks, k);
  }

  /**
   * Queue a file for indexing with debouncing.
   * Multiple rapid changes will be batched together.
   *
   * @param path - Vault-relative path of the file
   */
  queueFileForIndexing(path: string): void {
    this.pendingFiles.add(path);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(
      () => this.processPendingFiles(),
      this.settings.debounceMs
    );
  }

  /**
   * Process all pending files in the queue.
   */
  private async processPendingFiles(): Promise<void> {
    if (this.isIndexing || this.pendingFiles.size === 0) {
      return;
    }

    const paths = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    this.debounceTimer = undefined;

    console.log(`F9 MCP: Processing ${paths.length} pending files`);

    for (const path of paths) {
      const file = this.app.vault.getFileByPath(path);
      if (file) {
        try {
          await this.indexFile(file);
        } catch (err) {
          console.error(`F9 MCP: Failed to index ${path}:`, err);
        }
      }
    }

    await this.saveIndex();
  }

  /**
   * Handle file deletion: remove from index.
   *
   * @param path - Path of the deleted file
   */
  handleFileDelete(path: string): void {
    this.index.chunks = this.index.chunks.filter(c => c.filePath !== path);
    delete this.index.fileMtimes[path];
    this.pendingFiles.delete(path);
  }

  /**
   * Handle file rename: update paths in index.
   *
   * @param oldPath - Previous path
   * @param newPath - New path
   */
  handleFileRename(oldPath: string, newPath: string): void {
    for (const chunk of this.index.chunks) {
      if (chunk.filePath === oldPath) {
        chunk.filePath = newPath;
        chunk.id = `${newPath}::${chunk.chunkIndex}`;
      }
    }

    if (this.index.fileMtimes[oldPath] !== undefined) {
      this.index.fileMtimes[newPath] = this.index.fileMtimes[oldPath];
      delete this.index.fileMtimes[oldPath];
    }

    // Update pending files if needed
    if (this.pendingFiles.has(oldPath)) {
      this.pendingFiles.delete(oldPath);
      this.pendingFiles.add(newPath);
    }
  }

  /**
   * Get statistics about the current index.
   */
  getStats(): { fileCount: number; chunkCount: number; providerKey: string } {
    return {
      fileCount: Object.keys(this.index.fileMtimes).length,
      chunkCount: this.index.chunks.length,
      providerKey: this.index.providerKey,
    };
  }

  /**
   * Check if the embedding provider is available.
   */
  async checkProviderConnection(): Promise<boolean> {
    return this.provider.isAvailable();
  }
}
