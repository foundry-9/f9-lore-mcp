import type { CachedMetadata, HeadingCache, ListItemCache, SectionCache } from "obsidian";
import {
  generateSectionId,
  generateHeadingId,
  generateListItemId,
} from "./structure";

// ============================================================================
// Basic String Operations
// ============================================================================

/**
 * Replaces content between two offsets.
 */
export function replaceAtOffsets(
  content: string,
  startOffset: number,
  endOffset: number,
  replacement: string
): string {
  return content.slice(0, startOffset) + replacement + content.slice(endOffset);
}

// ============================================================================
// Lookup Helpers (DRY)
// ============================================================================

/**
 * Find a section by its generated ID.
 */
function findSectionById(cache: CachedMetadata, sectionId: string): SectionCache | undefined {
  return (cache.sections || []).find((s) => generateSectionId(s) === sectionId);
}

/**
 * Find a heading by its generated ID. Returns index and heading, or undefined.
 */
function findHeadingById(cache: CachedMetadata, headingId: string): { index: number; heading: HeadingCache } | undefined {
  const headings = cache.headings || [];
  const index = headings.findIndex((h) => generateHeadingId(h) === headingId);
  if (index === -1) return undefined;
  return { index, heading: headings[index] };
}

/**
 * Find a list item by its generated ID.
 */
function findListItemById(cache: CachedMetadata, listItemId: string): ListItemCache | undefined {
  return (cache.listItems || []).find((i) => generateListItemId(i) === listItemId);
}

// ============================================================================
// Section Editing
// ============================================================================

/**
 * Updates a section's content by ID.
 * Returns null if section not found.
 */
export function updateSectionContent(
  content: string,
  cache: CachedMetadata,
  sectionId: string,
  newContent: string
): string | null {
  const section = findSectionById(cache, sectionId);
  if (!section) return null;

  return replaceAtOffsets(
    content,
    section.position.start.offset,
    section.position.end.offset,
    newContent
  );
}

/**
 * Deletes a section by ID.
 * Returns null if section not found.
 */
export function deleteSection(
  content: string,
  cache: CachedMetadata,
  sectionId: string
): string | null {
  const section = findSectionById(cache, sectionId);
  if (!section) return null;

  // Delete the section and any trailing newline
  let endOffset = section.position.end.offset;
  if (content[endOffset] === "\n") {
    endOffset++;
  }

  return replaceAtOffsets(content, section.position.start.offset, endOffset, "");
}

/**
 * Inserts content after a section.
 * Returns null if section not found.
 */
export function insertAfterSection(
  content: string,
  cache: CachedMetadata,
  sectionId: string,
  newContent: string
): string | null {
  const section = findSectionById(cache, sectionId);
  if (!section) return null;

  const insertPoint = section.position.end.offset;
  // Ensure there's a newline before the new content
  const prefix = content[insertPoint - 1] === "\n" ? "" : "\n";
  const suffix = newContent.endsWith("\n") ? "" : "\n";

  return replaceAtOffsets(content, insertPoint, insertPoint, prefix + newContent + suffix);
}

/**
 * Inserts content before a section.
 * Returns null if section not found.
 */
export function insertBeforeSection(
  content: string,
  cache: CachedMetadata,
  sectionId: string,
  newContent: string
): string | null {
  const section = findSectionById(cache, sectionId);
  if (!section) return null;

  const insertPoint = section.position.start.offset;
  const suffix = newContent.endsWith("\n") ? "" : "\n";

  return replaceAtOffsets(content, insertPoint, insertPoint, newContent + suffix);
}

// ============================================================================
// Heading Editing
// ============================================================================

/**
 * Updates the content under a heading (until next heading of same or higher level).
 * If preserveSubheadings is true, only replaces content before the first subheading.
 * Returns null if heading not found.
 */
export function updateHeadingContent(
  content: string,
  cache: CachedMetadata,
  headingId: string,
  newContent: string,
  preserveSubheadings: boolean
): string | null {
  const found = findHeadingById(cache, headingId);
  if (!found) return null;

  const headings = cache.headings || [];
  const { index: headingIndex, heading } = found;
  const headingLevel = heading.level;

  // Start after the heading line
  let startOffset = heading.position.end.offset;
  if (content[startOffset] === "\n") {
    startOffset++;
  }

  // Find the end
  let endOffset = content.length;
  for (let i = headingIndex + 1; i < headings.length; i++) {
    const nextHeading = headings[i];
    if (preserveSubheadings) {
      // Stop at any subheading
      endOffset = nextHeading.position.start.offset;
      break;
    } else if (nextHeading.level <= headingLevel) {
      // Stop at same or higher level heading
      endOffset = nextHeading.position.start.offset;
      break;
    }
  }

  // Ensure proper newlines
  const prefix = "";
  const suffix = newContent.endsWith("\n") ? "" : "\n";

  return replaceAtOffsets(content, startOffset, endOffset, prefix + newContent + suffix);
}

