# Instruções Operacionais do Agente - Talk2TM

Este arquivo define as regras de execução, prioridades de esteira e restrições de arquitetura do projeto Talk2TM.

## Ordem Estrita de Execução e Prioridade

Ao realizar qualquer alteração, correção ou pipeline no repositório, o agente e a automação DEVEM seguir impreterivelmente esta sequência ordenada:

1. **package.json**: Validação de dependências, scripts e configurações do Node/npm.
2. **package-lock.json**: Garantia da árvore determinística de dependências gerada pelo npm (`npm install --package-lock-only` ou `npm ci`).
3. **CI (Continuous Integration)**: Verificação de fluxos do GitHub Actions (ex.: `.github/workflows/`), cache do npm e consistência do pipeline.
4. **Testes**: Execução dos testes automatizados e unitários (`tests/talk2tm.test.ts`) garantindo 100% de aprovação antes de qualquer avanço.
5. **Build**: Compilação de produção (`npm run build`) validando a geração dos artefatos em `dist/` e ausência de erros de TypeScript (`tsc --noEmit`).
6. **Firebase Deploy**: Validação e publicação das regras de segurança (`firestore.rules`) e configurações do Firebase.
7. **Render Deploy**: Validação final de entrega e disponibilidade na hospedagem do Render (ex.: https://talk2tm.onrender.com/).

---

## Regras de Domínio e Arquitetura do Talk2TM

- **Disfarce de Calculadora (Camouflage)**:
  - A interface de entrada opera visualmente como uma calculadora funcional normal.
  - É proibido exibir na interface textos ou botões evidentes que denunciem a existência de chat ou senha (ex: `[senha]`, `login`, `chat secreto`).
  - O cabeçalho deve exibir elementos autênticos de calculadora, como `DEG`.
  - O desbloqueio deve ser disparado de forma direta e instantânea ao digitar os códigos:
    - **Truman**: `852456`
    - **Mãezinha**: `135790`
- **Desbloqueio Otimista (Zero Latência)**:
  - A interface do chat é apresentada imediatamente ao validar a senha.
  - Carregamento imediato do cache local (IndexedDB) para histórico de mensagens.
  - Comunicações com Firestore devem ocorrer em segundo plano com timeout de tolerância para nunca bloquear a navegação do usuário caso a rede esteja instável.
- **Segurança e Regras do Firestore**:
  - `firestore.rules` deve validar o limite de 2 participantes por sala e esquemas de mensagem sem rejeitar campos de timestamp ou nulos opcionais.
