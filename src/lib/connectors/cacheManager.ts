/**
 * Price Search Cache Manager
 * Gerencia cache por fonte, termo, filtros, pagina e versão do conector com isolamento estrito de tenant.
 * Suporta ação "ATUALIZAR DADOS" para ignorar cache sob demanda.
 */

import { AmostraPreco, PaginationInfo } from './types'

export interface CacheEntry<T = any> {
  chave: string
  fonte: string
  termo: string
  tenantId: string
  timestamp: number
  validadeMs: number
  versaoConector: string
  quantidade: number
  dados: T
  pagination?: PaginationInfo
}

export class PriceSearchCache {
  private static instance: PriceSearchCache
  private cacheMemoria = new Map<string, CacheEntry>()
  private readonly defaultTtlMs = 10 * 60 * 1000 // 10 minutos para dados públicos

  private constructor() {
    // Limpeza periódica de itens expirados a cada 2 minutos
    if (typeof window !== 'undefined') {
      window.setInterval(() => this.expurgarExpirados(), 120000)
    }
  }

  public static getInstance(): PriceSearchCache {
    if (!PriceSearchCache.instance) {
      PriceSearchCache.instance = new PriceSearchCache()
    }
    return PriceSearchCache.instance
  }

  /**
   * Constrói chave canônica unívoca contendo tenant, fonte, parâmetros normalizados e versão
   */
  public gerarChave(
    tenantId: string,
    fonte: string,
    termo: string,
    filtros: Record<string, any>,
    pagina?: number,
    versaoConector = 'v1',
  ): string {
    const termoNorm = (termo || '').trim().toLowerCase()
    const filtrosSanitizados = Object.keys(filtros || {})
      .sort()
      .filter((k) => filtros[k] !== undefined && filtros[k] !== null && filtros[k] !== '')
      .map((k) => `${k}:${filtros[k]}`)
      .join('|')

    return `${tenantId}#${fonte.toUpperCase()}#${termoNorm}#p${pagina || 1}#${filtrosSanitizados}#ver:${versaoConector}`
  }

  public get<T = { amostras: AmostraPreco[]; pagination: PaginationInfo }>(
    chave: string,
  ): CacheEntry<T> | null {
    const entry = this.cacheMemoria.get(chave)
    if (!entry) return null

    const agora = Date.now()
    if (agora - entry.timestamp > entry.validadeMs) {
      this.cacheMemoria.delete(chave)
      return null
    }

    return entry as CacheEntry<T>
  }

  public set<T>(
    chave: string,
    fonte: string,
    termo: string,
    tenantId: string,
    dados: T,
    quantidade: number,
    pagination?: PaginationInfo,
    ttlMs?: number,
    versaoConector = 'v1',
  ): void {
    this.cacheMemoria.set(chave, {
      chave,
      fonte,
      termo,
      tenantId,
      timestamp: Date.now(),
      validadeMs: ttlMs ?? this.defaultTtlMs,
      versaoConector,
      quantidade,
      dados,
      pagination,
    })
  }

  public invalidarTenantOuFonte(tenantId: string, fonte?: string): void {
    const prefixo = fonte ? `${tenantId}#${fonte.toUpperCase()}` : `${tenantId}#`
    for (const key of this.cacheMemoria.keys()) {
      if (key.startsWith(prefixo)) {
        this.cacheMemoria.delete(key)
      }
    }
  }

  public expurgarExpirados(): void {
    const agora = Date.now()
    for (const [key, entry] of this.cacheMemoria.entries()) {
      if (agora - entry.timestamp > entry.validadeMs) {
        this.cacheMemoria.delete(key)
      }
    }
  }

  public limparTudo(): void {
    this.cacheMemoria.clear()
  }

  public getTamanho(): number {
    return this.cacheMemoria.size
  }
}
