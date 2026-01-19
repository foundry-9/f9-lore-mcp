/**
 * Vector indexer - main orchestrator for embedding and search
 */

import type { App, Plugin, TFile, FileSystemAdapter } from "obsidian";
import type {
  EmbeddingIndex,
  VectorSearchSettings,
  SearchResult,
  ChunkEmbedding,
  ExtendedIndexingStatus,
  IndexingError,
  PluginHealthState,
} from "./types";
import { createEmptyIndex, EMBEDDING_INDEX_VERSION } from "./types";
import { chunkMarkdown } from "./chunker";
import type { EmbeddingProvider } from "./provider";
import { createEmbeddingProvider } from "./provider";
import { TfidfClient } from "./tfidf";
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
    return path.join(home, "Library", "Caches", "f9-lore-mcp");
  } else if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "f9-lore-mcp"
    );
  } else {
    // Linux and others - use XDG_CACHE_HOME or fallback to ~/.cache
    return path.join(
      process.env.XDG_CACHE_HOME || path.join(home, ".cache"),
      "f9-lore-mcp"
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
 * Compute a SHA-256 hash of content, returned as hex string.
 */
function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  /** Debounce timer for batching save operations */
  private saveDebounceTimer?: ReturnType<typeof setTimeout>;
  /** Track if there are unsaved changes that need to be persisted */
  private hasPendingSave = false;
  /** Current file being indexed (for progress display) */
  private currentFile: string | null = null;
  /** Progress of current bulk indexing operation */
  private indexingProgress: { current: number; total: number } | null = null;
  /** Last indexing error (for status display) */
  private lastError: IndexingError | null = null;

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

      if (stored && stored.version !== EMBEDDING_INDEX_VERSION) {
        // Index version mismatch, reindex required
      } else if (stored && stored.version === EMBEDDING_INDEX_VERSION) {
        if (stored.providerKey !== currentProviderKey) {
          this.index = createEmptyIndex(currentProviderKey);
        } else {
          this.index = stored;
          // Load TF-IDF state if present and using TF-IDF provider
          this.loadTfidfState();
        }

        // Clean up any leftover legacy data from a previous migration
        await this.cleanupLegacyData();
        return;
      }
    } catch (err) {
      // Cache file doesn't exist or is invalid, check for legacy data
    }

    // Try loading from legacy data.json for migration
    const data = await this.plugin.loadData();
    const legacyStored = data?.[EMBEDDING_INDEX_KEY] as EmbeddingIndex | undefined;

    if (legacyStored && legacyStored.version === EMBEDDING_INDEX_VERSION) {
      if (legacyStored.providerKey !== currentProviderKey) {
        this.index = createEmptyIndex(currentProviderKey);
      } else {
        this.index = legacyStored;
        // Load TF-IDF state if present and using TF-IDF provider
        this.loadTfidfState();

        // Save to cache file
        await this.saveIndex();

        // Remove from data.json
        delete data[EMBEDDING_INDEX_KEY];
        await this.plugin.saveData(data);
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
      }
    } catch (err) {
      // Failed to clean up legacy data
    }
  }

  /**
   * Load TF-IDF state from the index into the provider if applicable.
   */
  private loadTfidfState(): void {
    if (this.provider instanceof TfidfClient && this.index.tfidfState) {
      this.provider.loadState(this.index.tfidfState);
    }
  }

  /**
   * Save TF-IDF state from the provider to the index if applicable.
   */
  private saveTfidfState(): void {
    if (this.provider instanceof TfidfClient) {
      const state = this.provider.getState();
      if (state) {
        this.index.tfidfState = state;
      } else {
        delete this.index.tfidfState;
      }
    } else {
      // Clear TF-IDF state if not using TF-IDF provider
      delete this.index.tfidfState;
    }
  }

  /**
   * Save the embedding index to the cache file.
   */
  async saveIndex(): Promise<void> {
    const vaultPath = this.getVaultPath();
    const cacheFilePath = getCacheFilePath(vaultPath);
    const cacheDir = path.dirname(cacheFilePath);

    // Save TF-IDF state to index before writing
    this.saveTfidfState();

    // Ensure cache directory exists
    await fs.mkdir(cacheDir, { recursive: true });

    // Write index to cache file
    await fs.writeFile(cacheFilePath, JSON.stringify(this.index), "utf-8");

    // Clear pending save flag since we just saved
    this.hasPendingSave = false;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
    }
  }

  /**
   * Schedule a debounced save operation.
   * Multiple calls within the debounce window will be batched into a single save.
   * Use this for mtime-only updates that don't require immediate persistence.
   */
  private scheduleSave(): void {
    this.hasPendingSave = true;

    // Clear existing timer
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    // Schedule save after 2 seconds of inactivity
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = undefined;
      if (this.hasPendingSave) {
        this.saveIndex().catch(() => {
          // Error in scheduled save
        });
      }
    }, 2000);
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
      this.index = createEmptyIndex(newProviderKey);
    }
  }

  /**
   * Check all markdown files for staleness and queue stale ones for reindexing.
   * Called on plugin startup.
   *
   * Uses a hybrid mtime+hash approach:
   * - If mtime unchanged: skip (fast path)
   * - If mtime changed: compute hash and compare to detect actual content changes
   *
   * @returns Number of stale files queued
   */
  async checkForStaleFiles(): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    let staleCount = 0;
    let hashChecks = 0;
    let mtimeUpdates = 0;

    for (const file of files) {
      const storedMtime = this.index.fileMtimes[file.path];
      const storedHash = this.index.fileHashes[file.path];
      const currentMtime = file.stat.mtime;

      // New file - never indexed
      if (storedMtime === undefined) {
        this.pendingFiles.add(file.path);
        staleCount++;
        continue;
      }

      // Mtime unchanged - content hasn't changed (fast path)
      if (storedMtime >= currentMtime) {
        continue;
      }

      // Mtime changed - check content hash to detect actual changes
      hashChecks++;
      const content = await this.app.vault.read(file);
      const currentHash = computeContentHash(content);

      if (storedHash !== currentHash) {
        // Content actually changed - needs reindex
        this.pendingFiles.add(file.path);
        staleCount++;
      } else {
        // Content unchanged despite mtime change - update mtime to avoid future checks
        this.index.fileMtimes[file.path] = currentMtime;
        mtimeUpdates++;
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
      // Process with a small delay to let Obsidian finish loading
      setTimeout(() => {
        this.processPendingFiles().catch(() => {
          // Error processing pending files
        });
      }, 1000);
    } else if (mtimeUpdates > 0) {
      // Save index to persist mtime updates even when no files need re-embedding
      this.saveIndex().catch(() => {
        // Error saving index after mtime updates
      });
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
    const contentHash = computeContentHash(content);
    const chunks = chunkMarkdown(content, this.settings.chunkSize, this.settings.chunkOverlap);

    if (chunks.length === 0) {
      // Empty file - remove any existing chunks
      this.index.chunks = this.index.chunks.filter(c => c.filePath !== file.path);
      this.index.fileMtimes[file.path] = file.stat.mtime;
      this.index.fileHashes[file.path] = contentHash;
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
    this.index.fileHashes[file.path] = contentHash;
  }

  /**
   * Force re-embed all markdown files in the vault.
   *
   * For TF-IDF provider, this first collects all chunks to fit the vocabulary,
   * then embeds each file using the fitted vocabulary.
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
    this.index.fileHashes = {};
    this.index.providerKey = this.provider.getProviderKey();

    try {
      // For TF-IDF, we need to fit on the entire corpus first
      if (this.provider instanceof TfidfClient) {
        const allChunks: string[] = [];

        // First pass: collect all chunks for vocabulary building
        for (const file of files) {
          try {
            const content = await this.app.vault.read(file);
            const chunks = chunkMarkdown(content, this.settings.chunkSize, this.settings.chunkOverlap);
            const filePrefix = `[${file.path}]\n\n`;
            for (const chunk of chunks) {
              allChunks.push(filePrefix + chunk);
            }
          } catch (err) {
            // Ignore errors during collection - we'll report them during indexing
          }
        }

        this.provider.fitCorpus(allChunks);
      }

      // Second pass (or only pass for non-TF-IDF): index each file
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        this.currentFile = file.path;
        this.indexingProgress = { current: i + 1, total: files.length };
        progressCallback?.(file.path, i + 1, files.length);

        try {
          await this.indexFile(file);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${file.path}: ${message}`);
          this.lastError = {
            timestamp: Date.now(),
            filePath: file.path,
            message,
          };
        }
      }

      await this.saveIndex();
    } finally {
      this.isIndexing = false;
      this.currentFile = null;
      this.indexingProgress = null;
    }

    return { indexed: files.length - errors.length, errors };
  }

  /**
   * Perform a vector similarity search.
   *
   * All providers (Ollama, OpenAI, TF-IDF) use pre-computed embeddings.
   * For TF-IDF, the vocabulary must be fitted via reindexVault() first.
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
   * Skips indexing if the file content hasn't actually changed (hash comparison).
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

    // If already indexing, re-schedule for a short retry (not full debounce)
    if (this.isIndexing) {
      const timer = setTimeout(
        () => this.processFileAfterDebounce(path),
        100 // Short retry delay, not full debounceMs
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

    this.currentFile = path;
    try {
      // Check if content has actually changed using hash comparison
      const storedHash = this.index.fileHashes[path];
      if (storedHash) {
        const content = await this.app.vault.read(file);
        const currentHash = computeContentHash(content);
        if (storedHash === currentHash) {
          // Content unchanged - just update mtime and schedule batched save
          this.index.fileMtimes[path] = file.stat.mtime;
          this.scheduleSave();
          this.isIndexing = false;
          this.currentFile = null;
          return;
        }
      }

      await this.indexFile(file);
      await this.saveIndex();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = {
        timestamp: Date.now(),
        filePath: path,
        message,
      };
    } finally {
      this.isIndexing = false;
      this.currentFile = null;
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


    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        this.currentFile = path;
        this.indexingProgress = { current: i + 1, total: paths.length };

        const file = this.app.vault.getFileByPath(path);
        if (file) {
          try {
            await this.indexFile(file);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.lastError = {
              timestamp: Date.now(),
              filePath: path,
              message,
            };
          }
        }
      }

      await this.saveIndex();
    } finally {
      this.isIndexing = false;
      this.currentFile = null;
      this.indexingProgress = null;
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
    delete this.index.fileHashes[path];
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

    if (this.index.fileHashes[oldPath] !== undefined) {
      this.index.fileHashes[newPath] = this.index.fileHashes[oldPath];
      delete this.index.fileHashes[oldPath];
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
  getStats(): {
    fileCount: number;
    chunkCount: number;
    providerKey: string;
    tfidfDrift?: {
      unknownTermsCount: number;
      vocabularySize: number;
      driftPercentage: number;
      sampleUnknownTerms: string[];
    };
  } {
    const stats: ReturnType<typeof this.getStats> = {
      fileCount: Object.keys(this.index.fileMtimes).length,
      chunkCount: this.index.chunks.length,
      providerKey: this.index.providerKey,
    };

    // Include TF-IDF drift stats if using TF-IDF provider
    if (this.provider instanceof TfidfClient) {
      stats.tfidfDrift = this.provider.getVocabularyDriftStats();
    }

    return stats;
  }

  /**
   * Get the current indexing status for status bar display.
   */
  getIndexingStatus(): ExtendedIndexingStatus {
    let healthState: PluginHealthState = "ok";

    if (this.isIndexing || this.pendingFiles.size > 0) {
      healthState = "busy";
    } else if (this.lastError && Date.now() - this.lastError.timestamp < 5 * 60 * 1000) {
      healthState = "warning";
    }

    return {
      isIndexing: this.isIndexing,
      pendingCount: this.pendingFiles.size,
      progress: this.indexingProgress && this.currentFile ? {
        current: this.indexingProgress.current,
        total: this.indexingProgress.total,
        currentFile: this.currentFile,
      } : undefined,
      lastError: this.lastError ?? undefined,
      healthState,
    };
  }

  /**
   * Clear the last error (e.g., after user acknowledges it).
   */
  clearLastError(): void {
    this.lastError = null;
  }

  /**
   * Check if the embedding provider is available.
   */
  async checkProviderConnection(): Promise<boolean> {
    return this.provider.isAvailable();
  }
}
