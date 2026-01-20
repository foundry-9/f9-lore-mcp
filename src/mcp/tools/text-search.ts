/**
 * Text search tools: grep, str_replace
 */

import type { App } from "obsidian";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveFilesToSearch,
  textResponse,
  errorResponse,
} from "../utils";
import { normalizeForSearch, replaceWithNormalization } from "../../utils/normalize";

/**
 * Register text search tools.
 */
export function registerTextSearchTools(mcp: McpServer, app: App): void {
  // Register grep (text/regex search) tool
  mcp.registerTool(
    "grep",
    {
      description:
        "Surgical text search for finding exact strings or regex patterns. Use this when you need to locate something specific—typically to edit it—such as a particular phrase, variable name, or tag. For general exploration or finding information about a topic, use the semantic search tool instead. Returns matching lines with file paths and optional context.",
      inputSchema: z.object({
        query: z.string().describe("Search string or regex pattern").min(1),
        is_regex: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, treat query as a regular expression"),
        case_sensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, search is case-sensitive"),
        path: z
          .string()
          .optional()
          .describe(
            "Vault-relative path to search. If a file path, searches only that file. If a folder path, searches all notes in that folder. If omitted/empty, searches entire vault."
          ),
        context_lines: z
          .number()
          .optional()
          .default(0)
          .describe("Number of lines of context to include before and after each match"),
        max_results: z
          .number()
          .optional()
          .default(100)
          .describe("Maximum number of matches to return (default: 100)"),
        normalize_diacritics: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), normalize Unicode diacritics for matching (e.g., 'Nimue' matches 'Nimuë')"),
      }),
    },
    async (args) => {
      const { query, is_regex, case_sensitive, path, context_lines, max_results, normalize_diacritics } = args;

      // Build regex from query
      // If normalizing diacritics, normalize the query first
      const queryToUse = normalize_diacritics && !is_regex ? normalizeForSearch(query) : query;

      let regex: RegExp;
      try {
        if (is_regex) {
          regex = new RegExp(queryToUse, case_sensitive ? "g" : "gi");
        } else {
          // Escape special regex characters for literal search
          const escaped = queryToUse.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          regex = new RegExp(escaped, case_sensitive ? "g" : "gi");
        }
      } catch (err) {
        return errorResponse(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Determine which files to search
      const { files: filesToSearch, error } = resolveFilesToSearch(app, path);
      if (error) {
        return error;
      }

      if (filesToSearch.length === 0) {
        return textResponse("No files to search");
      }

      // Search through files
      interface GrepMatch {
        file: string;
        line: number;
        content: string;
        context_before: string[];
        context_after: string[];
      }

      const matches: GrepMatch[] = [];
      let totalMatches = 0;

      for (const file of filesToSearch) {
        if (totalMatches >= max_results) break;

        const content = await app.vault.read(file);
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (totalMatches >= max_results) break;

          // Reset regex lastIndex for each line
          regex.lastIndex = 0;
          // Normalize the line for comparison if diacritics normalization is enabled
          const lineToTest = normalize_diacritics && !is_regex ? normalizeForSearch(lines[i]) : lines[i];
          if (regex.test(lineToTest)) {
            // Get context lines
            const contextBefore: string[] = [];
            const contextAfter: string[] = [];

            if (context_lines > 0) {
              for (let j = Math.max(0, i - context_lines); j < i; j++) {
                contextBefore.push(lines[j]);
              }
              for (let j = i + 1; j <= Math.min(lines.length - 1, i + context_lines); j++) {
                contextAfter.push(lines[j]);
              }
            }

            matches.push({
              file: file.path,
              line: i + 1, // 1-indexed
              content: lines[i],
              context_before: contextBefore,
              context_after: contextAfter,
            });
            totalMatches++;
          }
        }
      }

      if (matches.length === 0) {
        return textResponse(`No matches found for ${is_regex ? "pattern" : "query"}: ${query}`);
      }

      // Format results
      const formatted = matches
        .map((m) => {
          let result = `**${m.file}:${m.line}**\n`;
          if (m.context_before.length > 0) {
            result += m.context_before.map((l) => `  ${l}`).join("\n") + "\n";
          }
          result += `> ${m.content}`;
          if (m.context_after.length > 0) {
            result += "\n" + m.context_after.map((l) => `  ${l}`).join("\n");
          }
          return result;
        })
        .join("\n\n");

      const summary =
        totalMatches >= max_results
          ? `Found ${matches.length} matches (limited to ${max_results}). Searched ${filesToSearch.length} files.`
          : `Found ${matches.length} matches in ${filesToSearch.length} files.`;

      return textResponse(`${summary}\n\n${formatted}`);
    }
  );

  // Register str_replace (string replacement) tool
  mcp.registerTool(
    "str_replace",
    {
      description:
        "Replace all occurrences of a string in notes. Searches for exact string matches (not regex) and replaces them.",
      inputSchema: z.object({
        search: z.string().describe("The exact string to search for").min(1),
        replace: z.string().describe("The string to replace matches with"),
        case_sensitive: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), search is case-sensitive"),
        path: z
          .string()
          .optional()
          .describe(
            "Vault-relative path to search. If a file path, searches only that file. If a folder path, searches all notes in that folder. If omitted/empty, searches entire vault."
          ),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, only report what would be changed without making changes"),
        normalize_diacritics: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), normalize Unicode diacritics for matching (e.g., 'Nimue' matches 'Nimuë')"),
      }),
    },
    async (args) => {
      const { search, replace, case_sensitive, path, dry_run, normalize_diacritics } = args;

      // Determine which files to search
      const { files: filesToSearch, error } = resolveFilesToSearch(app, path);
      if (error) {
        return error;
      }

      if (filesToSearch.length === 0) {
        return textResponse("No files to search");
      }

      // Search and replace through files
      interface ReplaceResult {
        file: string;
        replacements: number;
      }

      const results: ReplaceResult[] = [];
      let totalReplacements = 0;
      let filesModified = 0;

      for (const file of filesToSearch) {
        const content = await app.vault.read(file);

        // Count and perform replacements
        let newContent: string;
        let count: number;

        if (normalize_diacritics) {
          // Use normalization-aware replacement
          const result = replaceWithNormalization(content, search, replace, case_sensitive);
          newContent = result.newContent;
          count = result.count;
        } else if (case_sensitive) {
          // Case-sensitive: simple split and count
          const parts = content.split(search);
          count = parts.length - 1;
          newContent = parts.join(replace);
        } else {
          // Case-insensitive: use regex with escaped search string
          const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(escaped, "gi");
          count = (content.match(regex) || []).length;
          newContent = content.replace(regex, replace);
        }

        if (count > 0) {
          results.push({
            file: file.path,
            replacements: count,
          });
          totalReplacements += count;
          filesModified++;

          if (!dry_run) {
            await app.vault.modify(file, newContent);
          }
        }
      }

      if (totalReplacements === 0) {
        return textResponse(`No occurrences of "${search}" found in ${filesToSearch.length} files.`);
      }

      // Format results
      const action = dry_run ? "Would replace" : "Replaced";
      const formatted = results
        .map((r) => `- **${r.file}**: ${r.replacements} replacement${r.replacements !== 1 ? "s" : ""}`)
        .join("\n");

      const summary = dry_run
        ? `**Dry run**: Would replace ${totalReplacements} occurrence${totalReplacements !== 1 ? "s" : ""} in ${filesModified} file${filesModified !== 1 ? "s" : ""}.`
        : `${action} ${totalReplacements} occurrence${totalReplacements !== 1 ? "s" : ""} in ${filesModified} file${filesModified !== 1 ? "s" : ""}.`;

      return textResponse(`${summary}\n\n${formatted}`);
    }
  );
}
