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
// String Utilities
// ============================================================================

/**
 * Truncate a string with ellipsis, optionally from the start.
 * @param str - String to truncate
 * @param maxLen - Maximum length including ellipsis
 * @param fromStart - If true, truncates from start (keeps end); otherwise truncates from end
 */
export function truncateString(str: string, maxLen: number, fromStart = false): string {
  if (str.length <= maxLen) return str;
  const ellipsis = "...";
  const availableLen = maxLen - ellipsis.length;
  if (availableLen <= 0) return ellipsis.slice(0, maxLen);
  return fromStart
    ? ellipsis + str.slice(-availableLen)
    : str.slice(0, availableLen) + ellipsis;
}

// ============================================================================
// Tool Result Types
// ============================================================================

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ============================================================================
// Error Response Factory
// ============================================================================

/** Error codes used across MCP tools */
export type ErrorCode =
  | "FILE_NOT_FOUND"
  | "FOLDER_NOT_FOUND"
  | "PATH_NOT_FOUND"
  | "NO_CACHE"
  | "SECTION_NOT_FOUND"
  | "HEADING_NOT_FOUND"
  | "STALE_TOKEN"
  | "TARGET_NOT_FOUND"
  | "VECTOR_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE";

/** Default messages for each error code */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  FILE_NOT_FOUND: "Note not found",
  FOLDER_NOT_FOUND: "Folder not found",
  PATH_NOT_FOUND: "Path not found",
  NO_CACHE: "Metadata cache not available",
  SECTION_NOT_FOUND: "Section not found",
  HEADING_NOT_FOUND: "Heading not found",
  STALE_TOKEN: "File has changed since last read. Please re-read the file structure.",
  TARGET_NOT_FOUND: "Edit operation failed - target not found",
  VECTOR_NOT_CONFIGURED: "Vector search is not configured",
  PROVIDER_UNAVAILABLE: "Embedding provider is not available. Check your settings.",
};

/**
 * Create an error response with consistent formatting.
 * @param code - Error code for programmatic handling
 * @param context - Additional context (e.g., path, ID) to append to message
 * @param json - If true, returns JSON format; otherwise plain text
 */
export function errorResult(code: ErrorCode, context?: string, json = false): ToolResult {
  const baseMessage = ERROR_MESSAGES[code];
  const message = context ? `${baseMessage}: ${context}` : baseMessage;

  if (json) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ============================================================================
// Convenience Error Helpers (for backwards compatibility and brevity)
// ============================================================================

export function fileNotFoundError(path: string): ToolResult {
  return errorResult("FILE_NOT_FOUND", path);
}

export function fileNotFoundJsonError(path: string): ToolResult {
  return errorResult("FILE_NOT_FOUND", path, true);
}

export function folderNotFoundError(path: string): ToolResult {
  return errorResult("FOLDER_NOT_FOUND", path);
}

export function pathNotFoundError(path: string): ToolResult {
  return errorResult("PATH_NOT_FOUND", path);
}

export function cacheNotAvailableError(): ToolResult {
  return errorResult("NO_CACHE", undefined, true);
}

export function vectorSearchNotConfiguredError(): ToolResult {
  return errorResult("VECTOR_NOT_CONFIGURED");
}

export function providerNotAvailableError(): ToolResult {
  return errorResult("PROVIDER_UNAVAILABLE");
}

// ============================================================================
// File Lookup Helper
// ============================================================================

export interface FileOrError {
  file: TFile;
  normalizedPath: string;
}

/**
 * Normalize a path and look up the file, returning an error result if not found.
 * Eliminates the repeated pattern of normalize -> lookup -> error check.
 *
 * @param app - Obsidian App instance
 * @param path - Raw path from tool arguments
 * @param jsonError - If true, returns JSON-formatted error; otherwise plain text
 * @returns Either { file, normalizedPath } or { error: ToolResult }
 */
export function getFileOrError(
  app: App,
  path: string,
  jsonError = false
): FileOrError | { error: ToolResult } {
  const normalizedPath = normalizeNotePath(path);
  const file = app.vault.getFileByPath(normalizedPath);
  if (!file) {
    return { error: jsonError ? fileNotFoundJsonError(normalizedPath) : fileNotFoundError(normalizedPath) };
  }
  return { file, normalizedPath };
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
