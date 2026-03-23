/**
 * Extract a sensible short title from a full feature description.
 *
 * Handles patterns like:
 *   "Title: Custom 404 Page Description: Add a styled..."
 *   "Title: Custom 404 Page\nDescription: ..."
 *   "Add a styled custom 404 error page to the Express server. When..."
 */
export function extractTitle(description: string): string {
  if (!description) return "Untitled Plan";

  // Pattern: "Title: X Description:" or "Title: X\n"
  const titleMatch = description.match(/^Title:\s*(.+?)(?:\s*(?:Description|Architecture|Key decisions):|[\n\r])/i);
  if (titleMatch) {
    return titleMatch[1].trim();
  }

  // Pattern: starts with "Title: X" (no Description marker, take rest of first line)
  const titleLineMatch = description.match(/^Title:\s*(.+)/i);
  if (titleLineMatch) {
    const title = titleLineMatch[1].trim();
    if (title.length <= 120) return title;
    return title.slice(0, title.lastIndexOf(" ", 120)) + "…";
  }

  // No "Title:" prefix — take first sentence or line
  const firstBreak = description.search(/[.\n\r]/);
  if (firstBreak > 0 && firstBreak <= 120) {
    return description.slice(0, firstBreak).trim();
  }

  // Truncate at word boundary
  if (description.length <= 120) return description.trim();
  const cut = description.lastIndexOf(" ", 120);
  return description.slice(0, cut > 0 ? cut : 120).trim() + "…";
}
