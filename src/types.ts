/**
 * Talk2TM — Tipos e interfaces estritas do produto
 * Modelo: Chat textual ultraleve para exatamente 2 pessoas por sala
 */

export type ConnectionState = 'conectando' | 'online' | 'offline' | 'sincronizando';

export type MessageStatus = 'pending' | 'synced' | 'failed' | 'read';

export interface Room {
  roomId: string;
  participantA: string;
  participantAName: string;
  participantB?: string | null;
  participantBName?: string | null;
  lastReadA?: string | null;
  lastReadB?: string | null;
  lastRead?: Record<string, string>;
  createdAt: string;
  lastActivity: string;
}

export interface Message {
  messageId: string;
  room: string;
  sender: string;
  senderId: string;
  text: string;
  clientId: string;
  createdAt: string;
  status?: MessageStatus;
}

export interface UserSession {
  userId: string;
  displayName: string;
  roomId: string;
  talk2tmId?: string;
}

export interface ChatConfig {
  ROOM_MAX_LENGTH: number;
  NAME_MAX_LENGTH: number;
  MESSAGE_MAX_LENGTH: number;
  HISTORY_LIMIT: number;
  MAX_PARTICIPANTS: number;
}

/**
 * ====================================================================
 * EXPANSION ARCHITECTURE V1: AS 5 ENTIDADES ENXUTAS DO TALK2TM
 * Cadeia Obrigatória: Auth UID -> Identidade -> Conversation -> Messages
 * ====================================================================
 */

/**
 * 1. users/{uid} — Metadados privados da conta associada ao Firebase Auth
 */
export interface UserAccount {
  uid: string;
  talk2tmId: string;
  createdAt: string;
}

/**
 * 2. userProfiles/{talk2tmId} — Índice público ultraleve para descoberta 1:1
 */
export interface UserProfile {
  talk2tmId: string;
  uid: string;
  displayName: string;
  active: boolean;
  createdAt: string;
}

/**
 * 3. conversations/{conversationId} — Vínculo estrito bilateral (exatamente 2 participantes)
 */
export interface Conversation {
  conversationId: string;
  participantA: string; // UID do participante A
  participantB: string; // UID do participante B
  talk2tmIdA: string;
  talk2tmIdB: string;
  displayNameA: string;
  displayNameB: string;
  createdAt: string;
  updatedAt: string;
  lastReadA?: string | null;
  lastReadB?: string | null;
}

/**
 * 4. conversationInvites/{inviteId} — Convites bilaterais para conversas
 */
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface ConversationInvite {
  inviteId: string;
  fromUid: string;
  fromDisplayName: string;
  fromTalk2tmId: string;
  toTalk2tmId: string;
  toUid?: string | null;
  conversationId: string;
  status: InviteStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 5. conversations/{conversationId}/messages/{messageId} — Mensagens puramente textuais
 */
export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  senderId: string; // UID obrigatório
  senderTalk2tmId: string;
  text: string;
  clientId: string;
  createdAt: string;
  status?: MessageStatus;
}
