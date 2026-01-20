import type { CachedMetadata, HeadingCache, ListItemCache, SectionCache } from "obsidian";

// ============================================================================
// Types
// ============================================================================

export interface FreshnessToken {
  mtime: number;
  hash: string; // First 16 chars of content hash
}

export interface FrontmatterInfo {
  exists: boolean;
  keys: string[];
  position?: { startLine: number; endLine: number };
}

export interface HeadingInfo {
  id: string; // e.g., "h-2-42" (level-line)
  level: number;
  text: string;
  line: number;
}

export interface SectionInfo {
  id: string; // e.g., "s-paragraph-15"
  type: string;
  startLine: number;
  endLine: number;
  preview: string; // First 100 chars
}

export interface ListItemInfo {
  id: string; // e.g., "li-22"
  line: number;
  indent: number;
  isTask: boolean;
  taskStatus?: string;
  text: string;
  parentId?: string;
}

export interface NoteStructure {
  freshnessToken: string;
  path: string;
  frontmatter: FrontmatterInfo;
  headings: HeadingInfo[];
  sections: SectionInfo[];
  listItems: ListItemInfo[];
}

// ============================================================================
// Freshness Token Functions
// ============================================================================

/**
 * Simple hash function for content (djb2 algorithm).
 * Returns a hex string.
 */
function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and then to hex
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Creates a freshness token from file content and mtime.
 * Token is base64-encoded JSON for compactness.
 */
export function createFreshnessToken(content: string, mtime: number): string {
  const token: FreshnessToken = {
    mtime,
    hash: hashContent(content),
  };
  return btoa(JSON.stringify(token));
}

/**
 * Parses a freshness token back into its components.
 * Returns null if the token is malformed.
 */
export function parseFreshnessToken(token: string): FreshnessToken | null {
  try {
    const decoded = atob(token);
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "mtime" in parsed &&
      "hash" in parsed &&
      typeof (parsed as FreshnessToken).mtime === "number" &&
      typeof (parsed as FreshnessToken).hash === "string"
    ) {
      return parsed as FreshnessToken;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verifies that a freshness token matches the current file state.
 * Returns true if the file hasn't changed, false otherwise.
 */
export function verifyFreshness(
  token: string,
  currentContent: string,
  currentMtime: number
): boolean {
  const parsed = parseFreshnessToken(token);
  if (!parsed) return false;

  // Fast path: if mtime matches, likely unchanged
  if (parsed.mtime === currentMtime) {
    return true;
  }

  // Slow path: verify content hash
  const currentHash = hashContent(currentContent);
  return parsed.hash === currentHash;
}

// ============================================================================
// ID Generation
// ============================================================================

export function generateHeadingId(heading: HeadingCache): string {
  return `h-${heading.level}-${heading.position.start.line}`;
}

export function generateSectionId(section: SectionCache): string {
  return `s-${section.type}-${section.position.start.line}`;
}

export function generateListItemId(item: ListItemCache): string {
  return `li-${item.position.start.line}`;
}

// ============================================================================
// Content Extraction
// ============================================================================

/**
 * Extracts text from content using position offsets.
 */
export function extractByOffsets(
  content: string,
  startOffset: number,
  endOffset: number
): string {
  return content.slice(startOffset, endOffset);
}

/**
 * Gets a preview of content (first N chars, trimmed).
 */
export function getPreview(content: string, maxLength = 100): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
}

/**
 * Extracts the content under a heading (until next heading of same or higher level).
 */
export function extractHeadingContent(
  content: string,
  headingId: string,
  cache: CachedMetadata
): { heading: HeadingCache; content: string } | null {
  const headings = cache.headings || [];
  const headingIndex = headings.findIndex((h) => generateHeadingId(h) === headingId);

  if (headingIndex === -1) {
    return null;
  }

  const heading = headings[headingIndex];
  const headingLevel = heading.level;

  // Find the end: either next heading of same/higher level, or end of file
  let endOffset = content.length;
  for (let i = headingIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= headingLevel) {
      endOffset = headings[i].position.start.offset;
      break;
    }
  }

  // Start after the heading line
  const headingEndOffset = heading.position.end.offset;
  // Skip the newline after heading
  let startOffset = headingEndOffset;
  if (content[startOffset] === "\n") {
    startOffset++;
  }

  return {
    heading,
    content: content.slice(startOffset, endOffset),
  };
}

