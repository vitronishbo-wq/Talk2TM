/**
 * Talk2TM — Testes Reais de Autorização do Firestore (Firebase Emulator Suite)
 *
 * Valida diretamente as regras em `firestore.rules` nos cenários obrigatórios:
 *  1. A e B conseguem criar e utilizar a sua conversa após convite aceite.
 *  2. C não consegue ler, listar ou escrever na conversa de A e B.
 *  3. Nenhum participante consegue substituir os UIDs ou os identificadores da conversa.
 *  4. Um convite não pode ser utilizado para criar uma conversa entre participantes diferentes.
 *  5. Terceiros não conseguem consultar ou modificar convites (e convites aceites não reabrem).
 *  6. Não é possível falsificar `senderId` ou `senderTalk2tmId` (nem adulterar `status`).
 *  7. `deletedFor` só permite eliminação individual legítima.
 *  8. Cada participante só altera o próprio marcador de leitura (`lastReadA` / `lastReadB`).
 *  9. Truman e Mãezinha continuam a comunicar normalmente (com flexibilidade segura de posição A/B).
 * 10. Terceiros e UIDs externos (mesmo com nome coincidente) não acedem à sala legada `truman-maezinha`.
 * 11. Novos utilizadores conseguem criar e restaurar a própria identidade (sem reivindicar ID alheio).
 * 12. Os campos legados, incluindo `createdAtServer: serverTimestamp()`, continuam compatíveis.
 * 13. Sala legada `truman-maezinha` suporta Truman em A / Mãezinha em B, recuperação `usr_*` e bloqueia UID impostor.
 * 14. Integridade de nomes na criação/reabertura de convites e criação de conversas.
 * 15. Estado activo (`active == true`) exigido para remetente e destinatário ao criar ou reabrir convites.
 * 16. Leitura `get` não autenticada rejeitada em todas as colecções, mesmo em documentos inexistentes.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

function assert(cond: boolean, message: string): void {
  if (!cond) {
    throw new Error(`FALHA DE AUTORIZAÇÃO: ${message}`);
  }
}

async function runEmulatorRulesTests(): Promise<void> {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  const hostPort = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr) || 8080;

  const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: 'talk2tm-rules-test',
    firestore: {
      rules,
      host,
      port,
    },
  });

  let passed = 0;
  let total = 0;

  async function testCase(name: string, fn: () => Promise<void>): Promise<void> {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  ✔ ${name}`);
    } catch (err) {
      console.error(`  ✖ ${name}`);
      throw err;
    }
  }

  try {
    await testEnv.clearFirestore();

    const uidA = 'uid_user_aaa_111';
    const uidB = 'uid_user_bbb_222';
    const uidC = 'uid_user_ccc_333';
    const uidD = 'uid_user_ddd_444';
    const talkIdA = 'TM-AAAA-2222';
    const talkIdB = 'TM-BBBB-3333';
    const talkIdC = 'TM-CCCC-4444';
    const talkIdD = 'TM-DDDD-5555';
    const convAB = `conv_${uidA}_${uidB}`; // uidA < uidB lexicograficamente
    const convAC = `conv_${uidA}_${uidC}`;
    const convAD = `conv_${uidA}_${uidD}`;
    const nowIso = new Date().toISOString();

    const ctxA = testEnv.authenticatedContext(uidA, { email: 'tm_aaaa_2222@talk2tm.internal' });
    const ctxB = testEnv.authenticatedContext(uidB, { email: 'tm_bbbb_3333@talk2tm.internal' });
    const ctxC = testEnv.authenticatedContext(uidC, { email: 'tm_cccc_4444@talk2tm.internal' });
    const ctxD = testEnv.authenticatedContext(uidD, { email: 'tm_dddd_5555@talk2tm.internal' });
    const ctxTruman = testEnv.authenticatedContext('uid_truman_852456', {
      email: 'truman@talk2tm.internal',
    });
    const ctxMaezinha = testEnv.authenticatedContext('uid_maezinha_135790', {
      email: 'maezinha@talk2tm.internal',
    });
    const unauth = testEnv.unauthenticatedContext();

    const dbA = ctxA.firestore();
    const dbB = ctxB.firestore();
    const dbC = ctxC.firestore();
    const dbD = ctxD.firestore();
    const dbTruman = ctxTruman.firestore();
    const dbMaezinha = ctxMaezinha.firestore();
    const dbUnauth = unauth.firestore();

    // -----------------------------------------------------------------------
    // Cenário 11: Novos utilizadores conseguem criar e restaurar a própria identidade
    // -----------------------------------------------------------------------
    await testCase('11. Criação/restauração de identidade própria e bloqueio de reivindicação de ID alheio', async () => {
      // Não pode criar userProfiles antes de users/{uid} existir
      await assertFails(
        setDoc(doc(dbA, 'userProfiles', talkIdA), {
          talk2tmId: talkIdA,
          uid: uidA,
          displayName: 'Conta A',
          active: true,
          createdAt: nowIso,
        })
      );

      // Cria users/{uid} e em seguida userProfiles/{talk2tmId} para A, B, C, D
      await assertSucceeds(setDoc(doc(dbA, 'users', uidA), { uid: uidA, talk2tmId: talkIdA, createdAt: nowIso }));
      // Não pode registar userProfiles com outro TM-ID diferente do registado em users/{uid}
      await assertFails(
        setDoc(doc(dbA, 'userProfiles', 'TM-FAKE-9999'), {
          talk2tmId: 'TM-FAKE-9999',
          uid: uidA,
          displayName: 'Fake A',
          active: true,
          createdAt: nowIso,
        })
      );
      await assertSucceeds(
        setDoc(doc(dbA, 'userProfiles', talkIdA), {
          talk2tmId: talkIdA,
          uid: uidA,
          displayName: 'Conta A',
          active: true,
          createdAt: nowIso,
        })
      );

      await assertSucceeds(setDoc(doc(dbB, 'users', uidB), { uid: uidB, talk2tmId: talkIdB, createdAt: nowIso }));
      await assertSucceeds(
        setDoc(doc(dbB, 'userProfiles', talkIdB), {
          talk2tmId: talkIdB,
          uid: uidB,
          displayName: 'Conta B',
          active: true,
          createdAt: nowIso,
        })
      );

      await assertSucceeds(setDoc(doc(dbC, 'users', uidC), { uid: uidC, talk2tmId: talkIdC, createdAt: nowIso }));
      await assertSucceeds(
        setDoc(doc(dbC, 'userProfiles', talkIdC), {
          talk2tmId: talkIdC,
          uid: uidC,
          displayName: 'Conta C',
          active: true,
          createdAt: nowIso,
        })
      );

      await assertSucceeds(setDoc(doc(dbD, 'users', uidD), { uid: uidD, talk2tmId: talkIdD, createdAt: nowIso }));
      await assertSucceeds(
        setDoc(doc(dbD, 'userProfiles', talkIdD), {
          talk2tmId: talkIdD,
          uid: uidD,
          displayName: 'Conta D',
          active: true,
          createdAt: nowIso,
        })
      );

      // Restauração da própria identidade e atualização de displayName/active permitido
      const snapUserA = await assertSucceeds(getDoc(doc(dbA, 'users', uidA)));
      const snapProfA = await assertSucceeds(getDoc(doc(dbA, 'userProfiles', talkIdA)));
      assert(snapUserA.exists() && snapUserA.data().talk2tmId === talkIdA, 'Conta A deve restaurar users/{uid}');
      assert(snapProfA.exists() && snapProfA.data().uid === uidA, 'Conta A deve restaurar userProfiles/{id}');

      await assertSucceeds(updateDoc(doc(dbA, 'userProfiles', talkIdA), { displayName: 'Conta A Editada', active: true }));
      await assertSucceeds(updateDoc(doc(dbA, 'userProfiles', talkIdA), { displayName: 'Conta A', active: true }));
      // Não pode trocar uid/talk2tmId em userProfiles nem alterar users/{uid}
      await assertFails(updateDoc(doc(dbA, 'userProfiles', talkIdA), { uid: uidC }));
      await assertFails(updateDoc(doc(dbA, 'users', uidA), { talk2tmId: 'TM-ZZZZ-9999' }));

      // C e não-autenticado não acedem users/{uidA}
      await assertFails(getDoc(doc(dbC, 'users', uidA)));
      await assertFails(getDocs(collection(dbC, 'users')));
      await assertFails(getDoc(doc(dbUnauth, 'users', uidA)));
      // C não pode reivindicar perfil público de A
      await assertFails(updateDoc(doc(dbC, 'userProfiles', talkIdA), { displayName: 'Sequestrado' }));
    });

    // -----------------------------------------------------------------------
    // Cenário 5: Terceiros não conseguem consultar ou modificar convites
    //            (e reabertura segura de declined/cancelled vs imutabilidade de accepted)
    // -----------------------------------------------------------------------
    await testCase('5. Convites privados entre remetente/destinatário; declined/cancelled reabre, accepted é terminal', async () => {
      // Bloqueia convite com toUid nulo ou com conversationId não canónico
      await assertFails(
        setDoc(doc(dbA, 'conversationInvites', convAB), {
          inviteId: convAB,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdB,
          toUid: null,
          conversationId: convAB,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(dbA, 'conversationInvites', convAC), {
          inviteId: convAC,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdB,
          toUid: uidB,
          conversationId: convAC, // não corresponde ao par A-B
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Convite válido A -> B
      await assertSucceeds(
        setDoc(doc(dbA, 'conversationInvites', convAB), {
          inviteId: convAB,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdB,
          toUid: uidB,
          conversationId: convAB,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Terceiro C não consegue ler por get, list, where nem alterar
      await assertFails(getDoc(doc(dbC, 'conversationInvites', convAB)));
      await assertFails(getDocs(collection(dbC, 'conversationInvites')));
      await assertFails(getDocs(query(collection(dbC, 'conversationInvites'), where('toUid', '==', uidB))));
      await assertFails(updateDoc(doc(dbC, 'conversationInvites', convAB), { status: 'accepted', updatedAt: nowIso }));

      // B recusa, e depois B (ou A) reabre com segurança de declined -> pending
      await assertSucceeds(updateDoc(doc(dbB, 'conversationInvites', convAB), { status: 'declined', updatedAt: nowIso }));
      await assertSucceeds(
        updateDoc(doc(dbA, 'conversationInvites', convAB), {
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toUid: uidB,
          toTalk2tmId: talkIdB,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );

      // A cancela e B reabre de cancelled -> pending convidando A de volta
      await assertSucceeds(updateDoc(doc(dbA, 'conversationInvites', convAB), { status: 'cancelled', updatedAt: nowIso }));
      await assertSucceeds(
        updateDoc(doc(dbB, 'conversationInvites', convAB), {
          fromUid: uidB,
          fromDisplayName: 'Conta B',
          fromTalk2tmId: talkIdB,
          toUid: uidA,
          toTalk2tmId: talkIdA,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );

      // Conversa ainda não pode ser criada antes do aceite
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAB), {
          conversationId: convAB,
          participantA: uidA,
          participantB: uidB,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdB,
          displayNameA: 'Conta A',
          displayNameB: 'Conta B',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // A aceita o convite (agora fromUid=B, toUid=A); depois disso accepted é TERMINAL (não reabre nem cancela!)
      await assertSucceeds(updateDoc(doc(dbA, 'conversationInvites', convAB), { status: 'accepted', updatedAt: nowIso }));
      await assertFails(updateDoc(doc(dbA, 'conversationInvites', convAB), { status: 'cancelled', updatedAt: nowIso }));
      await assertFails(
        updateDoc(doc(dbB, 'conversationInvites', convAB), {
          fromUid: uidB,
          fromDisplayName: 'Conta B',
          fromTalk2tmId: talkIdB,
          toUid: uidA,
          toTalk2tmId: talkIdA,
          status: 'pending',
          updatedAt: nowIso,
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 4: Convite não pode ser usado para criar conversa entre pares diferentes
    // -----------------------------------------------------------------------
    await testCase('4. Convite aceite de A-B não pode criar conversa para outro par ou UIDs diferentes', async () => {
      // C tenta criar conversa A-C usando ausência de convite aceite ou tentando reaproveitar docId
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAC), {
          conversationId: convAC,
          participantA: uidA,
          participantB: uidC,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdC,
          displayNameA: 'Conta A',
          displayNameB: 'Conta C',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      // Tentativa de adulterar talk2tmIdB ao criar convAB (convite é A-B, não A-C)
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAB), {
          conversationId: convAB,
          participantA: uidA,
          participantB: uidB,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdC,
          displayNameA: 'Conta A',
          displayNameB: 'Conta B',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      // Tentativa com convite ainda pending (A -> D)
      await assertSucceeds(
        setDoc(doc(dbA, 'conversationInvites', convAD), {
          inviteId: convAD,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdD,
          toUid: uidD,
          conversationId: convAD,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAD), {
          conversationId: convAD,
          participantA: uidA,
          participantB: uidD,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdD,
          displayNameA: 'Conta A',
          displayNameB: 'Conta D',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 1: A e B conseguem criar e utilizar a sua conversa após convite aceite
    // -----------------------------------------------------------------------
    const msgIdA1 = `${convAB}_cli_msgA_1`;
    await testCase('1. A e B criam conversa bilateral após aceite e trocam mensagens com sucesso', async () => {
      await assertSucceeds(
        setDoc(doc(dbB, 'conversations', convAB), {
          conversationId: convAB,
          participantA: uidA,
          participantB: uidB,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdB,
          displayNameA: 'Conta A',
          displayNameB: 'Conta B',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      const convSnap = await assertSucceeds(getDoc(doc(dbA, 'conversations', convAB)));
      assert(convSnap.exists() && convSnap.data().participantB === uidB, 'A deve ler conversa bilateral com B');

      await assertSucceeds(
        setDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1), {
          messageId: msgIdA1,
          conversationId: convAB,
          senderId: uidA,
          senderTalk2tmId: talkIdA,
          text: 'Olá B, conversa bilateral confirmada!',
          clientId: 'cli_msgA_1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      const msgsB = await assertSucceeds(getDocs(collection(dbB, 'conversations', convAB, 'messages')));
      assert(msgsB.size === 1, 'B deve listar a mensagem enviada por A');
    });

    // -----------------------------------------------------------------------
    // Cenário 2: C não consegue ler, listar ou escrever na conversa de A e B
    // -----------------------------------------------------------------------
    await testCase('2. Terceiro C é bloqueado de ler, listar ou escrever na conversa e mensagens de A e B', async () => {
      await assertFails(getDoc(doc(dbC, 'conversations', convAB)));
      await assertFails(getDocs(query(collection(dbC, 'conversations'), where('participantA', '==', uidA))));
      await assertFails(getDoc(doc(dbC, 'conversations', convAB, 'messages', msgIdA1)));
      await assertFails(getDocs(collection(dbC, 'conversations', convAB, 'messages')));
      await assertFails(
        setDoc(doc(dbC, 'conversations', convAB, 'messages', `${convAB}_intruder`), {
          messageId: `${convAB}_intruder`,
          conversationId: convAB,
          senderId: uidC,
          senderTalk2tmId: talkIdC,
          text: 'Tentativa de invasão',
          clientId: 'cli_intr',
          createdAt: nowIso,
          status: 'synced',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 3: Nenhum participante consegue substituir os UIDs ou identificadores da conversa
    // -----------------------------------------------------------------------
    await testCase('3. Participantes e identificadores da conversa são estritamente imutáveis', async () => {
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB), { participantB: uidC, updatedAt: nowIso }));
      await assertFails(updateDoc(doc(dbB, 'conversations', convAB), { participantA: uidC, updatedAt: nowIso }));
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB), { talk2tmIdB: talkIdC, updatedAt: nowIso }));
      await assertFails(updateDoc(doc(dbB, 'conversations', convAB), { displayNameA: 'Adulterado', updatedAt: nowIso }));
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB), { conversationId: 'conv_outro', updatedAt: nowIso }));
      await assertFails(deleteDoc(doc(dbA, 'conversations', convAB)));
    });

    // -----------------------------------------------------------------------
    // Cenário 6: Não é possível falsificar senderId ou senderTalk2tmId
    // -----------------------------------------------------------------------
    await testCase('6. Bloqueia falsificação de senderId, senderTalk2tmId e status inválido', async () => {
      // A tentando falsificar senderId de B
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAB, 'messages', `${convAB}_spoof_uid`), {
          messageId: `${convAB}_spoof_uid`,
          conversationId: convAB,
          senderId: uidB,
          senderTalk2tmId: talkIdB,
          text: 'UID falso',
          clientId: 'cli_spoof1',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      // A mantendo senderId=uidA mas falsificando senderTalk2tmId de B
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAB, 'messages', `${convAB}_spoof_tmid`), {
          messageId: `${convAB}_spoof_tmid`,
          conversationId: convAB,
          senderId: uidA,
          senderTalk2tmId: talkIdB,
          text: 'Talk2TM ID falso',
          clientId: 'cli_spoof2',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      // Status inválido
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAB, 'messages', `${convAB}_bad_status`), {
          messageId: `${convAB}_bad_status`,
          conversationId: convAB,
          senderId: uidA,
          senderTalk2tmId: talkIdA,
          text: 'Status inválido',
          clientId: 'cli_badstat',
          createdAt: nowIso,
          status: 'hacked',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 7: deletedFor só permite eliminação individual legítima
    // -----------------------------------------------------------------------
    await testCase('7. deletedFor aceita somente adição do próprio UID e proíbe remoção/adulteração', async () => {
      // A apaga para si
      await assertSucceeds(updateDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1), { deletedFor: arrayUnion(uidA) }));
      // A não pode adicionar B nem remover a si nem alterar texto nem deletar doc
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1), { deletedFor: [uidA, uidB] }));
      await assertFails(updateDoc(doc(dbB, 'conversations', convAB, 'messages', msgIdA1), { deletedFor: [uidB] })); // removeria uidA!
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1), { deletedFor: arrayRemove(uidA) }));
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1), { text: 'Adulterado' }));
      await assertFails(deleteDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1)));

      // B também pode apagar para si mantendo uidA preservado
      await assertSucceeds(updateDoc(doc(dbB, 'conversations', convAB, 'messages', msgIdA1), { deletedFor: arrayUnion(uidB) }));
    });

    // -----------------------------------------------------------------------
    // Cenário 8: Cada participante só altera o próprio marcador de leitura
    // -----------------------------------------------------------------------
    await testCase('8. Cada participante só atualiza o próprio marcador lastReadA/lastReadB', async () => {
      await assertSucceeds(updateDoc(doc(dbA, 'conversations', convAB), { lastReadA: nowIso, updatedAt: nowIso }));
      await assertSucceeds(updateDoc(doc(dbB, 'conversations', convAB), { lastReadB: nowIso, updatedAt: nowIso }));
      // Apenas updatedAt também funciona (envio de mensagem em firestore.ts)
      await assertSucceeds(updateDoc(doc(dbA, 'conversations', convAB), { updatedAt: new Date().toISOString() }));

      // A não pode alterar lastReadB e B não pode alterar lastReadA
      const forgedReadIso = new Date(Date.now() + 60000).toISOString();
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB), { lastReadB: forgedReadIso, updatedAt: forgedReadIso }));
      await assertFails(updateDoc(doc(dbB, 'conversations', convAB), { lastReadA: forgedReadIso, updatedAt: forgedReadIso }));
      // Tipo inválido em lastReadA é rejeitado
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB), { lastReadA: 12345, updatedAt: forgedReadIso }));
    });

    // -----------------------------------------------------------------------
    // Cenário 9: Truman e Mãezinha continuam a comunicar normalmente (flexibilidade A/B protegida)
    // -----------------------------------------------------------------------
    const legacyMsgT = 'truman-maezinha_cli_t1';
    const legacyMsgM = 'truman-maezinha_cli_m1';
    await testCase('9. Truman e Mãezinha comunicam em truman-maezinha (inclusive com Mãezinha em A e Truman em B)', async () => {
      // Mãezinha entra primeiro como participantA (flexibilidade legítima A/B preservada)
      await assertSucceeds(
        setDoc(doc(dbMaezinha, 'rooms', 'truman-maezinha'), {
          roomId: 'truman-maezinha',
          participantA: 'uid_maezinha_135790',
          participantAName: 'Mãezinha',
          participantB: null,
          participantBName: null,
          createdAt: nowIso,
          lastActivity: nowIso,
        })
      );

      // Mãezinha NÃO pode colocar o próprio UID em participantB também (A != B)
      await assertFails(
        updateDoc(doc(dbMaezinha, 'rooms', 'truman-maezinha'), {
          participantB: 'uid_maezinha_135790',
          participantBName: 'Mãezinha',
          lastActivity: nowIso,
        })
      );

      // Truman entra na vaga B com seu próprio UID e nome 'Truman'
      await assertSucceeds(
        updateDoc(doc(dbTruman, 'rooms', 'truman-maezinha'), {
          participantB: 'uid_truman_852456',
          participantBName: 'Truman',
          lastActivity: nowIso,
        })
      );

      // Truman NÃO pode sobrescrever participantA (vaga ocupada por Mãezinha) nem o nome dela
      await assertFails(
        updateDoc(doc(dbTruman, 'rooms', 'truman-maezinha'), {
          participantA: 'uid_truman_852456',
          lastActivity: nowIso,
        })
      );

      // Atualização de leitura em lastRead (mapa usado por updateFirestoreLastRead)
      await assertSucceeds(
        updateDoc(doc(dbTruman, 'rooms', 'truman-maezinha'), {
          'lastRead.Truman': nowIso,
          'lastRead.uid_truman_852456': nowIso,
          lastActivity: nowIso,
        })
      );

      // Troca de mensagens legadas e listagem
      await assertSucceeds(
        setDoc(doc(dbTruman, 'messages', legacyMsgT), {
          messageId: legacyMsgT,
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_truman_852456',
          text: 'Olá Mãezinha!',
          clientId: 'cli_t1',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      await assertSucceeds(
        setDoc(doc(dbMaezinha, 'messages', legacyMsgM), {
          messageId: legacyMsgM,
          room: 'truman-maezinha',
          sender: 'Mãezinha',
          senderId: 'uid_maezinha_135790',
          text: 'Oi amor!',
          clientId: 'cli_m1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      const roomMsgs = await assertSucceeds(
        getDocs(query(collection(dbMaezinha, 'messages'), where('room', '==', 'truman-maezinha')))
      );
      assert(roomMsgs.size === 2, 'Mãezinha deve ler mensagens de truman-maezinha');

      // Truman não consegue falsificar sender: 'Mãezinha' nem senderId da Mãezinha
      await assertFails(
        setDoc(doc(dbTruman, 'messages', 'truman-maezinha_cli_spoof'), {
          messageId: 'truman-maezinha_cli_spoof',
          room: 'truman-maezinha',
          sender: 'Mãezinha',
          senderId: 'uid_truman_852456',
          text: 'Falsificando nome',
          clientId: 'cli_sp1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      // Eliminação individual na coleção legada também preservada
      await assertSucceeds(updateDoc(doc(dbTruman, 'messages', legacyMsgM), { deletedFor: arrayUnion('uid_truman_852456') }));
      await assertFails(updateDoc(doc(dbTruman, 'messages', legacyMsgM), { text: 'Editada' }));
    });

    // -----------------------------------------------------------------------
    // Cenário 10: Terceiros não conseguem aceder à sala legada
    // -----------------------------------------------------------------------
    await testCase('10. Terceiro C (e não autenticado) bloqueado de ler, listar, alterar ou escrever na sala legada', async () => {
      await assertFails(getDoc(doc(dbC, 'rooms', 'truman-maezinha')));
      await assertFails(getDocs(collection(dbC, 'rooms')));
      await assertFails(updateDoc(doc(dbC, 'rooms', 'truman-maezinha'), { lastActivity: nowIso }));
      await assertFails(getDoc(doc(dbC, 'messages', legacyMsgT)));
      await assertFails(getDocs(query(collection(dbC, 'messages'), where('room', '==', 'truman-maezinha'))));
      await assertFails(
        setDoc(doc(dbC, 'messages', 'truman-maezinha_cli_inv'), {
          messageId: 'truman-maezinha_cli_inv',
          room: 'truman-maezinha',
          sender: 'Invasor',
          senderId: uidC,
          text: 'Intruso',
          clientId: 'cli_inv',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      await assertFails(
        setDoc(doc(dbC, 'rooms', 'sala-arbitraria'), {
          roomId: 'sala-arbitraria',
          participantA: uidC,
          participantAName: 'Invasor',
          createdAt: nowIso,
          lastActivity: nowIso,
        })
      );
      await assertFails(getDoc(doc(dbUnauth, 'rooms', 'truman-maezinha')));
    });

    // -----------------------------------------------------------------------
    // Cenário 12: Compatibilidade de createdAtServer: serverTimestamp() em legado e bilateral
    // -----------------------------------------------------------------------
    await testCase('12. Campos legados e createdAtServer (serverTimestamp()) aceites e strings inválidas rejeitadas', async () => {
      const legSrvId = 'truman-maezinha_cli_srv_1';
      await assertSucceeds(
        setDoc(doc(dbTruman, 'messages', legSrvId), {
          messageId: legSrvId,
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_truman_852456',
          text: 'Mensagem com serverTimestamp legado',
          clientId: 'cli_srv_1',
          createdAt: nowIso,
          createdAtServer: serverTimestamp(),
          status: 'synced',
        })
      );

      const biSrvId = `${convAB}_cli_srv_2`;
      await assertSucceeds(
        setDoc(doc(dbB, 'conversations', convAB, 'messages', biSrvId), {
          messageId: biSrvId,
          conversationId: convAB,
          senderId: uidB,
          senderTalk2tmId: talkIdB,
          text: 'Mensagem bilateral com serverTimestamp',
          clientId: 'cli_srv_2',
          createdAt: nowIso,
          createdAtServer: serverTimestamp(),
          status: 'synced',
        })
      );

      // createdAtServer com tipo errado (string em vez de timestamp) é rejeitado
      await assertFails(
        setDoc(doc(dbTruman, 'messages', 'truman-maezinha_cli_srv_bad'), {
          messageId: 'truman-maezinha_cli_srv_bad',
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_truman_852456',
          text: 'Tipo errado',
          clientId: 'cli_srv_bad',
          createdAt: nowIso,
          createdAtServer: '2026-11-16T00:00:00.000Z',
          status: 'synced',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 13: Segurança estrita da sala legada (UID != participante, mesmo com nome coincidente)
    //             + adesão Truman A / Mãezinha B + recuperação segura de usr_* legado
    // -----------------------------------------------------------------------
    await testCase('13. Sala legada exige correspondência de UID (bloqueia nome coincidente), preserva A/B e recuperação usr_*', async () => {
      const ctxRogueTruman = testEnv.authenticatedContext('uid_rogue_truman_999', {
        email: 'truman@talk2tm.internal',
      });
      const dbRogueTruman = ctxRogueTruman.firestore();

      // Enquanto truman-maezinha já está vinculada a uid_maezinha_135790 e uid_truman_852456:
      // Um UID externo (mesmo com email truman@talk2tm.internal e sender: 'Truman') é BLOQUEADO
      await assertFails(getDoc(doc(dbRogueTruman, 'rooms', 'truman-maezinha')));
      await assertFails(getDocs(collection(dbRogueTruman, 'rooms')));
      await assertFails(updateDoc(doc(dbRogueTruman, 'rooms', 'truman-maezinha'), { participantA: 'uid_rogue_truman_999', lastActivity: nowIso }));
      await assertFails(updateDoc(doc(dbRogueTruman, 'rooms', 'truman-maezinha'), { participantB: 'uid_rogue_truman_999', lastActivity: nowIso }));
      await assertFails(getDoc(doc(dbRogueTruman, 'messages', legacyMsgT)));
      await assertFails(getDocs(query(collection(dbRogueTruman, 'messages'), where('room', '==', 'truman-maezinha'))));
      await assertFails(
        setDoc(doc(dbRogueTruman, 'messages', 'truman-maezinha_cli_rogue_1'), {
          messageId: 'truman-maezinha_cli_rogue_1',
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_rogue_truman_999',
          text: 'Tentativa por coincidência de nome',
          clientId: 'cli_rogue_1',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      // C com sender: 'Truman' também continua bloqueado
      await assertFails(
        setDoc(doc(dbC, 'messages', 'truman-maezinha_cli_rogue_c'), {
          messageId: 'truman-maezinha_cli_rogue_c',
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: uidC,
          text: 'Tentativa C com nome Truman',
          clientId: 'cli_rogue_c',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      // Recria sala legada pré-UID (usr_truman / usr_maezinha) com mensagem histórica via Admin do Emulador
      await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
        const adminDb = adminCtx.firestore();
        await setDoc(doc(adminDb, 'rooms', 'truman-maezinha'), {
          roomId: 'truman-maezinha',
          participantA: 'usr_truman',
          participantAName: 'Truman',
          participantB: 'usr_maezinha',
          participantBName: 'Mãezinha',
          createdAt: nowIso,
          lastActivity: nowIso,
        });
        await setDoc(doc(adminDb, 'messages', 'truman-maezinha_hist_1'), {
          messageId: 'truman-maezinha_hist_1',
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'usr_truman',
          text: 'Mensagem histórica antes de vincular UID',
          clientId: 'cli_hist_1',
          createdAt: nowIso,
          status: 'synced',
        });
      });

      // Antes de vincular UID real, nem mesmo Truman/Mãezinha ou impostor lê/escreve /messages sem UID vinculado
      await assertFails(getDoc(doc(dbRogueTruman, 'messages', 'truman-maezinha_hist_1')));
      await assertFails(getDoc(doc(dbTruman, 'messages', 'truman-maezinha_hist_1')));

      // Recuperação segura: Truman vincula participantA ao seu UID real e Mãezinha vincula participantB ao seu UID real
      await assertSucceeds(getDoc(doc(dbTruman, 'rooms', 'truman-maezinha')));
      await assertSucceeds(
        updateDoc(doc(dbTruman, 'rooms', 'truman-maezinha'), {
          participantA: 'uid_truman_852456',
          lastActivity: new Date().toISOString(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(dbMaezinha, 'rooms', 'truman-maezinha'), {
          participantB: 'uid_maezinha_135790',
          lastActivity: new Date().toISOString(),
        })
      );

      // Após vinculação, ambos recuperam o histórico e enviam mensagens; impostor permanece bloqueado
      const histSnap = await assertSucceeds(getDoc(doc(dbMaezinha, 'messages', 'truman-maezinha_hist_1')));
      assert(histSnap.exists(), 'Mãezinha deve recuperar mensagem histórica após vinculação de UID');
      await assertSucceeds(
        setDoc(doc(dbTruman, 'messages', 'truman-maezinha_cli_pos_rec'), {
          messageId: 'truman-maezinha_cli_pos_rec',
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_truman_852456',
          text: 'Sala recuperada com Truman em A e Mãezinha em B',
          clientId: 'cli_pos_rec',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      await assertFails(getDoc(doc(dbRogueTruman, 'messages', 'truman-maezinha_hist_1')));
      await assertFails(getDoc(doc(dbRogueTruman, 'rooms', 'truman-maezinha')));

      // Verifica também criação com Truman em A e adesão inicial de Mãezinha em B (slot vazio)
      await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
        await deleteDoc(doc(adminCtx.firestore(), 'rooms', 'truman-maezinha'));
      });
      await assertSucceeds(
        setDoc(doc(dbTruman, 'rooms', 'truman-maezinha'), {
          roomId: 'truman-maezinha',
          participantA: 'uid_truman_852456',
          participantAName: 'Truman',
          participantB: null,
          participantBName: null,
          createdAt: nowIso,
          lastActivity: nowIso,
        })
      );
      await assertSucceeds(
        updateDoc(doc(dbMaezinha, 'rooms', 'truman-maezinha'), {
          participantB: 'uid_maezinha_135790',
          participantBName: 'Mãezinha',
          lastActivity: new Date().toISOString(),
        })
      );
      await assertSucceeds(
        setDoc(doc(dbMaezinha, 'messages', 'truman-maezinha_cli_ab_ok'), {
          messageId: 'truman-maezinha_cli_ab_ok',
          room: 'truman-maezinha',
          sender: 'Mãezinha',
          senderId: 'uid_maezinha_135790',
          text: 'Adesão inicial em B confirmada',
          clientId: 'cli_ab_ok',
          createdAt: nowIso,
          status: 'synced',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 14: Integridade dos nomes contra userProfiles/{talk2tmId}
    // -----------------------------------------------------------------------
    await testCase('14. Bloqueia nome falsificado na criação/reabertura de convites e criação de conversas', async () => {
      // Falsificação de fromDisplayName na criação do convite A -> C
      await assertFails(
        setDoc(doc(dbA, 'conversationInvites', convAC), {
          inviteId: convAC,
          fromUid: uidA,
          fromDisplayName: 'Impostor A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdC,
          toUid: uidC,
          conversationId: convAC,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Convite válido com nome real do perfil ('Conta A')
      await assertSucceeds(
        setDoc(doc(dbA, 'conversationInvites', convAC), {
          inviteId: convAC,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdC,
          toUid: uidC,
          conversationId: convAC,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // C recusa e tenta reabrir com nome falsificado ('Conta C Falsa')
      await assertSucceeds(updateDoc(doc(dbC, 'conversationInvites', convAC), { status: 'declined', updatedAt: nowIso }));
      await assertFails(
        updateDoc(doc(dbC, 'conversationInvites', convAC), {
          fromUid: uidC,
          fromDisplayName: 'Conta C Falsa',
          fromTalk2tmId: talkIdC,
          toUid: uidA,
          toTalk2tmId: talkIdA,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );

      // C reabre com seu nome verdadeiro e A aceita
      await assertSucceeds(
        updateDoc(doc(dbC, 'conversationInvites', convAC), {
          fromUid: uidC,
          fromDisplayName: 'Conta C',
          fromTalk2tmId: talkIdC,
          toUid: uidA,
          toTalk2tmId: talkIdA,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );
      await assertSucceeds(updateDoc(doc(dbA, 'conversationInvites', convAC), { status: 'accepted', updatedAt: nowIso }));

      // Falsificação de displayNameA ou displayNameB na criação da conversa convAC é rejeitada
      await assertFails(
        setDoc(doc(dbC, 'conversations', convAC), {
          conversationId: convAC,
          participantA: uidA,
          participantB: uidC,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdC,
          displayNameA: 'Nome Falso A',
          displayNameB: 'Conta C',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(dbC, 'conversations', convAC), {
          conversationId: convAC,
          participantA: uidA,
          participantB: uidC,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdC,
          displayNameA: 'Conta A',
          displayNameB: 'Nome Falso C',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Criação com nomes autênticos é aceite
      await assertSucceeds(
        setDoc(doc(dbC, 'conversations', convAC), {
          conversationId: convAC,
          participantA: uidA,
          participantB: uidC,
          talk2tmIdA: talkIdA,
          talk2tmIdB: talkIdC,
          displayNameA: 'Conta A',
          displayNameB: 'Conta C',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 15: Estado activo (active == true) exigido para remetente e destinatário
    // -----------------------------------------------------------------------
    await testCase('15. Perfis inactivos (active: false) bloqueados ao criar ou reabrir convites', async () => {
      const convCD = `conv_${uidC}_${uidD}`; // uidC < uidD

      // Remetente D inactivo não pode criar convite
      await assertSucceeds(updateDoc(doc(dbD, 'userProfiles', talkIdD), { displayName: 'Conta D', active: false }));
      await assertFails(
        setDoc(doc(dbD, 'conversationInvites', convCD), {
          inviteId: convCD,
          fromUid: uidD,
          fromDisplayName: 'Conta D',
          fromTalk2tmId: talkIdD,
          toTalk2tmId: talkIdC,
          toUid: uidC,
          conversationId: convCD,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Remetente D activo mas destinatário C inactivo também não pode criar convite
      await assertSucceeds(updateDoc(doc(dbD, 'userProfiles', talkIdD), { displayName: 'Conta D', active: true }));
      await assertSucceeds(updateDoc(doc(dbC, 'userProfiles', talkIdC), { displayName: 'Conta C', active: false }));
      await assertFails(
        setDoc(doc(dbD, 'conversationInvites', convCD), {
          inviteId: convCD,
          fromUid: uidD,
          fromDisplayName: 'Conta D',
          fromTalk2tmId: talkIdD,
          toTalk2tmId: talkIdC,
          toUid: uidC,
          conversationId: convCD,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Com ambos activos, cria e recusa para testar reabertura
      await assertSucceeds(updateDoc(doc(dbC, 'userProfiles', talkIdC), { displayName: 'Conta C', active: true }));
      await assertSucceeds(
        setDoc(doc(dbD, 'conversationInvites', convCD), {
          inviteId: convCD,
          fromUid: uidD,
          fromDisplayName: 'Conta D',
          fromTalk2tmId: talkIdD,
          toTalk2tmId: talkIdC,
          toUid: uidC,
          conversationId: convCD,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertSucceeds(updateDoc(doc(dbC, 'conversationInvites', convCD), { status: 'declined', updatedAt: nowIso }));

      // Se remetente estiver inactivo na reabertura -> rejeita
      await assertSucceeds(updateDoc(doc(dbD, 'userProfiles', talkIdD), { displayName: 'Conta D', active: false }));
      await assertFails(
        updateDoc(doc(dbD, 'conversationInvites', convCD), {
          fromUid: uidD,
          fromDisplayName: 'Conta D',
          fromTalk2tmId: talkIdD,
          toUid: uidC,
          toTalk2tmId: talkIdC,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );

      // Se destinatário estiver inactivo na reabertura -> rejeita
      await assertSucceeds(updateDoc(doc(dbD, 'userProfiles', talkIdD), { displayName: 'Conta D', active: true }));
      await assertSucceeds(updateDoc(doc(dbC, 'userProfiles', talkIdC), { displayName: 'Conta C', active: false }));
      await assertFails(
        updateDoc(doc(dbD, 'conversationInvites', convCD), {
          fromUid: uidD,
          fromDisplayName: 'Conta D',
          fromTalk2tmId: talkIdD,
          toUid: uidC,
          toTalk2tmId: talkIdC,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );

      // Com ambos activos novamente, reabertura funciona
      await assertSucceeds(updateDoc(doc(dbC, 'userProfiles', talkIdC), { displayName: 'Conta C', active: true }));
      await assertSucceeds(
        updateDoc(doc(dbD, 'conversationInvites', convCD), {
          fromUid: uidD,
          fromDisplayName: 'Conta D',
          fromTalk2tmId: talkIdD,
          toUid: uidC,
          toTalk2tmId: talkIdC,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 16: Autenticação obrigatória em TODAS as leituras get (inclusive docs inexistentes)
    // -----------------------------------------------------------------------
    await testCase('16. Leitura get não autenticada rejeitada em todas as colecções (inclusive docs inexistentes)', async () => {
      await assertFails(getDoc(doc(dbUnauth, 'users', 'uid_inexistente_999')));
      await assertFails(getDoc(doc(dbUnauth, 'userProfiles', 'TM-ZZZZ-9999')));
      await assertFails(getDoc(doc(dbUnauth, 'conversations', 'conv_inexistente_999')));
      await assertFails(getDoc(doc(dbUnauth, 'conversations', 'conv_inexistente_999', 'messages', 'msg_inexistente_999')));
      await assertFails(getDoc(doc(dbUnauth, 'conversationInvites', 'conv_inexistente_999')));
      await assertFails(getDoc(doc(dbUnauth, 'rooms', 'sala_inexistente_999')));
      await assertFails(getDoc(doc(dbUnauth, 'rooms', 'truman-maezinha')));
      await assertFails(getDoc(doc(dbUnauth, 'messages', 'msg_inexistente_999')));

      // Autenticado ainda consegue verificar existência prévia de conversa/convite inexistente
      const nonExistentConv = await assertSucceeds(getDoc(doc(dbA, 'conversations', 'conv_inexistente_999')));
      assert(!nonExistentConv.exists(), 'Documento inexistente consultado por utilizador autenticado deve retornar exists() === false');

      // Leitura não autenticada em phoneLookup também é rejeitada
      await assertFails(getDoc(doc(dbUnauth, 'phoneLookup', 'a'.repeat(64))));
    });

    // -----------------------------------------------------------------------
    // Cenário 17: Descoberta por phoneLookup/{phoneHash} (anti-enumeração + integridade)
    // -----------------------------------------------------------------------
    await testCase('17. phoneLookup/{phoneHash}: criação vinculada, busca exata autenticada, listagem bloqueada e anti-duplicação', async () => {
      const uidE = 'uid_user_eee_555';
      const talkIdE = 'TM-EEEE-6666';
      const phoneHashE = 'e'.repeat(64);
      const phoneHashBad = 'not-a-sha256-hash';
      const ctxE = testEnv.authenticatedContext(uidE, { email: `u_${phoneHashE.slice(0, 32)}@talk2tm.internal` });
      const dbE = ctxE.firestore();

      // users/{uid} rejeita phoneHash inválido
      await assertFails(
        setDoc(doc(dbE, 'users', uidE), {
          uid: uidE,
          talk2tmId: talkIdE,
          phoneHash: phoneHashBad,
          phoneMasked: '+244 ••• 555',
          createdAt: nowIso,
        })
      );

      // users/{uid} aceita phoneHash SHA-256 válido + phoneMasked
      await assertSucceeds(
        setDoc(doc(dbE, 'users', uidE), {
          uid: uidE,
          talk2tmId: talkIdE,
          phoneHash: phoneHashE,
          phoneMasked: '+244 ••• 555',
          createdAt: nowIso,
        })
      );

      // Não pode criar phoneLookup antes de criar userProfiles/{talkIdE}
      await assertFails(
        setDoc(doc(dbE, 'phoneLookup', phoneHashE), {
          phoneHash: phoneHashE,
          uid: uidE,
          talk2tmId: talkIdE,
          displayName: 'Conta E',
          active: true,
          createdAt: nowIso,
        })
      );

      await assertSucceeds(
        setDoc(doc(dbE, 'userProfiles', talkIdE), {
          talk2tmId: talkIdE,
          uid: uidE,
          displayName: 'Conta E',
          active: true,
          createdAt: nowIso,
        })
      );

      // Não pode registrar phoneLookup com nome divergente ou falsificando UID/TM-ID alheio
      await assertFails(
        setDoc(doc(dbE, 'phoneLookup', phoneHashE), {
          phoneHash: phoneHashE,
          uid: uidE,
          talk2tmId: talkIdE,
          displayName: 'Nome Diferente',
          active: true,
          createdAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(dbE, 'phoneLookup', phoneHashE), {
          phoneHash: phoneHashE,
          uid: uidA,
          talk2tmId: talkIdA,
          displayName: 'Conta A',
          active: true,
          createdAt: nowIso,
        })
      );

      // Criação legítima de phoneLookup/{phoneHashE}
      await assertSucceeds(
        setDoc(doc(dbE, 'phoneLookup', phoneHashE), {
          phoneHash: phoneHashE,
          uid: uidE,
          talk2tmId: talkIdE,
          displayName: 'Conta E',
          active: true,
          createdAt: nowIso,
        })
      );

      // Outro utilizador autenticado (A) consegue consultar exatamente pelo hash, mas NÃO consegue listar (anti-enumeração)
      const lookupSnap = await assertSucceeds(getDoc(doc(dbA, 'phoneLookup', phoneHashE)));
      assert(lookupSnap.exists() && lookupSnap.data().talk2tmId === talkIdE, 'Busca exata autenticada deve retornar perfil E');
      await assertFails(getDocs(collection(dbA, 'phoneLookup')));

      // Bloqueia duplicação/sequestro do mesmo número por outro utilizador ou exclusão
      await assertFails(
        setDoc(doc(dbA, 'phoneLookup', phoneHashE), {
          phoneHash: phoneHashE,
          uid: uidA,
          talk2tmId: talkIdA,
          displayName: 'Conta A',
          active: true,
          createdAt: nowIso,
        })
      );
      await assertFails(updateDoc(doc(dbA, 'phoneLookup', phoneHashE), { active: false }));
      await assertFails(deleteDoc(doc(dbE, 'phoneLookup', phoneHashE)));

      // Atualização pelo dono requer sincronismo com displayName de userProfiles
      await assertFails(updateDoc(doc(dbE, 'phoneLookup', phoneHashE), { displayName: 'Conta E Editada' }));
      await assertSucceeds(updateDoc(doc(dbE, 'userProfiles', talkIdE), { displayName: 'Conta E Editada', active: true }));
      await assertSucceeds(updateDoc(doc(dbE, 'phoneLookup', phoneHashE), { displayName: 'Conta E Editada', active: true }));
    });

    console.log(`\n\x1b[32m✔ Firebase Emulator Suite: ${passed}/${total} cenários reais aprovados com 100% de rigor.\x1b[0m`);
  } finally {
    await testEnv.cleanup();
  }
}

runEmulatorRulesTests().catch((err) => {
  console.error('\x1b[31m✖ Falha nos testes reais do Firebase Emulator Suite:\x1b[0m', err);
  process.exit(1);
});
