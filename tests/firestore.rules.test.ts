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
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
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

    const isAdminStart = rules.indexOf('function isAdmin()');
    const isAdminEnd = rules.indexOf('function isProtectedLegacyUid(uid)');
    const isAdminBlock =
      isAdminStart >= 0 && isAdminEnd > isAdminStart ? rules.slice(isAdminStart, isAdminEnd) : '';
    const adminEmailMatch = isAdminBlock.match(/request\.auth\.token\.email\s*==\s*'([^']+)'/);
    assert(
      Boolean(adminEmailMatch && adminEmailMatch[1] === 'vitronis.hbo@gmail.com') &&
      isAdminBlock.includes('request.auth != null') &&
      isAdminBlock.includes('request.auth.token.email_verified == true'),
      'firestore.rules deve exigir token.email == vitronis.hbo@gmail.com e token.email_verified == true em isAdmin()'
    );
    const adminEmail = adminEmailMatch![1];

    const ctxA = testEnv.authenticatedContext(uidA, { email: 'tm_aaaa_2222@talk2tm.internal' });
    const ctxB = testEnv.authenticatedContext(uidB, { email: 'tm_bbbb_3333@talk2tm.internal' });
    const ctxC = testEnv.authenticatedContext(uidC, { email: 'tm_cccc_4444@talk2tm.internal' });
    const ctxD = testEnv.authenticatedContext(uidD, { email: 'tm_dddd_5555@talk2tm.internal' });
    const ctxAdmin = testEnv.authenticatedContext('uid_admin_master_vitronis', {
      email: adminEmail,
      email_verified: true,
    });
    const ctxAdminUnverified = testEnv.authenticatedContext('uid_admin_unverified', {
      email: adminEmail,
      email_verified: false,
    });
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
    const dbAdmin = ctxAdmin.firestore();
    const dbAdminUnverified = ctxAdminUnverified.firestore();
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

      // Utilizador comum não pode desactivar o próprio perfil
      await assertFails(updateDoc(doc(dbD, 'userProfiles', talkIdD), { displayName: 'Conta D', active: false }));

      // Remetente D inactivo (desactivado pelo Admin) não pode criar convite
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdD), { active: false }));
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
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdD), { active: true }));
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdC), { active: false }));
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
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdC), { active: true }));
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
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdD), { active: false }));
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
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdD), { active: true }));
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdC), { active: false }));
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
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdC), { active: true }));
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

    // -----------------------------------------------------------------------
    // Cenário 18: Administração (isAdmin): metadados paginados, isolamento de privacidade e legado protegido
    // -----------------------------------------------------------------------
    await testCase('18. Admin consulta metadados paginados, NÃO acede mensagens/convites e NÃO desactiva legado', async () => {
      // Utilizador comum e e-mail master NÃO verificado nunca acedem ao escopo administrativo
      await assertFails(getDocs(collection(dbC, 'userProfiles')));
      await assertFails(updateDoc(doc(dbA, 'userProfiles', talkIdA), { plan: 'Pro', displayName: 'Conta A', active: true }));
      await assertFails(updateDoc(doc(dbC, 'userProfiles', talkIdA), { active: false }));
      await assertFails(getDocs(collection(dbAdminUnverified, 'userProfiles')));
      await assertFails(getDoc(doc(dbAdminUnverified, 'users', 'uid_user_eee_555')));
      await assertFails(updateDoc(doc(dbAdminUnverified, 'userProfiles', talkIdA), { active: false }));

      // Admin consegue listar paginado (limit 20) e filtrar por active + orderBy createdAt
      const pageSnap = await assertSucceeds(
        getDocs(query(collection(dbAdmin, 'userProfiles'), orderBy('createdAt', 'desc'), limit(20)))
      );
      assert(pageSnap.size >= 4, 'Admin deve listar perfis paginados');

      const activeSnap = await assertSucceeds(
        getDocs(
          query(
            collection(dbAdmin, 'userProfiles'),
            where('active', '==', true),
            orderBy('createdAt', 'desc'),
            limit(20)
          )
        )
      );
      assert(activeSnap.size >= 4, 'Admin deve filtrar perfis activos com índice composto');

      // Admin consegue obter metadado users/{uid} (ex.: phoneMasked), mas nunca listar users
      const userSnap = await assertSucceeds(getDoc(doc(dbAdmin, 'users', 'uid_user_eee_555')));
      assert(userSnap.exists() && userSnap.data().phoneMasked === '+244 ••• 555', 'Admin consulta phoneMasked do utilizador');
      await assertFails(getDocs(collection(dbAdmin, 'users')));

      // PRIVACIDADE & ESCOPO: Admin NUNCA pode consultar/listar convites, conversas ou mensagens (bilaterais ou legado)
      await assertFails(getDoc(doc(dbAdmin, 'conversationInvites', convAB)));
      await assertFails(getDocs(collection(dbAdmin, 'conversationInvites')));
      await assertFails(getDoc(doc(dbAdmin, 'conversations', convAB)));
      await assertFails(getDocs(collection(dbAdmin, 'conversations')));
      await assertFails(getDoc(doc(dbAdmin, 'conversations', convAB, 'messages', msgIdA1)));
      await assertFails(getDocs(collection(dbAdmin, 'conversations', convAB, 'messages')));
      await assertFails(getDoc(doc(dbAdmin, 'rooms', 'truman-maezinha')));
      await assertFails(getDocs(collection(dbAdmin, 'rooms')));
      await assertFails(getDoc(doc(dbAdmin, 'messages', legacyMsgT)));
      await assertFails(getDocs(collection(dbAdmin, 'messages')));

      // Admin não pode alterar displayName nem apagar contas
      await assertFails(updateDoc(doc(dbAdmin, 'userProfiles', talkIdA), { displayName: 'AlteradoAdmin' }));
      await assertFails(deleteDoc(doc(dbAdmin, 'userProfiles', talkIdA)));

      // LEGADO PROTEGIDO: Mesmo que exista perfil de Truman/Mãezinha, Admin NÃO pode desactivar UIDs legados
      const legacyTrumanProfileId = 'TM-TRUM-8524';
      const legacyMaezinhaProfileId = 'TM-MAEZ-1357';
      await testEnv.withSecurityRulesDisabled(async (emulAdminCtx) => {
        const emulDb = emulAdminCtx.firestore();
        await setDoc(doc(emulDb, 'userProfiles', legacyTrumanProfileId), {
          talk2tmId: legacyTrumanProfileId,
          uid: 'uid_truman_852456',
          displayName: 'Truman',
          active: true,
          createdAt: nowIso,
        });
        await setDoc(doc(emulDb, 'userProfiles', legacyMaezinhaProfileId), {
          talk2tmId: legacyMaezinhaProfileId,
          uid: 'uid_maezinha_135790',
          displayName: 'Mãezinha',
          active: true,
          createdAt: nowIso,
        });
      });

      await assertFails(updateDoc(doc(dbAdmin, 'userProfiles', legacyTrumanProfileId), { active: false }));
      await assertFails(updateDoc(doc(dbAdmin, 'userProfiles', legacyMaezinhaProfileId), { active: false }));
    });

    // -----------------------------------------------------------------------
    // Cenário 19: Suspensão real em sessão já aberta e recuperação após reactivação
    // -----------------------------------------------------------------------
    await testCase('19. Suspensão bloqueia envio/leitura/auto-reactivação na sessão aberta; reactivação restaura acesso', async () => {
      const uidE = 'uid_user_eee_555';
      const talkIdE = 'TM-EEEE-6666';
      const phoneHashE = 'e'.repeat(64);
      const ctxE = testEnv.authenticatedContext(uidE, { email: `u_${phoneHashE.slice(0, 32)}@talk2tm.internal` });
      const dbE = ctxE.firestore();

      // 1. Admin desactiva conta A (sessão já aberta em convAB) e conta E (userProfiles + phoneLookup)
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdA), { active: false, plan: 'Base Orgânico' }));

      const batchDeactivateE = writeBatch(dbAdmin);
      batchDeactivateE.update(doc(dbAdmin, 'userProfiles', talkIdE), { active: false });
      batchDeactivateE.update(doc(dbAdmin, 'phoneLookup', phoneHashE), { active: false });
      await assertSucceeds(batchDeactivateE.commit());

      // 2. Utilizador A desactivado que continua com sessão Auth aberta FALHA em todas as operações protegidas:
      //    a) Tentativa de enviar mensagem
      const blockedMsgId = `${convAB}_cli_blocked_while_suspended`;
      await assertFails(
        setDoc(doc(dbA, 'conversations', convAB, 'messages', blockedMsgId), {
          messageId: blockedMsgId,
          conversationId: convAB,
          senderId: uidA,
          senderTalk2tmId: talkIdA,
          text: 'Não devo conseguir enviar suspenso',
          clientId: 'cli_blocked',
          createdAt: new Date().toISOString(),
          status: 'synced',
        })
      );

      //    b) Tentativa de ler ou listar mensagens e ler/atualizar conversa
      await assertFails(getDoc(doc(dbA, 'conversations', convAB, 'messages', msgIdA1)));
      await assertFails(getDocs(collection(dbA, 'conversations', convAB, 'messages')));
      await assertFails(getDoc(doc(dbA, 'conversations', convAB)));
      await assertFails(getDocs(query(collection(dbA, 'conversations'), where('participantA', '==', uidA))));
      await assertFails(updateDoc(doc(dbA, 'conversations', convAB), { lastReadA: new Date().toISOString(), updatedAt: new Date().toISOString() }));

      //    c) Tentativa de reactivar a própria conta (userProfiles e phoneLookup) ou alterar nome enquanto suspensa
      await assertFails(updateDoc(doc(dbA, 'userProfiles', talkIdA), { active: true }));
      await assertFails(updateDoc(doc(dbA, 'userProfiles', talkIdA), { displayName: 'Tentativa', active: true }));
      await assertFails(updateDoc(doc(dbE, 'userProfiles', talkIdE), { active: true }));
      await assertFails(updateDoc(doc(dbE, 'phoneLookup', phoneHashE), { active: true }));

      //    d) Tentativa de criar ou modificar convites enquanto suspensa
      await assertFails(
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

      //    e) Truman e Mãezinha continuam totalmente operacionais sem impacto
      const legAfterSuspendId = 'truman-maezinha_cli_leg_ok_suspended_others';
      await assertSucceeds(
        setDoc(doc(dbTruman, 'messages', legAfterSuspendId), {
          messageId: legAfterSuspendId,
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_truman_852456',
          text: 'Legado intacto!',
          clientId: 'cli_leg_ok',
          createdAt: new Date().toISOString(),
          status: 'synced',
        })
      );

      // 3. Admin reactiva conta A (e conta E)
      await assertSucceeds(updateDoc(doc(dbAdmin, 'userProfiles', talkIdA), { active: true }));
      const batchReactivateE = writeBatch(dbAdmin);
      batchReactivateE.update(doc(dbAdmin, 'userProfiles', talkIdE), { active: true });
      batchReactivateE.update(doc(dbAdmin, 'phoneLookup', phoneHashE), { active: true });
      await assertSucceeds(batchReactivateE.commit());

      // 4. Utilizador reactivado recupera o acesso imediatamente
      await assertSucceeds(getDoc(doc(dbA, 'conversations', convAB)));
      const msgsAfterReactivate = await assertSucceeds(getDocs(collection(dbA, 'conversations', convAB, 'messages')));
      assert(msgsAfterReactivate.size >= 1, 'A reactivado deve voltar a listar mensagens');
      await assertSucceeds(
        updateDoc(doc(dbA, 'conversations', convAB), {
          lastReadA: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      );
      const recoveredMsgId = `${convAB}_cli_recovered_after_reactivation`;
      await assertSucceeds(
        setDoc(doc(dbA, 'conversations', convAB, 'messages', recoveredMsgId), {
          messageId: recoveredMsgId,
          conversationId: convAB,
          senderId: uidA,
          senderTalk2tmId: talkIdA,
          text: 'Conta reactivada com sucesso!',
          clientId: 'cli_recovered',
          createdAt: new Date().toISOString(),
          status: 'synced',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 20: Talk2TM Dating Fase 1 (`datingProfiles` & `evaluations`)
    // -----------------------------------------------------------------------
    await testCase('20. Dating Fase 1: +18 obrigatório, sem PII, visibilidade, anti-auto-dessuspensão e evaluations isoladas', async () => {
      const validProfileA = {
        uid: uidA,
        talk2tmId: talkIdA,
        displayName: 'Ana',
        age: 25,
        gender: 'woman',
        seeking: 'men',
        countryCode: 'AO',
        city: 'Luanda',
        cityKey: 'luanda',
        bio: 'Minimalismo e boas conversas.',
        intent: 'serious',
        adultConfirmed: true,
        termsAcceptedAt: nowIso,
        termsVersion: '2026-11',
        discoverable: true,
        paused: false,
        suspended: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      // Bloqueia menor de 18 anos, falta de adultConfirmed, bio > 160 chars, PII ou suspended: true na criação
      await assertFails(setDoc(doc(dbA, 'datingProfiles', uidA), { ...validProfileA, age: 17 }));
      await assertFails(setDoc(doc(dbA, 'datingProfiles', uidA), { ...validProfileA, adultConfirmed: false }));
      await assertFails(setDoc(doc(dbA, 'datingProfiles', uidA), { ...validProfileA, bio: 'x'.repeat(161) }));
      await assertFails(setDoc(doc(dbA, 'datingProfiles', uidA), { ...validProfileA, phone: '+244923456789' }));
      await assertFails(setDoc(doc(dbA, 'datingProfiles', uidA), { ...validProfileA, suspended: true }));
      await assertFails(setDoc(doc(dbA, 'datingProfiles', uidB), { ...validProfileA, uid: uidB, talk2tmId: talkIdB }));
      await assertFails(getDoc(doc(dbUnauth, 'datingProfiles', uidA)));

      // Criação válida por A e B
      await assertSucceeds(setDoc(doc(dbA, 'datingProfiles', uidA), validProfileA));
      await assertSucceeds(
        setDoc(doc(dbB, 'datingProfiles', uidB), {
          ...validProfileA,
          uid: uidB,
          talk2tmId: talkIdB,
          displayName: 'Bruno',
          gender: 'man',
          seeking: 'women',
        })
      );

      // B consegue consultar perfil activo e visível de A
      await assertSucceeds(getDoc(doc(dbB, 'datingProfiles', uidA)));
      const listVisible = await assertSucceeds(
        getDocs(
          query(
            collection(dbB, 'datingProfiles'),
            where('discoverable', '==', true),
            where('paused', '==', false),
            where('suspended', '==', false),
            where('adultConfirmed', '==', true),
            orderBy('updatedAt', 'desc'),
            limit(25)
          )
        )
      );
      assert(listVisible.size >= 2, 'Utilizador activo deve listar perfis Dating públicos');

      // A oculta o próprio perfil da descoberta -> B deixa de poder fazer get no perfil oculto
      await assertSucceeds(updateDoc(doc(dbA, 'datingProfiles', uidA), { discoverable: false, updatedAt: new Date().toISOString() }));
      await assertFails(getDoc(doc(dbB, 'datingProfiles', uidA)));
      await assertSucceeds(getDoc(doc(dbA, 'datingProfiles', uidA)));

      // A volta a tornar visível e pausa; Admin suspende A; A não pode remover a própria suspensão
      await assertSucceeds(updateDoc(doc(dbA, 'datingProfiles', uidA), { discoverable: true, paused: true, updatedAt: new Date().toISOString() }));
      await assertFails(getDoc(doc(dbB, 'datingProfiles', uidA)));
      await assertSucceeds(updateDoc(doc(dbA, 'datingProfiles', uidA), { paused: false, updatedAt: new Date().toISOString() }));

      await assertSucceeds(updateDoc(doc(dbAdmin, 'datingProfiles', uidA), { suspended: true, updatedAt: new Date().toISOString() }));
      await assertFails(updateDoc(doc(dbA, 'datingProfiles', uidA), { suspended: false, updatedAt: new Date().toISOString() }));
      await assertFails(getDoc(doc(dbB, 'datingProfiles', uidA)));
      await assertFails(updateDoc(doc(dbAdmin, 'datingProfiles', uidA), { bio: 'AlteradoAdmin' }));
      await assertFails(deleteDoc(doc(dbA, 'datingProfiles', uidA)));
      await assertSucceeds(updateDoc(doc(dbAdmin, 'datingProfiles', uidA), { suspended: false, updatedAt: new Date().toISOString() }));

      // Evaluations: apenas o próprio utilizador lê/escreve, sem auto-avaliação nem remoção
      await assertFails(
        setDoc(doc(dbA, 'datingProfiles', uidA, 'evaluations', uidA), {
          targetUid: uidA,
          decision: 'pass',
          createdAt: nowIso,
          dayKey: '2026-11-23',
        })
      );
      await assertSucceeds(
        setDoc(doc(dbA, 'datingProfiles', uidA, 'evaluations', uidB), {
          targetUid: uidB,
          decision: 'pass',
          createdAt: nowIso,
          dayKey: '2026-11-23',
        })
      );
      await assertFails(getDoc(doc(dbB, 'datingProfiles', uidA, 'evaluations', uidB)));
      await assertFails(getDocs(collection(dbB, 'datingProfiles', uidA, 'evaluations')));
      await assertFails(deleteDoc(doc(dbA, 'datingProfiles', uidA, 'evaluations', uidB)));
    });

    // -----------------------------------------------------------------------
    // Cenário 21: Dating Fase 2 (`datingLikes`, `datingMatches` e bloqueio pós-Unmatch)
    // -----------------------------------------------------------------------
    await testCase('21. Dating Fase 2: Like secreto, Match recíproco, conversa automática e bloqueio pós-Unmatch', async () => {
      const mUidA = 'uid_match_a';
      const mUidB = 'uid_match_b';
      const mUidC = 'uid_match_c';
      const mTalkA = 'TM-MATA-1111';
      const mTalkB = 'TM-MATB-2222';
      const mTalkC = 'TM-MATC-3333';

      const mDbA = testEnv.authenticatedContext(mUidA, { email: 'm_a@talk2tm.internal' }).firestore();
      const mDbB = testEnv.authenticatedContext(mUidB, { email: 'm_b@talk2tm.internal' }).firestore();
      const mDbC = testEnv.authenticatedContext(mUidC, { email: 'm_c@talk2tm.internal' }).firestore();

      const seedDatingAccount = async (
        db: typeof mDbA,
        uid: string,
        talk2tmId: string,
        displayName: string,
        gender: 'woman' | 'man',
        seeking: 'men' | 'women' | 'all'
      ) => {
        await assertSucceeds(setDoc(doc(db, 'users', uid), { uid, talk2tmId, createdAt: nowIso }));
        await assertSucceeds(
          setDoc(doc(db, 'userProfiles', talk2tmId), {
            talk2tmId,
            uid,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'datingProfiles', uid), {
            uid,
            talk2tmId,
            displayName,
            age: 26,
            gender,
            seeking,
            countryCode: 'AO',
            city: 'Luanda',
            cityKey: 'luanda',
            bio: 'Minimalismo e boas conversas.',
            intent: 'serious',
            adultConfirmed: true,
            termsAcceptedAt: nowIso,
            termsVersion: '2026-11-23',
            discoverable: true,
            paused: false,
            suspended: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        );
      };

      await seedDatingAccount(mDbA, mUidA, mTalkA, 'Alice', 'woman', 'men');
      await seedDatingAccount(mDbB, mUidB, mTalkB, 'Bruno', 'man', 'women');
      await seedDatingAccount(mDbC, mUidC, mTalkC, 'Carla', 'woman', 'all');

      const likeABId = `${mUidA}_${mUidB}`;
      const likeBAId = `${mUidB}_${mUidA}`;

      // 1. A envia Like secreto para B -> C e B não conseguem sondar nem listar Likes recebidos antes de curtir de volta
      await assertFails(
        setDoc(doc(mDbA, 'datingLikes', likeBAId), {
          likeId: likeBAId,
          fromUid: mUidB,
          toUid: mUidA,
          fromTalk2tmId: mTalkB,
          fromDisplayName: 'Bruno',
          createdAt: nowIso,
        })
      );
      const dayKey = nowIso.slice(0, 10);
      const batchLikeAB = writeBatch(mDbA);
      batchLikeAB.set(doc(mDbA, 'userRateLimits', mUidA), {
        uid: mUidA,
        dayKey,
        likeDayKey: dayKey,
        likeCountToday: 1,
        reportDayKey: dayKey,
        reportCountToday: 0,
        inviteDayKey: dayKey,
        inviteCountToday: 0,
        updatedAt: nowIso,
      });
      batchLikeAB.set(doc(mDbA, 'datingLikes', likeABId), {
        likeId: likeABId,
        fromUid: mUidA,
        toUid: mUidB,
        fromTalk2tmId: mTalkA,
        fromDisplayName: 'Alice',
        createdAt: nowIso,
      });
      await assertSucceeds(batchLikeAB.commit());

      // Zero-oracle: B não pode sondar se A já curtiu sem antes criar B->A
      await assertFails(getDoc(doc(mDbB, 'datingLikes', likeABId)));
      await assertFails(getDoc(doc(mDbB, 'datingLikes', `${mUidC}_${mUidB}`)));
      await assertFails(getDoc(doc(mDbC, 'datingLikes', likeABId)));

      // B não pode criar Match falso sem ter dado Like recíproco
      const matchId = `match_${mUidA}_${mUidB}`;
      const convId = `conv_${mUidA}_${mUidB}`;
      await assertFails(
        setDoc(doc(mDbB, 'datingMatches', matchId), {
          matchId,
          participantA: mUidA,
          participantB: mUidB,
          talk2tmIdA: mTalkA,
          talk2tmIdB: mTalkB,
          displayNameA: 'Alice',
          displayNameB: 'Bruno',
          matchedByUid: mUidB,
          conversationId: convId,
          status: 'matched',
          seenByA: false,
          seenByB: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // 2. B curte A de volta -> agora B pode ler o Like recíproco e criar Match + Conversa via writeBatch
      const batchLikeBA = writeBatch(mDbB);
      batchLikeBA.set(doc(mDbB, 'userRateLimits', mUidB), {
        uid: mUidB,
        dayKey,
        likeDayKey: dayKey,
        likeCountToday: 1,
        reportDayKey: dayKey,
        reportCountToday: 0,
        inviteDayKey: dayKey,
        inviteCountToday: 0,
        updatedAt: nowIso,
      });
      batchLikeBA.set(doc(mDbB, 'datingLikes', likeBAId), {
        likeId: likeBAId,
        fromUid: mUidB,
        toUid: mUidA,
        fromTalk2tmId: mTalkB,
        fromDisplayName: 'Bruno',
        createdAt: nowIso,
      });
      await assertSucceeds(batchLikeBA.commit());
      await assertSucceeds(getDoc(doc(mDbB, 'datingLikes', likeABId)));

      const batch = writeBatch(mDbB);
      batch.set(doc(mDbB, 'datingMatches', matchId), {
        matchId,
        participantA: mUidA,
        participantB: mUidB,
        talk2tmIdA: mTalkA,
        talk2tmIdB: mTalkB,
        displayNameA: 'Alice',
        displayNameB: 'Bruno',
        matchedByUid: mUidB,
        conversationId: convId,
        status: 'matched',
        seenByA: false,
        seenByB: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      batch.set(doc(mDbB, 'conversations', convId), {
        conversationId: convId,
        participantA: mUidA,
        participantB: mUidB,
        talk2tmIdA: mTalkA,
        talk2tmIdB: mTalkB,
        displayNameA: 'Alice',
        displayNameB: 'Bruno',
        createdAt: nowIso,
        updatedAt: nowIso,
        lastReadA: null,
        lastReadB: null,
      });
      await assertSucceeds(batch.commit());

      // Terceiro (C) não lê nem Match nem conversa; A e B conseguem trocar mensagem
      await assertFails(getDoc(doc(mDbC, 'datingMatches', matchId)));
      await assertSucceeds(
        setDoc(doc(mDbA, 'conversations', convId, 'messages', 'msg_match_1'), {
          messageId: 'msg_match_1',
          conversationId: convId,
          senderId: mUidA,
          senderTalk2tmId: mTalkA,
          text: 'Olá pelo Match!',
          clientId: 'cli_match_1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      // A marca Match como visto (não pode alterar visto de B)
      await assertFails(updateDoc(doc(mDbA, 'datingMatches', matchId), { seenByB: false, updatedAt: nowIso }));
      await assertSucceeds(updateDoc(doc(mDbA, 'datingMatches', matchId), { seenByA: true, updatedAt: nowIso }));

      // 3. A desfaz o Match -> estado terminal 'unmatched' e bloqueio imediato de novas mensagens/edições na conversa
      await assertSucceeds(
        updateDoc(doc(mDbA, 'datingMatches', matchId), {
          status: 'unmatched',
          unmatchedByUid: mUidA,
          unmatchedAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        updateDoc(doc(mDbB, 'datingMatches', matchId), {
          status: 'matched',
          updatedAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(mDbB, 'conversations', convId, 'messages', 'msg_after_unmatch'), {
          messageId: 'msg_after_unmatch',
          conversationId: convId,
          senderId: mUidB,
          senderTalk2tmId: mTalkB,
          text: 'Mensagem após unmatch',
          clientId: 'cli_match_2',
          createdAt: nowIso,
          status: 'synced',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Cenário 22: Fase 3 — Bloqueio, Denúncias, Rate Limiting & Hard Delete
    // -----------------------------------------------------------------------
    await testCase('22. Fase 3: Bloqueio bilateral, Denúncias com prova congelada, Rate Limiting atômico e Hard Delete em cascata', async () => {
      const f3UidA = 'uid_f3_aaa';
      const f3UidB = 'uid_f3_bbb';
      const f3UidC = 'uid_f3_ccc';
      const f3TalkA = 'TM-F3AA-1111';
      const f3TalkB = 'TM-F3BB-2222';
      const f3TalkC = 'TM-F3CC-3333';
      const f3PhoneA = 'a1'.repeat(32);
      const f3PhoneB = 'b2'.repeat(32);
      const f3PhoneC = 'c3'.repeat(32);
      const f3DayKey = nowIso.slice(0, 10);

      const f3DbA = testEnv.authenticatedContext(f3UidA, { email: 'f3_a@talk2tm.internal' }).firestore();
      const f3DbB = testEnv.authenticatedContext(f3UidB, { email: 'f3_b@talk2tm.internal' }).firestore();
      const f3DbC = testEnv.authenticatedContext(f3UidC, { email: 'f3_c@talk2tm.internal' }).firestore();

      const seedF3 = async (
        db: typeof f3DbA,
        uid: string,
        talk2tmId: string,
        displayName: string,
        phoneHash: string,
        gender: 'woman' | 'man'
      ) => {
        await assertSucceeds(
          setDoc(doc(db, 'users', uid), {
            uid,
            talk2tmId,
            phoneHash,
            phoneMasked: '+244 ••• 999',
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'userProfiles', talk2tmId), {
            talk2tmId,
            uid,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'phoneLookup', phoneHash), {
            phoneHash,
            uid,
            talk2tmId,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'datingProfiles', uid), {
            uid,
            talk2tmId,
            displayName,
            age: 27,
            gender,
            seeking: 'all',
            countryCode: 'AO',
            city: 'Luanda',
            cityKey: 'luanda',
            bio: 'Perfil Fase 3 seguro.',
            intent: 'chat',
            adultConfirmed: true,
            termsAcceptedAt: nowIso,
            termsVersion: '2026-11-23',
            discoverable: true,
            paused: false,
            suspended: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        );
      };

      await seedF3(f3DbA, f3UidA, f3TalkA, 'F3Ana', f3PhoneA, 'woman');
      await seedF3(f3DbB, f3UidB, f3TalkB, 'F3Bruno', f3PhoneB, 'man');
      await seedF3(f3DbC, f3UidC, f3TalkC, 'F3Carla', f3PhoneC, 'woman');

      // Conversa bilateral A <-> B via convite aceite
      const f3ConvAB = `conv_${f3UidA}_${f3UidB}`;
      await assertSucceeds(
        setDoc(doc(f3DbA, 'conversationInvites', f3ConvAB), {
          inviteId: f3ConvAB,
          fromUid: f3UidA,
          fromDisplayName: 'F3Ana',
          fromTalk2tmId: f3TalkA,
          toTalk2tmId: f3TalkB,
          toUid: f3UidB,
          conversationId: f3ConvAB,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertSucceeds(
        updateDoc(doc(f3DbB, 'conversationInvites', f3ConvAB), { status: 'accepted', updatedAt: nowIso })
      );
      await assertSucceeds(
        setDoc(doc(f3DbA, 'conversations', f3ConvAB), {
          conversationId: f3ConvAB,
          participantA: f3UidA,
          participantB: f3UidB,
          talk2tmIdA: f3TalkA,
          talk2tmIdB: f3TalkB,
          displayNameA: 'F3Ana',
          displayNameB: 'F3Bruno',
          createdAt: nowIso,
          updatedAt: nowIso,
          lastReadA: null,
          lastReadB: null,
        })
      );
      await assertSucceeds(
        setDoc(doc(f3DbA, 'conversations', f3ConvAB, 'messages', 'msg_f3_1'), {
          messageId: 'msg_f3_1',
          conversationId: f3ConvAB,
          senderId: f3UidA,
          senderTalk2tmId: f3TalkA,
          text: 'Olá antes do bloqueio',
          clientId: 'cli_f3_1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      // Avaliação de A sobre C (para validar deleção em cascata depois)
      await assertSucceeds(
        setDoc(doc(f3DbA, 'datingProfiles', f3UidA, 'evaluations', f3UidC), {
          targetUid: f3UidC,
          decision: 'pass',
          createdAt: nowIso,
          dayKey: f3DayKey,
        })
      );

      // 1. Bloqueio de utilizadores (userBlocks)
      const blockABId = `${f3UidA}_${f3UidB}`;
      await assertFails(
        setDoc(doc(f3DbA, 'userBlocks', `${f3UidA}_${f3UidA}`), {
          blockId: `${f3UidA}_${f3UidA}`,
          blockerUid: f3UidA,
          blockedUid: f3UidA,
          createdAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(f3DbB, 'userBlocks', blockABId), {
          blockId: blockABId,
          blockerUid: f3UidA,
          blockedUid: f3UidB,
          createdAt: nowIso,
        })
      );
      await assertSucceeds(
        setDoc(doc(f3DbA, 'userBlocks', blockABId), {
          blockId: blockABId,
          blockerUid: f3UidA,
          blockedUid: f3UidB,
          blockerTalk2tmId: f3TalkA,
          reason: 'spam',
          createdAt: nowIso,
        })
      );
      await assertFails(getDoc(doc(f3DbC, 'userBlocks', blockABId)));
      await assertFails(getDoc(doc(dbUnauth, 'userBlocks', blockABId)));

      // Após bloqueio, B não consegue enviar mensagens nem actualizar leitura em convAB, nem enviar like ou convite para A
      await assertFails(
        setDoc(doc(f3DbB, 'conversations', f3ConvAB, 'messages', 'msg_f3_blocked'), {
          messageId: 'msg_f3_blocked',
          conversationId: f3ConvAB,
          senderId: f3UidB,
          senderTalk2tmId: f3TalkB,
          text: 'Mensagem bloqueada',
          clientId: 'cli_f3_blocked',
          createdAt: nowIso,
          status: 'synced',
        })
      );
      await assertFails(
        updateDoc(doc(f3DbB, 'conversations', f3ConvAB), { lastReadB: nowIso, updatedAt: nowIso })
      );
      const batchBlockedLike = writeBatch(f3DbB);
      batchBlockedLike.set(doc(f3DbB, 'userRateLimits', f3UidB), {
        uid: f3UidB,
        dayKey: f3DayKey,
        likeDayKey: f3DayKey,
        likeCountToday: 1,
        reportDayKey: f3DayKey,
        reportCountToday: 0,
        inviteDayKey: f3DayKey,
        inviteCountToday: 0,
        updatedAt: nowIso,
      });
      batchBlockedLike.set(doc(f3DbB, 'datingLikes', `${f3UidB}_${f3UidA}`), {
        likeId: `${f3UidB}_${f3UidA}`,
        fromUid: f3UidB,
        toUid: f3UidA,
        fromTalk2tmId: f3TalkB,
        fromDisplayName: 'F3Bruno',
        createdAt: nowIso,
      });
      await assertFails(batchBlockedLike.commit());

      // Bloqueio B -> C também impede C de criar novo convite para B
      await assertSucceeds(
        setDoc(doc(f3DbB, 'userBlocks', `${f3UidB}_${f3UidC}`), {
          blockId: `${f3UidB}_${f3UidC}`,
          blockerUid: f3UidB,
          blockedUid: f3UidC,
          createdAt: nowIso,
        })
      );
      const f3ConvBC = `conv_${f3UidB}_${f3UidC}`;
      await assertFails(
        setDoc(doc(f3DbC, 'conversationInvites', f3ConvBC), {
          inviteId: f3ConvBC,
          fromUid: f3UidC,
          fromDisplayName: 'F3Carla',
          fromTalk2tmId: f3TalkC,
          toTalk2tmId: f3TalkB,
          toUid: f3UidB,
          conversationId: f3ConvBC,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // 2. Sistema de Denúncias (moderationReports) + Rate Limit Atômico
      const repId = `rep_${f3UidA}_1`;
      // Sem incremento atômico de userRateLimits, deve falhar
      await assertFails(
        setDoc(doc(f3DbA, 'moderationReports', repId), {
          reportId: repId,
          reporterUid: f3UidA,
          reporterTalk2tmId: f3TalkA,
          targetUid: f3UidB,
          targetTalk2tmId: f3TalkB,
          targetDisplayName: 'F3Bruno',
          sourceType: 'chat_message',
          channelId: f3ConvAB,
          reason: 'harassment',
          evidenceSnapshot: 'Mensagem ofensiva congelada',
          status: 'pending',
          createdAt: nowIso,
        })
      );

      // Com batch atômico em userRateLimits, deve ter sucesso
      const batchReport = writeBatch(f3DbA);
      batchReport.set(doc(f3DbA, 'userRateLimits', f3UidA), {
        uid: f3UidA,
        dayKey: f3DayKey,
        likeDayKey: f3DayKey,
        likeCountToday: 0,
        reportDayKey: f3DayKey,
        reportCountToday: 1,
        inviteDayKey: f3DayKey,
        inviteCountToday: 0,
        lastReportAtMs: Date.now(),
        updatedAt: nowIso,
      });
      batchReport.set(doc(f3DbA, 'moderationReports', repId), {
        reportId: repId,
        reporterUid: f3UidA,
        reporterTalk2tmId: f3TalkA,
        targetUid: f3UidB,
        targetTalk2tmId: f3TalkB,
        targetDisplayName: 'F3Bruno',
        sourceType: 'chat_message',
        channelId: f3ConvAB,
        reason: 'harassment',
        evidenceSnapshot: 'Mensagem ofensiva congelada',
        status: 'pending',
        createdAt: nowIso,
      });
      await assertSucceeds(batchReport.commit());

      // B (alvo), C (terceiro) e Admin não verificado não leem nem listam denúncias; denunciante não altera status
      await assertFails(getDoc(doc(f3DbB, 'moderationReports', repId)));
      await assertFails(getDoc(doc(f3DbC, 'moderationReports', repId)));
      await assertFails(getDoc(doc(dbAdminUnverified, 'moderationReports', repId)));
      await assertFails(getDocs(query(collection(f3DbB, 'moderationReports'), limit(10))));
      await assertFails(updateDoc(doc(f3DbA, 'moderationReports', repId), { status: 'resolved' }));

      // Admin verificado lista, lê, resolve denúncia (sem alterar prova congelada) e suspende alvo
      const adminReportsSnap = await assertSucceeds(
        getDocs(query(collection(dbAdmin, 'moderationReports'), where('status', '==', 'pending'), orderBy('createdAt', 'desc'), limit(10)))
      );
      assert(adminReportsSnap.size >= 1, 'Admin deve conseguir listar denúncias pendentes');
      await assertFails(
        updateDoc(doc(dbAdmin, 'moderationReports', repId), {
          evidenceSnapshot: 'Adulterado',
          status: 'resolved',
        })
      );
      await assertSucceeds(
        updateDoc(doc(dbAdmin, 'moderationReports', repId), {
          status: 'resolved',
          reviewedAt: nowIso,
          reviewedByUid: 'uid_admin_master_vitronis',
          resolutionAction: 'account_suspended',
        })
      );
      const batchSuspendB = writeBatch(dbAdmin);
      batchSuspendB.update(doc(dbAdmin, 'userProfiles', f3TalkB), { active: false });
      batchSuspendB.update(doc(dbAdmin, 'phoneLookup', f3PhoneB), { active: false });
      batchSuspendB.update(doc(dbAdmin, 'datingProfiles', f3UidB), { suspended: true, updatedAt: nowIso });
      await assertSucceeds(batchSuspendB.commit());

      // 3. Rate Limiting (limites diários máximos e monotonicidade)
      await assertFails(
        setDoc(doc(f3DbC, 'userRateLimits', f3UidC), {
          uid: f3UidC,
          dayKey: f3DayKey,
          likeDayKey: f3DayKey,
          likeCountToday: 6,
          reportDayKey: f3DayKey,
          reportCountToday: 0,
          inviteDayKey: f3DayKey,
          inviteCountToday: 0,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        updateDoc(doc(f3DbA, 'userRateLimits', f3UidA), {
          reportCountToday: 0,
          updatedAt: nowIso,
        })
      );

      // Likes válidos até o limite de 5/dia (criando um like de A para C)
      const batchLikeAC = writeBatch(f3DbA);
      batchLikeAC.set(doc(f3DbA, 'userRateLimits', f3UidA), {
        uid: f3UidA,
        dayKey: f3DayKey,
        likeDayKey: f3DayKey,
        likeCountToday: 1,
        reportDayKey: f3DayKey,
        reportCountToday: 1,
        inviteDayKey: f3DayKey,
        inviteCountToday: 0,
        updatedAt: nowIso,
      });
      batchLikeAC.set(doc(f3DbA, 'datingLikes', `${f3UidA}_${f3UidC}`), {
        likeId: `${f3UidA}_${f3UidC}`,
        fromUid: f3UidA,
        toUid: f3UidC,
        fromTalk2tmId: f3TalkA,
        fromDisplayName: 'F3Ana',
        createdAt: nowIso,
      });
      await assertSucceeds(batchLikeAC.commit());

      // 4. Hard Delete em Cascata (bloqueado antes de 'deleting', protegido para legado, permitido durante 'deleting')
      await assertFails(deleteDoc(doc(f3DbA, 'datingProfiles', f3UidA)));
      await assertFails(deleteDoc(doc(f3DbA, 'conversations', f3ConvAB)));
      await assertFails(
        updateDoc(doc(dbTruman, 'users', 'uid_truman_852456'), {
          accountStatus: 'deleting',
          deletionRequestedAt: nowIso,
        })
      );
      await assertFails(deleteDoc(doc(dbTruman, 'users', 'uid_truman_852456')));
      await assertFails(
        updateDoc(doc(f3DbA, 'users', f3UidA), {
          accountStatus: 'hacked',
          deletionRequestedAt: nowIso,
        })
      );

      // Marca conta A como 'deleting' e executa cascata completa
      await assertSucceeds(
        updateDoc(doc(f3DbA, 'users', f3UidA), {
          accountStatus: 'deleting',
          deletionRequestedAt: nowIso,
        })
      );
      const cascadeBatch = writeBatch(f3DbA);
      cascadeBatch.delete(doc(f3DbA, 'datingProfiles', f3UidA, 'evaluations', f3UidC));
      cascadeBatch.delete(doc(f3DbA, 'userBlocks', blockABId));
      cascadeBatch.delete(doc(f3DbA, 'datingLikes', `${f3UidA}_${f3UidC}`));
      cascadeBatch.delete(doc(f3DbA, 'conversations', f3ConvAB, 'messages', 'msg_f3_1'));
      cascadeBatch.delete(doc(f3DbA, 'conversations', f3ConvAB));
      cascadeBatch.delete(doc(f3DbA, 'conversationInvites', f3ConvAB));
      await assertSucceeds(cascadeBatch.commit());

      const finalRootBatch = writeBatch(f3DbA);
      finalRootBatch.delete(doc(f3DbA, 'userRateLimits', f3UidA));
      finalRootBatch.delete(doc(f3DbA, 'datingProfiles', f3UidA));
      finalRootBatch.delete(doc(f3DbA, 'phoneLookup', f3PhoneA));
      finalRootBatch.delete(doc(f3DbA, 'userProfiles', f3TalkA));
      finalRootBatch.delete(doc(f3DbA, 'users', f3UidA));
      await assertSucceeds(finalRootBatch.commit());

      const deletedUserSnap = await assertSucceeds(getDoc(doc(dbAdmin, 'users', f3UidA)));
      assert(!deletedUserSnap.exists(), 'Documento raiz users/{uid} deve desaparecer após Hard Delete');
    });

    // -----------------------------------------------------------------------
    // Cenário 23: Fase 4 — Foto Opcional WebP, Moderação Admin, Referral & Atribuição
    // -----------------------------------------------------------------------
    await testCase('23. Fase 4: Foto WebP, fila de moderação Admin, referralLinks e referralAttributions', async () => {
      const f4UidA = 'uid_f4_ana';
      const f4UidB = 'uid_f4_bruno';
      const f4TalkA = 'TM-F4AA-1001';
      const f4TalkB = 'TM-F4BB-2002';
      const f4PhoneA = 'e1'.repeat(32);
      const f4PhoneB = 'f2'.repeat(32);
      const f4DbA = testEnv.authenticatedContext(f4UidA, { email: 'f4_a@talk2tm.internal' }).firestore();
      const f4DbB = testEnv.authenticatedContext(f4UidB, { email: 'f4_b@talk2tm.internal' }).firestore();
      const dbUnauth = testEnv.unauthenticatedContext().firestore();

      const seedF4 = async (
        db: typeof f4DbA,
        uid: string,
        talk2tmId: string,
        displayName: string,
        phoneHash: string,
        gender: 'woman' | 'man'
      ) => {
        await assertSucceeds(
          setDoc(doc(db, 'users', uid), {
            uid,
            talk2tmId,
            phoneHash,
            phoneMasked: '+244 ••• 000',
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'userProfiles', talk2tmId), {
            talk2tmId,
            uid,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'phoneLookup', phoneHash), {
            phoneHash,
            uid,
            talk2tmId,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'datingProfiles', uid), {
            uid,
            talk2tmId,
            displayName,
            age: 26,
            gender,
            seeking: 'all',
            countryCode: 'AO',
            city: 'Luanda',
            cityKey: 'luanda',
            bio: 'Perfil Fase 4.',
            intent: 'serious',
            adultConfirmed: true,
            termsAcceptedAt: nowIso,
            termsVersion: 'dating-v1',
            discoverable: true,
            paused: false,
            suspended: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        );
      };

      await seedF4(f4DbA, f4UidA, f4TalkA, 'F4Ana', f4PhoneA, 'woman');
      await seedF4(f4DbB, f4UidB, f4TalkB, 'F4Bruno', f4PhoneB, 'man');

      const validPhotoUrl = `https://firebasestorage.googleapis.com/v0/b/gen-lang-client-0618196986.appspot.com/o/datingPhotos%2F${f4UidA}%2Favatar.webp?alt=media`;
      const validPhotoPath = `datingPhotos/${f4UidA}/avatar.webp`;

      // 1. Dono não pode auto-aprovar sua fotografia nem apontar photoPath de outro utilizador
      await assertFails(
        updateDoc(doc(f4DbA, 'datingProfiles', f4UidA), {
          photoUrl: validPhotoUrl,
          photoPath: validPhotoPath,
          photoStatus: 'approved',
          photoUpdatedAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        updateDoc(doc(f4DbA, 'datingProfiles', f4UidA), {
          photoUrl: validPhotoUrl,
          photoPath: `datingPhotos/${f4UidB}/avatar.webp`,
          photoStatus: 'pending',
          photoUpdatedAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Dono submete foto como 'pending'
      await assertSucceeds(
        updateDoc(doc(f4DbA, 'datingProfiles', f4UidA), {
          photoUrl: validPhotoUrl,
          photoPath: validPhotoPath,
          photoStatus: 'pending',
          photoUpdatedAt: nowIso,
          photoModerationNote: null,
          updatedAt: nowIso,
        })
      );

      // Admin não verificado e outro utilizador não podem moderar foto
      await assertFails(
        updateDoc(doc(dbAdminUnverified, 'datingProfiles', f4UidA), {
          photoStatus: 'approved',
          updatedAt: nowIso,
        })
      );
      await assertFails(
        updateDoc(doc(f4DbB, 'datingProfiles', f4UidA), {
          photoStatus: 'approved',
          updatedAt: nowIso,
        })
      );

      // Admin verificado aprova fotografia
      await assertSucceeds(
        updateDoc(doc(dbAdmin, 'datingProfiles', f4UidA), {
          photoStatus: 'approved',
          photoModerationNote: null,
          photoUpdatedAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Após aprovada, o dono ainda consegue atualizar sua biografia sem perder validação
      await assertSucceeds(
        updateDoc(doc(f4DbA, 'datingProfiles', f4UidA), {
          bio: 'Biografia atualizada com foto já aprovada.',
          updatedAt: nowIso,
        })
      );

      // Admin pode rejeitar e limpar URL/Path da foto
      await assertSucceeds(
        updateDoc(doc(dbAdmin, 'datingProfiles', f4UidA), {
          photoStatus: 'rejected',
          photoUrl: null,
          photoPath: null,
          photoModerationNote: 'Foto rejeitada pela moderação.',
          photoUpdatedAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // 2. ReferralLinks: get público por código sem enumeração (list bloqueada a visitantes/utilizadores)
      const refCodeA = 'TMF4A999';
      await assertSucceeds(
        setDoc(doc(f4DbA, 'referralLinks', refCodeA), {
          code: refCodeA,
          referrerUid: f4UidA,
          referrerDisplayName: 'F4Ana',
          active: true,
          createdAt: nowIso,
        })
      );
      await assertSucceeds(getDoc(doc(dbUnauth, 'referralLinks', refCodeA)));
      await assertFails(getDocs(query(collection(dbUnauth, 'referralLinks'), limit(10))));
      await assertFails(getDocs(query(collection(f4DbB, 'referralLinks'), limit(10))));

      // 3. ReferralStats: contador privado e monotónico por utilizador
      await assertSucceeds(
        setDoc(doc(f4DbA, 'referralStats', f4UidA), {
          uid: f4UidA,
          referralCode: refCodeA,
          invitesSharedCount: 2,
          updatedAt: nowIso,
        })
      );
      await assertFails(getDoc(doc(f4DbB, 'referralStats', f4UidA)));
      await assertFails(
        updateDoc(doc(f4DbA, 'referralStats', f4UidA), {
          invitesSharedCount: 1,
          updatedAt: nowIso,
        })
      );
      await assertSucceeds(
        updateDoc(doc(f4DbA, 'referralStats', f4UidA), {
          invitesSharedCount: 3,
          updatedAt: nowIso,
        })
      );

      // 4. ReferralAttributions: anti auto-indicação, imutável e vinculado a referralLinks válido
      await assertFails(
        setDoc(doc(f4DbA, 'referralAttributions', f4UidA), {
          newUid: f4UidA,
          newTalk2tmId: f4TalkA,
          referralCode: refCodeA,
          referrerUid: f4UidA,
          createdAt: nowIso,
        })
      );
      await assertSucceeds(
        setDoc(doc(f4DbB, 'referralAttributions', f4UidB), {
          newUid: f4UidB,
          newTalk2tmId: f4TalkB,
          referralCode: refCodeA,
          referrerUid: f4UidA,
          createdAt: nowIso,
        })
      );
      await assertFails(
        updateDoc(doc(f4DbB, 'referralAttributions', f4UidB), {
          referralCode: 'TMOTHER1',
        })
      );
      // Padrinho A consegue ler sua conversão
      const attrListA = await assertSucceeds(
        getDocs(query(collection(f4DbA, 'referralAttributions'), where('referrerUid', '==', f4UidA), limit(10)))
      );
      assert(attrListA.size === 1, 'Padrinho deve listar sua própria atribuição convertida');

      // 5. Hard Delete apaga referralLinks, referralStats e referralAttributions durante 'deleting'
      await assertFails(deleteDoc(doc(f4DbA, 'referralStats', f4UidA)));
      await assertSucceeds(
        updateDoc(doc(f4DbA, 'users', f4UidA), {
          accountStatus: 'deleting',
          deletionRequestedAt: nowIso,
        })
      );
      await assertSucceeds(deleteDoc(doc(f4DbA, 'referralLinks', refCodeA)));
      await assertSucceeds(deleteDoc(doc(f4DbA, 'referralStats', f4UidA)));

      await assertSucceeds(
        updateDoc(doc(f4DbB, 'users', f4UidB), {
          accountStatus: 'deleting',
          deletionRequestedAt: nowIso,
        })
      );
      await assertSucceeds(deleteDoc(doc(f4DbB, 'referralAttributions', f4UidB)));
    });

    // -----------------------------------------------------------------------
    // Cenário 24: Fase 5 — Telemetria WAU (growthTelemetry), chatStarted & Métricas Admin
    // -----------------------------------------------------------------------
    await testCase('24. Fase 5: growthTelemetry WAU/cidade, transição chatStarted única e leitura Admin', async () => {
      const f5UidA = 'uid_f5_alice';
      const f5UidB = 'uid_f5_bruno';
      const f5TalkA = 'TM-F5AA-1001';
      const f5TalkB = 'TM-F5BB-2002';
      const f5PhoneA = '5a'.repeat(32);
      const f5PhoneB = '5b'.repeat(32);
      const f5DbA = testEnv.authenticatedContext(f5UidA, { email: 'f5_a@talk2tm.internal' }).firestore();
      const f5DbB = testEnv.authenticatedContext(f5UidB, { email: 'f5_b@talk2tm.internal' }).firestore();

      const seedF5User = async (
        db: typeof f5DbA,
        uid: string,
        talk2tmId: string,
        displayName: string,
        phoneHash: string,
        gender: 'woman' | 'man'
      ) => {
        await assertSucceeds(
          setDoc(doc(db, 'users', uid), {
            uid,
            talk2tmId,
            phoneHash,
            phoneMasked: '+244 ••• 000',
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'userProfiles', talk2tmId), {
            talk2tmId,
            uid,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'phoneLookup', phoneHash), {
            phoneHash,
            uid,
            talk2tmId,
            displayName,
            active: true,
            createdAt: nowIso,
          })
        );
        await assertSucceeds(
          setDoc(doc(db, 'datingProfiles', uid), {
            uid,
            talk2tmId,
            displayName,
            age: 27,
            gender,
            seeking: 'all',
            countryCode: 'AO',
            city: 'Luanda',
            cityKey: 'luanda',
            bio: 'Perfil Fase 5.',
            intent: 'serious',
            adultConfirmed: true,
            termsAcceptedAt: nowIso,
            termsVersion: 'dating-v1',
            discoverable: true,
            paused: false,
            suspended: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        );
      };

      await seedF5User(f5DbA, f5UidA, f5TalkA, 'F5Alice', f5PhoneA, 'woman');
      await seedF5User(f5DbB, f5UidB, f5TalkB, 'F5Bruno', f5PhoneB, 'man');

      // 1. growthTelemetry/{uid}: escrita pelo próprio utilizador, listagem exclusiva do Admin
      await assertSucceeds(
        setDoc(doc(f5DbA, 'growthTelemetry', f5UidA), {
          uid: f5UidA,
          lastActiveAt: nowIso,
          lastActiveDay: '2026-11-26',
          city: 'Luanda',
          cityKey: 'luanda',
          countryCode: 'AO',
          updatedAt: nowIso,
        })
      );
      await assertFails(
        setDoc(doc(f5DbB, 'growthTelemetry', f5UidA), {
          uid: f5UidA,
          lastActiveAt: nowIso,
          lastActiveDay: '2026-11-26',
          updatedAt: nowIso,
        })
      );
      await assertFails(getDoc(doc(f5DbB, 'growthTelemetry', f5UidA)));
      await assertFails(getDocs(query(collection(f5DbB, 'growthTelemetry'), limit(10))));

      // Admin verificado consegue consultar growthTelemetry, datingMatches e referralStats para KPIs
      await assertSucceeds(getDoc(doc(dbAdmin, 'growthTelemetry', f5UidA)));
      await assertSucceeds(getDocs(query(collection(dbAdmin, 'growthTelemetry'), limit(10))));
      await assertFails(getDocs(query(collection(dbAdminUnverified, 'growthTelemetry'), limit(10))));

      // 2. datingMatches: criação do Match + transição única chatStarted: true pelo participante
      const likeABBatch = writeBatch(f5DbA);
      likeABBatch.set(doc(f5DbA, 'userRateLimits', f5UidA), {
        uid: f5UidA,
        likeDayKey: '2026-11-26',
        likeCountToday: 1,
        reportDayKey: '2026-11-26',
        reportCountToday: 0,
        inviteDayKey: '2026-11-26',
        inviteCountToday: 0,
        updatedAt: nowIso,
      });
      likeABBatch.set(doc(f5DbA, 'datingLikes', `${f5UidA}_${f5UidB}`), {
        likeId: `${f5UidA}_${f5UidB}`,
        fromUid: f5UidA,
        toUid: f5UidB,
        fromTalk2tmId: f5TalkA,
        fromDisplayName: 'F5Alice',
        createdAt: nowIso,
      });
      await assertSucceeds(likeABBatch.commit());

      const matchId5 = `match_${f5UidA}_${f5UidB}`;
      const convId5 = `conv_${f5UidA}_${f5UidB}`;
      const matchBatch = writeBatch(f5DbB);
      matchBatch.set(doc(f5DbB, 'userRateLimits', f5UidB), {
        uid: f5UidB,
        likeDayKey: '2026-11-26',
        likeCountToday: 1,
        reportDayKey: '2026-11-26',
        reportCountToday: 0,
        inviteDayKey: '2026-11-26',
        inviteCountToday: 0,
        updatedAt: nowIso,
      });
      matchBatch.set(doc(f5DbB, 'datingLikes', `${f5UidB}_${f5UidA}`), {
        likeId: `${f5UidB}_${f5UidA}`,
        fromUid: f5UidB,
        toUid: f5UidA,
        fromTalk2tmId: f5TalkB,
        fromDisplayName: 'F5Bruno',
        createdAt: nowIso,
      });
      matchBatch.set(doc(f5DbB, 'datingMatches', matchId5), {
        matchId: matchId5,
        conversationId: convId5,
        participantA: f5UidA,
        participantB: f5UidB,
        talk2tmIdA: f5TalkA,
        talk2tmIdB: f5TalkB,
        displayNameA: 'F5Alice',
        displayNameB: 'F5Bruno',
        matchedByUid: f5UidB,
        status: 'matched',
        seenByA: false,
        seenByB: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await assertSucceeds(matchBatch.commit());

      // Participante marca chatStarted = true pela primeira vez
      await assertSucceeds(
        updateDoc(doc(f5DbA, 'datingMatches', matchId5), {
          chatStarted: true,
          chatStartedAt: nowIso,
          updatedAt: nowIso,
        })
      );
      // Não é possível reverter chatStarted para false nem sobrescrever novamente
      await assertFails(
        updateDoc(doc(f5DbB, 'datingMatches', matchId5), {
          chatStarted: false,
          chatStartedAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await assertFails(
        updateDoc(doc(f5DbB, 'datingMatches', matchId5), {
          chatStarted: true,
          chatStartedAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Admin consegue listar datingMatches e referralStats; utilizador comum não consegue listar todos
      await assertSucceeds(getDocs(query(collection(dbAdmin, 'datingMatches'), limit(10))));
      await assertSucceeds(getDocs(query(collection(dbAdmin, 'referralStats'), limit(10))));
      await assertFails(getDocs(query(collection(f5DbA, 'referralStats'), limit(10))));

      // 3. Hard Delete apaga growthTelemetry/{uid} apenas quando accountStatus == 'deleting'
      await assertFails(deleteDoc(doc(f5DbA, 'growthTelemetry', f5UidA)));
      await assertSucceeds(
        updateDoc(doc(f5DbA, 'users', f5UidA), {
          accountStatus: 'deleting',
          deletionRequestedAt: nowIso,
        })
      );
      await assertSucceeds(deleteDoc(doc(f5DbA, 'growthTelemetry', f5UidA)));
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
