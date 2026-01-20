/**
 * Unicode diacritical normalization utilities for search.
 *
 * These functions enable searching for words like "Nimue" to match "Nimuë"
 * by stripping combining diacritical marks for comparison purposes only.
 */

/**
 * Normalize a string for search comparison by stripping diacritical marks.
 * Uses NFD normalization to decompose characters, then removes combining marks.
 *
 * @example
 * normalizeForSearch("Nimuë") // returns "Nimue"
 * normalizeForSearch("café") // returns "cafe"
 * normalizeForSearch("naïve") // returns "naive"
 */
export function normalizeForSearch(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Build an index map from normalized string positions to original NFD string positions.
 * This is used to map match positions in normalized content back to original content.
 *
 * Returns an array where indexMap[normalizedPos] = originalNFDPos
 */
export function buildNormalizedIndexMap(original: string): number[] {
  const nfd = original.normalize("NFD");
  const map: number[] = [];

  for (let i = 0; i < nfd.length; i++) {
    const char = nfd[i];
    // Skip combining diacritical marks (U+0300 to U+036F)
    if (!/[\u0300-\u036f]/.test(char)) {
      map.push(i);
    }
  }

  return map;
}

/**
 * Find all match positions in normalized content and map them back to original content.
 * Returns an array of {start, end} positions in the original string.
 *
 * @param original - The original string (not normalized)
 * @param search - The search string (will be normalized internally)
 * @param caseSensitive - Whether the search should be case-sensitive
 */
export function findNormalizedMatches(
  original: string,
  search: string,
  caseSensitive: boolean
): Array<{ start: number; end: number }> {
  const nfd = original.normalize("NFD");
  const indexMap = buildNormalizedIndexMap(original);
  const normalized = normalizeForSearch(original);
  const normalizedSearch = normalizeForSearch(search);

  const matches: Array<{ start: number; end: number }> = [];

  // Build regex for finding matches in normalized content
  const escaped = normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, caseSensitive ? "g" : "gi");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized)) !== null) {
    const normalizedStart = match.index;
    const normalizedEnd = match.index + match[0].length;

    // Map normalized positions back to NFD positions
    const nfdStart = indexMap[normalizedStart];
    // For the end, we need the position after the last matched character
    // If normalizedEnd is past the last index, use nfd.length
    const nfdEnd =
      normalizedEnd < indexMap.length
        ? indexMap[normalizedEnd]
        : nfd.length;

    // Convert NFD positions back to original string positions
    // NFD positions can be directly used as byte positions in the original
    // since normalize("NFD") only expands characters, it doesn't change their starting positions
    const origStart = nfdToOriginalPosition(original, nfdStart);
    const origEnd = nfdToOriginalPosition(original, nfdEnd);

    matches.push({ start: origStart, end: origEnd });
  }

  return matches;
}

/**
 * Convert an NFD string position to the corresponding position in the original string.
 */
function nfdToOriginalPosition(original: string, nfdPos: number): number {
  // Walk through original string, tracking NFD position
  let origPos = 0;
  let currentNfdPos = 0;

  while (origPos < original.length && currentNfdPos < nfdPos) {
    const char = original[origPos];
    const charNfd = char.normalize("NFD");
    currentNfdPos += charNfd.length;
    origPos++;
  }

  // If we're past the target NFD position, we're at the right original position
  // If currentNfdPos > nfdPos, the nfdPos was in the middle of a decomposed char
  return origPos;
}

/**
 * Perform string replacement with diacritical normalization.
 * Finds matches using normalized comparison but replaces the original text.
 *
 * @param content - The original content to search in
 * @param search - The search string (will be normalized for matching)
 * @param replace - The replacement string
 * @param caseSensitive - Whether the search should be case-sensitive
 * @returns Object with new content and count of replacements made
 */
export function replaceWithNormalization(
  content: string,
  search: string,
  replace: string,
  caseSensitive: boolean
): { newContent: string; count: number } {
  const matches = findNormalizedMatches(content, search, caseSensitive);

  if (matches.length === 0) {
    return { newContent: content, count: 0 };
  }

  // Build new content by replacing matches from end to start
  // (to preserve position indices)
  let newContent = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i];
    newContent = newContent.slice(0, start) + replace + newContent.slice(end);
  }

  return { newContent, count: matches.length };
}
