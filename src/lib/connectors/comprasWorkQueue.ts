export type TipoCatalogoCompras = 'material' | 'servico'
export type SeletorPrecoCompras = 'codigoItemCatalogo' | 'codigoPdm'

export type TrabalhoCompras =
  | { etapa: 'catalogo'; tipo: TipoCatalogoCompras; termo: string }
  | { etapa: 'pdm'; codigoPdm: string }
  | {
      etapa: 'precos'
      tipo: TipoCatalogoCompras
      codigo: string
      pagina: number
      /** Omitted only by legacy continuations; the adapter restarts that code safely. */
      tamanhoPagina?: number
      seletor?: 'codigoItemCatalogo'
    }
  | {
      etapa: 'precos'
      tipo: 'material'
      codigo: string
      pagina: number
      tamanhoPagina?: number
      seletor: 'codigoPdm'
    }

export interface PaginacaoCompras {
  tipo: TipoCatalogoCompras
  codigo: string
  pagina: number
  tamanho: number
  total: number
  paginas: number
  seletor?: SeletorPrecoCompras
}

export function chavePaginacaoCompras(
  p: Pick<PaginacaoCompras, 'tipo' | 'codigo' | 'seletor'>,
): string {
  return JSON.stringify([p.tipo, p.seletor ?? 'codigoItemCatalogo', p.codigo.trim()])
}

export interface LoteCompras<T> {
  amostras: T[]
  continuacoes: TrabalhoCompras[]
  paginacao?: PaginacaoCompras
}

export interface OpcoesFilaCompras<T> {
  trabalhos: TrabalhoCompras[]
  executar: (trabalho: TrabalhoCompras, signal: AbortSignal) => Promise<LoteCompras<T>>
  onBatch?: (amostras: T[], trabalho: TrabalhoCompras) => void
  signal?: AbortSignal
  concorrencia?: number
  /** Absolute Unix timestamp in milliseconds; omitted means no queue deadline. */
  deadlineAtMs?: number
}

export interface ResultadoFilaCompras<T> {
  amostras: T[]
  pendencias: TrabalhoCompras[]
  falhas: { trabalho: TrabalhoCompras; erro: unknown }[]
  paginacao: PaginacaoCompras[]
  parcial: boolean
  concluida: boolean
  retryAtMs?: number
  trabalhosConcluidos: number
}

function identidade(trabalho: TrabalhoCompras): string {
  if (trabalho.etapa === 'catalogo')
    return JSON.stringify(['catalogo', trabalho.tipo, trabalho.termo.trim()])
  if (trabalho.etapa === 'pdm') return JSON.stringify(['pdm', trabalho.codigoPdm.trim()])
  if (trabalho.seletor === 'codigoPdm')
    return JSON.stringify([
      'precos',
      'material',
      'codigoPdm',
      trabalho.codigo.trim(),
      trabalho.pagina,
      trabalho.tamanhoPagina ?? null,
    ])
  return JSON.stringify([
    'precos',
    trabalho.tipo,
    trabalho.codigo.trim(),
    trabalho.pagina,
    trabalho.tamanhoPagina ?? null,
  ])
}

