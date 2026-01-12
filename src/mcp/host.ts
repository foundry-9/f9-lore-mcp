import type { App, TFile, TFolder } from "obsidian";
import { z } from "zod";
import { createServer as createHttpsServer, ServerOptions as HttpsServerOptions } from "node:https";
import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VectorIndexer } from "../vector/indexer";
import {
  buildNoteStructure,
  createFreshnessToken,
  verifyFreshness,
  extractSectionContent,
  extractHeadingContent,
  generateSectionId,
  generateHeadingId,
  generateListItemId,
  type NoteStructure,
} from "./structure";
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
} from "./editors";

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
}

interface McpSession {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

export class ObsidianMcpHost {
  private app: App;
  private config: McpConfig;
  private httpServer?: Server;
  private sessions: Map<string, McpSession> = new Map();
  private vectorIndexer?: VectorIndexer;

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

  /**
   * Perform an edit operation with freshness verification and optional post-write verification.
   */
  private async performEdit(
    file: TFile,
    freshnessToken: string,
    editFn: (content: string, cache: import("obsidian").CachedMetadata) => string | null,
    verify: boolean
  ): Promise<{
    success: boolean;
    freshnessToken?: string;
    verified?: boolean;
    error?: string;
    errorCode?: string;
    currentToken?: string;
  }> {
    // Read current content
    const content = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);

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
    await this.app.vault.modify(file, newContent);

    // Wait for cache to update
    if (verify) {
      await this.waitForCacheUpdate(file);
    }

    // Generate new token
    const updatedContent = await this.app.vault.read(file);
    const newToken = createFreshnessToken(updatedContent, file.stat.mtime);

    return {
      success: true,
      freshnessToken: newToken,
      verified: verify,
    };
  }

  isRunning(): boolean {
    return !!this.httpServer;
  }

