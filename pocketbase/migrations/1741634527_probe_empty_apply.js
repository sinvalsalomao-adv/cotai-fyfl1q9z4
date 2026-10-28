/// <reference path="../pb_data/types.d.ts" />

// Diagnóstico: migration vazia para separar o pipeline de apply do conteúdo.
// Não altera nada no banco.
migrate(
  (_app) => {},
  (_app) => {},
)
