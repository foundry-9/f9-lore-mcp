/**
 * Vector indexer - main orchestrator for embedding and search
 */

import type { App, Plugin, TFile, FileSystemAdapter } from "obsidian";
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
import { createHash } from "crypto";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

/** Key used to store embedding index in plugin data (legacy, for migration) */
const EMBEDDING_INDEX_KEY = "embeddingIndex";

/** Cache file name for embeddings */
const EMBEDDINGS_CACHE_FILE = "embeddings.json";

/**
 * Get the platform-appropriate cache directory for the plugin.
 */
function getCacheBaseDir(): string {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "f9-obsidian-mcp");
  } else if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "f9-obsidian-mcp"
    );
  } else {
    // Linux and others - use XDG_CACHE_HOME or fallback to ~/.cache
    return path.join(
      process.env.XDG_CACHE_HOME || path.join(home, ".cache"),
      "f9-obsidian-mcp"
    );
  }
}

/**
 * Create a short hash of the vault path for unique cache directory.
 */
function getVaultHash(vaultPath: string): string {
  return createHash("sha256").update(vaultPath).digest("hex").slice(0, 16);
}

/**
 * Get the full path to the cache file for a specific vault.
 */
function getCacheFilePath(vaultPath: string): string {
  const vaultHash = getVaultHash(vaultPath);
  return path.join(getCacheBaseDir(), vaultHash, EMBEDDINGS_CACHE_FILE);
}

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
  /** Per-file debounce timers - each file gets its own timer */
  private fileDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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
   * Get the absolute path to the vault root.
   */
  private getVaultPath(): string {
    return (this.app.vault.adapter as FileSystemAdapter).getBasePath();
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
   * Load the embedding index from cache file.
   * Falls back to legacy data.json and migrates if found.
   * Creates an empty index if none exists or if migration is needed.
   */
  async loadIndex(): Promise<void> {
    const currentProviderKey = this.provider.getProviderKey();
    const vaultPath = this.getVaultPath();
    const cacheFilePath = getCacheFilePath(vaultPath);

    // Try loading from cache file first
    try {
      const cacheContent = await fs.readFile(cacheFilePath, "utf-8");
      const stored = JSON.parse(cacheContent) as EmbeddingIndex;

      if (stored && stored.version === EMBEDDING_INDEX_VERSION) {
        if (stored.providerKey !== currentProviderKey) {
          console.log(
            `F9 MCP: Embedding provider changed from ${stored.providerKey} to ${currentProviderKey}, index invalidated`
          );
          this.index = createEmptyIndex(currentProviderKey);
        } else {
          console.log(`F9 MCP: Loaded embedding index from cache (${stored.chunks.length} chunks)`);
          this.index = stored;
        }

        // Clean up any leftover legacy data from a previous migration
        await this.cleanupLegacyData();
        return;
      }
    } catch {
      // Cache file doesn't exist or is invalid, check for legacy data
    }

    // Try loading from legacy data.json for migration
    const data = await this.plugin.loadData();
    const legacyStored = data?.[EMBEDDING_INDEX_KEY] as EmbeddingIndex | undefined;

    if (legacyStored && legacyStored.version === EMBEDDING_INDEX_VERSION) {
      if (legacyStored.providerKey !== currentProviderKey) {
        console.log(
          `F9 MCP: Embedding provider changed from ${legacyStored.providerKey} to ${currentProviderKey}, index invalidated`
        );
        this.index = createEmptyIndex(currentProviderKey);
      } else {
        console.log(
          `F9 MCP: Migrating embedding index from data.json to cache (${legacyStored.chunks.length} chunks)`
        );
        this.index = legacyStored;

        // Save to cache file
        await this.saveIndex();

        // Remove from data.json
        delete data[EMBEDDING_INDEX_KEY];
        await this.plugin.saveData(data);
        console.log("F9 MCP: Migration complete, removed embeddingIndex from data.json");
      }
      return;
    }

    // No existing index found, create empty
    this.index = createEmptyIndex(currentProviderKey);
  }

  /**
   * Remove legacy embedding data from data.json if it exists.
   * This cleans up after migration to the cache file.
   * Checks both top-level and per-vault locations.
   */
  private async cleanupLegacyData(): Promise<void> {
    try {
      const data = await this.plugin.loadData();
      if (!data) return;

      let cleaned = false;

      // Check top-level (original legacy location)
      if (EMBEDDING_INDEX_KEY in data) {
        delete data[EMBEDDING_INDEX_KEY];
        cleaned = true;
      }

      // Check per-vault location (where Obsidian's saveData may have placed it)
      const vaultName = this.app.vault.getName();
      if (data.vaults?.[vaultName]?.[EMBEDDING_INDEX_KEY]) {
        delete data.vaults[vaultName][EMBEDDING_INDEX_KEY];
        cleaned = true;
      }

      if (cleaned) {
        await this.plugin.saveData(data);
        console.log("F9 MCP: Cleaned up legacy embeddingIndex from data.json");
      }
    } catch (err) {
      console.error("F9 MCP: Failed to clean up legacy data:", err);
    }
  }

  /**
   * Save the embedding index to the cache file.
   */
  async saveIndex(): Promise<void> {
    const vaultPath = this.getVaultPath();
    const cacheFilePath = getCacheFilePath(vaultPath);
    const cacheDir = path.dirname(cacheFilePath);

    // Ensure cache directory exists
    await fs.mkdir(cacheDir, { recursive: true });

    // Write index to cache file
    await fs.writeFile(cacheFilePath, JSON.stringify(this.index), "utf-8");
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

    // Prepend file path to each chunk for better semantic search on filenames
    const filePrefix = `[${file.path}]\n\n`;
    const chunksWithPath = chunks.map(chunk => filePrefix + chunk);

    // Generate embeddings for chunks with file path context
    const embeddings = await this.provider.embed(chunksWithPath);

    // Remove old chunks for this file
    this.index.chunks = this.index.chunks.filter(c => c.filePath !== file.path);

    // Add new chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk: ChunkEmbedding = {
        id: `${file.path}::${i}`,
        filePath: file.path,
        chunkIndex: i,
        preview: chunksWithPath[i].slice(0, 200),
        content: chunksWithPath[i],
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
   * Queue a file for indexing with per-file debouncing.
   * Each file must be quiescent (no changes) for the configured duration before being indexed.
   *
   * @param path - Vault-relative path of the file
   */
  queueFileForIndexing(path: string): void {
    this.pendingFiles.add(path);

    // Clear any existing timer for this specific file
    const existingTimer = this.fileDebounceTimers.get(path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Start a new timer for this file
    const timer = setTimeout(
      () => this.processFileAfterDebounce(path),
      this.settings.debounceMs
    );
    this.fileDebounceTimers.set(path, timer);
  }

  /**
   * Process a single file after its debounce period has elapsed.
   * Uses isIndexing flag to serialize processing and prevent race conditions.
   *
   * @param path - Vault-relative path of the file
   */
  private async processFileAfterDebounce(path: string): Promise<void> {
    // Clean up the timer entry
    this.fileDebounceTimers.delete(path);

    // Skip if file was removed from pending (e.g., deleted)
    if (!this.pendingFiles.has(path)) {
      return;
    }

    // If already indexing, re-schedule for later to prevent concurrent processing
    if (this.isIndexing) {
      const timer = setTimeout(
        () => this.processFileAfterDebounce(path),
        this.settings.debounceMs
      );
      this.fileDebounceTimers.set(path, timer);
      return;
    }

    this.isIndexing = true;
    this.pendingFiles.delete(path);

    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      this.isIndexing = false;
      return;
    }

    console.log(`F9 MCP: Indexing ${path} after quiescence period`);

    try {
      await this.indexFile(file);
      await this.saveIndex();
    } catch (err) {
      console.error(`F9 MCP: Failed to index ${path}:`, err);
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Process all pending files in the queue immediately (used for startup bulk processing).
   */
  private async processPendingFiles(): Promise<void> {
    if (this.isIndexing || this.pendingFiles.size === 0) {
      return;
    }

    this.isIndexing = true;

    const paths = Array.from(this.pendingFiles);
    this.pendingFiles.clear();

    // Clear all pending per-file timers since we're processing everything now
    for (const [, timer] of this.fileDebounceTimers) {
      clearTimeout(timer);
    }
    this.fileDebounceTimers.clear();

    console.log(`F9 MCP: Processing ${paths.length} pending files`);

    try {
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
    } finally {
      this.isIndexing = false;
    }
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

    // Clean up any pending debounce timer for this file
    const timer = this.fileDebounceTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.fileDebounceTimers.delete(path);
    }
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

    // Transfer any pending debounce timer to the new path
    const timer = this.fileDebounceTimers.get(oldPath);
    if (timer) {
      // Cancel the old timer and start a new one for the new path
      clearTimeout(timer);
      this.fileDebounceTimers.delete(oldPath);
      const newTimer = setTimeout(
        () => this.processFileAfterDebounce(newPath),
        this.settings.debounceMs
      );
      this.fileDebounceTimers.set(newPath, newTimer);
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
   * Get the current indexing status for status bar display.
   */
  getIndexingStatus(): { isIndexing: boolean; pendingCount: number } {
    return {
      isIndexing: this.isIndexing,
      pendingCount: this.pendingFiles.size,
    };
  }

  /**
   * Check if the embedding provider is available.
   */
  async checkProviderConnection(): Promise<boolean> {
    return this.provider.isAvailable();
  }
}