/** Schedules explicit continuations. The executor owns HTTP limiting and retries. */
export async function executarFilaCompras<T>(
  opcoes: OpcoesFilaCompras<T>,
): Promise<ResultadoFilaCompras<T>> {
  const abortado = () => new DOMException('Pesquisa cancelada.', 'AbortError')
  if (opcoes.signal?.aborted) throw abortado()
  if (opcoes.deadlineAtMs !== undefined && !Number.isFinite(opcoes.deadlineAtMs)) {
    throw new TypeError('deadlineAtMs deve ser um timestamp finito.')
  }
  const concorrencia = Math.max(
    1,
    Math.min(3, Number.isFinite(opcoes.concorrencia) ? Math.floor(opcoes.concorrencia!) : 3),
  )
  const controller = new AbortController()
  const fila: TrabalhoCompras[] = []
  const vistos = new Set<string>()
  const amostras: T[] = []
  const falhas: ResultadoFilaCompras<T>['falhas'] = []
  const paginas = new Map<string, PaginacaoCompras>()
  type Evento = { chave: string; trabalho: TrabalhoCompras } & (
    | { lote: LoteCompras<T> }
    | { erro: unknown }
  )
  const ativos = new Map<string, { trabalho: TrabalhoCompras; promessa: Promise<Evento> }>()
  let expirado = false
  let pressaoFonte = false
  let retryAtMs: number | undefined
  let trabalhosConcluidos = 0
  const registrarPressao = (value: unknown) => {
    const erro = value as { status?: number; circuitOpen?: boolean; retryAtMs?: number } | null
    if (erro?.status === 429 || erro?.status === 503 || erro?.circuitOpen === true) {
      pressaoFonte = true
      if (typeof erro.retryAtMs === 'number' && Number.isFinite(erro.retryAtMs)) {
        retryAtMs = Math.max(retryAtMs || 0, erro.retryAtMs)
      }
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let acordar!: (evento: { parar: true }) => void
  const parada = new Promise<{ parar: true }>((resolve) => {
    acordar = resolve
  })
  const cancelar = () => {
    controller.abort()
    acordar({ parar: true })
  }
  const prazoEsgotado = () => {
    if (!expirado && opcoes.deadlineAtMs !== undefined && Date.now() >= opcoes.deadlineAtMs) {
      expirado = true
      cancelar()
    }
    return expirado
  }
  const agendarDeadline = () => {
    if (opcoes.deadlineAtMs === undefined || prazoEsgotado()) return
    const restante = opcoes.deadlineAtMs - Date.now()
    timer = setTimeout(agendarDeadline, Math.min(Math.max(0, restante), 2_147_483_647))
  }
  const agendar = (trabalho: TrabalhoCompras) => {
    const chave = identidade(trabalho)
    if (!vistos.has(chave)) {
      vistos.add(chave)
      fila.push(trabalho)
    }
  }
  // Fair rotation: ready first pages do not wait behind every PDM; discovery
  // and remaining pages also get turns. Price groups alternate kinds, keeping
  // FIFO within each kind; discovery retains its original FIFO ordering.
  let proximoGrupo = 0
  const proximoTipo: Partial<Record<number, TipoCatalogoCompras>> = {}
  const grupo = (trabalho: TrabalhoCompras) =>
    trabalho.etapa !== 'precos' ? 1 : trabalho.pagina === 1 ? 0 : 2
  const retirar = (): TrabalhoCompras => {
    for (let offset = 0; offset < 3; offset++) {
      const atual = (proximoGrupo + offset) % 3
      let index = fila.findIndex((trabalho) => grupo(trabalho) === atual)
      if (index !== -1) {
        if (atual !== 1) {
          const preferido = fila.findIndex(
            (trabalho) =>
              grupo(trabalho) === atual &&
              trabalho.etapa === 'precos' &&
              trabalho.tipo === proximoTipo[atual],
          )
          if (preferido !== -1) index = preferido
          const trabalho = fila[index]
          if (trabalho.etapa === 'precos') {
            proximoTipo[atual] = trabalho.tipo === 'material' ? 'servico' : 'material'
          }
        }
        proximoGrupo = (atual + 1) % 3
        return fila.splice(index, 1)[0]
      }
    }
    throw new Error('Fila sem trabalho disponível.')
  }
  opcoes.trabalhos.forEach(agendar)
  opcoes.signal?.addEventListener('abort', cancelar, { once: true })
  agendarDeadline()
  try {
    while (fila.length || ativos.size) {
      if (opcoes.signal?.aborted) throw abortado()
      if (prazoEsgotado()) break
      while (
        !pressaoFonte &&
        fila.length &&
        ativos.size < concorrencia &&
        !controller.signal.aborted &&
        !prazoEsgotado()
      ) {
        const trabalho = retirar()
        const chave = identidade(trabalho)
        const promessa = (async (): Promise<Evento> => {
          try {
            return { chave, trabalho, lote: await opcoes.executar(trabalho, controller.signal) }
          } catch (erro) {
            // Mark pressure as soon as the executor settles, not only when its
            // event wins Promise.race after another already-settled success.
            registrarPressao(erro)
            return { chave, trabalho, erro }
          }
        })()
        ativos.set(chave, { trabalho, promessa })
      }
      if (!ativos.size) break
      const evento = await Promise.race([parada, ...Array.from(ativos.values(), (a) => a.promessa)])
      if (opcoes.signal?.aborted) throw abortado()
      if ('parar' in evento || prazoEsgotado()) break
      ativos.delete(evento.chave)
      if ('erro' in evento) {
        falhas.push({ trabalho: evento.trabalho, erro: evento.erro })
        continue
      }
      const { lote } = evento
      trabalhosConcluidos++
      amostras.push(...lote.amostras)
      opcoes.onBatch?.(lote.amostras, evento.trabalho)
      lote.continuacoes.forEach(agendar)
      if (lote.paginacao) {
        const p = lote.paginacao
        const chave = chavePaginacaoCompras(p)
        const anterior = paginas.get(chave)
        paginas.set(
          chave,
          anterior
            ? {
                ...p,
                pagina: Math.max(anterior.pagina, p.pagina),
                total: Math.max(anterior.total, p.total),
                paginas: Math.max(anterior.paginas, p.paginas),
              }
            : { ...p },
        )
      }
    }
    if (opcoes.signal?.aborted) throw abortado()
    const pendencias = [
      ...fila,
      ...Array.from(ativos.values(), (a) => a.trabalho),
      ...falhas.map((f) => f.trabalho),
    ]
    return {
      amostras,
      pendencias,
      falhas,
      paginacao: [...paginas.values()],
      parcial: pendencias.length > 0,
      concluida: pendencias.length === 0,
      retryAtMs,
      trabalhosConcluidos,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    opcoes.signal?.removeEventListener('abort', cancelar)
    controller.abort()
  }
}
