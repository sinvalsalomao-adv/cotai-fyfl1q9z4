import pb from '@/lib/pocketbase/client'
import type {
  Organizacao,
  PerfilNormativo,
  Demanda,
  DemandaItem,
  Pesquisa,
  Referencia,
  Evidencia,
  Calculo,
  Documento,
  VersaoDocumento,
  Aprovacao,
  Processo,
  Integracao,
  Auditoria,
} from '@/types'

// Utilitário para pegar organizacao_id ativa do usuário
export function getActiveOrgId(): string | null {
  return localStorage.getItem('active_org_id') || pb.authStore.record?.organizacao_id || null
}

export function setActiveOrgId(id: string) {
  localStorage.setItem('active_org_id', id)
}

// 1. Organizações
export async function listarOrganizacoes(): Promise<Organizacao[]> {
  const records = await pb.collection('organizacoes').getFullList<Organizacao>({
    sort: 'nome',
    expand: 'perfil_normativo_id,responsavel_pesquisa',
  })
  return records
}

export async function obterOrganizacao(id: string): Promise<Organizacao> {
  return await pb.collection('organizacoes').getOne<Organizacao>(id, {
    expand: 'perfil_normativo_id,responsavel_pesquisa',
  })
}

export async function criarOrganizacao(data: Partial<Organizacao>): Promise<Organizacao> {
  return await pb.collection('organizacoes').create<Organizacao>(data)
}

export async function atualizarOrganizacao(
  id: string,
  data: Partial<Organizacao>,
): Promise<Organizacao> {
  return await pb.collection('organizacoes').update<Organizacao>(id, data)
}

// 2. Perfis Normativos
export async function listarPerfisNormativos(): Promise<PerfilNormativo[]> {
  return await pb.collection('perfis_normativos').getFullList<PerfilNormativo>({
    sort: 'nome',
  })
}

// 3. Demandas
export async function listarDemandas(orgId?: string): Promise<Demanda[]> {
  const filter = orgId ? `organizacao_id = "${orgId}"` : ''
  return await pb.collection('demandas').getFullList<Demanda>({
    filter,
    sort: '-created',
    expand: 'organizacao_id,responsavel_id',
  })
}

export async function obterDemanda(id: string): Promise<Demanda> {
  return await pb.collection('demandas').getOne<Demanda>(id, {
    expand: 'organizacao_id,responsavel_id',
  })
}

export async function criarDemanda(data: Partial<Demanda>): Promise<Demanda> {
  return await pb.collection('demandas').create<Demanda>(data)
}

export async function atualizarDemanda(id: string, data: Partial<Demanda>): Promise<Demanda> {
  return await pb.collection('demandas').update<Demanda>(id, data)
}

// 4. Demanda Itens
export async function listarItensDaDemanda(demandaId: string): Promise<DemandaItem[]> {
  return await pb.collection('demanda_itens').getFullList<DemandaItem>({
    filter: `demanda_id = "${demandaId}"`,
    sort: 'created',
  })
}

export async function criarItemDemanda(data: Partial<DemandaItem>): Promise<DemandaItem> {
  return await pb.collection('demanda_itens').create<DemandaItem>(data)
}

export async function atualizarItemDemanda(
  id: string,
  data: Partial<DemandaItem>,
): Promise<DemandaItem> {
  return await pb.collection('demanda_itens').update<DemandaItem>(id, data)
}

// 5. Pesquisas
export async function listarPesquisas(orgId?: string): Promise<Pesquisa[]> {
  // Se orgId estiver definido, podemos listar todas e filtrar pela demanda associada
  const records = await pb.collection('pesquisas').getFullList<Pesquisa>({
    sort: '-created',
    expand: 'demanda_item_id.demanda_id,responsavel_id',
  })
  if (orgId) {
    return records.filter(
      (p) => p.expand?.demanda_item_id?.expand?.demanda_id?.organizacao_id === orgId,
    )
  }
  return records
}

export async function obterPesquisa(id: string): Promise<Pesquisa> {
  return await pb.collection('pesquisas').getOne<Pesquisa>(id, {
    expand: 'demanda_item_id.demanda_id,responsavel_id',
  })
}

export async function criarPesquisa(data: Partial<Pesquisa>): Promise<Pesquisa> {
  return await pb.collection('pesquisas').create<Pesquisa>(data)
}

