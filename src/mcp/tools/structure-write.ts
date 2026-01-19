/**
 * Structure write tools: update_section, delete_section, update_heading_content,
 * rename_heading, update_list_item, update_frontmatter, insert_content
 */

import type { App, TFile, CachedMetadata } from "obsidian";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeNotePath,
  fileNotFoundJsonError,
  editResultToToolResponse,
  type PerformEditResult,
} from "../utils";
import {
  createFreshnessToken,
  verifyFreshness,
} from "../structure";
import {
  updateSectionContent,
  deleteSection,
  updateHeadingContent,
  renameHeading,
  updateListItemText,
  updateListItemTask,
  updateFrontmatter,
  insertContent,
  type InsertPosition,
} from "../editors";

/**
 * Context required for structure write operations.
 */
export interface StructureWriteContext {
  app: App;
  waitForCacheUpdate: (file: TFile, timeout?: number) => Promise<void>;
}

/**
 * Perform an edit operation with freshness verification and optional post-write verification.
 */
async function performEdit(
  ctx: StructureWriteContext,
  file: TFile,
  freshnessToken: string,
  editFn: (content: string, cache: CachedMetadata) => string | null,
  verify: boolean
): Promise<PerformEditResult> {
  const { app, waitForCacheUpdate } = ctx;

  // Read current content
  const content = await app.vault.read(file);
  const cache = app.metadataCache.getFileCache(file);

  if (!cache) {
    return {
      success: false,
      error: "Metadata cache not available",
      errorCode: "NO_CACHE",
    };
  }

  // Verify freshness
  if (!verifyFreshness(freshnessToken, content, file.stat.mtime)) {
    const currentToken = createFreshnessToken(content, file.stat.mtime);
    return {
      success: false,
      error: "File has changed since last read. Please re-read the file structure.",
      errorCode: "STALE_TOKEN",
      currentToken,
    };
  }

  // Apply the edit
  const newContent = editFn(content, cache);
  if (newContent === null) {
    return {
      success: false,
      error: "Edit operation failed - target not found",
      errorCode: "TARGET_NOT_FOUND",
    };
  }

  // Write the changes
  await app.vault.modify(file, newContent);

  // Wait for cache to update
  if (verify) {
    await waitForCacheUpdate(file);
  }

  // Generate new token
  const updatedContent = await app.vault.read(file);
  const newToken = createFreshnessToken(updatedContent, file.stat.mtime);

  return {
    success: true,
    freshnessToken: newToken,
    verified: verify,
  };
}

/**
 * Register structure write tools.
 */
