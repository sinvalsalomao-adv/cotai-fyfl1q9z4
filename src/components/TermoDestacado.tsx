import React from 'react'

/**
 * Destaca as ocorrências dos termos de busca em um texto, utilizando <mark> com fundo amarelo.
 */
export const TermoDestacado: React.FC<{
  texto: string | null | undefined
  termoBusca?: string
  className?: string
}> = ({ texto, termoBusca, className = '' }) => {
  if (!texto) return null
  const baseClass = `break-words whitespace-normal ${className}`.trim()
  if (!termoBusca || !termoBusca.trim()) {
    return <span className={baseClass}>{texto}</span>
  }

  // Tokeniza palavras para busca flexível ou frase completa
  const palavras = termoBusca
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter((p) => p.length > 1)

  if (palavras.length === 0) {
    return <span className={baseClass}>{texto}</span>
  }

  try {
    const regex = new RegExp(`(${palavras.join('|')})`, 'gi')
    const partes = texto.split(regex)

    return (
      <span className={baseClass}>
        {partes.map((parte, index) => {
          const match = palavras.some(
            (p) =>
              p.toLowerCase() === parte.toLowerCase() ||
              parte.toLowerCase().includes(p.toLowerCase()),
          )
          if (match) {
            return (
              <mark
                key={index}
                className="bg-[#fef08a] text-black font-semibold px-0.5 rounded-2xs inline break-words"
              >
                {parte}
              </mark>
            )
          }
          return React.createElement(React.Fragment, { key: index }, parte)
        })}
      </span>
    )
  } catch {
    return <span className={baseClass}>{texto}</span>
  }
}

/**
 * Calcula a quantidade de dias restantes para o vencimento de uma vigência.
 */
export function calcularDiasVencimento(dataFimStr?: string | null): {
  dias: number
  texto: string
  vencido: boolean
} | null {
  if (!dataFimStr) return null
  const dataFim = new Date(dataFimStr)
  if (isNaN(dataFim.getTime())) return null

  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const fim = new Date(dataFim)
  fim.setHours(0, 0, 0, 0)

  const diffMs = fim.getTime() - hoje.getTime()
  const dias = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

  if (dias < 0) {
    return {
      dias,
      texto: `Vencido há ${Math.abs(dias)} dia(s)`,
      vencido: true,
    }
  }

  return {
    dias,
    texto: `Faltam ${dias} dias para o vencimento.`,
    vencido: false,
  }
}
