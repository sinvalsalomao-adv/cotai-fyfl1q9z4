import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const sources = [
  ['PNCP', '../pocketbase/hooks/pncp_search.js'],
  ['Compras.gov.br', '../pocketbase/hooks/comprasgov_search.js'],
] as const

function register(relativePath: string) {
  let handler: (event: any) => any
  let middleware: any[] = []
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const source = readFileSync(path, 'utf8')
  vm.runInNewContext(source, {
    routerAdd(_method: string, _route: string, callback: typeof handler, ...rest: any[]) {
      handler = callback
      middleware = rest
    },
    $apis: { requireAuth: () => ({ authenticated: true }) },
  })
  return { source, handler: handler!, middleware }
}

describe.each(sources)('%s official source receipt hook', (_source, relativePath) => {
  it('requires authentication before parsing a source query', () => {
    const hook = register(relativePath)
    const result = hook.handler({
      auth: null,
      requestInfo: () => {
        throw new Error('query must not be parsed before auth')
      },
      json: (status: number, body: any) => ({ status, body }),
    })

    expect(result).toMatchObject({ status: 401, body: { error: 'AUTH_REQUIRED' } })
    expect(hook.middleware.some((entry) => entry.authenticated)).toBe(true)
  })

  it('issues only private, expiring page receipts and keeps helpers callback-local', () => {
    const { source } = register(relativePath)
    const callbackStart = source.indexOf('function (e) {')
    const receiptHelper = source.indexOf('function issueOfficialReceipt')

    expect(receiptHelper).toBeGreaterThan(callbackStart)
    expect(source).toContain("findCollectionByNameOrId('official_ingestion_receipts')")
    expect(source).toMatch(
      /findRecordsByFilter\(\s*['"]official_ingestion_receipts['"]/,
    )
    expect(source).toContain('_cotai_ingestion_claim')
    expect(source).toContain('ingestion_receipt')
    expect(source).toContain('expires_at')
  })
})
