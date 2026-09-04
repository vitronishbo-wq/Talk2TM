# Talk2TM — Chat Textual Ultraleve para 2 Pessoas

Talk2TM é uma aplicação de chat textual estritamente restrita a 2 participantes por sala, projetada para ser offline-first, sem mídias, sem cards e sem duplicação de mensagens.

## Arquitetura em Camadas

1. **Camada 01 — Identidade do Produto**:
   - Modelo: 2 pessoas por sala (`MAX_PARTICIPANTS = 2`).
   - Unidades: `room` e `message`.
   - Conteúdo estritamente permitido: texto, números e caracteres.
   - Zero cards, zero avatars, zero anexos, zero mídias, zero previews.

2. **Camada 02 — UI Mínima**:
   - Sem frameworks pesados ou bibliotecas visuais infladas.
   - Botões textuais (`[entrar]`, `[enviar]`, `[sair]`, `[carregar anteriores]`).
   - Lista linear com DOM incremental e `textContent`.
   - Um único campo de input, um único comando de envio.

3. **Camada 03 & 04 — Input & Anti-Media**:
   - Sanitização de sala (máx 32 caracteres, alfanumérico e hífens).
   - Sanitização de nome (máx 30 caracteres).
   - Validação de mensagem (1 a 2000 caracteres, rejeita vazio e espaços).
   - Bloqueio ativo de drag-and-drop de arquivos e paste de imagens do clipboard.

4. **Camada 05, 06 & 07 — Modelo de Dados, Firestore & Offline-First**:
   - Persistência local via IndexedDB (`talk2tm_local_v1`) com suporte a fila outbox.
   - Fluxo: `LOCAL → FIRESTORE CACHE → NETWORK`.
   - Mensagem renderizada imediatamente com estado `· ...` (pendente) e atualizada para `· ok` (sincronizada).

5. **Camada 08 & 09 — Reconexão & Idempotência**:
   - Chave determinística de documento: `${room}_${clientId}`.
   - Retentativas de rede gravam no mesmo ID, impossibilitando duplicações.
   - Monitoramento de eventos `online`/`offline` com sincronização automática do outbox.

6. **Camada 12 & 13 — Regra de 2 Participantes & Firestore Security Rules**:
   - Vagas `participantA` e `participantB` com validação no backend e em `firestore.rules`.
   - Terceiro participante é estritamente rejeitado.

## Estrutura de Arquivos

```text
talk2tm/
├── index.html                 # Shell HTML com meta tags e manifest PWA
├── package.json               # Dependências do projeto
├── firebase-blueprint.json    # IR da modelagem e coleções
├── firestore.rules            # Regras de segurança de acesso com validação rígida
├── firestore.indexes.json     # Índices compostos de ordenação cronológica
├── firebase.json              # Configuração para Firebase Hosting e Firestore
├── public/
│   ├── manifest.json          # Manifesto PWA mínimo
│   └── sw.js                  # Service Worker com cache do shell estático
├── src/
│   ├── main.ts                # Orquestrador da aplicação e listeners
│   ├── config.ts              # Constantes de limites operacionais
│   ├── types.ts               # Tipos TypeScript estritos
│   ├── style.css              # Estilos CSS mínimos sem sombras nem cards
│   ├── utils/
│   │   └── sanitize.ts        # Sanitização e normalização de entradas
│   ├── storage/
│   │   └── indexeddb.ts       # Armazenamento IndexedDB local offline-first
│   ├── firebase/
│   │   └── firestore.ts       # Integração com Firestore e regras de 2 participantes
│   └── ui/
│       └── dom.ts             # Manipulação pura de DOM com textContent incremental
├── tests/
│   └── talk2tm.test.ts        # Suite de testes unitários das camadas
└── README.md
```

## Execução

- Desenvolvimento: `npm run dev`
- Build de Produção: `npm run build`
- Validação de Tipos: `npm run lint`
