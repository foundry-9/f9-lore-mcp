/**
 * Basic note operations: ping, create, read, update, delete, move/rename
 */

import type { App, TFile } from "obsidian";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeNotePath,
  fileNotFoundError,
  ensureParentFolder,
  textResponse,
  getFileOrError,
} from "../utils";

/**
 * Register basic note operation tools.
 */
export function registerBasicOpsTools(mcp: McpServer, app: App): void {
  // Register simple ping tool
  mcp.registerTool("ping", {}, async () => ({
    content: [{ type: "text", text: "pong from Lore" }],
  }));

  // Register note creation tool
  mcp.registerTool(
    "create_note",
    {
      description: "Create a new note in the current vault. For adding content to an existing note, prefer granular structure tools (insert_content, update_section, update_heading_content) which are more token-efficient.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative path, e.g. 'Folder/Note.md'")
          .min(1),
        content: z.string().optional().describe("Initial note contents"),
      }),
    },
    async (args) => {
      const { path, content } = args;
      const normalizedPath = normalizeNotePath(path);
      await ensureParentFolder(app, normalizedPath);
      const file = await app.vault.create(normalizedPath, content ?? "");
      return textResponse(`Created note at ${file.path}`);
    }
  );

  // Register note reading tool
  mcp.registerTool(
    "read_note",
    {
      description: "Read the contents of a note in the current vault. If the exact path is not found, attempts fuzzy matching by filename.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative path, e.g. 'Folder/Note.md'")
          .min(1),
      }),
    },
    async (args) => {
      const { path } = args;
      const normalizedPath = normalizeNotePath(path);
      let file = app.vault.getFileByPath(normalizedPath);
      let fuzzyMatch = false;
      let matchedPath: string | undefined;

      if (!file) {
        // Try fuzzy matching by filename
        const allFiles = app.vault.getMarkdownFiles();

        // Extract the target name without extension
        const targetName = normalizedPath
          .split("/").pop()!
          .replace(/\.md$/i, "")
          .toLowerCase();

        // Find best match by comparing filenames (without extensions)
        let bestMatch: TFile | null = null;
        let bestScore = 0;

        for (const f of allFiles) {
          const fileName = f.basename.toLowerCase();

          // Exact filename match (ignoring case and extension)
          if (fileName === targetName) {
            bestMatch = f;
            bestScore = 1000;
            break;
          }

          // Check if filename contains the target or vice versa
          let score = 0;
          if (fileName.includes(targetName)) {
            score = targetName.length / fileName.length * 100;
          } else if (targetName.includes(fileName)) {
            score = fileName.length / targetName.length * 50;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = f;
          }
        }

        if (bestMatch) {
          file = bestMatch;
          fuzzyMatch = true;
          matchedPath = bestMatch.path;
        }
      }

      if (!file) {
        return fileNotFoundError(normalizedPath);
      }

      const noteContent = await app.vault.read(file);

      if (fuzzyMatch) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                content: noteContent,
                fuzzy_match: true,
                requested_path: normalizedPath,
                actual_path: matchedPath,
              }),
            },
          ],
        };
      }

      return textResponse(noteContent);
    }
  );

  // Register note update tool
  mcp.registerTool(
    "update_note",
    {
      description: "Replace the entire contents of an existing note. For partial edits, prefer granular structure tools (update_section, update_heading_content, update_list_item, update_frontmatter, insert_content) which are more token-efficient and reduce risk of unintended changes.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative path, e.g. 'Folder/Note.md'")
          .min(1),
        content: z.string().describe("New contents for the note"),
      }),
    },
    async (args) => {
      const { path, content } = args;
      const lookup = getFileOrError(app, path);
      if ("error" in lookup) return lookup.error;
      await app.vault.modify(lookup.file, content);
      return textResponse(`Updated note: ${lookup.normalizedPath}`);
    }
  );

  // Register note deletion tool
  mcp.registerTool(
    "delete_note",
    {
      description: "Delete a note from the current vault (moves to system trash)",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative path, e.g. 'Folder/Note.md'")
          .min(1),
      }),
    },
    async (args) => {
      const { path } = args;
      const lookup = getFileOrError(app, path);
      if ("error" in lookup) return lookup.error;
      await app.fileManager.trashFile(lookup.file);
      return textResponse(`Deleted note: ${lookup.normalizedPath}`);
    }
  );

  // Register note move/rename tool
  mcp.registerTool(
    "move_or_rename_note",
    {
      description: "Move or rename a note in the current vault",
      inputSchema: z.object({
        from: z
          .string()
          .describe("Current vault-relative path, e.g. 'Folder/Note.md'")
          .min(1),
        to: z
          .string()
          .describe("New vault-relative path, e.g. 'NewFolder/RenamedNote.md'")
          .min(1),
      }),
    },
    async (args) => {
      const { from, to } = args;
      const lookup = getFileOrError(app, from);
      if ("error" in lookup) return lookup.error;
      const normalizedTo = normalizeNotePath(to);
      await ensureParentFolder(app, normalizedTo);
      await app.fileManager.renameFile(lookup.file, normalizedTo);
      return textResponse(`Moved note from ${lookup.normalizedPath} to ${normalizedTo}`);
    }
  );
}
