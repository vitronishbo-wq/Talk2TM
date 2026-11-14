/**
 * Talk2TM — Utilitários puros para detecção de mensagens não lidas,
 * ordenação cronológica e deduplicação sem falsos positivos.
 */

import { Conversation, Message, Room } from '../types';

export interface UnreadCheckParams {
  messages: Message[];
  myUid: string;
  myDisplayName?: string;
  lastReadIso: string | null;
  isHiddenFn?: (messageId: string) => boolean;
}

/**
 * Compara datas ISO retornando a mais recente (não-nula).
 */
export function maxIsoDate(...dates: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const d of dates) {
    if (!d || typeof d !== 'string') continue;
    if (!latest || d > latest) {
      latest = d;
    }
  }
  return latest;
}

/**
 * Extrai a data ISO da última leitura do próprio usuário a partir da sala ou conversa.
 */
export function getSelfLastReadFromChannel(
  channel: Room | Conversation | null | undefined,
  myUid: string,
  myDisplayName?: string
): string | null {
  if (!channel) return null;

  const candidates: Array<string | null | undefined> = [];

  if ('lastRead' in channel && channel.lastRead) {
    if (myUid) candidates.push(channel.lastRead[myUid]);
    if (myDisplayName) candidates.push(channel.lastRead[myDisplayName]);
  }

  const isParticipantA =
    channel.participantA === myUid ||
    ('participantAName' in channel && Boolean(myDisplayName) && channel.participantAName === myDisplayName) ||
    ('displayNameA' in channel && Boolean(myDisplayName) && channel.displayNameA === myDisplayName);

  const isParticipantB =
    channel.participantB === myUid ||
    ('participantBName' in channel && Boolean(myDisplayName) && channel.participantBName === myDisplayName) ||
    ('displayNameB' in channel && Boolean(myDisplayName) && channel.displayNameB === myDisplayName);

  if (isParticipantA && channel.lastReadA) {
    candidates.push(channel.lastReadA);
  }
  if (isParticipantB && channel.lastReadB) {
    candidates.push(channel.lastReadB);
  }

  return maxIsoDate(...candidates);
}

/**
 * Filtra mensagens visíveis (respeitando deletedFor e tombstones locais),
 * remove duplicatas por messageId e ordena cronologicamente (ascendente).
 */
export function normalizeAndDeduplicateMessages(
  messages: Message[],
  myUid: string,
  isHiddenFn?: (messageId: string) => boolean
): Message[] {
  const byId = new Map<string, Message>();

  for (const msg of messages) {
    if (!msg || !msg.messageId) continue;
    if (myUid && msg.deletedFor && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(myUid)) {
      continue;
    }
    if (isHiddenFn && isHiddenFn(msg.messageId)) {
      continue;
    }
    const existing = byId.get(msg.messageId);
    if (!existing || (msg.status === 'read' && existing.status !== 'read') || (msg.status === 'synced' && existing.status === 'pending')) {
      byId.set(msg.messageId, msg);
    }
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.createdAt > b.createdAt ? 1 : a.createdAt < b.createdAt ? -1 : 0
  );
}

/**
 * Seleciona as N mensagens mais recentes por createdAt (ascendente ao final),
 * garantindo que fallbacks sem orderBy nunca descartem mensagens recentes.
 */
export function selectLatestMessages(messages: Message[], maxCount: number = 50): Message[] {
  if (messages.length <= maxCount) {
    return [...messages].sort((a, b) =>
      a.createdAt > b.createdAt ? 1 : a.createdAt < b.createdAt ? -1 : 0
    );
  }
  const sortedDesc = [...messages].sort((a, b) =>
    b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0
  );
  return sortedDesc.slice(0, maxCount).reverse();
}

/**
 * Determina se há pelo menos uma mensagem nova do parceiro não consultada.
 * Evita falsos positivos checando remetente, deletedFor, tombstones e lastRead.
 */
export function hasUnreadIncomingMessage(params: UnreadCheckParams): boolean {
  const { messages, myUid, myDisplayName, lastReadIso, isHiddenFn } = params;
  const visible = normalizeAndDeduplicateMessages(messages, myUid, isHiddenFn);

  for (const msg of visible) {
    // 1. Nunca dispara indicador para mensagens enviadas pelo próprio usuário
    const isFromSelf =
      (Boolean(myUid) && msg.senderId === myUid) ||
      (Boolean(myDisplayName) && msg.sender === myDisplayName);
    if (isFromSelf) {
      continue;
    }

    // 2. Se já existe carimbo de leitura >= createdAt, a mensagem já foi consultada
    if (lastReadIso && msg.createdAt <= lastReadIso) {
      continue;
    }

    return true;
  }

  return false;
}
