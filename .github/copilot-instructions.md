# GitHub Copilot & AI Instructions - Talk2TM

## Ordem Estrita de Execução e Prioridade

1. **package.json**: Validação de dependências, scripts e configurações do Node/npm.
2. **package-lock.json**: Garantia da árvore determinística de dependências gerada pelo npm (`npm ci` / `npm install --package-lock-only`).
3. **CI**: Verificação de workflows do GitHub Actions (`.github/workflows/`), cache e consistência da esteira.
4. **Testes**: Execução dos testes automatizados e unitários (`tests/talk2tm.test.ts`) com 100% de aprovação.
5. **Build**: Compilação de produção (`npm run build`) validando a ausência de erros de TypeScript (`tsc --noEmit`).
6. **Firebase Deploy**: Validação e publicação das regras de segurança (`firestore.rules`) e configurações do Firebase.
7. **Render Deploy**: Validação final de entrega e disponibilidade na hospedagem do Render (ex.: https://talk2tm.onrender.com/).

## Diretrizes de Interface e Segurança

- **Camuflagem**: A tela inicial deve se comportar estritamente como uma calculadora real. É proibido exibir textos ou elementos denunciadores de chat/senha na interface pública.
- **Códigos de Desbloqueio**:
  - Truman: `852456`
  - Mãezinha: `135790`
- **Desbloqueio Otimista**: Entrada instantânea no chat com tolerância offline e sincronização em segundo plano no Firestore.
