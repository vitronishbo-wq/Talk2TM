/**
 * Talk2TM — Orquestrador da Aplicação (app.ts)
 * 
 * Lógica central de verificação de senha em campo único:
 * - '852456' -> Truman
 * - '135790' -> Mãezinha
 * 
 * Trata a entrada como um campo único de senha que desbloqueia a interface do chat.
 */

import {
  CONFIG,
  ACCESS_CONFIG,
  AppSettings,
  loadSettings,
  saveSettings,
} from './config';
import { ConnectionState, Message, Room, UserSession } from './types';
import { generateId, sanitizeMessageText } from './utils/sanitize';
import {
  addToOutbox,
  clearSession,
  getLocalMessages,
  getOlderLocalMessages,
  getOutboxMessages,
  removeFromOutbox,
  saveLocalMessage,
  saveLocalRoom,
  saveSession,
} from './storage/indexeddb';
import {
  initFirebase,
  joinFirestoreRoom,
  sendFirestoreMessage,
  subscribeToMessages,
  subscribeToRoom,
} from './firebase/firestore';
import { ChatUI } from './ui/dom';
import { Unsubscribe } from 'firebase/firestore';

/**
 * Mapeamento estrito de senhas únicas por usuário
 */
export const PASSWORDS = {
  TRUMAN: '852456',
  MAEZINHA: '135790',
} as const;

export type AuthenticatedUser = 'Truman' | 'Mãezinha';

export interface AuthVerificationResult {
  valid: boolean;
  user?: AuthenticatedUser;
  userId?: string;
  error?: string;
}

/**
 * Verifica a senha digitada no campo único e determina automaticamente o usuário correspondente:
 * - '852456' -> Truman (usr_truman)
 * - '135790' -> Mãezinha (usr_maezinha)
 */
export function verifyPassword(inputPassword: string): AuthVerificationResult {
  const cleanPassword = (inputPassword || '').trim();

  if (!cleanPassword) {
    return {
      valid: false,
      error: 'Por favor, digite a senha de acesso.',
    };
  }

  if (cleanPassword === PASSWORDS.TRUMAN) {
    return {
      valid: true,
      user: 'Truman',
      userId: 'usr_truman',
    };
  }

  if (cleanPassword === PASSWORDS.MAEZINHA) {
    return {
      valid: true,
      user: 'Mãezinha',
      userId: 'usr_maezinha',
    };
  }

  return {
    valid: false,
    error: 'Senha inválida. Acesso não autorizado.',
  };
}

export class Talk2TMApp {
  public ui: ChatUI;
  public currentSession: UserSession | null = null;
  public currentRoom: Room | null = null;
  public connectionState: ConnectionState = 'conectando';

  private appSettings: AppSettings;
  private sessionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimerId: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeMessages: Unsubscribe | null = null;
  private unsubscribeRoom: Unsubscribe | null = null;

  constructor(container: HTMLElement) {
    this.appSettings = loadSettings();

    this.ui = new ChatUI(container, this.appSettings, {
      onUnlockByPin: (password: string) => this.unlockChatWithPassword(password),
      onLockToCalculator: () => this.lockToCalculator(),
      onSendMessage: (text: string) => this.sendMessage(text),
      onLoadOlder: () => this.loadOlderMessages(),
      onUpdateSettings: (settings: AppSettings) => this.updateSettings(settings),
    });

    this.setupNetworkMonitoring();
    this.setupActivityListeners();
    this.registerServiceWorker();
  }

  /**
   * Ponto central de desbloqueio:
   * Processa a entrada do campo único de senha e, se válida, desbloqueia IMEDIATAMENTE
   * a interface do chat de forma otimista, sem travar na rede.
   */
  public async unlockChatWithPassword(password: string): Promise<boolean> {
    const verification = verifyPassword(password);

    if (!verification.valid || !verification.user || !verification.userId) {
      this.ui.showPassError(verification.error || 'Senha inválida.');
      this.ui.showTemporaryNotice(verification.error || 'Senha inválida.');
      return false;
    }

    const roomId = ACCESS_CONFIG.DEFAULT_ROOM;
    const { user, userId } = verification;

    const session: UserSession = {
      userId,
      displayName: user,
      roomId,
    };

    const nowIso = new Date().toISOString();
    const immediateRoom: Room = {
      roomId,
      participantA: userId,
      participantAName: user,
      participantB: null,
      participantBName: null,
      createdAt: nowIso,
      lastActivity: nowIso,
    };

    this.currentSession = session;
    this.currentRoom = immediateRoom;
    saveSession(session);
    saveLocalRoom(immediateRoom).catch(console.warn);

    // 1. DESBLOQUEIO IMEDIATO DA INTERFACE DO CHAT (Zero latência)
    this.ui.showChatView(session, immediateRoom);
    this.setConnectionState(navigator.onLine ? 'conectando' : 'offline');

    // 2. Inicia temporizadores de sessão e inatividade (5 segundos sem teclar)
    this.startSessionTimeout();
    this.resetInactivityTimer();

    // 3. Carrega histórico local imediato do IndexedDB
    try {
      const localHistory = await getLocalMessages(roomId, CONFIG.HISTORY_LIMIT);
      for (const msg of localHistory) {
        this.ui.appendOrUpdateMessage(msg, msg.senderId === userId);
      }
      if (localHistory.length >= CONFIG.HISTORY_LIMIT) {
        this.ui.setHasOlderMessages(true);
      }
    } catch (dbErr) {
      console.warn('Erro ao ler mensagens locais:', dbErr);
    }

    // 4. Conecta assincronamente ao Firestore em segundo plano
    this.connectFirestoreBackground(roomId, userId, user);

    return true;
  }

