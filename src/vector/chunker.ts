/**
 * Markdown chunking for vector embeddings
 *
 * Splits markdown content into overlapping chunks while preserving
 * paragraph boundaries where possible.
 */

/**
 * Split a long paragraph into smaller chunks by sentences or characters.
 * Used as fallback when a single paragraph exceeds chunk size.
 */
function splitLongParagraph(
  paragraph: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];

  // Try splitting by sentences first
  const sentences = paragraph.split(/(?<=[.!?])\s+/);

  if (sentences.length > 1) {
    let current = "";
    for (const sentence of sentences) {
      if (current.length + sentence.length > chunkSize && current.length > 0) {
        chunks.push(current.trim());
        // Keep overlap from end of current chunk
        const overlapText = current.slice(-overlap);
        current = overlapText + " " + sentence;
      } else {
        current += (current ? " " : "") + sentence;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }
    return chunks;
  }

  // Fall back to character-based splitting
  let start = 0;
  while (start < paragraph.length) {
    const end = Math.min(start + chunkSize, paragraph.length);
    chunks.push(paragraph.slice(start, end).trim());
    start = end - overlap;
    if (start >= paragraph.length - overlap) break;
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Chunk markdown content into overlapping pieces.
 *
 * @param content - The markdown content to chunk
 * @param chunkSize - Target chunk size in characters (default ~2000 for ~500 tokens)
 * @param overlap - Overlap between chunks in characters (default 200)
 * @returns Array of chunk strings
 */
export function chunkMarkdown(
  content: string,
  chunkSize: number = 2000,
  overlap: number = 200
): string[] {
  if (!content || content.trim().length === 0) {
    return [];
  }

  // Split by double newlines (paragraphs)
  const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    const trimmedPara = para.trim();

    // If adding this paragraph would exceed chunk size
    if (currentChunk.length + trimmedPara.length + 2 > chunkSize) {
      if (currentChunk.length > 0) {
        // Save current chunk
        chunks.push(currentChunk.trim());

        // Start new chunk with overlap from end of current
        const overlapText = currentChunk.length > overlap
          ? currentChunk.slice(-overlap).trim()
          : "";

        // If paragraph itself is too long, split it
        if (trimmedPara.length > chunkSize) {
          const subChunks = splitLongParagraph(trimmedPara, chunkSize, overlap);
          if (subChunks.length > 0) {
            // Prepend overlap to first subchunk if it fits
            if (overlapText && subChunks[0].length + overlapText.length + 2 <= chunkSize) {
              subChunks[0] = overlapText + "\n\n" + subChunks[0];
            }
            // Add all but last subchunk to results
            for (let i = 0; i < subChunks.length - 1; i++) {
              chunks.push(subChunks[i]);
            }
            // Continue building with last subchunk
            currentChunk = subChunks[subChunks.length - 1];
          } else {
            currentChunk = overlapText ? overlapText + "\n\n" + trimmedPara : trimmedPara;
          }
        } else {
          currentChunk = overlapText
            ? overlapText + "\n\n" + trimmedPara
            : trimmedPara;
        }
      } else {
        // Current chunk is empty but paragraph is too long
        const subChunks = splitLongParagraph(trimmedPara, chunkSize, overlap);
        for (let i = 0; i < subChunks.length - 1; i++) {
          chunks.push(subChunks[i]);
        }
        currentChunk = subChunks[subChunks.length - 1] || "";
      }
    } else {
      // Add paragraph to current chunk
      currentChunk += (currentChunk ? "\n\n" : "") + trimmedPara;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
