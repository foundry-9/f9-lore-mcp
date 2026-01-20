/**
 * Folder operations: list_folders, list_notes, create_folder, delete_folder
 */

import { TFolder } from "obsidian";
import type { App } from "obsidian";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeFolderPath,
  folderNotFoundError,
  textResponse,
} from "../utils";

/**
 * Register folder operation tools.
 */
export function registerFolderOpsTools(mcp: McpServer, app: App): void {
  // Register list folders tool
  mcp.registerTool(
    "list_folders",
    {
      description: "List folders in the vault, optionally filtered by parent folder",
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe("Vault-relative parent folder path. If omitted, lists all folders in the vault."),
      }),
    },
    (args) => {
      const { folder } = args;
      const allFolders: string[] = [];
      const root = app.vault.getRoot();
      const collectFolders = (f: TFolder) => {
        for (const child of f.children) {
          if (child instanceof TFolder) {
            allFolders.push(child.path);
            collectFolders(child);
          }
        }
      };
      collectFolders(root);

      let folders: string[];
      if (folder) {
        const normalizedFolder = normalizeFolderPath(folder);
        folders = allFolders.filter((f) => f.startsWith(normalizedFolder + "/"));
      } else {
        folders = allFolders;
      }
      folders.sort();
      return Promise.resolve(textResponse(folders.length > 0 ? folders.join("\n") : "(no folders found)"));
    }
  );

  // Register list notes tool
  mcp.registerTool(
    "list_notes",
    {
      description: "List notes in the vault, optionally filtered by folder",
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe("Vault-relative folder path to list notes from. If omitted, lists all notes in the vault."),
      }),
    },
    (args) => {
      const { folder } = args;
      const allFiles = app.vault.getMarkdownFiles();

      let files;
      if (folder) {
        const normalizedFolder = normalizeFolderPath(folder);
        files = allFiles.filter((f) => f.path.startsWith(normalizedFolder + "/"));
      } else {
        files = allFiles;
      }
      const paths = files.map((f) => f.path).sort();
      return Promise.resolve(textResponse(paths.length > 0 ? paths.join("\n") : "(no notes found)"));
    }
  );

  // Register folder creation tool
  mcp.registerTool(
    "create_folder",
    {
      description: "Create a folder in the current vault (creates intermediate folders as needed)",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative folder path, e.g. 'Parent/Child/NewFolder'")
          .min(1),
      }),
    },
    async (args) => {
      const { path } = args;
      const normalizedPath = normalizeFolderPath(path);
      const existing = app.vault.getAbstractFileByPath(normalizedPath);
      if (existing) {
        return textResponse(`Folder already exists: ${normalizedPath}`);
      }
      await app.vault.createFolder(normalizedPath);
      return textResponse(`Created folder: ${normalizedPath}`);
    }
  );

  // Register folder deletion tool
  mcp.registerTool(
    "delete_folder",
    {
      description: "Delete a folder from the current vault (moves to system trash)",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative folder path, e.g. 'Folder/Subfolder'")
          .min(1),
        delete_if_not_empty: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, delete folder even if it contains files. Defaults to false."),
      }),
    },
    async (args) => {
      const { path, delete_if_not_empty } = args;
      const normalizedPath = normalizeFolderPath(path);
      const folder = app.vault.getAbstractFileByPath(normalizedPath);
      if (!folder) {
        return folderNotFoundError(normalizedPath);
      }
      if (!(folder instanceof TFolder)) {
        return {
          content: [{ type: "text", text: `Path is not a folder: ${normalizedPath}` }],
          isError: true,
        };
      }
      if (!delete_if_not_empty && folder.children.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Folder is not empty: ${normalizedPath} (contains ${folder.children.length} items). Set delete_if_not_empty to true to delete anyway.`,
            },
          ],
          isError: true,
        };
      }
      await app.fileManager.trashFile(folder);
      return textResponse(`Deleted folder: ${normalizedPath}`);
    }
  );
}
