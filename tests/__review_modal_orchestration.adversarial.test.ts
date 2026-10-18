import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOfficialCollectionIdentity,
  buildOfficialQueryParams,
  decideObservationAfterSuccess,
  decidePollFailure,
  isEligibleComprasOfficialProof,
} from '../src/components/modalSearchPolicy'
import { ComprasQuerySession } from '../src/lib/connectors/comprasQuerySession'
import { PncpQuerySession } from '../src/lib/connectors/pncpQuerySession'

afterEach(() => vi.useRealTimers())

const pendingCompras = {
  continuacoesCompras: [
    {
      etapa: 'precos' as const,
      tipo: 'material' as const,
      codigo: '19385',
      pagina: 4,
      seletor: 'codigoPdm' as const,
    },
  ],
  paginacaoCompras: [],
  retryAtComprasMs: 0,
}

function pendingPncp(status = 'pending') {
  return {
    tarefa_id: 'task-review',
    status,
    fonte_processada: 'PNCP',
    cobertura_parcial: status !== 'completed',
    amostras: [],
    amostras_resposta_parcial: false,
    paginas_consultadas: 0,
    itens_processados: 0,
    amostras_inseridas: 0,
    amostras_atualizadas: 0,
  } as any
}

describe('review-only modal orchestration adversarial checks', () => {
  it('keeps every official path independent from the visual source selection', () => {
    const selected = {
      item: 'review',
      termo: 'IBUPROFENO',
      fonte: 'PNCP',
      fontes: ['PNCP'],
      ordenar: 'valor_unitario:asc',
    }
    expect(buildOfficialQueryParams(selected)).toEqual({
      item: 'review',
      termo: 'IBUPROFENO',
      ordenar: 'valor_unitario:asc',
      fonte: undefined,
    })
    expect(buildOfficialCollectionIdentity(selected)).toBe(
      buildOfficialCollectionIdentity({ ...selected, fonte: 'Compras.gov.br', fontes: ['Compras.gov.br'] }),
    )
  })

  it('keeps pending observation alive with bounded progressive delays past the old deadline', () => {
    expect(decideObservationAfterSuccess({
      now: 99_999,
      deadline: 100_000,
      unchangedCycles: 10_000,
      terminalConfirmed: false,
      workPending: true,
    })).toEqual({ action: 'continue', delayMs: 21_000 })
    expect(decidePollFailure({
      now: 99_999,
      deadline: 100_000,
      consecutiveFailures: 400,
      automaticRecoveries: 400,
    })).toEqual({ action: 'cooldown', delayMs: 24_000 })
  })

  it('cancels Compras timers without publishing an orphan batch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const session = new ComprasQuerySession('review')
    session.registrar(pendingCompras)
    const outer = new AbortController()
    const publish = vi.fn()
    const execute = vi.fn(async () => ({
      observabilidade: { detalhePorFonte: { compras_gov: pendingCompras } },
    }))
    session.acompanhar(outer.signal, execute, publish, () => undefined)
    outer.abort()
    await vi.runAllTimersAsync()
    expect(execute).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels PNCP timers and suppresses stale status after generation abort', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const outer = new AbortController()
    const status = vi.fn()
    const execute = vi.fn(async () => pendingPncp())
    const session = new PncpQuerySession({
      signal: outer.signal,
      ativa: () => true,
      deadlineMs: 120_000,
      executar: execute,
      publicar: async () => undefined,
      status,
    })
    session.iniciar(pendingPncp())
    outer.abort()
    await vi.runAllTimersAsync()
    expect(execute).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts an official grouped PDM row when the row omits optional PDM echo', () => {
    const url = 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoPdm&codigo=19385&pagina=2&tamanhoPagina=500'
    const proof = {
      versao: 1,
      status: 'verificada',
      fonte: 'Compras.gov.br',
      campo_unitario: 'precoUnitario',
      valor_unitario: 4.4,
      data_oficial: '2025-03-13',
      campo_data: 'dataResultado',
      url_evidencia: url,
      identidade: {
        tipo: 'material', codigoCatalogo: '151063', idCompra: '15836906900012025',
        idItemCompra: '7670225', numeroItemCompra: 1, fornecedor: '51340170000156',
      },
      contexto_consulta: {
        tipo: 'material', codigo: '151063', seletor: 'codigoPdm', codigoPdm: '19385',
        pagina: 2, tamanhoPagina: 500, urlConsultaOficial: url,
      },
      registro_oficial: {
        idCompra: '15836906900012025', idItemCompra: '7670225', numeroItemCompra: 1,
        codigoItemCatalogo: '151063', codigoCatmat: '151063', precoUnitario: 4.4,
        dataResultado: '2025-03-13',
      },
    }
    expect(isEligibleComprasOfficialProof(proof, 4.4)).toBe(true)
  })

  it('accepts a safe official purchase link while separately proving the exact PDM query', () => {
    const queryUrl = 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoPdm&codigo=19385&pagina=2&tamanhoPagina=500'
    const proof = {
      versao: 1, status: 'verificada', fonte: 'Compras.gov.br',
      campo_unitario: 'precoUnitario', valor_unitario: 4.4,
      data_oficial: '2025-03-13', campo_data: 'dataResultado',
      url_evidencia: 'https://pncp.gov.br/app/editais/15836906900012025/2025/1',
      identidade: {
        tipo: 'material', codigoCatalogo: '151063', idCompra: '15836906900012025',
        idItemCompra: '7670225', numeroItemCompra: 1, fornecedor: '51340170000156',
      },
      contexto_consulta: {
        tipo: 'material', codigo: '151063', seletor: 'codigoPdm', codigoPdm: '19385',
        pagina: 2, tamanhoPagina: 500, urlConsultaOficial: queryUrl,
      },
      registro_oficial: {
        idCompra: '15836906900012025', idItemCompra: '7670225', numeroItemCompra: 1,
        codigoItemCatalogo: '151063', codigoCatmat: '151063', codigoPdm: '19385',
        precoUnitario: 4.4, dataResultado: '2025-03-13',
        linkEditalOuCompra: 'https://pncp.gov.br/app/editais/15836906900012025/2025/1',
      },
    }
    expect(isEligibleComprasOfficialProof(proof, 4.4)).toBe(true)
  })
})
