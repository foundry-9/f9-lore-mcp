# F9 Obsidian MCP

A minimal Obsidian plugin skeleton to host an MCP inside Obsidian.

## Develop

1) Install dev deps

```bash
npm i -D esbuild typescript @types/node obsidian
```

2) Start dev build (watches and rebuilds `main.js`)

```bash
npm run dev
```

3) Load in Obsidian

- Copy (or symlink) this folder into your vault's `.obsidian/plugins/f9-obsidian-mcp/` directory.
- In Obsidian, enable the plugin in Settings → Community Plugins.

## Build

```bash
npm run build
```

## MCP Runtime

- Enable under Settings → Community Plugins → F9 Obsidian MCP → "Enable MCP server".
- Default endpoint: `http://127.0.0.1:3030/mcp` (SSE/Streamable HTTP).

Quick test (JSON response mode is disabled by default; use SSE-aware client):

```bash
curl -N -H 'Accept: text/event-stream' \
  http://127.0.0.1:3030/mcp
# In another shell, POST a ping request:
curl -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"obsidian.ping"}}' \
  http://127.0.0.1:3030/mcp
```

Currently available tools
- `obsidian.ping` → returns a text “pong from Obsidian”.
- `obsidian.create_note` → args: `{ path: string, content?: string }`.

## Versioning

Update `package.json` version, then sync `manifest.json`:

```bash
npm run version
```

## Files

- `manifest.json` — Obsidian plugin manifest (entry: `main.js`).
- `src/main.ts` — Plugin source (TypeScript).
- `styles.css` — Optional styles for UI elements.
- `scripts/version-bump.mjs` — Keeps manifest version in sync with package.json.
