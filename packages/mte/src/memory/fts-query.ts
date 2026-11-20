/** Converts raw user text into a safe FTS5 MATCH expression. */
export function toFtsMatchQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' AND ')
}
