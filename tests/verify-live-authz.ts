/**
 * Talk2TM — Verificação Não-Destrutiva de Autorização em Produção
 *
 * Executa leituras legítimas de Truman e Mãezinha e testa rejeições estritas (permission-denied)
 * diretamente contra o servidor Firestore publicado, SEM gravar nenhum documento em produção.
 */

import * as fs from 'fs';
import * as path from 'path';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { USER_AUTH_CREDENTIALS } from '../src/config';

function getFirebaseConfig() {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

async function expectPermissionDenied(label: string, op: Promise<unknown>): Promise<void> {
  try {
    await op;
    throw new Error(`ESPERAVA permission-denied em "${label}", mas a operação foi permitida!`);
  } catch (err: any) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '');
    if (code === 'permission-denied' || msg.includes('PERMISSION_DENIED') || msg.includes('Missing or insufficient permissions')) {
      console.log(`  ✔ Bloqueado pelo servidor (permission-denied): ${label}`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const cfg = getFirebaseConfig();
  const app = getApps().length ? getApps()[0] : initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);

  console.log(`Verificando regras publicadas no projeto: ${cfg.projectId}...`);

  // 1. Truman continua acedendo truman-maezinha normalmente (somente leitura)
  const trumanCreds = USER_AUTH_CREDENTIALS.Truman;
  const trumanRes = await signInWithEmailAndPassword(auth, trumanCreds.email, trumanCreds.pinPass).catch(() =>
    signInWithEmailAndPassword(auth, trumanCreds.email, trumanCreds.pass)
  );
  const trumanUid = trumanRes.user.uid;
  try {
    const roomSnapT = await getDoc(doc(db, 'rooms', 'truman-maezinha'));
    if (!roomSnapT.exists()) {
      console.warn('  ⚠ rooms/truman-maezinha ainda não existe no servidor, mas leitura get foi permitida.');
    }
    await getDocs(query(collection(db, 'messages'), where('room', '==', 'truman-maezinha'), limit(5)));
    console.log(`  ✔ Truman (${trumanUid}) acedeu a rooms/truman-maezinha e mensagens normalmente`);
  } catch (err: any) {
    throw new Error(
      `Falha ao ler rooms/truman-maezinha ou /messages como Truman (${err?.code || err?.message}). ` +
      'Verifique se o firestore.rules atual já foi publicado no projeto (ex.: firebase deploy --only firestore:rules).'
    );
  }

  // 2. Mãezinha continua acedendo truman-maezinha normalmente (somente leitura)
  await signOut(auth);
  const maezinhaCreds = USER_AUTH_CREDENTIALS['Mãezinha'];
  const maezinhaRes = await signInWithEmailAndPassword(auth, maezinhaCreds.email, maezinhaCreds.pinPass).catch(() =>
    signInWithEmailAndPassword(auth, maezinhaCreds.email, maezinhaCreds.pass)
  );
  const maezinhaUid = maezinhaRes.user.uid;
  const roomSnapM = await getDoc(doc(db, 'rooms', 'truman-maezinha'));
  if (!roomSnapM.exists()) {
    console.warn('  ⚠ rooms/truman-maezinha ainda não existe no servidor para Mãezinha, mas leitura get foi permitida.');
  }
  await getDocs(query(collection(db, 'messages'), where('room', '==', 'truman-maezinha'), limit(5)));
  console.log(`  ✔ Mãezinha (${maezinhaUid}) acedeu a rooms/truman-maezinha e mensagens normalmente`);

  // 3. Rejeições em tempo real (nenhum dado é gravado no servidor)
  const nowIso = new Date().toISOString();

  await expectPermissionDenied(
    'Falsificação de senderId em /messages',
    setDoc(doc(db, 'messages', `probe_spoof_${Date.now()}`), {
      messageId: `probe_spoof_${Date.now()}`,
      room: 'truman-maezinha',
      sender: 'Truman',
      senderId: trumanUid, // logado como Mãezinha tentando falsificar Truman
      text: 'Spoof probe',
      clientId: 'cli_probe',
      createdAt: nowIso,
      status: 'synced',
    })
  );

  await expectPermissionDenied(
    'Leitura de conversa bilateral de terceiros A-B por utilizador externo C',
    getDocs(collection(db, 'conversations', 'conv_fakeA_fakeB', 'messages'))
  );

  await expectPermissionDenied(
    'Criação de conversa com participantA == participantB (sem 2 identidades distintas)',
    setDoc(doc(db, 'conversations', `conv_${maezinhaUid}_${maezinhaUid}`), {
      conversationId: `conv_${maezinhaUid}_${maezinhaUid}`,
      participantA: maezinhaUid,
      participantB: maezinhaUid,
      talk2tmIdA: 'TM-AAAA-2222',
      talk2tmIdB: 'TM-AAAA-2222',
      displayNameA: 'A',
      displayNameB: 'B',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  );

  await expectPermissionDenied(
    'Leitura ampla/terceiro de convites em /conversationInvites',
    getDocs(query(collection(db, 'conversationInvites'), where('toUid', '==', 'uid_terceiro_qualquer')))
  );

  await expectPermissionDenied(
    'Alteração de sala não autorizada em /rooms',
    updateDoc(doc(db, 'rooms', 'sala_inexistente_terceiro'), {
      participantA: maezinhaUid,
    })
  );

  await expectPermissionDenied(
    'Gravação de users/{uid} pertencente a outro utilizador',
    setDoc(doc(db, 'users', 'uid_outro_utilizador'), {
      uid: 'uid_outro_utilizador',
      talk2tmId: 'TM-ZZZZ-9999',
      createdAt: nowIso,
    })
  );

  await signOut(auth);
  console.log('\n\x1b[32m✔ Verificação ao vivo no Firestore concluída com 100% de aprovação (zero poluição de dados).\x1b[0m');
  process.exit(0);
}

main().catch((err) => {
  console.error('\x1b[31m✖ Falha na verificação ao vivo:\x1b[0m', err);
  process.exit(1);
});
