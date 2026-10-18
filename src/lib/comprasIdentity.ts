import type { BudgetPriceResult } from '@/services/budgetService'
import { matchesExactOfficialQuery, parseStrictOfficialUrl } from '@/lib/officialUrl'

const first = (raw: any, names: string[]) => {
  for (const name of names) if (raw[name] != null) return raw[name]
  return ''
}
const text = (value: any) => (value == null ? '' : String(value))
const positiveDigits = (value: any) =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
  /^\d+$/.test(text(value)) &&
  /[1-9]/.test(text(value))
const boundedPositive = (value: any, minimum: number, maximum?: number) => {
  if (!positiveDigits(value)) return false
  const numeric = Number(value)
  return (
    Number.isSafeInteger(numeric) &&
    numeric >= minimum &&
    (maximum === undefined || numeric <= maximum)
  )
}
const validIsoDate = (value: any) => {
  if (typeof value !== 'string') return false
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]),
    date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

// Retained legacy proof is evidence of a rounding event, never an exact ID.
function evidence(row: BudgetPriceResult) {
  const details = row.raw_data,
    proof = details?.proveniencia_preco
  const raw = proof?.registro_oficial,
    id = proof?.identidade,
    context = proof?.contexto_consulta
  if (
    row.source !== 'Compras.gov.br' ||
    proof?.versao !== 1 ||
    proof.status !== 'verificada' ||
    proof.fonte !== row.source ||
    !raw ||
    !id ||
    !context ||
    raw.isDemo === true ||
    raw.is_demo === true ||
    typeof raw.idCompraItem !== 'string' ||
    !raw.idCompraItem
  )
    return null
  const fields = [
    'idItemCompra',
    'idCompraItem',
    'numeroItemCompra',
    'numeroItem',
    'id',
    'codigoItemCatalogo',
    'codigoCatmat',
    'codigoCatser',
    'cnpjFornecedor',
    'cpfCnpjFornecedor',
    'niFornecedor',
    'cnpjOrgao',
    'cnpj',
    'codigoUasg',
    'codigoPdm',
    'codigoPDM',
  ]
  if (fields.some((field) => typeof raw[field] === 'number' && !Number.isSafeInteger(raw[field])))
    return null
  const purchase = first(raw, ['idCompra', 'codigoCompra'])
  const legacy =
    typeof purchase === 'number' && Number.isInteger(purchase) && !Number.isSafeInteger(purchase)
  if (!legacy && (typeof purchase !== 'string' || !/^\d+$/.test(purchase))) return null
  if (
    Object.keys(id).some(
      (field) =>
        typeof id[field] === 'number' &&
        !Number.isSafeInteger(id[field]) &&
        !(legacy && field === 'idCompra'),
    )
  )
    return null
  const item = text(first(raw, ['idItemCompra', 'numeroItemCompra', 'numeroItem']))
  const number = text(first(raw, ['numeroItemCompra', 'numeroItem']))
  const supplier = text(
    first(raw, [
      'cnpjFornecedor',
      'cpfCnpjFornecedor',
      'niFornecedor',
      'nomeFornecedor',
      'razaoSocial',
    ]),
  )
  const namespace = id.tipo === 'servico' ? 'CATSER' : 'CATMAT'
  const groupedPdm = context.seletor === 'codigoPdm'
  if (
    !['material', 'servico'].includes(id.tipo) ||
    (context.seletor != null &&
      context.seletor !== '' &&
      context.seletor !== 'codigoItemCatalogo' &&
      context.seletor !== 'codigoPdm') ||
    context.tipo !== id.tipo ||
    !/^\d+$/.test(text(id.codigoCatalogo)) ||
    text(context.codigo) !== text(id.codigoCatalogo) ||
    text(id.idCompra) !== text(purchase) ||
    text(id.idItemCompra) !== text(raw.idItemCompra) ||
    text(id.numeroItemCompra) !== number ||
    text(id.fornecedor) !== supplier ||
    !item ||
    !supplier ||
    details.codigo_item !== text(id.codigoCatalogo) ||
    details.tipoCatalogo !== namespace
  )
    return null
  const rawCode = first(raw, [
    'codigoItemCatalogo',
    id.tipo === 'servico' ? 'codigoCatser' : 'codigoCatmat',
  ])
  if (rawCode && text(rawCode) !== text(id.codigoCatalogo)) return null
  if (
    groupedPdm &&
    (id.tipo !== 'material' ||
      context.tipo !== 'material' ||
      typeof context.codigoPdm !== 'string' ||
      !positiveDigits(context.codigoPdm) ||
      !boundedPositive(context.pagina, 1) ||
      !boundedPositive(context.tamanhoPagina, 10, 500) ||
      (context.estado != null &&
        text(context.estado) !== '' &&
        !/^[A-Z]{2}$/.test(text(context.estado))) ||
      (context.dataCompraInicio != null &&
        text(context.dataCompraInicio) !== '' &&
        !validIsoDate(context.dataCompraInicio)) ||
      (context.dataCompraFim != null &&
        text(context.dataCompraFim) !== '' &&
        !validIsoDate(context.dataCompraFim)) ||
      (validIsoDate(context.dataCompraInicio) &&
        validIsoDate(context.dataCompraFim) &&
        context.dataCompraInicio > context.dataCompraFim) ||
      !positiveDigits(raw.codigoItemCatalogo) ||
      text(raw.codigoItemCatalogo) !== text(id.codigoCatalogo) ||
      (raw.codigoCatmat != null &&
        (!positiveDigits(raw.codigoCatmat) ||
          text(raw.codigoCatmat) !== text(id.codigoCatalogo))) ||
      (raw.codigoPdm != null && text(raw.codigoPdm) !== context.codigoPdm) ||
      (raw.codigoPDM != null && text(raw.codigoPDM) !== context.codigoPdm) ||
      text(details.codigo_item) !== text(id.codigoCatalogo) ||
      details.tipoCatalogo !== 'CATMAT')
  )
    return null
  const dates = [
    'dataResultado',
    'dataHomologacao',
    'dataCompra',
    'dataAssinatura',
    'data_resultado',
    'data_compra',
  ]
  if (
    !dates.includes(proof.campo_data) ||
    !proof.data_oficial ||
    text(raw[proof.campo_data]) !== proof.data_oficial ||
    row.source_date !== proof.data_oficial ||
    !Number.isFinite(Date.parse(proof.data_oficial))
  )
    return null
  const external = [namespace, text(purchase), item, proof.data_oficial, supplier]
    .map(encodeURIComponent)
    .join('#')
  if (row.source_record_id !== external || row.source_url !== proof.url_evidencia) return null
  try {
    const url = parseStrictOfficialUrl(proof.url_evidencia)
    if (!url) return null
    const path =
      id.tipo === 'servico'
        ? '/modulo-pesquisa-preco/3_consultarServico'
        : '/modulo-pesquisa-preco/1_consultarMaterial'
    if (groupedPdm) {
      const queryUrl = parseStrictOfficialUrl(context.urlConsultaOficial)
      const expected: Record<string, unknown> = {
        tipo: 'codigoPdm',
        codigo: context.codigoPdm,
        pagina: context.pagina,
        tamanhoPagina: context.tamanhoPagina,
      }
      for (const field of ['estado', 'dataCompraInicio', 'dataCompraFim']) {
        if (context[field] != null && text(context[field]) !== '') {
          expected[field] = context[field]
        }
      }
      if (
        !queryUrl ||
        queryUrl.host !== 'dadosabertos.compras.gov.br' ||
        queryUrl.pathname !== '/modulo-pesquisa-preco/1_consultarMaterial' ||
        !matchesExactOfficialQuery(queryUrl, expected) ||
        (proof.url_evidencia !== context.urlConsultaOficial &&
          ![raw.linkEditalOuCompra, raw.link_resultado, raw.url].includes(proof.url_evidencia))
      )
        return null
    } else if (url.host === 'dadosabertos.compras.gov.br') {
      const expected: Record<string, unknown> =
        id.tipo === 'servico'
          ? { codigoItemCatalogo: text(id.codigoCatalogo) }
          : { tipo: 'codigoItemCatalogo', codigo: text(id.codigoCatalogo) }
      for (const field of ['pagina', 'tamanhoPagina', 'estado', 'dataInicial', 'dataFinal']) {
        if (context[field] != null && text(context[field]) !== '') {
          expected[field] = context[field]
        }
      }
      const exactItemQuery =
        url.pathname === path &&
        boundedPositive(context.pagina, 1) &&
        boundedPositive(context.tamanhoPagina, 10, 500) &&
        matchesExactOfficialQuery(url, expected)
      const boundItemLink = [raw.linkEditalOuCompra, raw.link_resultado, raw.url].includes(
        proof.url_evidencia,
      )
      if (!exactItemQuery && !boundItemLink) return null
    } else if (![raw.linkEditalOuCompra, raw.link_resultado, raw.url].includes(proof.url_evidencia))
      return null
  } catch {
    return null
  }
  const priceFields = [
    'precoUnitarioHomologado',
    'valorUnitario',
    'precoUnitario',
    'precoPraticado',
  ]
  if (
    !priceFields.includes(proof.campo_unitario) ||
    !Number.isFinite(row.unit_price) ||
    row.unit_price <= 0 ||
    Number(raw[proof.campo_unitario]) !== row.unit_price ||
    Number(proof.valor_unitario) !== row.unit_price ||
    !['homologado', 'contratado'].includes(proof.natureza) ||
    details.natureza !== proof.natureza
  )
    return null
  const unit =
    text(
      raw.unidadeMedida ||
        raw.siglaUnidadeFornecimento ||
        raw.siglaUnidadeMedida ||
        raw.unidadeFornecimento ||
        raw.nomeUnidadeFornecimento ||
        raw.unidade ||
        '',
    ).trim() || 'NÃO INFORMADO'
  const quantityRaw = Number(
    first(raw, ['quantidade', 'quantidadeItem', 'quantidadeTotal', 'quantidadeHomologada']),
  )
  const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 0
  const document =
    text(first(raw, ['cnpjFornecedor', 'cpfCnpjFornecedor', 'niFornecedor'])) || 'NÃO INFORMADO'
  if (row.unit !== unit || row.quantity !== quantity || row.supplier_document !== document)
    return null
  const bucket = JSON.stringify([
    namespace,
    text(id.codigoCatalogo),
    raw.idCompraItem,
    text(raw.idItemCompra),
    number,
    proof.data_oficial,
    supplier,
    row.unit_price,
    row.quantity,
    row.unit,
    proof.natureza,
  ])
  return { purchase, legacy, bucket }
}

