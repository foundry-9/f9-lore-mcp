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
- Current tools: `obsidian.ping`, `obsidian.create_note`, `obsidian.delete_note`

### Build System

- esbuild bundles TypeScript to `main.js`
- `obsidian` module is marked external (provided by Obsidian runtime)
- CommonJS format, Node platform target

## Key Dependencies

- `@modelcontextprotocol/sdk` - MCP server implementation
- `zod` - Tool argument validation
- `obsidian` - Obsidian API types (dev dependency, external at runtime)
