# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

F9 Obsidian MCP is an Obsidian plugin that hosts a Model Context Protocol (MCP) server inside Obsidian, exposing vault operations via HTTP/SSE endpoints.

## Workflow

- Always update `CHANGELOG.md` when making changes to the codebase

## Build Commands

```bash
npm run dev      # Watch mode: rebuilds main.js on changes
npm run build    # Production build: minified main.js
npm run version  # Sync manifest.json version with package.json
```

No test framework is configured yet.

## Development Setup

1. Install dependencies: `npm i`
2. Run `npm run dev` for watch mode
3. Symlink or copy this folder to `<vault>/.obsidian/plugins/f9-obsidian-mcp/`
4. Enable the plugin in Obsidian Settings → Community Plugins

## Architecture

### Plugin Entry Point (`src/main.ts`)

- `F9ObsidianMCPPlugin` extends Obsidian's `Plugin` class
- Manages settings (port, MCP enabled toggle, DNS rebinding protection)
- Creates `ObsidianMcpHost` instance and calls `ensureMcpRunning()` on load and settings change

### MCP Host (`src/mcp/host.ts`)

- `ObsidianMcpHost` wraps `@modelcontextprotocol/sdk` server
- **Multi-session architecture**: supports multiple concurrent MCP clients
  - Each client connection gets its own `McpServer` + `StreamableHTTPServerTransport` pair
  - Sessions managed via `Map<sessionId, McpSession>`
  - Routing based on `mcp-session-id` request header
  - New sessions created on-demand for POST requests without valid session ID
- Uses `StreamableHTTPServerTransport` for HTTPS/SSE transport
- Requires mkcert-generated TLS certificates for localhost
- Listens on `127.0.0.1:<port>` with endpoints:
  - `/mcp` - MCP protocol endpoint (HTTPS, multi-session)
  - `/health` - Health check (HTTPS, reports session count)
- Tools are registered via `McpServer.registerTool()` with Zod schemas for validation
- **Zod Schema Constraints**: Some Zod types fail when the MCP SDK converts them to JSON Schema in Obsidian's bundled environment:
  - ❌ **Avoid**: `z.any()`, `z.unknown()`, `z.record(z.any())`, `z.record(z.unknown())`
  - ✅ **Use instead**: Explicit types like `z.record(z.string(), z.string())`, `z.union([...])`, or `z.object({...})`
  - This is due to how esbuild bundles Zod for the Obsidian Electron runtime; the same schemas work fine in Node.js
  - When adding new tools, test that `tools/list` still works after reloading Obsidian
- Current tools:
  - **Basic Operations**
    - `ping` - Simple ping/pong health check
    - `list_folders` - List folders in the vault
    - `list_notes` - List notes in the vault
    - `create_note` - Create a note
    - `read_note` - Read note contents
    - `update_note` - Update note contents (full file replacement)
    - `delete_note` - Delete a note (moves to trash)
    - `move_or_rename_note` - Move or rename a note
    - `create_folder` - Create a folder
    - `delete_folder` - Delete a folder (moves to trash)
  - **Granular Structure Tools** (token-efficient editing)
    - `get_note_structure` - Get headings, sections, list items, frontmatter with freshness token
    - `read_section` - Read specific section content by ID
    - `read_heading_content` - Read content under a heading
    - `read_frontmatter` - Read frontmatter as JSON
    - `update_section` - Update section content
    - `delete_section` - Delete a section
    - `update_heading_content` - Update content under heading
    - `rename_heading` - Rename heading text/level
    - `update_list_item` - Update list item text/task status
    - `update_frontmatter` - Update frontmatter properties
    - `insert_content` - Insert at specific position
  - **Vector Search**
    - `search` - Semantic vector search across vault notes
    - `reindex_vault` - Force re-embed all files for vector search
    - `refresh_index` - Check for stale files and reindex them

### Granular Editing (`src/mcp/structure.ts`, `src/mcp/editors.ts`)

- `structure.ts` - Types and utilities for note structure extraction
  - Freshness tokens (mtime + content hash) for staleness detection
  - `buildNoteStructure()` uses `app.metadataCache` to extract headings, sections, list items
  - ID generation for sections (`s-type-line`), headings (`h-level-line`), list items (`li-line`)
- `editors.ts` - Pure functions for content manipulation
  - String-based editing using position offsets from metadata cache
  - Functions: `updateSectionContent`, `deleteSection`, `updateHeadingContent`, `renameHeading`, `updateListItemText`, `updateListItemTask`, `updateFrontmatter`, `insertContent`

### Vector Search (`src/vector/`)

- `VectorIndexer` orchestrates embedding and search using local Ollama
- Automatic indexing on file create/modify/delete/rename events
- Fixed-size chunking (~500 tokens) with overlap
- Staleness detection on startup compares file mtime against stored `embeddedAt`
- Embeddings stored in plugin's `data.json` via `saveData()`
- Key files:
  - `types.ts` - Interfaces for ChunkEmbedding, EmbeddingIndex, VectorSearchSettings
  - `chunker.ts` - Paragraph-aware markdown chunking
  - `ollama.ts` - Ollama API client for embeddings
  - `similarity.ts` - Cosine similarity and topK search
  - `indexer.ts` - Main orchestrator class

### Build System

- esbuild bundles TypeScript to `main.js`
- `obsidian` module is marked external (provided by Obsidian runtime)
- CommonJS format, Node platform target

## Key Dependencies

- `@modelcontextprotocol/sdk` - MCP server implementation
- `zod` - Tool argument validation
- `obsidian` - Obsidian API types (dev dependency, external at runtime)