// Each merge map owns small composite/evidence buckets; no full-grid alias scan.
const bucketsByMap = new WeakMap<Map<string, BudgetPriceResult>, Map<string, Set<string>>>()
export function mesclarIdentidadeCompras(
  map: Map<string, BudgetPriceResult>,
  incoming: BudgetPriceResult,
  keyFor: (row: BudgetPriceResult) => string,
  preserveCanonical = false,
) {
  let buckets = bucketsByMap.get(map)
  if (!buckets) {
    buckets = new Map()
    for (const [key, row] of map) {
      const info = evidence(row)
      if (info) {
        const keys = buckets.get(info.bucket) || new Set<string>()
        keys.add(key)
        buckets.set(info.bucket, keys)
      }
    }
    bucketsByMap.set(map, buckets)
  }
  const info = evidence(incoming),
    canonical = keyFor(incoming)
  let key = canonical,
    previous = map.get(key)
  let collisionId: string | undefined
  const composite = incoming.raw_data?.proveniencia_preco?.registro_oficial?.idCompraItem
  const previousComposite = previous?.raw_data?.proveniencia_preco?.registro_oficial?.idCompraItem
  if (
    incoming.source === 'Compras.gov.br' &&
    previous &&
    typeof composite === 'string' &&
    typeof previousComposite === 'string' &&
    composite !== previousComposite
  ) {
    // A legacy rounded external key can collide with another exact purchase.
    // Keep both transient rows without changing either public external identity.
    key = canonical + '#COMPRAS_PROOF#' + encodeURIComponent(composite)
    if (previous.id === incoming.id)
      collisionId = incoming.id + '#COMPRAS_PROOF#' + encodeURIComponent(composite)
    previous = map.get(key)
  }
  if (info && (!previous || keyFor(previous) !== canonical)) {
    const matches: string[] = []
    for (const candidate of buckets.get(info.bucket) || []) {
      const row = map.get(candidate),
        other = row && evidence(row)
      if (
        other &&
        row &&
        (keyFor(row) === canonical ||
          (info.legacy !== other.legacy && Number(info.purchase) === Number(other.purchase)))
      )
        matches.push(candidate)
    }
    if (matches.length === 1) {
      key = matches[0]
      previous = map.get(key)
    }
  }
  let prior = previous && evidence(previous)
  let isAlias =
    info &&
    prior &&
    info.bucket === prior.bucket &&
    info.legacy !== prior.legacy &&
    Number(info.purchase) === Number(prior.purchase)
  if (previous && keyFor(previous) !== canonical && !isAlias) {
    // An alias correction retains its old map slot. A later exact purchase may
    // own that old canonical key without being the corrected purchase, even if
    // its composite contradictorily agrees. Keep the selected row in its slot.
    const discriminator =
      encodeURIComponent(incoming.source_record_id || canonical) +
      '#' +
      encodeURIComponent(typeof composite === 'string' ? composite : '')
    key = canonical + '#COMPRAS_ID#' + discriminator
    if (previous.id === incoming.id) collisionId = incoming.id + '#COMPRAS_ID#' + discriminator
    previous = map.get(key)
    prior = previous && evidence(previous)
    isAlias =
      info &&
      prior &&
      info.bucket === prior.bucket &&
      info.legacy !== prior.legacy &&
      Number(info.purchase) === Number(prior.purchase)
  }
  const preferred =
    previous && ((isAlias && !prior!.legacy) || (!isAlias && preserveCanonical))
      ? previous
      : incoming
  const stableId = previous?.id || collisionId
  const value = stableId && stableId !== preferred.id ? { ...preferred, id: stableId } : preferred
  if (prior) buckets.get(prior.bucket)?.delete(key)
  map.set(key, value)
  const current = evidence(value)
  if (current) {
    const keys = buckets.get(current.bucket) || new Set<string>()
    keys.add(key)
    buckets.set(current.bucket, keys)
  }
  return { chave: key, amostra: value, anterior: previous }
}
