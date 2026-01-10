import type { App, TFile, TFolder } from "obsidian";
import { z } from "zod";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VectorIndexer } from "../vector/indexer";

export interface McpConfig {
  enabled: boolean;
  port: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  enableDnsRebindingProtection?: boolean;
}

export class ObsidianMcpHost {
  private app: App;
  private config: McpConfig;
  private httpServer?: ReturnType<typeof createServer>;
  private transport?: StreamableHTTPServerTransport;
  private mcp?: McpServer;
  private vectorIndexer?: VectorIndexer;

  constructor(app: App, config: McpConfig, vectorIndexer?: VectorIndexer) {
    this.app = app;
    this.config = config;
    this.vectorIndexer = vectorIndexer;
  }

  isRunning(): boolean {
    return !!this.httpServer && !!this.mcp;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (!this.config.enabled) return;

    const { port } = this.config;

    // Prepare MCP server and tools
    const mcp = new McpServer({ name: "F9 Obsidian MCP", version: "1.0.0" });

    // Register simple ping tool
    mcp.registerTool("obsidian.ping", {}, async () => ({
      content: [{ type: "text", text: "pong from Obsidian" }],
    }));

    // Register list folders tool
    mcp.registerTool(
      "obsidian.list_folders",
      {
        description: "List folders in the vault, optionally filtered by parent folder",
        inputSchema: {
          folder: z
            .string()
            .optional()
            .describe("Vault-relative parent folder path. If omitted, lists all folders in the vault."),
        },
      },
      async (args) => {
        const { folder } = args;
        const allFolders: string[] = [];
        const root = this.app.vault.getRoot();
        const collectFolders = (f: TFolder) => {
          for (const child of f.children) {
            if ("children" in child) {
              allFolders.push(child.path);
              collectFolders(child as TFolder);
            }
          }
        };
        collectFolders(root);
        let folders: string[];
        if (folder) {
          const normalizedFolder = folder.replace(/^\/+/, "").replace(/\/+$/, "");
          folders = allFolders.filter((f) => f.startsWith(normalizedFolder + "/"));
        } else {
          folders = allFolders;
        }
        folders.sort();
        return {
          content: [{ type: "text", text: folders.length > 0 ? folders.join("\n") : "(no folders found)" }],
        };
      }
    );

    // Register list notes tool
    mcp.registerTool(
      "obsidian.list_notes",
      {
        description: "List notes in the vault, optionally filtered by folder",
        inputSchema: {
          folder: z
            .string()
            .optional()
            .describe("Vault-relative folder path to list notes from. If omitted, lists all notes in the vault."),
        },
      },
      async (args) => {
        const { folder } = args;
        const allFiles = this.app.vault.getMarkdownFiles();
        let files: TFile[];
        if (folder) {
          const normalizedFolder = folder.replace(/^\/+/, "").replace(/\/+$/, "");
          files = allFiles.filter((f) => f.path.startsWith(normalizedFolder + "/"));
        } else {
          files = allFiles;
        }
        const paths = files.map((f) => f.path).sort();
        return {
          content: [{ type: "text", text: paths.length > 0 ? paths.join("\n") : "(no notes found)" }],
        };
      }
    );

    // Register note creation tool
    mcp.registerTool(
      "obsidian.create_note",
      {
        description: "Create a note in the current vault",
        inputSchema: {
          path: z
            .string()
            .describe("Vault-relative path, e.g. 'Folder/Note.md'")
            .min(1),
          content: z.string().optional().describe("Initial note contents"),
        },
      },
      async (args) => {
        const { path, content } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        // Create intermediate folders if needed
        const folderPath = normalizedPath.split("/").slice(0, -1).join("/");
        if (folderPath) {
          try {
            await this.app.vault.createFolder(folderPath);
          } catch (_) {
            // ignore if exists
          }
        }
        const file = await this.app.vault.create(normalizedPath, content ?? "");
        return {
          content: [
            {
              type: "text",
              text: `Created note at ${file.path}`,
            },
          ],
        };
      }
    );

    // Register note reading tool
    mcp.registerTool(
      "obsidian.read_note",
      {
        description: "Read the contents of a note in the current vault",
        inputSchema: {
          path: z
            .string()
            .describe("Vault-relative path, e.g. 'Folder/Note.md'")
            .min(1),
        },
      },
      async (args) => {
        const { path } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [{ type: "text", text: `Note not found: ${normalizedPath}` }],
            isError: true,
          };
        }
        const noteContent = await this.app.vault.read(file);
        return {
          content: [{ type: "text", text: noteContent }],
        };
      }
    );

    // Register note update tool
    mcp.registerTool(
      "obsidian.update_note",
      {
        description: "Update the contents of an existing note in the current vault",
        inputSchema: {
          path: z
            .string()
            .describe("Vault-relative path, e.g. 'Folder/Note.md'")
            .min(1),
          content: z.string().describe("New contents for the note"),
        },
      },
      async (args) => {
        const { path, content } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [{ type: "text", text: `Note not found: ${normalizedPath}` }],
            isError: true,
          };
        }
        await this.app.vault.modify(file, content);
        return {
          content: [{ type: "text", text: `Updated note: ${normalizedPath}` }],
        };
      }
    );

    // Register note deletion tool
    mcp.registerTool(
      "obsidian.delete_note",
      {
        description: "Delete a note from the current vault (moves to system trash)",
        inputSchema: {
          path: z
            .string()
            .describe("Vault-relative path, e.g. 'Folder/Note.md'")
            .min(1),
        },
      },
      async (args) => {
        const { path } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [{ type: "text", text: `Note not found: ${normalizedPath}` }],
            isError: true,
          };
        }
        await this.app.vault.trash(file, true);
        return {
          content: [{ type: "text", text: `Deleted note: ${normalizedPath}` }],
        };
      }
    );

    // Register note move/rename tool
    mcp.registerTool(
      "obsidian.move_or_rename_note",
      {
        description: "Move or rename a note in the current vault",
        inputSchema: {
          from: z
            .string()
            .describe("Current vault-relative path, e.g. 'Folder/Note.md'")
            .min(1),
          to: z
            .string()
            .describe("New vault-relative path, e.g. 'NewFolder/RenamedNote.md'")
            .min(1),
        },
      },
      async (args) => {
        const { from, to } = args;
        const normalizedFrom = from.replace(/^\/+/, "");
        const normalizedTo = to.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedFrom);
        if (!file) {
          return {
            content: [{ type: "text", text: `Note not found: ${normalizedFrom}` }],
            isError: true,
          };
        }
        // Create intermediate folders if needed
        const folderPath = normalizedTo.split("/").slice(0, -1).join("/");
        if (folderPath) {
          try {
            await this.app.vault.createFolder(folderPath);
          } catch (_) {
            // ignore if exists
          }
        }
        await this.app.fileManager.renameFile(file, normalizedTo);
        return {
          content: [
            {
              type: "text",
              text: `Moved note from ${normalizedFrom} to ${normalizedTo}`,
            },
          ],
        };
      }
    );

    // Register folder creation tool
    mcp.registerTool(
      "obsidian.create_folder",
      {
        description: "Create a folder in the current vault (creates intermediate folders as needed)",
        inputSchema: {
          path: z
            .string()
            .describe("Vault-relative folder path, e.g. 'Parent/Child/NewFolder'")
            .min(1),
        },
      },
      async (args) => {
        const { path } = args;
        const normalizedPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
        const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (existing) {
          return {
            content: [{ type: "text", text: `Folder already exists: ${normalizedPath}` }],
          };
        }
        await this.app.vault.createFolder(normalizedPath);
        return {
          content: [{ type: "text", text: `Created folder: ${normalizedPath}` }],
        };
      }
    );

    // Register folder deletion tool
    mcp.registerTool(
      "obsidian.delete_folder",
      {
        description: "Delete a folder from the current vault (moves to system trash)",
        inputSchema: {
          path: z
            .string()
            .describe("Vault-relative folder path, e.g. 'Folder/Subfolder'")
            .min(1),
          delete_if_not_empty: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, delete folder even if it contains files. Defaults to false."),
        },
      },
      async (args) => {
        const { path, delete_if_not_empty } = args;
        const normalizedPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
        const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!folder) {
          return {
            content: [{ type: "text", text: `Folder not found: ${normalizedPath}` }],
            isError: true,
          };
        }
        if (!("children" in folder)) {
          return {
            content: [{ type: "text", text: `Path is not a folder: ${normalizedPath}` }],
            isError: true,
          };
        }
        const typedFolder = folder as TFolder;
        if (!delete_if_not_empty && typedFolder.children.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Folder is not empty: ${normalizedPath} (contains ${typedFolder.children.length} items). Set delete_if_not_empty to true to delete anyway.`,
              },
            ],
            isError: true,
          };
        }
        await this.app.vault.trash(folder, true);
        return {
          content: [{ type: "text", text: `Deleted folder: ${normalizedPath}` }],
        };
      }
    );

    // Register vector search refresh tool (check for stale files)
    mcp.registerTool(
      "obsidian.refresh_index",
      {
        description: "Check for new or modified files and update the vector index (same as startup check)",
        inputSchema: {},
      },
      async () => {
        if (!this.vectorIndexer) {
          return {
            content: [{ type: "text", text: "Vector search is not configured" }],
            isError: true,
          };
        }

        try {
          const available = await this.vectorIndexer.checkOllamaConnection();
          if (!available) {
            return {
              content: [{ type: "text", text: "Cannot connect to Ollama. Is it running?" }],
              isError: true,
            };
          }

          const staleCount = await this.vectorIndexer.checkForStaleFiles();
          if (staleCount === 0) {
            return {
              content: [{ type: "text", text: "Index is up to date. No files need reindexing." }],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Found ${staleCount} new or modified files. Reindexing in background.`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Register vector search reindex tool
    mcp.registerTool(
      "obsidian.reindex_vault",
      {
        description: "Force re-embed all markdown files in the vault for vector search",
        inputSchema: {},
      },
      async () => {
        if (!this.vectorIndexer) {
          return {
            content: [{ type: "text", text: "Vector search is not configured" }],
            isError: true,
          };
        }

        try {
          const available = await this.vectorIndexer.checkOllamaConnection();
          if (!available) {
            return {
              content: [{ type: "text", text: "Cannot connect to Ollama. Is it running?" }],
              isError: true,
            };
          }

          const result = await this.vectorIndexer.reindexVault();
          return {
            content: [
              {
                type: "text",
                text: `Reindexed ${result.indexed} files successfully.${
                  result.errors.length > 0
                    ? `\n\nErrors (${result.errors.length}):\n${result.errors.slice(0, 10).join("\n")}`
                    : ""
                }`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Reindex failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Register vector search tool
    mcp.registerTool(
      "obsidian.search",
      {
        description: "Semantic vector search across vault notes using embeddings",
        inputSchema: {
          query: z.string().describe("Natural language search query").min(1),
          limit: z
            .number()
            .optional()
            .default(10)
            .describe("Maximum number of results (default: 10)"),
        },
      },
      async (args) => {
        const { query, limit } = args;

        if (!this.vectorIndexer) {
          return {
            content: [{ type: "text", text: "Vector search is not configured" }],
            isError: true,
          };
        }

        try {
          const results = await this.vectorIndexer.search(query, limit);

          if (results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No results found. The vault may need to be indexed first (use obsidian.reindex_vault).",
                },
              ],
            };
          }

          // Format results
          const formatted = results
            .map(
              (r, i) =>
                `${i + 1}. **${r.chunk.filePath}** (score: ${r.score.toFixed(3)})\n   > ${r.chunk.preview}...`
            )
            .join("\n\n");

          return {
            content: [{ type: "text", text: formatted }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Build transport and HTTP endpoint
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      allowedHosts: this.config.allowedHosts,
      allowedOrigins: this.config.allowedOrigins,
      enableDnsRebindingProtection: this.config.enableDnsRebindingProtection ?? false,
    });

    await mcp.connect(transport);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = req.url || "/";
        if (url === "/mcp") {
          await transport.handleRequest(req, res);
        } else if (url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", (e) => reject(e));
      server.listen(port, "127.0.0.1", () => resolve());
    });

    this.mcp = mcp;
    this.transport = transport;
    this.httpServer = server;
  }

  async stop(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    if (this.httpServer) {
      const s = this.httpServer;
      closePromises.push(
        new Promise<void>((resolve) => s.close(() => resolve()))
      );
      this.httpServer = undefined;
    }
    if (this.mcp) {
      await this.mcp.close();
      this.mcp = undefined;
    }
    this.transport = undefined;
    await Promise.allSettled(closePromises);
  }

  async restart(config?: Partial<McpConfig>): Promise<void> {
    if (config) this.config = { ...this.config, ...config };
    await this.stop();
    await this.start();
  }
}
