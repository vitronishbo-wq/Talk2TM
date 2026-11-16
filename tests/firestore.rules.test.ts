/**
 * Talk2TM — Testes de Autorização do Firestore (Firebase Emulator Suite)
 *
 * Valida diretamente as regras em `firestore.rules` cobrindo:
 * 1. Utilizador A consegue aceder à sua conversa com B.
 * 2. Utilizador C não consegue ler mensagens de A e B.
 * 3. Utilizador não consegue alterar participantes de uma conversa.
 * 4. Utilizador não consegue ler convites destinados a terceiros.
 * 5. Utilizador não consegue falsificar o remetente de mensagens.
 * 6. Truman e Mãezinha continuam a comunicar normalmente.
 * 7. Novo utilizador consegue criar e restaurar a sua identidade.
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
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
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
    const talkIdA = 'TM-AAAA-2222';
    const talkIdB = 'TM-BBBB-3333';
    const talkIdC = 'TM-CCCC-4444';
    const convId = `conv_${uidA}_${uidB}`; // uidA < uidB lexicograficamente
    const nowIso = new Date().toISOString();

    const ctxA = testEnv.authenticatedContext(uidA, { email: 'tm_aaaa@talk2tm.internal' });
    const ctxB = testEnv.authenticatedContext(uidB, { email: 'tm_bbbb@talk2tm.internal' });
    const ctxC = testEnv.authenticatedContext(uidC, { email: 'tm_cccc@talk2tm.internal' });
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
    const dbTruman = ctxTruman.firestore();
    const dbMaezinha = ctxMaezinha.firestore();
    const dbUnauth = unauth.firestore();

    // -----------------------------------------------------------------------
    // Caso 7: Novo utilizador consegue criar e restaurar a sua identidade
    // -----------------------------------------------------------------------
    await testCase('7. Novo utilizador cria e restaura identidade própria sem aceder a terceiros', async () => {
      await assertSucceeds(
        setDoc(doc(dbA, 'users', uidA), { uid: uidA, talk2tmId: talkIdA, createdAt: nowIso })
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

      await assertSucceeds(
        setDoc(doc(dbB, 'users', uidB), { uid: uidB, talk2tmId: talkIdB, createdAt: nowIso })
      );
      await assertSucceeds(
        setDoc(doc(dbB, 'userProfiles', talkIdB), {
          talk2tmId: talkIdB,
          uid: uidB,
          displayName: 'Conta B',
          active: true,
          createdAt: nowIso,
        })
      );

      await assertSucceeds(
        setDoc(doc(dbC, 'users', uidC), { uid: uidC, talk2tmId: talkIdC, createdAt: nowIso })
      );
      await assertSucceeds(
        setDoc(doc(dbC, 'userProfiles', talkIdC), {
          talk2tmId: talkIdC,
          uid: uidC,
          displayName: 'Conta C',
          active: true,
          createdAt: nowIso,
        })
      );

      // Restauração da própria identidade
      const snapUserA = await assertSucceeds(getDoc(doc(dbA, 'users', uidA)));
      const snapProfA = await assertSucceeds(getDoc(doc(dbA, 'userProfiles', talkIdA)));
      assert(snapUserA.exists() && snapUserA.data().talk2tmId === talkIdA, 'Conta A deve restaurar users/{uid}');
      assert(snapProfA.exists() && snapProfA.data().uid === uidA, 'Conta A deve restaurar userProfiles/{id}');

      // Isolamento de PII privada em users/{uid}
      await assertFails(getDoc(doc(dbC, 'users', uidA)));
      await assertFails(
        setDoc(doc(dbC, 'users', uidA), { uid: uidA, talk2tmId: talkIdC, createdAt: nowIso })
      );
      await assertFails(getDoc(doc(dbUnauth, 'users', uidA)));
    });

    // -----------------------------------------------------------------------
    // Caso 4: Utilizador não consegue ler convites destinados a terceiros
    // -----------------------------------------------------------------------
    await testCase('4. Convites são privados entre remetente e destinatário; terceiros são bloqueados', async () => {
      // Bloqueia convite sem toUid (toUid nulo/vazio)
      await assertFails(
        setDoc(doc(dbA, 'conversationInvites', convId), {
          inviteId: convId,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdB,
          toUid: null,
          conversationId: convId,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // Envio legítimo de convite A -> B
      await assertSucceeds(
        setDoc(doc(dbA, 'conversationInvites', convId), {
          inviteId: convId,
          fromUid: uidA,
          fromDisplayName: 'Conta A',
          fromTalk2tmId: talkIdA,
          toTalk2tmId: talkIdB,
          toUid: uidB,
          conversationId: convId,
          status: 'pending',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );

      // C não consegue ler o convite de A -> B (nem getDoc nem list/where)
      await assertFails(getDoc(doc(dbC, 'conversationInvites', convId)));
      await assertFails(getDocs(collection(dbC, 'conversationInvites')));
      await assertFails(
        getDocs(query(collection(dbC, 'conversationInvites'), where('toUid', '==', uidB)))
      );
      await assertFails(
        updateDoc(doc(dbC, 'conversationInvites', convId), { status: 'accepted', updatedAt: nowIso })
      );

      // Conversa NÃO pode ser criada antes de o convite ser aceito
      await assertFails(
        setDoc(doc(dbA, 'conversations', convId), {
          conversationId: convId,
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

      // B lê seu convite e aceita
      await assertSucceeds(
        getDocs(query(collection(dbB, 'conversationInvites'), where('toUid', '==', uidB)))
      );
      await assertSucceeds(
        updateDoc(doc(dbB, 'conversationInvites', convId), {
          status: 'accepted',
          updatedAt: new Date().toISOString(),
        })
      );
    });

    // -----------------------------------------------------------------------
    // Caso 1: Utilizador A consegue aceder à sua conversa com B
    // -----------------------------------------------------------------------
    await testCase('1. Utilizador A cria/acede à conversa bilateral com B e troca mensagens', async () => {
      // Criação legítima da conversa bilateral após convite aceito
      await assertSucceeds(
        setDoc(doc(dbB, 'conversations', convId), {
          conversationId: convId,
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

      const convSnap = await assertSucceeds(getDoc(doc(dbA, 'conversations', convId)));
      assert(convSnap.exists() && convSnap.data().participantB === uidB, 'A deve ler conversa bilateral com B');

      await assertSucceeds(
        getDocs(query(collection(dbA, 'conversations'), where('participantA', '==', uidA)))
      );

      const msgIdA = `${convId}_cli_msgA_1`;
      await assertSucceeds(
        setDoc(doc(dbA, 'conversations', convId, 'messages', msgIdA), {
          messageId: msgIdA,
          conversationId: convId,
          senderId: uidA,
          senderTalk2tmId: talkIdA,
          text: 'Olá B, tudo seguro?',
          clientId: 'cli_msgA_1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      const msgsB = await assertSucceeds(getDocs(collection(dbB, 'conversations', convId, 'messages')));
      assert(msgsB.size === 1, 'B deve ler a mensagem de A');

      // A atualiza apenas seu próprio lastReadA
      await assertSucceeds(
        updateDoc(doc(dbA, 'conversations', convId), {
          lastReadA: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      );
    });

    // -----------------------------------------------------------------------
    // Caso 2: Utilizador C não consegue ler mensagens de A e B
    // -----------------------------------------------------------------------
    await testCase('2. Utilizador C (terceiro) é bloqueado de ler conversa ou mensagens de A e B', async () => {
      const msgIdA = `${convId}_cli_msgA_1`;
      await assertFails(getDoc(doc(dbC, 'conversations', convId)));
      await assertFails(getDoc(doc(dbC, 'conversations', convId, 'messages', msgIdA)));
      await assertFails(getDocs(collection(dbC, 'conversations', convId, 'messages')));
      await assertFails(
        setDoc(doc(dbC, 'conversations', convId, 'messages', `${convId}_intruder`), {
          messageId: `${convId}_intruder`,
          conversationId: convId,
          senderId: uidC,
          senderTalk2tmId: talkIdC,
          text: 'Intrusão',
          clientId: 'cli_intr',
          createdAt: nowIso,
          status: 'synced',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Caso 3: Utilizador não consegue alterar participantes de uma conversa
    // -----------------------------------------------------------------------
    await testCase('3. Participantes de uma conversa são estritamente imutáveis após criação', async () => {
      // Nem A, nem B, nem C podem alterar participantA, participantB ou campos de identidade
      await assertFails(
        updateDoc(doc(dbA, 'conversations', convId), {
          participantB: uidC,
          talk2tmIdB: talkIdC,
          updatedAt: new Date().toISOString(),
        })
      );
      await assertFails(
        updateDoc(doc(dbB, 'conversations', convId), {
          participantA: uidC,
          updatedAt: new Date().toISOString(),
        })
      );
      await assertFails(
        updateDoc(doc(dbA, 'conversations', convId), {
          lastReadB: new Date().toISOString(), // A não pode falsificar leitura de B
          updatedAt: new Date().toISOString(),
        })
      );
      await assertFails(
        updateDoc(doc(dbC, 'conversations', convId), {
          participantB: uidC,
          updatedAt: new Date().toISOString(),
        })
      );
    });

    // -----------------------------------------------------------------------
    // Caso 5: Utilizador não consegue falsificar o remetente de mensagens
    // -----------------------------------------------------------------------
    await testCase('5. Remetente (senderId) não pode ser falsificado e deletedFor é individual', async () => {
      // A tentando enviar se passando por B
      await assertFails(
        setDoc(doc(dbA, 'conversations', convId, 'messages', `${convId}_spoof_1`), {
          messageId: `${convId}_spoof_1`,
          conversationId: convId,
          senderId: uidB,
          senderTalk2tmId: talkIdB,
          text: 'Mensagem falsa',
          clientId: 'cli_spoof',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      // Eliminação individual: A pode adicionar seu próprio UID em deletedFor
      const msgIdA = `${convId}_cli_msgA_1`;
      await assertSucceeds(
        updateDoc(doc(dbA, 'conversations', convId, 'messages', msgIdA), {
          deletedFor: arrayUnion(uidA),
        })
      );
      // A NÃO pode apagar para B nem alterar texto da mensagem
      await assertFails(
        updateDoc(doc(dbA, 'conversations', convId, 'messages', msgIdA), {
          deletedFor: [uidA, uidB],
        })
      );
      await assertFails(
        updateDoc(doc(dbA, 'conversations', convId, 'messages', msgIdA), {
          text: 'Texto adulterado',
        })
      );
    });

    // -----------------------------------------------------------------------
    // Caso 6: Truman e Mãezinha continuam a comunicar normalmente
    // -----------------------------------------------------------------------
    await testCase('6. Truman e Mãezinha continuam a comunicar na sala truman-maezinha; C bloqueado', async () => {
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
          lastActivity: nowIso,
        })
      );

      const mTruman = 'truman-maezinha_cli_t1';
      await assertSucceeds(
        setDoc(doc(dbTruman, 'messages', mTruman), {
          messageId: mTruman,
          room: 'truman-maezinha',
          sender: 'Truman',
          senderId: 'uid_truman_852456',
          text: 'Olá Mãezinha!',
          clientId: 'cli_t1',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      const mMaezinha = 'truman-maezinha_cli_m1';
      await assertSucceeds(
        setDoc(doc(dbMaezinha, 'messages', mMaezinha), {
          messageId: mMaezinha,
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

      // Falsificação de remetente em /messages também deve falhar
      await assertFails(
        setDoc(doc(dbTruman, 'messages', 'truman-maezinha_cli_spoof'), {
          messageId: 'truman-maezinha_cli_spoof',
          room: 'truman-maezinha',
          sender: 'Mãezinha',
          senderId: 'uid_maezinha_135790',
          text: 'Tentativa falsa',
          clientId: 'cli_spoof',
          createdAt: nowIso,
          status: 'synced',
        })
      );

      // Utilizador C NÃO consegue aceder nem à sala truman-maezinha nem a salas arbitrárias
      await assertFails(getDoc(doc(dbC, 'rooms', 'truman-maezinha')));
      await assertFails(getDoc(doc(dbC, 'messages', mTruman)));
      await assertFails(
        setDoc(doc(dbC, 'rooms', 'sala-invasao'), {
          roomId: 'sala-invasao',
          participantA: uidC,
          participantAName: 'Invasor',
          createdAt: nowIso,
          lastActivity: nowIso,
        })
      );
    });

    console.log(`\n\x1b[32m✔ Firebase Emulator Rules: ${passed}/${total} suítes de autorização aprovadas.\x1b[0m`);
  } finally {
    await testEnv.cleanup();
  }
}

runEmulatorRulesTests().catch((err) => {
  console.error('\x1b[31m✖ Falha nos testes de regras do Firestore:\x1b[0m', err);
  process.exit(1);
});