/**
 * Extracts a section's content by ID.
 */
export function extractSectionContent(
  content: string,
  sectionId: string,
  cache: CachedMetadata
): { section: SectionCache; content: string } | null {
  const sections = cache.sections || [];
  const section = sections.find((s) => generateSectionId(s) === sectionId);

  if (!section) {
    return null;
  }

  return {
    section,
    content: extractByOffsets(content, section.position.start.offset, section.position.end.offset),
  };
}

/**
 * Gets the text content of a list item (excluding the marker).
 */
function extractListItemText(content: string, item: ListItemCache): string {
  const lineStart = item.position.start.offset;
  const lineEnd = item.position.end.offset;
  const line = content.slice(lineStart, lineEnd);

  // Parse the list marker: -, *, +, or 1. style, possibly with [ ] task
  // Examples: "- text", "* text", "1. text", "- [ ] task", "  - nested"
  const match = line.match(/^(\s*)(?:[-*+]|\d+\.)\s*(?:\[(.)\]\s*)?(.*)/);
  if (match) {
    return match[3] || "";
  }
  return line.trim();
}

/**
 * Calculates indent level from a list item.
 * Uses the parent property: negative means root level.
 */
function calculateIndentLevel(
  item: ListItemCache,
  allItems: ListItemCache[]
): { indent: number; parentId?: string } {
  if (item.parent < 0) {
    // Root level item
    return { indent: 0 };
  }

  // Find parent by line number
  const parentItem = allItems.find((i) => i.position.start.line === item.parent);
  if (parentItem) {
    const parentResult = calculateIndentLevel(parentItem, allItems);
    return {
      indent: parentResult.indent + 1,
      parentId: generateListItemId(parentItem),
    };
  }

  return { indent: 0 };
}

// ============================================================================
// Build Note Structure
// ============================================================================

/**
 * Builds a complete NoteStructure from file content and metadata cache.
 */
export function buildNoteStructure(
  path: string,
  content: string,
  cache: CachedMetadata | null,
  mtime: number
): NoteStructure {
  const freshnessToken = createFreshnessToken(content, mtime);

  // Handle null cache (file might not be parsed yet)
  if (!cache) {
    return {
      freshnessToken,
      path,
      frontmatter: { exists: false, keys: [] },
      headings: [],
      sections: [],
      listItems: [],
    };
  }

  // Build frontmatter info
  const frontmatter: FrontmatterInfo = {
    exists: !!cache.frontmatter,
    keys: cache.frontmatter ? Object.keys(cache.frontmatter).filter((k) => k !== "position") : [],
  };
  if (cache.frontmatterPosition) {
    frontmatter.position = {
      startLine: cache.frontmatterPosition.start.line,
      endLine: cache.frontmatterPosition.end.line,
    };
  }

  // Build headings info
  const headings: HeadingInfo[] = (cache.headings || []).map((h) => ({
    id: generateHeadingId(h),
    level: h.level,
    text: h.heading,
    line: h.position.start.line,
  }));

  // Build sections info
  const sections: SectionInfo[] = (cache.sections || []).map((s) => {
    const sectionContent = extractByOffsets(
      content,
      s.position.start.offset,
      s.position.end.offset
    );
    return {
      id: generateSectionId(s),
      type: s.type,
      startLine: s.position.start.line,
      endLine: s.position.end.line,
      preview: getPreview(sectionContent),
    };
  });

  // Build list items info
  const allListItems = cache.listItems || [];
  const listItems: ListItemInfo[] = allListItems.map((item) => {
    const { indent, parentId } = calculateIndentLevel(item, allListItems);
    const text = extractListItemText(content, item);
    const isTask = item.task !== undefined;

    return {
      id: generateListItemId(item),
      line: item.position.start.line,
      indent,
      isTask,
      taskStatus: item.task,
      text,
      parentId,
    };
  });

  return {
    freshnessToken,
    path,
    frontmatter,
    headings,
    sections,
    listItems,
  };
}
