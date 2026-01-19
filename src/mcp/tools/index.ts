/**
 * MCP Tools registration index
 */

import type { App, TFile } from "obsidian";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VectorIndexer } from "../../vector/indexer";

import { registerBasicOpsTools } from "./basic-ops";
import { registerFolderOpsTools } from "./folder-ops";
import { registerStructureReadTools } from "./structure-read";
import { registerStructureWriteTools, type StructureWriteContext } from "./structure-write";
import { registerVectorSearchTools } from "./vector-search";
import { registerTextSearchTools } from "./text-search";

export { type StructureWriteContext } from "./structure-write";

/**
 * Context required for registering all tools.
 */
export interface ToolRegistrationContext {
  app: App;
  waitForCacheUpdate: (file: TFile, timeout?: number) => Promise<void>;
  getVectorIndexer: () => VectorIndexer | undefined;
}

/**
 * Register all MCP tools on a server instance.
 */
export function registerAllTools(mcp: McpServer, ctx: ToolRegistrationContext): void {
  const { app, waitForCacheUpdate, getVectorIndexer } = ctx;

  // Basic note operations
  registerBasicOpsTools(mcp, app);

  // Folder operations
  registerFolderOpsTools(mcp, app);

  // Structure read operations
  registerStructureReadTools(mcp, app);

  // Structure write operations
  const structureWriteCtx: StructureWriteContext = {
    app,
    waitForCacheUpdate,
  };
  registerStructureWriteTools(mcp, structureWriteCtx);

  // Vector search operations
  registerVectorSearchTools(mcp, getVectorIndexer);

  // Text search operations
  registerTextSearchTools(mcp, app);
}
