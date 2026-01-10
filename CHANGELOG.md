# Changelog

## [Unreleased]

### Added

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

- Updated Zod from 3.23.8 to 4.3.5
- Migrated from deprecated `McpServer.tool()` to `McpServer.registerTool()` API
- Updated CLAUDE.md with complete list of current MCP tools
