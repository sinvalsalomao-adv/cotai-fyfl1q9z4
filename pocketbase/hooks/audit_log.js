// Hook: Trilha de auditoria das operações estruturais
// Nota Skip Cloud: Sem funções no escopo de topo; todo o código inline dentro do callback

onRecordAfterCreateSuccess(
  (e) => {
    try {
      const rec = e.record
      const colName = rec.collection().name
      const auditoriaCol = $app.findCollectionByNameOrId('auditoria')
      const auditRec = new Record(auditoriaCol)

      let orgId = ''
      if (rec.has('organizacao_id')) {
        orgId = rec.getString('organizacao_id')
      }

      auditRec.set('organizacao_id', orgId || 'unknown')
      auditRec.set('agente_id', rec.has('responsavel_id') ? rec.getString('responsavel_id') : '')
      auditRec.set('evento', 'create')
      auditRec.set('objeto_tipo', colName)
      auditRec.set('objeto_id', rec.id)
      auditRec.set('antes_depois', JSON.stringify({ action: 'create', data: rec }))
      auditRec.set('correlacao', 'api_hook_audit')
      $app.save(auditRec)
    } catch (err) {
      // Não quebra a transação principal em caso de log secundário
    }
    e.next()
  },
  'demandas',
  'pesquisas',
  'calculos',
  'documentos',
  'aprovacoes',
)
