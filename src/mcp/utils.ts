/**
 * Shared utilities for MCP tools
 */

import type { App, TFile } from "obsidian";

// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Normalize a note path by removing leading slashes.
 */
export function normalizeNotePath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Normalize a folder path by removing leading and trailing slashes.
 */
export function normalizeFolderPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

// ============================================================================
// Tool Result Types
// ============================================================================

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ============================================================================
// Error Response Helpers
// ============================================================================

/**
 * Create a "file not found" error response (plain text).
 */
export function fileNotFoundError(path: string): ToolResult {
  return {
    content: [{ type: "text", text: `Note not found: ${path}` }],
    isError: true,
  };
}

/**
 * Create a "file not found" error response (JSON format).
 */
export function fileNotFoundJsonError(path: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${path}` }),
      },
    ],
    isError: true,
  };
}

/**
 * Create a "folder not found" error response (plain text).
 */
export function folderNotFoundError(path: string): ToolResult {
  return {
    content: [{ type: "text", text: `Folder not found: ${path}` }],
    isError: true,
  };
}

/**
 * Create a "path not found" error response.
 */
export function pathNotFoundError(path: string): ToolResult {
  return {
    content: [{ type: "text", text: `Path not found: ${path}` }],
    isError: true,
  };
}

/**
 * Create a "cache not available" error response (JSON format).
 */
export function cacheNotAvailableError(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "NO_CACHE", message: "Metadata cache not available" }),
      },
    ],
    isError: true,
  };
}

/**
 * Create a "vector search not configured" error response.
 */
export function vectorSearchNotConfiguredError(): ToolResult {
  return {
    content: [{ type: "text", text: "Vector search is not configured" }],
    isError: true,
  };
}

/**
 * Create a "provider not available" error response.
 */
export function providerNotAvailableError(): ToolResult {
  return {
    content: [{ type: "text", text: "Embedding provider is not available. Check your settings." }],
    isError: true,
  };
}

// ============================================================================
// File List Resolution
// ============================================================================

/**
 * Resolve which files to search based on an optional path filter.
 * If path is a file, returns just that file.
 * If path is a folder, returns all markdown files in that folder.
 * If path is empty/undefined, returns all markdown files in the vault.
 */
export function resolveFilesToSearch(
  app: App,
  path?: string
): { files: TFile[]; error?: ToolResult } {
  const allFiles = app.vault.getMarkdownFiles();

  if (path && path.trim() !== "") {
    const normalizedPath = normalizeFolderPath(path);

    // Check if it's a file
    const file = app.vault.getFileByPath(normalizedPath);
    if (file) {
      return { files: [file] };
    }

    // Check if it's a folder
    const folder = app.vault.getAbstractFileByPath(normalizedPath);
    if (folder && "children" in folder) {
      // It's a folder - get all markdown files in it
      const folderPrefix = normalizedPath + "/";
      const files = allFiles.filter((f) => f.path.startsWith(folderPrefix));
      return { files };
    }

    return { files: [], error: pathNotFoundError(normalizedPath) };
  }

  // Search entire vault
  return { files: allFiles };
}

// ============================================================================
// Folder Creation
// ============================================================================

/**
 * Ensure the parent folder for a file path exists.
 * Creates intermediate folders as needed.
 */
export async function ensureParentFolder(app: App, filePath: string): Promise<void> {
  const folderPath = filePath.split("/").slice(0, -1).join("/");
  if (folderPath) {
    try {
      await app.vault.createFolder(folderPath);
    } catch {
      // ignore if exists
    }
  }
}

// ============================================================================
// Edit Result Handling
// ============================================================================

export interface PerformEditResult {
  success: boolean;
  freshnessToken?: string;
  verified?: boolean;
  error?: string;
  errorCode?: string;
  currentToken?: string;
}

/**
 * Convert a performEdit result to a tool response.
 */
export function editResultToToolResponse(
  result: PerformEditResult,
  extraFields?: Record<string, unknown>
): ToolResult {
  if (!result.success) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: result.errorCode,
            message: result.error,
            currentToken: result.currentToken,
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          freshnessToken: result.freshnessToken,
          verified: result.verified,
          ...extraFields,
        }),
      },
    ],
  };
}

// ============================================================================
// Text Response Helpers
// ============================================================================

/**
 * Create a simple text response.
 */
export function textResponse(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Create a JSON response.
 */
export function jsonResponse(data: unknown, pretty = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data),
      },
    ],
  };
}

/**
 * Create an error response.
 */
export function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
