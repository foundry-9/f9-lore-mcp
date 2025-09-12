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

