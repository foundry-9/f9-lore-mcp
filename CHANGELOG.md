# Changelog

## [Unreleased]

### Added

- **MIT License** for open-source distribution
- **versions.json** for Obsidian plugin registry compatibility

### Removed

- **Console logging** removed from production code for cleaner output

### Changed

- **Internal refactoring** for improved code maintainability
  - Extracted path normalization utilities for consistent path handling
  - Consolidated error response helpers across MCP tools
  - Extracted MCP tools into separate modules by category (basic-ops, folder-ops, structure-read, structure-write, vector-search, text-search)
  - Created shared utility module (`src/mcp/utils.ts`) with DRY helpers
  - Host.ts reduced from ~2200 lines to ~370 lines
  - Removed unused code from TF-IDF vectorizer (340 lines to 75 lines)
  - Removed unused setter methods from embedding providers

- **Rich status bar indicator** with animated spinner and detailed tooltips
  - Animated spinner icon during indexing operations (spinning circle phases)
  - Checkmark (✓) when idle and healthy
  - Warning icon (⚠) when errors occurred in the last 5 minutes
  - Progress display shows "X/Y" during bulk indexing operations
  - Hover tooltip shows:
    - Port number and MCP session count
    - Current file being indexed (truncated if too long)
    - Number of pending files
    - Recent error details with age and file path
    - Index statistics (file count, chunk count)
    - Current embedding provider
  - Status bar updates every 500ms for responsive spinner animation

### Changed

- **Plugin renamed** from "F9 Obsidian MCP" to "F9 Lore MCP"
  - ID changed from `f9-obsidian-mcp` to `f9-lore-mcp` (complies with plugin guidelines: no "obsidian" in ID/name)
  - Cache directory changed from `f9-obsidian-mcp` to `f9-lore-mcp`
  - Class names updated: `F9LoreMCPPlugin`, `F9LoreMCPSettings`, `LoreMcpHost`
  - All internal references updated

- **README.md rewritten** to document current plugin features
  - Complete list of all MCP tools (note ops, folder ops, granular editing, vector search, text search)
  - Installation instructions (from source and for development)
  - Configuration guide (basic settings, HTTPS, vector search providers)
  - Claude Desktop integration instructions with mcp-remote
  - Multi-session support documentation
  - Updated file structure overview

- **Hybrid mtime+hash staleness detection for vector indexing**
  - Staleness detection now uses content hashes (SHA-256) in addition to mtime
  - Fast path: If mtime unchanged, file is assumed unchanged (no I/O needed)
  - Hash check: If mtime changed, content hash is computed and compared
  - Avoids unnecessary reindexing when files are touched but content is unchanged (git operations, sync tools, backups)
  - Index version bumped to 3; existing v2 indexes will require full reindex on upgrade

- **Embedding index moved to system cache directory**
  - Embeddings are now stored in a platform-appropriate cache directory instead of `data.json`
  - macOS: `~/Library/Caches/f9-lore-mcp/<vault-hash>/embeddings.json`
  - Windows: `%LOCALAPPDATA%/f9-lore-mcp/<vault-hash>/embeddings.json`
  - Linux: `~/.cache/f9-lore-mcp/<vault-hash>/embeddings.json`
  - Prevents embeddings from being synced across devices (which caused index corruption)
  - Vault-specific hash allows symlinked plugin directories to work correctly with multiple vaults
  - Automatic migration from legacy `data.json` storage on first load
  - Legacy `embeddingIndex` key is removed from `data.json` after successful migration or cache load

### Fixed

- **Unnecessary re-embedding when file modify events fire without content changes**
  - Obsidian fires "modify" events during startup for some files even when content hasn't changed
  - Previously, any modify event triggered re-embedding after the debounce period
  - Now compares content hash before re-embedding; skips if hash matches stored value
  - Mtime-only updates are batched with a 2-second debounce to avoid repeated saves
  - Also fixes mtime-only updates not being persisted after `checkForStaleFiles()`
  - Added error handling around async save operations to surface failures in console