/**
 * Renames a heading (changes text and/or level).
 * Returns null if heading not found.
 */
export function renameHeading(
  content: string,
  cache: CachedMetadata,
  headingId: string,
  newText: string,
  newLevel?: number
): string | null {
  const found = findHeadingById(cache, headingId);
  if (!found) return null;

  const level = newLevel ?? found.heading.level;
  const hashes = "#".repeat(level);
  const newHeadingLine = `${hashes} ${newText}`;

  return replaceAtOffsets(
    content,
    found.heading.position.start.offset,
    found.heading.position.end.offset,
    newHeadingLine
  );
}

/**
 * Inserts content at the end of a heading's section (before next same/higher level heading).
 * Returns null if heading not found.
 */
export function insertUnderHeading(
  content: string,
  cache: CachedMetadata,
  headingId: string,
  newContent: string,
  atStart: boolean
): string | null {
  const found = findHeadingById(cache, headingId);
  if (!found) return null;

  const headings = cache.headings || [];
  const { index: headingIndex, heading } = found;
  const headingLevel = heading.level;

  if (atStart) {
    // Insert right after the heading
    let insertPoint = heading.position.end.offset;
    if (content[insertPoint] === "\n") {
      insertPoint++;
    }
    const suffix = newContent.endsWith("\n") ? "" : "\n";
    return replaceAtOffsets(content, insertPoint, insertPoint, newContent + suffix);
  } else {
    // Insert at the end of the heading's content
    let endOffset = content.length;
    for (let i = headingIndex + 1; i < headings.length; i++) {
      if (headings[i].level <= headingLevel) {
        endOffset = headings[i].position.start.offset;
        break;
      }
    }

    // Go back before any trailing newlines
    while (endOffset > 0 && content[endOffset - 1] === "\n") {
      endOffset--;
    }

    const prefix = "\n";
    const suffix = newContent.endsWith("\n") ? "" : "\n";
    return replaceAtOffsets(content, endOffset, endOffset, prefix + newContent + suffix);
  }
}

// ============================================================================
// List Item Editing
// ============================================================================

/**
 * Parses a list item line to extract its components.
 */
function parseListItemLine(line: string): {
  indent: string;
  marker: string;
  taskBox?: string;
  text: string;
} | null {
  // Match: optional indent, marker (-, *, +, or number.), optional task box, text
  const match = line.match(/^(\s*)([-*+]|\d+\.)\s*(\[(.)\]\s*)?(.*)/);
  if (!match) {
    return null;
  }

  return {
    indent: match[1],
    marker: match[2],
    taskBox: match[3] ? `[${match[4]}] ` : undefined,
    text: match[5] || "",
  };
}

/**
 * Helper to find a list item and parse its line content.
 * Returns null if item not found or line cannot be parsed.
 */
function withParsedListItem(
  content: string,
  cache: CachedMetadata,
  listItemId: string,
  builder: (parsed: { indent: string; marker: string; taskBox?: string; text: string }) => string
): string | null {
  const item = findListItemById(cache, listItemId);
  if (!item) return null;

  const lineStart = item.position.start.offset;
  const lineEnd = item.position.end.offset;
  const currentLine = content.slice(lineStart, lineEnd);

  const parsed = parseListItemLine(currentLine);
  if (!parsed) return null;

  const newLine = builder(parsed);
  return replaceAtOffsets(content, lineStart, lineEnd, newLine);
}

/**
 * Updates a list item's text (preserving marker and task status).
 * Returns null if list item not found.
 */
export function updateListItemText(
  content: string,
  cache: CachedMetadata,
  listItemId: string,
  newText: string
): string | null {
  return withParsedListItem(content, cache, listItemId, (parsed) =>
    `${parsed.indent}${parsed.marker} ${parsed.taskBox || ""}${newText}`
  );
}

/**
 * Updates a list item's task status.
 * If the item is not a task, converts it to one.
 * Returns null if list item not found.
 */
export function updateListItemTask(
  content: string,
  cache: CachedMetadata,
  listItemId: string,
  taskStatus: string
): string | null {
  return withParsedListItem(content, cache, listItemId, (parsed) =>
    `${parsed.indent}${parsed.marker} [${taskStatus}] ${parsed.text}`
  );
}

/**
 * Removes task status from a list item.
 * Returns null if list item not found.
 */
export function removeListItemTask(
  content: string,
  cache: CachedMetadata,
  listItemId: string
): string | null {
  return withParsedListItem(content, cache, listItemId, (parsed) =>
    `${parsed.indent}${parsed.marker} ${parsed.text}`
  );
}

// ============================================================================
// Frontmatter Editing
// ============================================================================

/**
 * Updates frontmatter properties.
 * If replaceAll is true, replaces entire frontmatter.
 * Use null as a value to delete a key.
 * Returns null if there's an error.
 */
