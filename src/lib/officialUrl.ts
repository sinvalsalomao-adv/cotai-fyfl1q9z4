export interface StrictOfficialUrl {
  raw: string
  host: string
  pathname: string
  query: string | null
}

/** Raw DNS host grammar shared by producers and UI consumers. */
export function isStrictOfficialGovHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false
  const host = value.toLowerCase()
  if (!host.endsWith('.gov.br') || host === 'catalogo.compras.gov.br') return false
  return host
    .split('.')
    .every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
}

/**
 * Parses only the raw URL grammar accepted by the index-batch hook.
 *
 * This validation deliberately happens before WHATWG URL parsing: URL would
 * otherwise turn backslashes into slashes, remove an explicit :443 port and
 * encode raw whitespace, accepting evidence that the persistent index rejects.
 */
export function parseStrictOfficialUrl(value: unknown): StrictOfficialUrl | null {
  if (typeof value !== 'string' || value.length === 0 || /[\s\\]/.test(value)) return null
  const match = value.match(/^https:\/\/([a-z0-9.-]+)(\/[^#]*)?$/i)
  if (!match) return null

  const host = match[1].toLowerCase()
  if (!isStrictOfficialGovHost(host)) return null

  const rawPath = match[2] || '/'
  const separator = rawPath.indexOf('?')
  const pathname = separator < 0 ? rawPath : rawPath.slice(0, separator)
  const query = separator < 0 ? null : rawPath.slice(separator + 1)

  return { raw: value, host, pathname, query }
}

/** Exact raw-query comparison compatible with index_batch.js. */
export function matchesExactOfficialQuery(
  url: StrictOfficialUrl,
  expected: Record<string, unknown>,
): boolean {
  if (url.query === null || url.query.length === 0) return false
  const pieces = url.query.split('&')
  const seen = new Set<string>()

  for (const piece of pieces) {
    const pair = piece.split('=')
    if (pair.length !== 2 || !pair[0]) return false
    let name: string
    let value: string
    try {
      name = decodeURIComponent(pair[0].replace(/\+/g, ' '))
      value = decodeURIComponent(pair[1].replace(/\+/g, ' '))
    } catch {
      return false
    }
    if (
      !Object.prototype.hasOwnProperty.call(expected, name) ||
      seen.has(name) ||
      value !== String(expected[name] ?? '')
    )
      return false
    seen.add(name)
  }

  return seen.size === Object.keys(expected).length
}

/** First raw query value, compatible with index_batch.js legacy item routes. */
export function getStrictOfficialQueryParam(url: StrictOfficialUrl, name: string): string {
  if (url.query === null) return ''
  const match = url.query.match(new RegExp('(?:^|&)' + name + '=([^&#]*)'))
  if (!match) return ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}
