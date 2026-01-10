import type { App } from "obsidian";
import { z } from "zod";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

  constructor(app: App, config: McpConfig) {
    this.app = app;
    this.config = config;
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