- **`refresh_index` and `reindex_vault` tools broken due to renamed method**
  - Tools were calling non-existent `checkOllamaConnection()` method on VectorIndexer
  - Method was renamed to `checkProviderConnection()` when multi-provider support was added
  - Error messages updated to be provider-agnostic ("Embedding provider is not available" instead of Ollama-specific)

- **Legacy embeddingIndex cleanup now checks per-vault location**
  - Previous cleanup only checked top-level `data["embeddingIndex"]`, but Obsidian stores settings under `data.vaults[vaultName]`
  - Now also removes `data.vaults[vaultName].embeddingIndex` to properly clean up legacy data

- **Race condition in per-file vector indexing**
  - Added `isIndexing` guard to `processFileAfterDebounce` to prevent concurrent file processing
  - Files that arrive while indexing is in progress are re-scheduled instead of processed concurrently
  - `processPendingFiles` now properly sets `isIndexing` flag during bulk processing
  - Fixes potential startup hang caused by concurrent `saveIndex()` calls racing on plugin data

### Added

- **TF-IDF embedding provider** as a third option alongside Ollama and OpenAI
  - Works fully offline with no external services required
  - No local LLM needed (unlike Ollama)
  - Fast search using pre-computed TF-IDF vectors (vocabulary fitted during reindex)
  - Vocabulary and IDF weights persisted alongside embedding index
  - Incremental indexing uses existing vocabulary (new terms ignored until reindex)
  - **Vocabulary drift tracking**: Unknown terms are tracked during incremental indexing
    - Settings show vocabulary size and number of unknown terms since last reindex
    - Warning displayed when drift is detected with sample of new terms
    - Helps users know when it's time to reindex for better search accuracy
  - Keyword-based matching (less semantic understanding than neural embeddings)
  - Good for users who want simple search without API costs or local LLM setup

- **Per-file debouncing for vector indexing**
  - Each file must be quiescent (unchanged) for the configured duration before being sent to the embedder
  - New "Indexing delay" setting in Vector Search settings (configurable in seconds)
  - Default changed from 2 seconds to 10 seconds
  - Prevents excessive re-indexing during active editing sessions
  - Each file has its own independent timer; editing one file doesn't delay indexing of other quiescent files

- **Unicode diacritical normalization for search tools**
  - Searching for "Nimue" now matches "Nimuë" (and similar diacritical variations)
  - Uses Unicode NFD normalization to decompose characters, then strips combining marks (U+0300–U+036F) for comparison
  - `grep` tool: New `normalize_diacritics` parameter (default: `true`) for literal searches
  - `str_replace` tool: New `normalize_diacritics` parameter (default: `true`) - finds normalized matches but replaces original text
  - `search` tool: Queries are automatically normalized for better semantic matching
  - Original content is always preserved; normalization is only used for comparison/matching

- **`grep` tool** for text and regex search across vault notes
  - Search for literal strings or regex patterns
  - Optional case-sensitive matching (`case_sensitive` parameter)
  - Scope search to a single file, folder, or entire vault (`path` parameter)
  - Configurable context lines before/after matches (`context_lines` parameter)
  - Returns file path, line number, and matching content
  - Limit results with `max_results` parameter (default: 100)

- **`str_replace` tool** for find-and-replace across vault notes
  - Replace all occurrences of an exact string (no regex)
  - Optional case-sensitive matching (`case_sensitive` parameter, default: true)
  - Scope replacements to a single file, folder, or entire vault (`path` parameter)
  - Dry-run mode to preview changes without modifying files (`dry_run` parameter)
  - Reports number of replacements per file

- **Dynamic status bar** showing real-time plugin state
  - Displays port number and active MCP session count (e.g., "F9 MCP:3000 | 2 sessions")
  - Shows indexing status when files are being embedded ("indexing..." or "3 pending")
  - Shows "off" when MCP server is disabled, "starting..." during initialization
  - Updates every 2 seconds for responsive feedback