export function updateFrontmatter(
  content: string,
  cache: CachedMetadata,
  updates: Record<string, unknown>,
  replaceAll: boolean
): string | null {
  const hasFrontmatter = !!cache.frontmatter;
  const frontmatterPos = cache.frontmatterPosition;

  // Build the new frontmatter object
  let newFrontmatter: Record<string, unknown>;

  if (replaceAll) {
    newFrontmatter = { ...updates };
  } else if (hasFrontmatter && cache.frontmatter) {
    // Merge with existing
    newFrontmatter = { ...cache.frontmatter };
    delete newFrontmatter.position; // Remove internal key

    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        delete newFrontmatter[key];
      } else {
        newFrontmatter[key] = value;
      }
    }
  } else {
    // No existing frontmatter, create new
    newFrontmatter = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== null) {
        newFrontmatter[key] = value;
      }
    }
  }

  // Remove null values
  for (const key of Object.keys(newFrontmatter)) {
    if (newFrontmatter[key] === null) {
      delete newFrontmatter[key];
    }
  }

  // Convert to YAML
  const yamlLines: string[] = [];
  for (const [key, value] of Object.entries(newFrontmatter)) {
    yamlLines.push(formatYamlLine(key, value));
  }

  const newFrontmatterContent =
    yamlLines.length > 0 ? `---\n${yamlLines.join("\n")}\n---\n` : "";

  if (hasFrontmatter && frontmatterPos) {
    // Replace existing frontmatter
    let endOffset = frontmatterPos.end.offset;
    // Include the trailing newline if present
    if (content[endOffset] === "\n") {
      endOffset++;
    }
    return replaceAtOffsets(content, frontmatterPos.start.offset, endOffset, newFrontmatterContent);
  } else {
    // Insert at beginning
    return newFrontmatterContent + content;
  }
}

/**
 * Formats a key-value pair as a YAML line.
 * Handles basic types (string, number, boolean, array, object).
 */
function formatYamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return `${key}:`;
  }

  if (typeof value === "string") {
    // Check if string needs quoting
    if (
      value.includes(":") ||
      value.includes("#") ||
      value.includes("\n") ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      value === ""
    ) {
      return `${key}: "${value.replace(/"/g, '\\"')}"`;
    }
    return `${key}: ${value}`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `${key}: ${value}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${key}: []`;
    }
    // Simple inline array for short items
    if (value.every((v) => typeof v === "string" && v.length < 20 && !v.includes(","))) {
      return `${key}: [${value.map((v) => (typeof v === "string" ? v : String(v))).join(", ")}]`;
    }
    // Multi-line array
    const items = value.map((v) => `  - ${typeof v === "string" ? v : JSON.stringify(v)}`);
    return `${key}:\n${items.join("\n")}`;
  }

  // For objects, null, or other types, use JSON serialization
  return `${key}: ${JSON.stringify(value)}`;
}

// ============================================================================
// Generic Insert Operations
// ============================================================================

export type InsertPosition =
  | { after_section_id: string }
  | { before_section_id: string }
  | { under_heading_id: string; at: "start" | "end" }
  | { at_line: number }
  | { at: "start" | "end" };

/**
 * Inserts content at a specified position.
 * Returns null if the position reference is not found.
 */
export function insertContent(
  content: string,
  cache: CachedMetadata,
  position: InsertPosition,
  newContent: string
): string | null {
  if ("after_section_id" in position) {
    return insertAfterSection(content, cache, position.after_section_id, newContent);
  }

  if ("before_section_id" in position) {
    return insertBeforeSection(content, cache, position.before_section_id, newContent);
  }

  if ("under_heading_id" in position) {
    return insertUnderHeading(
      content,
      cache,
      position.under_heading_id,
      newContent,
      position.at === "start"
    );
  }

  if ("at_line" in position) {
    // Find offset for line number (0-based)
    const lines = content.split("\n");
    let offset = 0;
    for (let i = 0; i < position.at_line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    const suffix = newContent.endsWith("\n") ? "" : "\n";
    return replaceAtOffsets(content, offset, offset, newContent + suffix);
  }

  if ("at" in position) {
    if (position.at === "start") {
      // Insert at very beginning (after frontmatter if present)
      const frontmatterPos = cache.frontmatterPosition;
      let insertPoint = 0;
      if (frontmatterPos) {
        insertPoint = frontmatterPos.end.offset;
        if (content[insertPoint] === "\n") {
          insertPoint++;
        }
      }
      const suffix = newContent.endsWith("\n") ? "" : "\n";
      return replaceAtOffsets(content, insertPoint, insertPoint, newContent + suffix);
    } else {
      // Insert at end
      const suffix = content.endsWith("\n") ? "" : "\n";
      const prefix = newContent.startsWith("\n") ? "" : "\n";
      return content + prefix + newContent + suffix;
    }
  }

  return null;
}
