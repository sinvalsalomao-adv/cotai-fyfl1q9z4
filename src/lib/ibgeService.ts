export interface MunicipioIbge {
  id: number
  nome: string
  microrregiao: {
    mesorregiao: {
      UF: {
        id: number
        sigla: string
        nome: string
      }
    }
  }
}

// Cache local simples em memória
let municipiosCache: MunicipioIbge[] | null = null

export async function buscarMunicipiosIbge(
  termo?: string,
): Promise<{ id: string; label: string }[]> {
  try {
    if (!municipiosCache) {
      const resp = await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/municipios')
      if (resp.ok) {
        municipiosCache = await resp.json()
      } else {
        municipiosCache = []
      }
    }

    if (!municipiosCache || municipiosCache.length === 0) {
      // Fallback estático
      return [
        { id: '3550308', label: '3550308 - São Paulo (SP)' },
        { id: '3106200', label: '3106200 - Belo Horizonte (MG)' },
        { id: '3304557', label: '3304557 - Rio de Janeiro (RJ)' },
        { id: '4106902', label: '4106902 - Curitiba (PR)' },
        { id: '5300108', label: '5300108 - Brasília (DF)' },
      ]
    }

    const t = (termo || '').toLowerCase().trim()
    const filtrados = t
      ? municipiosCache.filter(
          (m) =>
            m.nome.toLowerCase().includes(t) ||
            String(m.id).includes(t) ||
            m.microrregiao.mesorregiao.UF.sigla.toLowerCase().includes(t),
        )
      : municipiosCache.slice(0, 50)

    return filtrados.slice(0, 30).map((m) => ({
      id: String(m.id),
      label: `${m.id} - ${m.nome} (${m.microrregiao.mesorregiao.UF.sigla})`,
    }))
  } catch (err) {
    console.warn('Erro ao consultar API do IBGE, usando opções básicas:', err)
    return [
      { id: '3550308', label: '3550308 - São Paulo (SP)' },
      { id: '3106200', label: '3106200 - Belo Horizonte (MG)' },
      { id: '3304557', label: '3304557 - Rio de Janeiro (RJ)' },
      { id: '4106902', label: '4106902 - Curitiba (PR)' },
      { id: '5300108', label: '5300108 - Brasília (DF)' },
    ]
  }
}
