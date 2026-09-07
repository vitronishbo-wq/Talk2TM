/**
 * Talk2TM — Script de Teste de Conectividade em Tempo Real (A <-> B)
 *
 * Valida a propagação instantânea de mensagens entre clientes via Firestore:
 * 1. Inicializa o cliente do Firestore com as credenciais do projeto.
 * 2. Registra o Listener em tempo real do Cliente B (Mãezinha) na coleção 'messages'.
 * 3. Insere uma nova mensagem no Firestore pelo Cliente A (Truman).
 * 4. Captura a mensagem no listener do Cliente B e calcula a latência ponta a ponta.
 * 5. Conclui com sucesso quando a mensagem chega instantaneamente.
 */

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  setDoc,
} from 'firebase/firestore';
import * as fs from 'fs';
import * as path from 'path';

function getFirebaseConfig() {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      // continua para variáveis de ambiente
    }
  }

  return {
    apiKey: process.env.VITE_FIREBASE_API_KEY || 'AIzaSyCfwTvVhyrRZHk4zzzRweShyVdMnimnzm0',
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || 'gen-lang-client-0618196986.firebaseapp.com',
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || 'gen-lang-client-0618196986',
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || 'gen-lang-client-0618196986.firebasestorage.app',
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '511328922010',
    appId: process.env.VITE_FIREBASE_APP_ID || '1:511328922010:web:58c5982b1ab704d93f3223',
  };
}

async function runRealtimeTest(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Talk2TM — Teste de Conectividade em Tempo Real (A <-> B)    ');
  console.log('═══════════════════════════════════════════════════════════════');

  const config = getFirebaseConfig();
  console.log(`[1/4] Inicializando Firestore (Projeto: ${config.projectId})...`);

  const app = getApps().length ? getApps()[0] : initializeApp(config);
  const db = getFirestore(app);

  const testRoomId = 'truman-maezinha';
  const testClientId = `test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const testMessageId = `${testRoomId}_${testClientId}`;
  const testPayloadText = `[TESTE_A_B] Olá Mãezinha, teste de sincronização ${testClientId}`;

  console.log(`[2/4] Sala de teste: "${testRoomId}" | ID: "${testMessageId}"`);

  let unsubscribeListener: (() => void) | null = null;
  const timeoutMs = 8000;
  let timer: NodeJS.Timeout;
  const startTime = Date.now();

  const listenerPromise = new Promise<{ latencyMs: number; receivedData: any }>((resolve, reject) => {
    timer = setTimeout(() => {
      if (unsubscribeListener) unsubscribeListener();
      reject(new Error(`TIMEOUT (${timeoutMs}ms): O listener do Cliente B não detectou o documento a tempo.`));
    }, timeoutMs);

    console.log('[3/4] Conectando listener em tempo real do Cliente B (Mãezinha)...');

    const q = query(
      collection(db, 'messages'),
      where('room', '==', testRoomId),
      orderBy('createdAt', 'desc'),
      limit(20)
    );

    unsubscribeListener = onSnapshot(
      q,
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'added' || change.type === 'modified') {
            const data = change.doc.data();
            if (data.messageId === testMessageId || change.doc.id === testMessageId) {
              const latencyMs = Date.now() - startTime;
              clearTimeout(timer);
              if (unsubscribeListener) unsubscribeListener();
              resolve({ latencyMs, receivedData: data });
              return;
            }
          }
        }
      },
      (error) => {
        clearTimeout(timer);
        if (unsubscribeListener) unsubscribeListener();
        reject(new Error(`Erro no listener do Firestore: ${error.message}`));
      }
    );
  });

  // Aguarda 150ms para garantir conexão do listener
  await new Promise((resolve) => setTimeout(resolve, 150));

  console.log('[4/4] Inserindo mensagem pelo Cliente A (Truman) no Firestore...');
  const docRef = doc(db, 'messages', testMessageId);

  try {
    await setDoc(docRef, {
      messageId: testMessageId,
      room: testRoomId,
      sender: 'Truman',
      senderId: 'usr_truman',
      text: testPayloadText,
      clientId: testClientId,
      createdAt: new Date().toISOString(),
      status: 'synced',
    });
    console.log(`      ↳ Mensagem gravada no Firestore pelo Cliente A.`);
  } catch (err: any) {
    clearTimeout(timer!);
    if (unsubscribeListener) (unsubscribeListener as () => void)();
    console.error('      ✖ Falha ao gravar no Firestore:', err.message);
    process.exit(1);
  }

  try {
    const result = await listenerPromise;
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  RESULTADO: SUCESSO! Conectividade em tempo real validada.   ');
    console.log(`  • Latência de entrega A -> B: ${result.latencyMs} ms`);
    console.log(`  • Mensagem recebida por B: "${result.receivedData.text}"`);
    console.log(`  • Remetente identificado: ${result.receivedData.sender} (${result.receivedData.senderId})`);
    console.log(`  • ID da Mensagem: ${result.receivedData.messageId}`);
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(0);
  } catch (error: any) {
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('  RESULTADO: FALHA no teste de sincronização em tempo real.');
    console.error(`  • Motivo: ${error.message}`);
    console.error('═══════════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

runRealtimeTest();
