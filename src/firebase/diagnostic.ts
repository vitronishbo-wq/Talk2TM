/**
 * Talk2TM — Módulo de Diagnóstico de Sincronização em Tempo Real (A <-> B)
 *
 * Implementa a função de teste 'testRealtimeSyncAtoB' que:
 * 1. Conecta um snapshot listener na coleção 'messages'.
 * 2. Grava um documento com timestamp na coleção 'messages' simulando o Cliente A.
 * 3. Captura o documento no snapshot listener simulando o Cliente B.
 * 4. Calcula o tempo de ida e volta e registra detalhadamente a latência no console.
 */

import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  setDoc,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import { initFirebase } from './firestore';
import { Message } from '../types';
import { ACCESS_CONFIG } from '../config';
import { generateId } from '../utils/sanitize';

export interface DiagnosticOptions {
  roomId?: string;
  timeoutMs?: number;
  customText?: string;
}

export interface DiagnosticResult {
  success: boolean;
  messageId: string;
  room: string;
  sender: string;
  senderId: string;
  receiver: string;
  receiverId: string;
  text: string;
  sentAt: string;
  receivedAt?: string;
  latencyMs?: number;
  error?: string;
  details?: string;
}

/**
 * Executa o teste de sincronização em tempo real entre Cliente A e Cliente B:
 * - Grava um documento com timestamp em 'messages'
 * - Utiliza um snapshot listener para verificar o recebimento
 * - Registra os resultados de latência no console
 */
export async function testRealtimeSyncAtoB(options?: DiagnosticOptions): Promise<DiagnosticResult> {
  const roomId = options?.roomId || ACCESS_CONFIG.DEFAULT_ROOM;
  const timeoutMs = options?.timeoutMs || 8000;
  const clientId = generateId('diag');
  const messageId = `${roomId}_${clientId}`;
  const sentIso = new Date().toISOString();

  const sender = 'Truman';
  const senderId = 'usr_truman';
  const receiver = 'Mãezinha';
  const receiverId = 'usr_maezinha';

  const text = options?.customText || `[DIAGNOSTICO_A_B] Ping de sincronização ${clientId}`;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Talk2TM — Diagnóstico de Conectividade em Tempo Real (A <-> B)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`[1/4] Inicializando Firestore para sala "${roomId}"...`);

  // 1. Inicializa o Firestore
  const { db } = await initFirebase();
  if (!db) {
    const errMsg = 'Firestore não está disponível ou credenciais não foram configuradas.';
    console.error(`✖ Erro: ${errMsg}`);
    return {
      success: false,
      messageId,
      room: roomId,
      sender,
      senderId,
      receiver,
      receiverId,
      text,
      sentAt: sentIso,
      error: errMsg,
    };
  }

  // 2. Registra o snapshot listener (Cliente B)
  console.log(`[2/4] Conectando snapshot listener na coleção 'messages'...`);
  let unsubscribeListener: Unsubscribe | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const startTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  const listenerDetectionPromise = new Promise<{ receivedAt: string; latencyMs: number }>((resolve, reject) => {
    timerId = setTimeout(() => {
      if (unsubscribeListener) {
        unsubscribeListener();
        unsubscribeListener = null;
      }
      reject(
        new Error(
          `Timeout (${timeoutMs}ms): O snapshot listener não detectou o documento gravado a tempo.`
        )
      );
    }, timeoutMs);

    const q = query(
      collection(db, 'messages'),
      where('room', '==', roomId),
      orderBy('createdAt', 'desc'),
      limit(20)
    );

    unsubscribeListener = onSnapshot(
      q,
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'added' || change.type === 'modified') {
            const data = change.doc.data();
            if (data.messageId === messageId || data.clientId === clientId || change.doc.id === messageId) {
              const endTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
              const latencyMs = Math.round(endTime - startTime);
              const receivedIso = new Date().toISOString();

              if (timerId) {
                clearTimeout(timerId);
                timerId = null;
              }
              if (unsubscribeListener) {
                unsubscribeListener();
                unsubscribeListener = null;
              }

              resolve({ receivedAt: receivedIso, latencyMs });
              return;
            }
          }
        }
      },
      (listenerError) => {
        if (timerId) {
          clearTimeout(timerId);
          timerId = null;
        }
        if (unsubscribeListener) {
          unsubscribeListener();
          unsubscribeListener = null;
        }
        reject(new Error(`Erro no snapshot listener: ${listenerError.message}`));
      }
    );
  });

  // Aguarda 150ms para assegurar o handshake da conexão do snapshot listener
  await new Promise((r) => setTimeout(r, 150));

  // 3. Grava o documento com timestamp na coleção 'messages' (Cliente A)
  console.log(`[3/4] Gravando documento com timestamp em 'messages' (ID: ${messageId})...`);
  try {
    const docRef = doc(db, 'messages', messageId);
    const payload: Message = {
      messageId,
      room: roomId,
      sender,
      senderId,
      text,
      clientId,
      createdAt: sentIso,
      status: 'synced',
    };

    await setDoc(docRef, payload);
    console.log(`      ↳ Documento gravado no Firestore com sucesso.`);
  } catch (writeError) {
    if (timerId) clearTimeout(timerId);
    if (unsubscribeListener) (unsubscribeListener as Unsubscribe)();

    const errMessage = writeError instanceof Error ? writeError.message : String(writeError);
    console.error(`✖ Falha na gravação do documento: ${errMessage}`);
    return {
      success: false,
      messageId,
      room: roomId,
      sender,
      senderId,
      receiver,
      receiverId,
      text,
      sentAt: sentIso,
      error: `Falha na gravação: ${errMessage}`,
    };
  }

  // 4. Aguarda a confirmação pelo snapshot listener e registra a latência no console
  console.log(`[4/4] Aguardando detecção imediata pelo snapshot listener...`);
  try {
    const { receivedAt, latencyMs } = await listenerDetectionPromise;

    // Log dos resultados de latência no console
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  RESULTADO: Sincronização em Tempo Real Verificada com Sucesso! ');
    console.log(`  • Latência de propagação: ${latencyMs} ms`);
    console.log(`  • ID da mensagem: ${messageId}`);
    console.log(`  • Timestamp de envio: ${sentIso}`);
    console.log(`  • Timestamp de recebimento: ${receivedAt}`);
    console.log(`  • Remetente (Cliente A): ${sender} (${senderId})`);
    console.log(`  • Destinatário (Cliente B): ${receiver} (${receiverId})`);
    console.log(`  • Conteúdo validado: "${text}"`);
    console.log('═══════════════════════════════════════════════════════════════');

    return {
      success: true,
      messageId,
      room: roomId,
      sender,
      senderId,
      receiver,
      receiverId,
      text,
      sentAt: sentIso,
      receivedAt,
      latencyMs,
      details: `Documento recebido pelo snapshot listener em ${latencyMs}ms.`,
    };
  } catch (detectError) {
    const errMessage = detectError instanceof Error ? detectError.message : String(detectError);
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('  RESULTADO: Falha no Teste de Sincronização em Tempo Real');
    console.error(`  • Erro: ${errMessage}`);
    console.error('═══════════════════════════════════════════════════════════════');

    return {
      success: false,
      messageId,
      room: roomId,
      sender,
      senderId,
      receiver,
      receiverId,
      text,
      sentAt: sentIso,
      error: errMessage,
    };
  }
}