export async function atualizarPesquisa(id: string, data: Partial<Pesquisa>): Promise<Pesquisa> {
  return await pb.collection('pesquisas').update<Pesquisa>(id, data)
}

// 6. Referências (Candidatos)
export async function listarReferencias(pesquisaId: string): Promise<Referencia[]> {
  return await pb.collection('referencias').getFullList<Referencia>({
    filter: `pesquisa_id = "${pesquisaId}"`,
    sort: 'valor_original',
    expand: 'canonico_id',
  })
}

export async function criarReferencia(data: Partial<Referencia>): Promise<Referencia> {
  return await pb.collection('referencias').create<Referencia>(data)
}

export async function atualizarReferencia(
  id: string,
  data: Partial<Referencia>,
): Promise<Referencia> {
  return await pb.collection('referencias').update<Referencia>(id, data)
}

// 7. Evidências
export async function listarEvidencias(referenciaId: string): Promise<Evidencia[]> {
  return await pb.collection('evidencias').getFullList<Evidencia>({
    filter: `referencia_id = "${referenciaId}"`,
  })
}

export async function criarEvidencia(data: Partial<Evidencia>): Promise<Evidencia> {
  return await pb.collection('evidencias').create<Evidencia>(data)
}

// 8. Cálculos
export async function obterCalculoDaPesquisa(pesquisaId: string): Promise<Calculo | null> {
  try {
    const records = await pb.collection('calculos').getList<Calculo>(1, 1, {
      filter: `pesquisa_id = "${pesquisaId}"`,
      sort: '-created',
    })
    return records.items[0] || null
  } catch {
    return null
  }
}

export async function salvarCalculo(data: Partial<Calculo>): Promise<Calculo> {
  if (data.id) {
    return await pb.collection('calculos').update<Calculo>(data.id, data)
  }
  return await pb.collection('calculos').create<Calculo>(data)
}

// 9. Documentos
export async function listarDocumentos(orgId?: string): Promise<Documento[]> {
  const records = await pb.collection('documentos').getFullList<Documento>({
    sort: '-created',
    expand: 'processo_id.demanda_id,processo_id.organizacao_id',
  })
  if (orgId) {
    return records.filter((d) => d.expand?.processo_id?.organizacao_id === orgId)
  }
  return records
}

export async function obterDocumento(id: string): Promise<Documento> {
  return await pb.collection('documentos').getOne<Documento>(id, {
    expand: 'processo_id.demanda_id,processo_id.organizacao_id',
  })
}

export async function criarDocumento(data: Partial<Documento>): Promise<Documento> {
  return await pb.collection('documentos').create<Documento>(data)
}

export async function atualizarDocumento(id: string, data: Partial<Documento>): Promise<Documento> {
  return await pb.collection('documentos').update<Documento>(id, data)
}

export async function listarVersoesDocumento(documentoId: string): Promise<VersaoDocumento[]> {
  return await pb.collection('versoes_documento').getFullList<VersaoDocumento>({
    filter: `documento_id = "${documentoId}"`,
    sort: '-numero_versao',
  })
}

export async function criarVersaoDocumento(
  data: Partial<VersaoDocumento>,
): Promise<VersaoDocumento> {
  return await pb.collection('versoes_documento').create<VersaoDocumento>(data)
}

export async function registrarAprovacao(data: Partial<Aprovacao>): Promise<Aprovacao> {
  return await pb.collection('aprovacoes').create<Aprovacao>(data)
}

// 10. Processos
export async function listarProcessos(orgId?: string): Promise<Processo[]> {
  const filter = orgId ? `organizacao_id = "${orgId}"` : ''
  return await pb.collection('processos').getFullList<Processo>({
    filter,
    sort: '-updated',
    expand: 'organizacao_id,demanda_id,responsavel_id',
  })
}

export async function obterProcesso(id: string): Promise<Processo> {
  return await pb.collection('processos').getOne<Processo>(id, {
    expand: 'organizacao_id,demanda_id,responsavel_id',
  })
}

// 11. Integrações
export async function listarIntegracoes(): Promise<Integracao[]> {
  return await pb.collection('integracoes').getFullList<Integracao>({
    sort: 'nome',
  })
}

// 12. Auditoria
export async function listarAuditoria(orgId?: string): Promise<Auditoria[]> {
  const filter = orgId ? `organizacao_id = "${orgId}"` : ''
  return await pb.collection('auditoria').getFullList<Auditoria>({
    filter,
    sort: '-created',
    expand: 'agente_id',
  })
}