- **OpenAI embeddings support** as alternative to Ollama
  - New "Embedding provider" dropdown to choose between Ollama (local) and OpenAI
  - OpenAI settings: API key (masked), model selector with common models, custom model input
  - Supported OpenAI models: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
  - Optional custom API endpoint for Azure OpenAI or compatible services
  - Provider abstraction allows easy addition of future embedding providers

- **Fuzzy filename matching for `read_note` tool**
  - When exact path is not found, searches all vault files for best filename match
  - Matches by filename (ignoring path and `.md` extension), e.g., "Friday Core" finds "Prompts/Friday Core.md"
  - Returns `fuzzy_match: true`, `requested_path`, and `actual_path` in JSON response when fuzzy matched
  - Exact matches still return plain text content for backwards compatibility

- **Client-based session cleanup**
  - When a client reconnects, any existing sessions from the same client are automatically closed
  - Client identity determined by IP address + User-Agent header combination
  - Prevents session accumulation from reconnecting clients (Claude Desktop, mcp-remote, etc.)
  - Logged when stale sessions are cleaned up

- **Configurable session timeout**
  - Sessions that haven't received requests are automatically closed after the configured timeout
  - Default timeout: 30 minutes (configurable in settings)
  - Background cleanup runs every 5 minutes
  - Prevents orphaned sessions from accumulating memory

- **Debounced server restart on configuration changes**
  - MCP server restarts are debounced by 2 seconds when settings change
  - Prevents rapid restarts when adjusting multiple settings quickly
  - Applies to port, HTTPS, TLS, session timeout, and other server configuration

- **Per-vault settings storage**
  - Settings are now keyed by vault name in `data.json`
  - Multiple vaults can share the same plugin folder (e.g., symlinked for development) without overwriting each other's settings
  - Each vault can have its own port, HTTPS config, etc.
  - Existing settings are automatically migrated on first load

### Changed

- **File path prepended to vector search chunks**
  - Each chunk now includes `[path/to/file.md]` prefix before the content
  - Improves semantic search matching on filenames and folder paths
  - e.g., searching "meeting notes" now matches files named "Meeting Notes.md" even if the content doesn't mention meetings
  - Note: Existing embeddings should be reindexed to include the new filename context

- **Improved `search` and `grep` tool descriptions** to clarify intended use cases
  - `search`: Positioned as the default tool for exploring the vault, finding information about topics, and discovering relationships/patterns/concepts
  - `grep`: Positioned as a surgical tool for precise text matching, typically when locating something specific to edit

- **`search` tool now returns full chunk content** instead of truncated 200-character previews
  - Previously, previews showed only the first 200 characters, which might not contain the semantically relevant content
  - Now returns the full ~2000 character chunk so the matched content is always visible
  - Results separated by `---` dividers for readability

- **Refactored embedding system to use provider abstraction**
  - `EmbeddingProvider` interface implemented by both `OllamaClient` and new `OpenAIClient`
  - Index invalidation now based on provider key (includes provider type + model + endpoint)
  - Breaking: Index version bumped to 2, existing embeddings will be re-indexed on first use

- **HTTPS is now optional** - MCP server can run in HTTP mode (default) or HTTPS mode
  - New "Enable HTTPS" toggle in settings
  - HTTP mode is simpler to configure and works with clients that don't require TLS
  - HTTPS mode still available for Claude Desktop and other clients requiring trusted TLS
- **TLS configuration uses inline content instead of file paths**
  - Certificate and key content are pasted directly into settings textareas
  - Eliminates file path issues and makes configuration more portable
  - TLS settings only appear when HTTPS is enabled

### Added

- **Claude Desktop configuration snippet** in settings
  - Shows copyable JSON config for `claude_desktop_config.json`
  - Automatically uses vault name as slug (e.g., `f9-lore-my-vault`)
  - Includes correct protocol (http/https) and port from settings
  - Adds `NODE_TLS_REJECT_UNAUTHORIZED=0` env var when HTTPS is enabled
  - Copy button for easy clipboard access
  - Shows direct `npx mcp-remote` command as alternative