export function registerStructureWriteTools(mcp: McpServer, ctx: StructureWriteContext): void {
  const { app, waitForCacheUpdate } = ctx;

  // Register update section tool
  mcp.registerTool(
    "update_section",
    {
      description: "Update the content of a specific section",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        section_id: z.string().describe("Section ID from get_note_structure").min(1),
        freshnessToken: z.string().describe("Token from last read to verify file hasn't changed").min(1),
        content: z.string().describe("New content for the section"),
        verify: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true, verify the change was applied"),
      }),
    },
    async (args) => {
      const { path, section_id, freshnessToken, content: newContent, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const result = await performEdit(
        ctx,
        file,
        freshnessToken,
        (c, cache) => updateSectionContent(c, cache, section_id, newContent),
        verify
      );

      return editResultToToolResponse(result);
    }
  );

  // Register delete section tool
  mcp.registerTool(
    "delete_section",
    {
      description: "Delete a section from a note",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        section_id: z.string().describe("Section ID from get_note_structure").min(1),
        freshnessToken: z.string().describe("Token from last read").min(1),
        verify: z.boolean().optional().default(true),
      }),
    },
    async (args) => {
      const { path, section_id, freshnessToken, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const result = await performEdit(
        ctx,
        file,
        freshnessToken,
        (c, cache) => deleteSection(c, cache, section_id),
        verify
      );

      return editResultToToolResponse(result);
    }
  );

  // Register update heading content tool
  mcp.registerTool(
    "update_heading_content",
    {
      description: "Update all content under a heading (until next same/higher level heading)",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        heading_id: z.string().describe("Heading ID from get_note_structure").min(1),
        freshnessToken: z.string().describe("Token from last read").min(1),
        content: z.string().describe("New content to place under the heading"),
        preserve_subheadings: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true, only replaces content before first subheading"),
        verify: z.boolean().optional().default(true),
      }),
    },
    async (args) => {
      const { path, heading_id, freshnessToken, content: newContent, preserve_subheadings, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const result = await performEdit(
        ctx,
        file,
        freshnessToken,
        (c, cache) => updateHeadingContent(c, cache, heading_id, newContent, preserve_subheadings),
        verify
      );

      return editResultToToolResponse(result);
    }
  );

  // Register rename heading tool
  mcp.registerTool(
    "rename_heading",
    {
      description: "Rename a heading (change text and/or level)",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        heading_id: z.string().describe("Heading ID from get_note_structure").min(1),
        freshnessToken: z.string().describe("Token from last read").min(1),
        new_text: z.string().describe("New heading text"),
        new_level: z
          .number()
          .min(1)
          .max(6)
          .optional()
          .describe("New heading level (1-6). If omitted, keeps current level."),
        verify: z.boolean().optional().default(true),
      }),
    },
    async (args) => {
      const { path, heading_id, freshnessToken, new_text, new_level, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const result = await performEdit(
        ctx,
        file,
        freshnessToken,
        (c, cache) => renameHeading(c, cache, heading_id, new_text, new_level),
        verify
      );

      return editResultToToolResponse(result);
    }
  );

  // Register update list item tool
  mcp.registerTool(
    "update_list_item",
    {
      description: "Update a list item's text and/or task status",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        list_item_id: z.string().describe("List item ID from get_note_structure").min(1),
        freshnessToken: z.string().describe("Token from last read").min(1),
        text: z.string().optional().describe("New text for the list item (excluding marker)"),
        task_status: z
          .string()
          .optional()
          .describe("Task status character: ' ' for incomplete, 'x' for complete, or other character"),
        verify: z.boolean().optional().default(true),
      }),
    },
    async (args) => {
      const { path, list_item_id, freshnessToken, text, task_status, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      // Apply text update if provided
      let editResult: PerformEditResult = { success: true, freshnessToken, verified: false };

      if (text !== undefined) {
        editResult = await performEdit(
          ctx,
          file,
          editResult.freshnessToken!,
          (c, cache) => updateListItemText(c, cache, list_item_id, text),
          false // Don't verify intermediate step
        );
        if (!editResult.success) {
          return editResultToToolResponse(editResult);
        }
      }

      // Apply task status update if provided
      if (task_status !== undefined) {
        editResult = await performEdit(
          ctx,
          file,
          editResult.freshnessToken!,
          (c, cache) => updateListItemTask(c, cache, list_item_id, task_status),
          verify
        );
        if (!editResult.success) {
          return editResultToToolResponse(editResult);
        }
      } else if (verify && text !== undefined) {
        // If only text was updated, we need to verify now
        await waitForCacheUpdate(file);
        const updatedContent = await app.vault.read(file);
        editResult.freshnessToken = createFreshnessToken(updatedContent, file.stat.mtime);
        editResult.verified = true;
      }

      return editResultToToolResponse(editResult);
    }
  );

  // Register update frontmatter tool
  mcp.registerTool(
    "update_frontmatter",
    {
      description: "Update frontmatter properties. Use null as a value to delete a key.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        freshnessToken: z.string().describe("Token from last read").min(1),
        updates: z
          .record(z.string(), z.string())
          .describe("Key-value pairs to set (values are JSON-stringified). Use 'null' to delete a key."),
        replace_all: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, replaces entire frontmatter instead of merging"),
        verify: z.boolean().optional().default(true),
      }),
    },
    async (args) => {
      const { path, freshnessToken, updates, replace_all, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const result = await performEdit(
        ctx,
        file,
        freshnessToken,
        (c, cache) => updateFrontmatter(c, cache, updates, replace_all),
        verify
      );

      return editResultToToolResponse(result);
    }
  );

  // Register insert content tool
  mcp.registerTool(
    "insert_content",
    {
      description: "Insert content at a specific position in a note",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path").min(1),
        freshnessToken: z.string().describe("Token from last read").min(1),
        position: z
          .union([
            z.object({ after_section_id: z.string() }),
            z.object({ before_section_id: z.string() }),
            z.object({
              under_heading_id: z.string(),
              at: z.enum(["start", "end"]),
            }),
            z.object({ at_line: z.number() }),
            z.object({ at: z.enum(["start", "end"]) }),
          ])
          .describe("Where to insert: after/before section, under heading, at line number, or at start/end of file"),
        content: z.string().describe("Content to insert"),
        verify: z.boolean().optional().default(true),
      }),
    },
    async (args) => {
      const { path, freshnessToken, position, content: newContent, verify } = args;
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const result = await performEdit(
        ctx,
        file,
        freshnessToken,
        (c, cache) => insertContent(c, cache, position as InsertPosition, newContent),
        verify
      );

      return editResultToToolResponse(result);
    }
  );
}
