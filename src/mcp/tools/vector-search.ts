/**
 * Vector search tools: search, refresh_index, reindex_vault
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VectorIndexer } from "../../vector/indexer";
import {
  vectorSearchNotConfiguredError,
  providerNotAvailableError,
  textResponse,
  errorResponse,
} from "../utils";
import { normalizeForSearch } from "../../utils/normalize";

/**
 * Register vector search tools.
 */
export function registerVectorSearchTools(
  mcp: McpServer,
  getVectorIndexer: () => VectorIndexer | undefined
): void {
  // Register vector search refresh tool (check for stale files)
  mcp.registerTool(
    "refresh_index",
    {
      description: "Check for new or modified files and update the vector index (same as startup check)",
      inputSchema: z.object({}),
    },
    async () => {
      const vectorIndexer = getVectorIndexer();
      if (!vectorIndexer) {
        return vectorSearchNotConfiguredError();
      }

      try {
        const available = await vectorIndexer.checkProviderConnection();
        if (!available) {
          return providerNotAvailableError();
        }

        const staleCount = await vectorIndexer.checkForStaleFiles();
        if (staleCount === 0) {
          return textResponse("Index is up to date. No files need reindexing.");
        }

        return textResponse(`Found ${staleCount} new or modified files. Reindexing in background.`);
      } catch (err) {
        return errorResponse(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Register vector search reindex tool
  mcp.registerTool(
    "reindex_vault",
    {
      description: "Force re-embed all markdown files in the vault for vector search",
      inputSchema: z.object({}),
    },
    async () => {
      const vectorIndexer = getVectorIndexer();
      if (!vectorIndexer) {
        return vectorSearchNotConfiguredError();
      }

      try {
        const available = await vectorIndexer.checkProviderConnection();
        if (!available) {
          return providerNotAvailableError();
        }

        const result = await vectorIndexer.reindexVault();
        return textResponse(
          `Reindexed ${result.indexed} files successfully.${
            result.errors.length > 0
              ? `\n\nErrors (${result.errors.length}):\n${result.errors.slice(0, 10).join("\n")}`
              : ""
          }`
        );
      } catch (err) {
        return errorResponse(`Reindex failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Register vector search tool
  mcp.registerTool(
    "search",
    {
      description:
        "Semantic vector search across vault notes. Use this as the default search tool when exploring the vault, finding information about a topic, or discovering relationships, patterns, and concepts. For precise text matching (e.g., to locate something specific for editing), use grep instead.",
      inputSchema: z.object({
        query: z.string().describe("Natural language search query").min(1),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Maximum number of results (default: 10)"),
      }),
    },
    async (args) => {
      const { query, limit } = args;
      const vectorIndexer = getVectorIndexer();

      if (!vectorIndexer) {
        return vectorSearchNotConfiguredError();
      }

      try {
        // Normalize the query to strip diacriticals for better semantic matching
        const normalizedQuery = normalizeForSearch(query);
        const results = await vectorIndexer.search(normalizedQuery, limit);

        if (results.length === 0) {
          return textResponse(
            "No results found. The vault may need to be indexed first (use reindex_vault)."
          );
        }

        // Format results
        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.chunk.filePath}** (score: ${r.score.toFixed(3)})\n\n${r.chunk.content}`
          )
          .join("\n\n---\n\n");

        return textResponse(formatted);
      } catch (err) {
        return errorResponse(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