### Removed

- Sample toggle setting (unused boilerplate from plugin template)

### Fixed

- Remove dots from tool names to fix Claude Desktop compatibility
  - Claude Desktop's frontend validation requires tool names to match `^[a-zA-Z0-9_-]{1,64}$`
  - Removed `obsidian.` prefix from all tools (e.g., `obsidian.ping` → `ping`)
- Fix `tools/list` failing in Obsidian's bundled environment due to Zod schema serialization issue
  - `z.record(z.any())` and `z.record(z.unknown())` fail to convert to JSON schema when bundled with esbuild for Obsidian
  - Changed `update_frontmatter` tool's `updates` field from `z.record(z.any())` to `z.record(z.string(), z.string())`
  - Frontmatter values are now JSON-stringified; use `'null'` string to delete a key

### Added

- **Multi-session support** for concurrent MCP client connections
  - Multiple clients (Claude Desktop, Claude.ai, mcp-remote, etc.) can now connect simultaneously
  - Each client gets its own isolated MCP session with independent state
  - Sessions are created on-demand when clients send initialize requests
  - Session routing based on `mcp-session-id` header
  - Health endpoint now reports active session count
  - Sessions are properly cleaned up on client disconnect or server shutdown

- **HTTPS support with mkcert certificates** for secure localhost connections
  - MCP server now uses HTTPS instead of HTTP
  - Compatible with Claude Desktop and other clients requiring trusted TLS
  - New settings: TLS certificate file path, TLS key file path
  - Validates certificate files exist before server startup
  - Clear error messages via Obsidian Notice when TLS configuration is invalid

- **Granular markdown editing tools** for token-efficient note editing
  - `get_note_structure` - Get structural overview (headings, sections, list items, frontmatter) with freshness token
  - `read_section` - Read specific section content by ID
  - `read_heading_content` - Read all content under a heading
  - `read_frontmatter` - Read frontmatter as structured JSON
  - `update_section` - Update a section's content
  - `delete_section` - Delete a section from a note
  - `update_heading_content` - Update content under a heading (with subheading preservation option)
  - `rename_heading` - Rename a heading (change text and/or level)
  - `update_list_item` - Update list item text and/or task status
  - `update_frontmatter` - Update frontmatter properties (merge or replace)
  - `insert_content` - Insert content at specific positions (after/before section, under heading, at line, at start/end)
  - Freshness tokens for staleness detection to prevent conflicting edits
  - Post-write verification to confirm changes were applied correctly
- **Vector search with local Ollama embeddings**
  - Automatic embedding of markdown files on create/modify/delete/rename events
  - Fixed-size chunking (~500 tokens) with overlap for better search granularity
  - Staleness detection on plugin startup to reindex modified files
  - `search` tool for semantic vector search across vault notes
  - `reindex_vault` tool to force re-embed all files
  - `refresh_index` tool to check for stale files and reindex them
  - Settings UI for Ollama URL, model selection, auto-indexing toggle, and manual reindex
  - Embeddings stored in plugin data.json (syncs with vault)
- `list_folders` tool to list folders in the vault (with optional parent folder filter)
- `list_notes` tool to list notes in the vault (with optional folder filter)
- `read_note` tool to read the contents of a note
- `update_note` tool to update the contents of an existing note
- `create_folder` tool to create folders (with intermediate folder creation)
- `delete_folder` tool to delete folders (with `delete_if_not_empty` option)
- `move_or_rename_note` tool to move or rename notes within the vault
- `delete_note` tool to delete notes (moves to system trash)

### Changed

- Refactored MCP host architecture to support multiple concurrent sessions
  - Each session now has its own McpServer and transport instance
  - Tool registration extracted into reusable `registerTools()` method
- Updated Zod from 3.23.8 to 4.3.5
- Migrated from deprecated `McpServer.tool()` to `McpServer.registerTool()` API
- Updated CLAUDE.md with complete list of current MCP tools
