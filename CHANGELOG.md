# Changelog

## [Unreleased]

### Added

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
  - Displays active MCP session count (e.g., "F9 MCP | 2 sessions")
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

### Changed

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
  - Automatically uses vault name as slug (e.g., `f9-obsidian-my-vault`)
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