  /**
   * Register all MCP tools on a server instance.
   */
  private registerTools(mcp: McpServer): void {
    // Register simple ping tool
    mcp.registerTool("ping", {}, async () => ({
      content: [{ type: "text", text: "pong from Obsidian" }],
    }));

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
      "create_note",
      {
        description: "Create a note in the current vault",
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
        const normalizedPath = path.replace(/^\/+/, "");
        let file = this.app.vault.getFileByPath(normalizedPath);
        let fuzzyMatch = false;
        let matchedPath: string | undefined;

        if (!file) {
          // Try fuzzy matching by filename
          const allFiles = this.app.vault.getMarkdownFiles();

          // Extract the target name without extension
          const targetName = normalizedPath
            .split("/").pop()!  // Get filename part
            .replace(/\.md$/i, "")  // Remove .md extension
            .toLowerCase();

          // Find best match by comparing filenames (without extensions)
          let bestMatch: TFile | null = null;
          let bestScore = 0;

          for (const f of allFiles) {
            const fileName = f.basename.toLowerCase();

            // Exact filename match (ignoring case and extension)
            if (fileName === targetName) {
              bestMatch = f;
              bestScore = 1000;  // Perfect match
              break;
            }

            // Check if filename contains the target or vice versa
            let score = 0;
            if (fileName.includes(targetName)) {
              // Prefer shorter filenames that contain the target (closer match)
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
          return {
            content: [{ type: "text", text: `Note not found: ${normalizedPath}` }],
            isError: true,
          };
        }

        const noteContent = await this.app.vault.read(file);

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

        return {
          content: [{ type: "text", text: noteContent }],
        };
      }
    );

    // Register note update tool
    mcp.registerTool(
      "update_note",
      {
        description: "Update the contents of an existing note in the current vault",
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

    // ========================================================================
    // Granular Structure Tools
    // ========================================================================

    // Register get note structure tool
    mcp.registerTool(
      "get_note_structure",
      {
        description:
          "Get the structural overview of a note (headings, sections, list items, frontmatter) with a freshness token for subsequent edits. Returns metadata without full content for token efficiency.",
        inputSchema: z.object({
          path: z
            .string()
            .describe("Vault-relative path, e.g. 'Folder/Note.md'")
            .min(1),
          include_content: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, includes full content for sections instead of previews"),
        }),
      },
      async (args) => {
        const { path, include_content } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const noteContent = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        const structure = buildNoteStructure(normalizedPath, noteContent, cache, file.stat.mtime);

        // If include_content is true, replace previews with full content
        if (include_content && cache?.sections) {
          for (const section of structure.sections) {
            const extracted = extractSectionContent(noteContent, section.id, cache);
            if (extracted) {
              (section as { preview: string }).preview = extracted.content;
            }
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify(structure, null, 2) }],
        };
      }
    );

    // Register read section tool
    mcp.registerTool(
      "read_section",
      {
        description: "Read the full content of a specific section by ID (from get_note_structure)",
        inputSchema: z.object({
          path: z.string().describe("Vault-relative path").min(1),
          section_id: z.string().describe("Section ID from get_note_structure, e.g. 's-paragraph-15'").min(1),
          freshnessToken: z
            .string()
            .optional()
            .describe("Token from get_note_structure to verify file hasn't changed"),
        }),
      },
      async (args) => {
        const { path, section_id, freshnessToken } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const noteContent = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);

        // Check freshness if token provided
        let stale = false;
        if (freshnessToken) {
          stale = !verifyFreshness(freshnessToken, noteContent, file.stat.mtime);
        }

        if (!cache) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "NO_CACHE", message: "Metadata cache not available for this file" }),
              },
            ],
            isError: true,
          };
        }

        const extracted = extractSectionContent(noteContent, section_id, cache);
        if (!extracted) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "SECTION_NOT_FOUND", message: `Section not found: ${section_id}` }),
              },
            ],
            isError: true,
          };
        }

        const newToken = createFreshnessToken(noteContent, file.stat.mtime);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                content: extracted.content,
                freshnessToken: newToken,
                stale,
              }),
            },
          ],
        };
      }
    );

    // Register read heading content tool
    mcp.registerTool(
      "read_heading_content",
      {
        description:
          "Read all content under a heading (until the next heading of same or higher level)",
        inputSchema: z.object({
          path: z.string().describe("Vault-relative path").min(1),
          heading_id: z.string().describe("Heading ID from get_note_structure, e.g. 'h-2-42'").min(1),
          freshnessToken: z
            .string()
            .optional()
            .describe("Token from get_note_structure to verify file hasn't changed"),
        }),
      },
      async (args) => {
        const { path, heading_id, freshnessToken } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const noteContent = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);

        let stale = false;
        if (freshnessToken) {
          stale = !verifyFreshness(freshnessToken, noteContent, file.stat.mtime);
        }

        if (!cache) {
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

        const extracted = extractHeadingContent(noteContent, heading_id, cache);
        if (!extracted) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "HEADING_NOT_FOUND", message: `Heading not found: ${heading_id}` }),
              },
            ],
            isError: true,
          };
        }

        const newToken = createFreshnessToken(noteContent, file.stat.mtime);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                heading: extracted.heading.heading,
                level: extracted.heading.level,
                content: extracted.content,
                freshnessToken: newToken,
                stale,
              }),
            },
          ],
        };
      }
    );

    // Register read frontmatter tool
    mcp.registerTool(
      "read_frontmatter",
      {
        description: "Read frontmatter (YAML) from a note as structured JSON",
        inputSchema: z.object({
          path: z.string().describe("Vault-relative path").min(1),
          keys: z
            .array(z.string())
            .optional()
            .describe("Specific keys to read. If omitted, reads all frontmatter."),
        }),
      },
      async (args) => {
        const { path, keys } = args;
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const noteContent = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        const newToken = createFreshnessToken(noteContent, file.stat.mtime);

        if (!cache?.frontmatter) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  exists: false,
                  data: {},
                  freshnessToken: newToken,
                }),
              },
            ],
          };
        }

        // Filter out the internal 'position' key that Obsidian adds
        const frontmatter = { ...cache.frontmatter };
        delete (frontmatter as Record<string, unknown>).position;

        let data: Record<string, unknown>;
        if (keys && keys.length > 0) {
          data = {};
          for (const key of keys) {
            if (key in frontmatter) {
              data[key] = frontmatter[key];
            }
          }
        } else {
          data = frontmatter;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                exists: true,
                data,
                freshnessToken: newToken,
              }),
            },
          ],
        };
      }
    );

    // ========================================================================
    // Granular Write Tools
    // ========================================================================

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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const result = await this.performEdit(
          file,
          freshnessToken,
          (c, cache) => updateSectionContent(c, cache, section_id, newContent),
          verify
        );

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
              }),
            },
          ],
        };
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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const result = await this.performEdit(
          file,
          freshnessToken,
          (c, cache) => deleteSection(c, cache, section_id),
          verify
        );

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
              }),
            },
          ],
        };
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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const result = await this.performEdit(
          file,
          freshnessToken,
          (c, cache) => updateHeadingContent(c, cache, heading_id, newContent, preserve_subheadings),
          verify
        );

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
              }),
            },
          ],
        };
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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const result = await this.performEdit(
          file,
          freshnessToken,
          (c, cache) => renameHeading(c, cache, heading_id, new_text, new_level),
          verify
        );

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
              }),
            },
          ],
        };
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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        // Apply text update if provided
        let editResult = { success: true, freshnessToken, verified: false, error: undefined as string | undefined, errorCode: undefined as string | undefined, currentToken: undefined as string | undefined };

        if (text !== undefined) {
          editResult = await this.performEdit(
            file,
            editResult.freshnessToken!,
            (c, cache) => updateListItemText(c, cache, list_item_id, text),
            false // Don't verify intermediate step
          );
          if (!editResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: editResult.errorCode,
                    message: editResult.error,
                    currentToken: editResult.currentToken,
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        // Apply task status update if provided
        if (task_status !== undefined) {
          editResult = await this.performEdit(
            file,
            editResult.freshnessToken!,
            (c, cache) => updateListItemTask(c, cache, list_item_id, task_status),
            verify
          );
          if (!editResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: editResult.errorCode,
                    message: editResult.error,
                    currentToken: editResult.currentToken,
                  }),
                },
              ],
              isError: true,
            };
          }
        } else if (verify && text !== undefined) {
          // If only text was updated, we need to verify now
          await this.waitForCacheUpdate(file);
          const updatedContent = await this.app.vault.read(file);
          editResult.freshnessToken = createFreshnessToken(updatedContent, file.stat.mtime);
          editResult.verified = true;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                freshnessToken: editResult.freshnessToken,
                verified: editResult.verified,
              }),
            },
          ],
        };
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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const result = await this.performEdit(
          file,
          freshnessToken,
          (c, cache) => updateFrontmatter(c, cache, updates, replace_all),
          verify
        );

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
              }),
            },
          ],
        };
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
        const normalizedPath = path.replace(/^\/+/, "");
        const file = this.app.vault.getFileByPath(normalizedPath);
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "FILE_NOT_FOUND", message: `Note not found: ${normalizedPath}` }),
              },
            ],
            isError: true,
          };
        }

        const result = await this.performEdit(
          file,
          freshnessToken,
          (c, cache) => insertContent(c, cache, position as InsertPosition, newContent),
          verify
        );

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
              }),
            },
          ],
        };
      }
    );

    // Register vector search refresh tool (check for stale files)
    mcp.registerTool(
      "refresh_index",
      {
        description: "Check for new or modified files and update the vector index (same as startup check)",
        inputSchema: z.object({}),
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
      "reindex_vault",
      {
        description: "Force re-embed all markdown files in the vault for vector search",
        inputSchema: z.object({}),
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
      "search",
      {
        description: "Semantic vector search across vault notes using embeddings",
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
                  text: "No results found. The vault may need to be indexed first (use reindex_vault).",
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
  }

  /**
   * Create a new MCP session with its own server and transport.
   */
  private async createSession(): Promise<{ sessionId: string; session: McpSession }> {
    const mcp = new McpServer(
      { name: "F9 Obsidian MCP", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );

    this.registerTools(mcp);

    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      allowedHosts: this.config.allowedHosts,
      allowedOrigins: this.config.allowedOrigins,
      enableDnsRebindingProtection: this.config.enableDnsRebindingProtection ?? false,
    });

    console.log(`[F9 MCP] Connecting MCP server to transport...`);
    await mcp.connect(transport);
    console.log(`[F9 MCP] Connected`);

    const session: McpSession = {
      mcp,
      transport,
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    console.log(`[F9 MCP] Created new session: ${sessionId} (total: ${this.sessions.size})`);

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
      console.log(`[F9 MCP] Closed session: ${sessionId} (remaining: ${this.sessions.size})`);
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

          console.log(`[F9 MCP] ${req.method} /mcp - sessionId: ${sessionId || "(none)"}, existing sessions: ${this.sessions.size}`);

          if (sessionId && this.sessions.has(sessionId)) {
            // Route to existing session
            console.log(`[F9 MCP] Routing to existing session: ${sessionId}`);
            const session = this.sessions.get(sessionId)!;
            try {
              await session.transport.handleRequest(req, res);
              console.log(`[F9 MCP] Request handled successfully for session: ${sessionId}`);
            } catch (transportErr) {
              console.error(`[F9 MCP] Transport error for session ${sessionId}:`, transportErr);
              throw transportErr;
            }
          } else if (req.method === "POST") {
            // Create new session for POST without valid session ID
            console.log(`[F9 MCP] Creating new session for POST request`);
            const { sessionId: newSessionId, session } = await this.createSession();
            console.log(`[F9 MCP] Handling request with new session: ${newSessionId}`);
            try {
              await session.transport.handleRequest(req, res);
              console.log(`[F9 MCP] Initial request handled for session: ${newSessionId}`);
            } catch (transportErr) {
              console.error(`[F9 MCP] Transport error for new session ${newSessionId}:`, transportErr);
              throw transportErr;
            }
          } else if (req.method === "DELETE" && sessionId) {
            // Handle session termination
            console.log(`[F9 MCP] DELETE request for session: ${sessionId}`);
            await this.closeSession(sessionId);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else if (req.method === "GET") {
            // GET requests need a valid session for SSE streams
            console.log(`[F9 MCP] GET request without valid session - rejecting`);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "GET requires valid mcp-session-id header" }));
          } else {
            // Invalid request - no session and not a POST
            console.log(`[F9 MCP] Invalid request: method=${req.method}, sessionId=${sessionId}`);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid session or method" }));
          }
        } else if (url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessions: this.sessions.size }));
        } else if (url === "/debug") {
          // Debug endpoint to inspect server state
          const sessionInfo: Record<string, unknown>[] = [];
          for (const [sid, sess] of this.sessions) {
            const toolCount = Object.keys((sess.mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools || {}).length;
            sessionInfo.push({
              sessionId: sid,
              createdAt: sess.createdAt,
              toolCount,
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
        console.error(`[F9 MCP] Error handling request: ${message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    };

    // Create HTTP or HTTPS server based on configuration
    let server: Server;
    const protocol = useHttps ? "https" : "http";

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
    console.log(`[F9 MCP] Server started on ${protocol}://127.0.0.1:${port}/mcp (multi-session v2 - ${new Date().toISOString()})`);
  }

  async stop(): Promise<void> {
    // Close all active sessions
    const closePromises: Promise<void>[] = [];

    for (const [sessionId, session] of this.sessions) {
      closePromises.push(
        session.mcp.close().then(() => {
          console.log(`[F9 MCP] Closed session: ${sessionId}`);
        })
      );
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
    console.log("[F9 MCP] Server stopped");
  }

  async restart(config?: Partial<McpConfig>): Promise<void> {
    if (config) this.config = { ...this.config, ...config };
    await this.stop();
    await this.start();
  }
}
