# F9 Lore MCP

A plugin that hosts a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server, exposing vault operations via HTTP/SSE endpoints. This allows AI assistants like Claude Desktop, Claude.ai, and other MCP-compatible clients to read, search, and edit your vault.

## Features

### Note Operations

- **create_note** - Create new notes with optional content
- **read_note** - Read note contents (with fuzzy filename matching)
- **update_note** - Replace note contents
- **delete_note** - Delete notes (moves to trash)
- **move_or_rename_note** - Move or rename notes within the vault

### Folder Operations

- **list_folders** - List folders in the vault
- **list_notes** - List notes in the vault
- **create_folder** - Create folders (including intermediate directories)
- **delete_folder** - Delete folders (with optional force delete if not empty)

### Granular Editing (Token-Efficient)

Instead of reading/writing entire files, these tools allow precise editing:

- **get_note_structure** - Get headings, sections, list items, frontmatter with freshness token
- **read_section** / **read_heading_content** / **read_frontmatter** - Read specific parts
- **update_section** / **update_heading_content** / **update_frontmatter** - Update specific parts
- **delete_section** - Remove a section
- **rename_heading** - Change heading text or level
- **update_list_item** - Update list item text or task status
- **insert_content** - Insert content at specific positions

### Vector Search

Semantic search across your vault using embeddings:

- **search** - Find notes by meaning, not just keywords
- **reindex_vault** - Force re-embed all files
- **refresh_index** - Check for stale files and reindex

Three embedding provider options:

- **Ollama** (default) - Local LLM, requires [Ollama](https://ollama.com/) running
- **OpenAI** - Cloud API, requires API key
- **TF-IDF** - Keyword-based, fully offline, no external services

### Text Search

- **grep** - Search for text/regex patterns across notes (with context lines, path scoping)
- **str_replace** - Find and replace strings across notes (with dry-run mode)

### Other

- **ping** - Health check

## Installation

### From Source

1. Clone this repository into your vault's plugin directory:

   ```bash
   cd <your-vault>/.obsidian/plugins/
   git clone https://github.com/f9/f9-lore-mcp.git
   cd f9-lore-mcp
   npm install
   npm run build
   ```

2. Enable the plugin in Settings → Community Plugins → F9 Lore MCP

### For Development

1. Clone and install dependencies:

   ```bash
   git clone https://github.com/f9/f9-lore-mcp.git
   cd f9-lore-mcp
   npm install
   ```

2. Start watch mode:

   ```bash
   npm run dev
   ```

3. Symlink to your vault:

   ```bash
   ln -s /path/to/f9-lore-mcp <vault>/.obsidian/plugins/f9-lore-mcp
   ```

4. Enable the plugin in Obsidian Settings → Community Plugins

## Configuration

### Basic Settings

- **Port** - HTTP server port (default: 3000)
- **Enable MCP server** - Toggle the server on/off
- **Session timeout** - Auto-close inactive sessions (default: 30 minutes)

### HTTPS (Optional)

For clients that require TLS (like Claude Desktop with strict security):

1. Enable "Enable HTTPS" toggle
2. Paste your TLS certificate content
3. Paste your TLS private key content

Generate certificates with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert localhost 127.0.0.1 ::1
```

### Vector Search Settings

- **Enable auto-indexing** - Automatically embed files on changes
- **Embedding provider** - Choose Ollama, OpenAI, or TF-IDF
- **Indexing delay** - Debounce time before embedding (default: 10s)

For **Ollama**:

- Install [Ollama](https://ollama.com/) and run it locally
- Configure URL (default: `http://localhost:11434`)
- Select model (e.g., `nomic-embed-text`)

For **OpenAI**:

- Enter your API key
- Select model (text-embedding-3-small, text-embedding-3-large, or text-embedding-ada-002)
- Optionally set custom endpoint for Azure OpenAI

For **TF-IDF**:

- No configuration needed
- Works fully offline
- Keyword-based (less semantic than neural embeddings)

## Using with Claude Desktop

The plugin settings show a copyable configuration snippet for `claude_desktop_config.json`. You'll need [mcp-remote](https://www.npmjs.com/package/mcp-remote) to bridge Claude Desktop to the HTTP endpoint:

```json
{
  "mcpServers": {
    "f9-lore-my-vault": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3000/mcp"]
    }
  }
}
```

For HTTPS mode, add the environment variable:

```json
{
  "mcpServers": {
    "f9-lore-my-vault": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://127.0.0.1:3000/mcp"],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

## Quick Test

```bash
# Check if server is running
curl http://127.0.0.1:3000/health

# Start an SSE connection (in one terminal)
curl -N -H 'Accept: text/event-stream' http://127.0.0.1:3000/mcp

# Send a ping request (in another terminal)
curl -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}' \
  http://127.0.0.1:3000/mcp
```

## Multi-Session Support

Multiple MCP clients can connect simultaneously. Each client gets its own isolated session with independent state. Sessions are:

- Created on-demand when clients connect
- Routed via `mcp-session-id` header
- Automatically cleaned up on disconnect or timeout
- Visible in the status bar (e.g., "F9 MCP:3000 | 2 sessions")

## Build Commands

```bash
npm run dev      # Watch mode: rebuilds main.js on changes
npm run build    # Production build: minified main.js
npm run version  # Sync manifest.json version with package.json
```

## Versioning

Update `package.json` version, then sync `manifest.json`:

```bash
npm run version
```

## Files

- `manifest.json` — Obsidian plugin manifest
- `src/main.ts` — Plugin entry point
- `src/mcp/host.ts` — MCP server host (multi-session architecture)
- `src/mcp/structure.ts` — Note structure extraction
- `src/mcp/editors.ts` — Granular content editing
- `src/vector/` — Vector search subsystem
- `styles.css` — Optional UI styles

## License

UNLICENSED
