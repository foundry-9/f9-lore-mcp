import type { App, TFile } from "obsidian";
import { createServer as createHttpsServer, ServerOptions as HttpsServerOptions } from "node:https";
import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VectorIndexer } from "../vector/indexer";
import { registerAllTools, type ToolRegistrationContext } from "./tools";

export interface McpConfig {
  enabled: boolean;
  port: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  enableDnsRebindingProtection?: boolean;
  https?: boolean;
  tls?: {
    cert: string;
    key: string;
  };
  sessionTimeoutMinutes?: number;
}

interface McpSession {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  clientKey: string;
  lastActivity: number;
  toolCount: number;
}

const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check for expired sessions every 5 minutes
const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

export class LoreMcpHost {
  private app: App;
  private config: McpConfig;
  private httpServer?: Server;
  private sessions: Map<string, McpSession> = new Map();
  private vectorIndexer?: VectorIndexer;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(app: App, config: McpConfig, vectorIndexer?: VectorIndexer) {
    this.app = app;
    this.config = config;
    this.vectorIndexer = vectorIndexer;
  }

  /**
   * Wait for the metadata cache to update after a file modification.
   */
  private waitForCacheUpdate(file: TFile, timeout = 500): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      const ref = this.app.metadataCache.on("changed", (changedFile) => {
        if (changedFile.path === file.path) {
          clearTimeout(timer);
          this.app.metadataCache.offref(ref);
          resolve();
        }
      });
    });
  }

  isRunning(): boolean {
    return !!this.httpServer;
  }

  /**
   * Get the number of active MCP sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Register all MCP tools on a server instance.
   * Returns the number of tools registered.
   */
  private registerTools(mcp: McpServer): number {
    const ctx: ToolRegistrationContext = {
      app: this.app,
      waitForCacheUpdate: this.waitForCacheUpdate.bind(this),
      getVectorIndexer: () => this.vectorIndexer,
    };

    registerAllTools(mcp, ctx);

    // Count tools by accessing the internal registry
    // Note: This is a workaround since McpServer doesn't expose a tool count method
    try {
      const registeredTools = (mcp as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
      return registeredTools ? Object.keys(registeredTools).length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Compute a unique client identity key from the request.
   * Combines IP address and User-Agent header for localhost differentiation.
   */
  private getClientKey(req: IncomingMessage): string {
    const ip = req.socket?.remoteAddress || "unknown";
    const userAgent = (req.headers["user-agent"] || "").trim();
    return `${ip}:${userAgent}`;
  }

  /**
   * Parse a clientKey back into its components.
   */
  private parseClientKey(clientKey: string): { ip: string; userAgent: string } {
    const colonIndex = clientKey.indexOf(":");
    if (colonIndex === -1) {
      return { ip: clientKey, userAgent: "" };
    }
    return {
      ip: clientKey.substring(0, colonIndex),
      userAgent: clientKey.substring(colonIndex + 1),
    };
  }

  /**
   * Close and remove sessions matching a predicate.
   * Collects matching session IDs first to avoid modifying the map during iteration.
   */
  private async cleanupSessionsWhere(
    predicate: (sessionId: string, session: McpSession) => boolean
  ): Promise<void> {
    const sessionsToClose: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (predicate(sessionId, session)) {
        sessionsToClose.push(sessionId);
      }
    }
    for (const sessionId of sessionsToClose) {
      await this.closeSession(sessionId);
    }
  }

  /**
   * Close and remove all sessions belonging to a specific client.
   * Called when a new session is created to ensure only one session per client.
   */
  private async cleanupClientSessions(clientKey: string): Promise<void> {
    await this.cleanupSessionsWhere((_, session) => session.clientKey === clientKey);
  }

  /**
   * Remove sessions that have been inactive beyond the configured TTL.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const timeoutMs = (this.config.sessionTimeoutMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES) * 60 * 1000;
    const now = Date.now();
    await this.cleanupSessionsWhere((_, session) => now - session.lastActivity > timeoutMs);
  }

  /**
   * Create a new MCP session with its own server and transport.
   */
  private async createSession(req: IncomingMessage): Promise<{ sessionId: string; session: McpSession }> {
    const clientKey = this.getClientKey(req);

    // Clean up any existing sessions from this client
    await this.cleanupClientSessions(clientKey);
    const mcp = new McpServer(
      { name: "F9 Lore MCP", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );

    const toolCount = this.registerTools(mcp);

    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      allowedHosts: this.config.allowedHosts,
      allowedOrigins: this.config.allowedOrigins,
      enableDnsRebindingProtection: this.config.enableDnsRebindingProtection ?? false,
    });

    await mcp.connect(transport);

    const now = Date.now();
    const session: McpSession = {
      mcp,
      transport,
      createdAt: now,
      clientKey,
      lastActivity: now,
      toolCount,
    };

    this.sessions.set(sessionId, session);

    return { sessionId, session };
  }

  /**
   * Close and remove a session.
   */
  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.mcp.close();
      this.sessions.delete(sessionId);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (!this.config.enabled) return;

    const { port, https: useHttps } = this.config;

    // Validate TLS configuration if HTTPS is enabled
    if (useHttps) {
      if (!this.config.tls) {
        throw new Error("TLS configuration is required for HTTPS. Please configure certificate content in settings.");
      }
      if (!this.config.tls.cert || !this.config.tls.key) {
        throw new Error("TLS certificate and key content are required for HTTPS. Please configure them in settings.");
      }
    }

    // Request handler shared by HTTP and HTTPS
    const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = req.url || "/";
        if (url === "/mcp") {
          // Extract session ID from request headers
          const sessionId = req.headers["mcp-session-id"] as string | undefined;

          if (sessionId && this.sessions.has(sessionId)) {
            // Route to existing session
            const session = this.sessions.get(sessionId)!;
            session.lastActivity = Date.now(); // Update activity timestamp
            try {
              await session.transport.handleRequest(req, res);
            } catch (transportErr) {
              throw transportErr;
            }
          } else if (req.method === "POST") {
            // Create new session for POST without valid session ID
            const { session } = await this.createSession(req);
            try {
              await session.transport.handleRequest(req, res);
            } catch (transportErr) {
              throw transportErr;
            }
          } else if (req.method === "DELETE" && sessionId) {
            // Handle session termination
            await this.closeSession(sessionId);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else if (req.method === "GET") {
            // GET requests need a valid session for SSE streams
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "GET requires valid mcp-session-id header" }));
          } else {
            // Invalid request - no session and not a POST
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid session or method" }));
          }
        } else if (url === "/health") {
          const sessionList = [];
          for (const [sessionId, session] of this.sessions) {
            const { ip, userAgent } = this.parseClientKey(session.clientKey);
            sessionList.push({
              id: sessionId,
              ip,
              userAgent: userAgent || "(none)",
              createdAt: new Date(session.createdAt).toISOString(),
              lastActivity: new Date(session.lastActivity).toISOString(),
            });
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            vault: this.app.vault.getName(),
            sessions: sessionList,
          }, null, 2));
        } else if (url === "/debug") {
          // Debug endpoint to inspect server state
          const sessionInfo: Record<string, unknown>[] = [];
          for (const [sid, sess] of this.sessions) {
            sessionInfo.push({
              sessionId: sid,
              createdAt: sess.createdAt,
              toolCount: sess.toolCount,
            });
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sessions: sessionInfo }, null, 2));
        } else if (url === "/debug/tools") {
          // Debug: Get actual tools list from first session
          const firstSession = this.sessions.values().next().value;
          if (firstSession) {
            const registeredTools = (firstSession.mcp as unknown as { _registeredTools: Record<string, { description?: string; enabled: boolean }> })._registeredTools || {};
            const tools = Object.entries(registeredTools)
              .filter(([, tool]) => tool.enabled)
              .map(([name, tool]) => ({
                name,
                description: tool.description,
              }));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools }, null, 2));
          } else {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "No sessions" }));
          }
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    };

    // Create HTTP or HTTPS server based on configuration
    let server: Server;

    if (useHttps && this.config.tls) {
      const tlsOptions: HttpsServerOptions = {
        cert: this.config.tls.cert,
        key: this.config.tls.key,
      };
      server = createHttpsServer(tlsOptions, requestHandler);
    } else {
      server = createHttpServer(requestHandler);
    }

    await new Promise<void>((resolve, reject) => {
      server.once("error", (e) => reject(e));
      server.listen(port, "127.0.0.1", () => resolve());
    });

    this.httpServer = server;

    // Start periodic session cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions().catch(() => {
        // Error during session cleanup
      });
    }, SESSION_CLEANUP_INTERVAL_MS);

  }

  async stop(): Promise<void> {
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Close all active sessions
    const closePromises: Promise<void>[] = [];

    for (const [, session] of this.sessions) {
      closePromises.push(session.mcp.close());
    }
    this.sessions.clear();

    if (this.httpServer) {
      const s = this.httpServer;
      closePromises.push(
        new Promise<void>((resolve) => s.close(() => resolve()))
      );
      this.httpServer = undefined;
    }

    await Promise.allSettled(closePromises);
  }

  async restart(config?: Partial<McpConfig>): Promise<void> {
    if (config) this.config = { ...this.config, ...config };
    await this.stop();
    await this.start();
  }
}
