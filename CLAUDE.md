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
- Uses `StreamableHTTPServerTransport` for HTTP/SSE transport
- Listens on `127.0.0.1:<port>` with endpoints:
  - `/mcp` - MCP protocol endpoint
  - `/health` - Health check
- Tools are registered via `McpServer.registerTool()` with Zod schemas for validation
- Current tools:
  - **Basic Operations**
    - `obsidian.ping` - Simple ping/pong health check
    - `obsidian.list_folders` - List folders in the vault
    - `obsidian.list_notes` - List notes in the vault
    - `obsidian.create_note` - Create a note
    - `obsidian.read_note` - Read note contents
    - `obsidian.update_note` - Update note contents (full file replacement)
    - `obsidian.delete_note` - Delete a note (moves to trash)
    - `obsidian.move_or_rename_note` - Move or rename a note
    - `obsidian.create_folder` - Create a folder
    - `obsidian.delete_folder` - Delete a folder (moves to trash)
  - **Granular Structure Tools** (token-efficient editing)
    - `obsidian.get_note_structure` - Get headings, sections, list items, frontmatter with freshness token
    - `obsidian.read_section` - Read specific section content by ID
    - `obsidian.read_heading_content` - Read content under a heading
    - `obsidian.read_frontmatter` - Read frontmatter as JSON
    - `obsidian.update_section` - Update section content
    - `obsidian.delete_section` - Delete a section
    - `obsidian.update_heading_content` - Update content under heading
    - `obsidian.rename_heading` - Rename heading text/level
    - `obsidian.update_list_item` - Update list item text/task status
    - `obsidian.update_frontmatter` - Update frontmatter properties
    - `obsidian.insert_content` - Insert at specific position
  - **Vector Search**
    - `obsidian.search` - Semantic vector search across vault notes
    - `obsidian.reindex_vault` - Force re-embed all files for vector search
    - `obsidian.refresh_index` - Check for stale files and reindex them

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
