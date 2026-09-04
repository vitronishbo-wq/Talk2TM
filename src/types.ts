/**
 * Talk2TM — Tipos e interfaces estritas do produto
 * Modelo: Chat textual ultraleve para exatamente 2 pessoas por sala
 */

export type ConnectionState = 'conectando' | 'online' | 'offline' | 'sincronizando';

export type MessageStatus = 'pending' | 'synced' | 'failed';

export interface Room {
  roomId: string;
  participantA: string;
  participantAName: string;
  participantB?: string | null;
  participantBName?: string | null;
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
}

export interface ChatConfig {
  ROOM_MAX_LENGTH: number;
  NAME_MAX_LENGTH: number;
  MESSAGE_MAX_LENGTH: number;
  HISTORY_LIMIT: number;
  MAX_PARTICIPANTS: number;
}