  /**
   * Conecta ao Firestore em segundo plano com timeout de resiliência
   */
  private async connectFirestoreBackground(roomId: string, userId: string, user: string): Promise<void> {
    try {
      const joinResult = await joinFirestoreRoom(roomId, userId, user);

      if (joinResult && joinResult.success && joinResult.room) {
        this.currentRoom = joinResult.room;
        await saveLocalRoom(this.currentRoom);
        if (this.currentSession) {
          this.ui.updateRoomInfo(this.currentRoom, this.currentSession);
        }

        // Escuta novas mensagens em tempo real
        this.setupRealtimeListeners(roomId);

        // Sincroniza mensagens que estavam pendentes no outbox
        await this.syncPendingOutbox();

        this.setConnectionState(navigator.onLine ? 'online' : 'offline');
      } else {
        this.setConnectionState('offline');
      }
    } catch (err) {
      console.warn('Conexão remota Firestore em background falhou:', err);
      this.setConnectionState('offline');
    }
  }

  public setConnectionState(newState: ConnectionState): void {
    this.connectionState = newState;
    this.ui.updateConnectionState(newState);
  }

  public resetInactivityTimer(): void {
    if (this.inactivityTimerId) {
      clearTimeout(this.inactivityTimerId);
      this.inactivityTimerId = null;
    }

    if (!this.currentSession || this.appSettings.inactivityLockSeconds <= 0) return;

    this.inactivityTimerId = setTimeout(() => {
      // Tempo sem teclar atingido: bloqueia imediatamente na calculadora
      this.lockToCalculator();
    }, this.appSettings.inactivityLockSeconds * 1000);
  }

  public startSessionTimeout(): void {
    if (this.sessionTimeoutId) {
      clearTimeout(this.sessionTimeoutId);
      this.sessionTimeoutId = null;
    }

    if (this.appSettings.sessionTimeoutMinutes <= 0) return;

    this.sessionTimeoutId = setTimeout(() => {
      this.leaveSession();
      this.lockToCalculator();
    }, this.appSettings.sessionTimeoutMinutes * 60 * 1000);
  }

  public stopAllTimers(): void {
    if (this.sessionTimeoutId) {
      clearTimeout(this.sessionTimeoutId);
      this.sessionTimeoutId = null;
    }
    if (this.inactivityTimerId) {
      clearTimeout(this.inactivityTimerId);
      this.inactivityTimerId = null;
    }
  }

  public lockToCalculator(): void {
    this.stopAllTimers();
    this.ui.showCalculatorView();
  }

  public leaveSession(): void {
    this.stopAllTimers();
    if (this.unsubscribeMessages) {
      this.unsubscribeMessages();
      this.unsubscribeMessages = null;
    }
    if (this.unsubscribeRoom) {
      this.unsubscribeRoom();
      this.unsubscribeRoom = null;
    }
    this.currentSession = null;
    this.currentRoom = null;
    clearSession();
  }

