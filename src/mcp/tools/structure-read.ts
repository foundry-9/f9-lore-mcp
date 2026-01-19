/**
 * Structure read tools: get_note_structure, read_section, read_heading_content, read_frontmatter
 */

import type { App } from "obsidian";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeNotePath,
  fileNotFoundJsonError,
  cacheNotAvailableError,
  jsonResponse,
} from "../utils";
import {
  buildNoteStructure,
  createFreshnessToken,
  verifyFreshness,
  extractSectionContent,
  extractHeadingContent,
} from "../structure";

/**
 * Register structure read tools.
 */
export function registerStructureReadTools(mcp: McpServer, app: App): void {
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
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const noteContent = await app.vault.read(file);
      const cache = app.metadataCache.getFileCache(file);
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

      return jsonResponse(structure, true);
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
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const noteContent = await app.vault.read(file);
      const cache = app.metadataCache.getFileCache(file);

      // Check freshness if token provided
      let stale = false;
      if (freshnessToken) {
        stale = !verifyFreshness(freshnessToken, noteContent, file.stat.mtime);
      }

      if (!cache) {
        return cacheNotAvailableError();
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
      return jsonResponse({
        content: extracted.content,
        freshnessToken: newToken,
        stale,
      });
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
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const noteContent = await app.vault.read(file);
      const cache = app.metadataCache.getFileCache(file);

      let stale = false;
      if (freshnessToken) {
        stale = !verifyFreshness(freshnessToken, noteContent, file.stat.mtime);
      }

      if (!cache) {
        return cacheNotAvailableError();
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
      return jsonResponse({
        heading: extracted.heading.heading,
        level: extracted.heading.level,
        content: extracted.content,
        freshnessToken: newToken,
        stale,
      });
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
      const normalizedPath = normalizeNotePath(path);
      const file = app.vault.getFileByPath(normalizedPath);
      if (!file) {
        return fileNotFoundJsonError(normalizedPath);
      }

      const noteContent = await app.vault.read(file);
      const cache = app.metadataCache.getFileCache(file);
      const newToken = createFreshnessToken(noteContent, file.stat.mtime);

      if (!cache?.frontmatter) {
        return jsonResponse({
          exists: false,
          data: {},
          freshnessToken: newToken,
        });
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

      return jsonResponse({
        exists: true,
        data,
        freshnessToken: newToken,
      });
    }
  );
}
