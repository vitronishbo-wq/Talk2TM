/**
 * Talk2TM — Canal de Mensagens Bilateral (Fase 4)
 * Conecta a engine de mensagens ultra-rápida (com suporte offline IndexedDB e exclusão local) à conversationId.
 */

import { Conversation, Message, Room, UserSession } from './types';
import {
  saveLocalMessage,
  getLocalMessages,
  hideMessagesLocally,
  isMessageHiddenLocally,
  loadHiddenMessagesFromDB,
  deleteLocalMessages,
  addToOutbox,
  removeFromOutbox,
} from './storage/indexeddb';
import {
  sendFirestoreConversationMessage,
  isAuthValidAndNonAnonymous,
} from './firebase/firestore';

/**
 * Gera um ID de conversa determinístico ordenando os identificadores dos dois participantes.
 * Garante que ambos participantes usem sempre o mesmo ID de canal bilateral.
 */
export function buildDeterministicConversationId(id1: string, id2: string): string {
  const sorted = [id1.trim(), id2.trim()].sort();
  return `conv_${sorted[0]}_${sorted[1]}`;
}

/**
 * Converte um objeto Conversation para compatibilidade com o modelo de visualização Room.
 */
export function conversationToRoom(conv: Conversation): Room {
  return {
    roomId: conv.conversationId,
    participantA: conv.participantA,
    participantAName: conv.displayNameA,
    participantB: conv.participantB,
    participantBName: conv.displayNameB,
    lastReadA: conv.lastReadA || null,
    lastReadB: conv.lastReadB || null,
    lastRead: {
      [conv.displayNameA]: conv.lastReadA || '',
      [conv.displayNameB]: conv.lastReadB || '',
      [conv.participantA]: conv.lastReadA || '',
      [conv.participantB]: conv.lastReadB || '',
    },
    createdAt: conv.createdAt,
    lastActivity: conv.updatedAt,
  };
}

/**
 * Salva mensagem no IndexedDB e na fila outbox caso offline, ou envia diretamente ao Firestore se online
 */
export async function sendChannelMessage(
  conversationId: string,
  text: string,
  session: UserSession
): Promise<Message> {
  const clientId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const messageId = `${conversationId}_${clientId}`;
  const nowIso = new Date().toISOString();

  const msg: Message = {
    messageId,
    room: conversationId,
    conversationId,
    sender: session.displayName,
    senderId: session.userId,
    senderTalk2tmId: session.talk2tmId,
    text,
    clientId,
    createdAt: nowIso,
    status: 'pending',
  };

  // 1. Persistência local instantânea no IndexedDB (Zero Latência)
  await saveLocalMessage(msg);
  await addToOutbox(msg);

  // 2. Se online e autenticado, envia ao Firestore
  if (typeof navigator !== 'undefined' && navigator.onLine && isAuthValidAndNonAnonymous()) {
    try {
      await sendFirestoreConversationMessage(msg);
      await removeFromOutbox(msg.messageId);
      const syncedMsg: Message = { ...msg, status: 'synced' };
      await saveLocalMessage(syncedMsg);
      return syncedMsg;
    } catch (err) {
      console.warn('Talk2TM [Fase 4]: Mensagem mantida no outbox offline para sincronização:', err);
    }
  }

  return msg;
}

/**
 * Exclusão local (tombstone) estrita neste dispositivo:
 * 1. Registra no set de tombstones em memória e IndexedDB para nunca mais renderizar
 * 2. Remove do banco de mensagens local e da fila outbox
 * 3. Preserva a mensagem no Firestore para o outro participante da conversa
 */
export async function deleteChannelMessagesLocally(
  conversationId: string,
  messageIds: string[]
): Promise<void> {
  hideMessagesLocally(conversationId, messageIds);
  await deleteLocalMessages(messageIds);
  for (const id of messageIds) {
    await removeFromOutbox(id).catch(() => {});
  }
}

/**
 * Carrega histórico local de mensagens da conversa aplicando os tombstones locais
 */
export async function loadChannelHistory(
  conversationId: string,
  limitCount = 50
): Promise<Message[]> {
  await loadHiddenMessagesFromDB(conversationId);
  const localMessages = await getLocalMessages(conversationId, limitCount);
  return localMessages.filter((m) => !isMessageHiddenLocally(conversationId, m.messageId));
}