  public async sendMessage(rawText: string): Promise<void> {
    if (!this.currentSession) return;
    this.resetInactivityTimer();

    const sanitized = sanitizeMessageText(rawText);
    if (!sanitized.valid) {
      this.ui.showTemporaryNotice(sanitized.error || 'Mensagem inválida');
      return;
    }

    const clientId = generateId('cli');
    const messageId = `${this.currentSession.roomId}_${clientId}`;
    const nowIso = new Date().toISOString();

    const msg: Message = {
      messageId,
      room: this.currentSession.roomId,
      sender: this.currentSession.displayName,
      senderId: this.currentSession.userId,
      text: sanitized.text,
      clientId,
      createdAt: nowIso,
      status: 'pending',
    };

    await saveLocalMessage(msg);
    await addToOutbox(msg);
    this.ui.appendOrUpdateMessage(msg, true);

    if (navigator.onLine) {
      try {
        await sendFirestoreMessage(msg);
        await removeFromOutbox(msg.messageId);
        const syncedMsg: Message = { ...msg, status: 'synced' };
        await saveLocalMessage(syncedMsg);
        this.ui.appendOrUpdateMessage(syncedMsg, true);
      } catch (error) {
        console.warn('Mensagem salva localmente:', error);
      }
    }
  }

  public async loadOlderMessages(): Promise<void> {
    if (!this.currentSession) return;
    this.resetInactivityTimer();

    const currentMessages = await getLocalMessages(this.currentSession.roomId, 1000);
    if (currentMessages.length === 0) {
      this.ui.setHasOlderMessages(false);
      return;
    }

    const oldestDate = currentMessages[0].createdAt;
    const olderMessages = await getOlderLocalMessages(
      this.currentSession.roomId,
      oldestDate,
      CONFIG.HISTORY_LIMIT
    );

    if (olderMessages.length > 0) {
      this.ui.prependMessages(olderMessages, this.currentSession.userId);
    }

    if (olderMessages.length < CONFIG.HISTORY_LIMIT) {
      this.ui.setHasOlderMessages(false);
    }
  }

  public updateSettings(newSettings: AppSettings): void {
    this.appSettings = newSettings;
    saveSettings(newSettings);

    if (this.currentSession) {
      this.startSessionTimeout();
      this.resetInactivityTimer();
    }
  }

  private async syncPendingOutbox(): Promise<void> {
    if (!navigator.onLine) return;
    const pending = await getOutboxMessages();
    if (pending.length === 0) return;

    this.setConnectionState('sincronizando');

    for (const msg of pending) {
      try {
        await sendFirestoreMessage(msg);
        await removeFromOutbox(msg.messageId);
        const syncedMsg: Message = { ...msg, status: 'synced' };
        await saveLocalMessage(syncedMsg);
        this.ui.appendOrUpdateMessage(syncedMsg, syncedMsg.senderId === this.currentSession?.userId);
      } catch (err) {
        console.warn('Erro ao sincronizar mensagem pendente:', msg.messageId, err);
      }
    }

    this.setConnectionState('online');
  }

  private setupRealtimeListeners(roomId: string): void {
    if (this.unsubscribeMessages) this.unsubscribeMessages();
    if (this.unsubscribeRoom) this.unsubscribeRoom();

    this.unsubscribeRoom = subscribeToRoom(roomId, (updatedRoom) => {
      this.currentRoom = updatedRoom;
      saveLocalRoom(updatedRoom);
      if (this.currentSession) {
        this.ui.updateRoomInfo(updatedRoom, this.currentSession);
      }
    });

    this.unsubscribeMessages = subscribeToMessages(
      roomId,
      async (incomingMessages) => {
        if (!this.currentSession) return;
        for (const msg of incomingMessages) {
          await saveLocalMessage(msg);
          this.ui.appendOrUpdateMessage(msg, msg.senderId === this.currentSession.userId);
        }
      },
      (err) => {
        console.warn('Listener Firestore offline:', err);
      }
    );
  }

  private setupActivityListeners(): void {
    const renewActivity = () => {
      if (this.currentSession) {
        this.resetInactivityTimer();
      }
    };

    window.addEventListener('keydown', renewActivity, { passive: true });
    window.addEventListener('input', renewActivity, { passive: true });
    window.addEventListener('touchstart', renewActivity, { passive: true });
    window.addEventListener('pointerdown', renewActivity, { passive: true });
  }

  private setupNetworkMonitoring(): void {
    window.addEventListener('online', () => {
      this.setConnectionState('online');
      this.syncPendingOutbox();
    });

    window.addEventListener('offline', () => {
      this.setConnectionState('offline');
    });
  }

  private registerServiceWorker(): void {
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.debug('Service Worker erro:', err));
    }
  }

  public async init(): Promise<void> {
    await initFirebase();
    this.setConnectionState(navigator.onLine ? 'online' : 'offline');
    this.ui.showCalculatorView();
  }
}

/**
 * Inicializador da aplicação
 */
export async function startApp(container?: HTMLElement): Promise<Talk2TMApp> {
  const root = container || document.getElementById('root');
  if (!root) throw new Error('Elemento #root não encontrado no DOM');

  const app = new Talk2TMApp(root);
  await app.init();
  return app;
}
