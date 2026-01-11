# Changelog

## [Unreleased]

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
  - `obsidian.get_note_structure` - Get structural overview (headings, sections, list items, frontmatter) with freshness token
  - `obsidian.read_section` - Read specific section content by ID
  - `obsidian.read_heading_content` - Read all content under a heading
  - `obsidian.read_frontmatter` - Read frontmatter as structured JSON
  - `obsidian.update_section` - Update a section's content
  - `obsidian.delete_section` - Delete a section from a note
  - `obsidian.update_heading_content` - Update content under a heading (with subheading preservation option)
  - `obsidian.rename_heading` - Rename a heading (change text and/or level)
  - `obsidian.update_list_item` - Update list item text and/or task status
  - `obsidian.update_frontmatter` - Update frontmatter properties (merge or replace)
  - `obsidian.insert_content` - Insert content at specific positions (after/before section, under heading, at line, at start/end)
  - Freshness tokens for staleness detection to prevent conflicting edits
  - Post-write verification to confirm changes were applied correctly
- **Vector search with local Ollama embeddings**
  - Automatic embedding of markdown files on create/modify/delete/rename events
  - Fixed-size chunking (~500 tokens) with overlap for better search granularity
  - Staleness detection on plugin startup to reindex modified files
  - `obsidian.search` tool for semantic vector search across vault notes
  - `obsidian.reindex_vault` tool to force re-embed all files
  - `obsidian.refresh_index` tool to check for stale files and reindex them
  - Settings UI for Ollama URL, model selection, auto-indexing toggle, and manual reindex
  - Embeddings stored in plugin data.json (syncs with vault)
- `obsidian.list_folders` tool to list folders in the vault (with optional parent folder filter)
- `obsidian.list_notes` tool to list notes in the vault (with optional folder filter)
- `obsidian.read_note` tool to read the contents of a note
- `obsidian.update_note` tool to update the contents of an existing note
- `obsidian.create_folder` tool to create folders (with intermediate folder creation)
- `obsidian.delete_folder` tool to delete folders (with `delete_if_not_empty` option)
- `obsidian.move_or_rename_note` tool to move or rename notes within the vault
- `obsidian.delete_note` tool to delete notes (moves to system trash)

### Changed

- Refactored MCP host architecture to support multiple concurrent sessions
  - Each session now has its own McpServer and transport instance
  - Tool registration extracted into reusable `registerTools()` method
- Updated Zod from 3.23.8 to 4.3.5
- Migrated from deprecated `McpServer.tool()` to `McpServer.registerTool()` API
- Updated CLAUDE.md with complete list of current MCP tools
