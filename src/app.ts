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
  getLocalRoom,
  updateLocalLastRead,
  saveSession,
  getSession,
  hideMessagesLocally,
  isMessageHiddenLocally,
  deleteLocalMessages,
  loadHiddenMessagesFromDB,
} from './storage/indexeddb';
import {
  initFirebase,
  joinFirestoreRoom,
  sendFirestoreMessage,
  subscribeToMessages,
  subscribeToRoom,
  restoreAuthSession,
  silentAuthenticateWithEmail,
  isAuthValidAndNonAnonymous,
  waitForAuthCompletion,
  getCurrentAuthUser,
  updateFirestoreLastRead,
} from './firebase/firestore';
import { ChatUI } from './ui/dom';
import { Unsubscribe } from 'firebase/firestore';
import { testRealtimeSyncAtoB } from './firebase/diagnostic';

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
      onDeleteMessagesLocally: async (messageIds: string[]) => {
        if (!this.currentSession) return;
        const roomId = this.currentSession.roomId;
        // 1. Marca tombstone no armazenamento local/IndexedDB
        hideMessagesLocally(roomId, messageIds);
        // 2. Remove do IndexedDB local
        await deleteLocalMessages(messageIds);
        // 3. Se houver mensagens no outbox ainda pendentes, remove para não enviar após apagadas
        for (const id of messageIds) {
          await removeFromOutbox(id).catch(() => {});
        }
      },
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
    const existingRoom = await getLocalRoom(roomId).catch(() => null);
    const roomToUse: Room = existingRoom || {
      roomId,
      participantA: userId,
      participantAName: user,
      participantB: null,
      participantBName: null,
      createdAt: nowIso,
      lastActivity: nowIso,
    };

    this.currentSession = session;
    this.currentRoom = roomToUse;
    saveSession(session);
    saveLocalRoom(roomToUse).catch(console.warn);

    // 1. DESBLOQUEIO IMEDIATO DA INTERFACE DO CHAT (Zero latência)
    this.ui.showChatView(session, roomToUse);
    this.setConnectionState(navigator.onLine ? 'conectando' : 'offline');

    // 2. Inicia temporizadores de sessão e inatividade (5 segundos sem teclar)
    this.startSessionTimeout();
    this.resetInactivityTimer();

    // 3. Carrega histórico local imediato do IndexedDB (carregando tombstones antes)
    try {
      await loadHiddenMessagesFromDB(roomId);
      const localHistory = await getLocalMessages(roomId, CONFIG.HISTORY_LIMIT);
      for (const msg of localHistory) {
        if (!isMessageHiddenLocally(roomId, msg.messageId)) {
          this.ui.appendOrUpdateMessage(msg, msg.senderId === userId);
        }
      }
      if (localHistory.length >= CONFIG.HISTORY_LIMIT) {
        this.ui.setHasOlderMessages(true);
      }
    } catch (dbErr) {
      console.warn('Erro ao ler mensagens locais:', dbErr);
    }

    // Registra leitura imediata do chat pelo participante
    this.markChatAsRead();

    // Layer 4 — 2. Complete Silent Auth (if new session)
    // Autenticação transparente sem prompt visual na calculadora
    const authUser = await silentAuthenticateWithEmail(user);
    const effectiveUid = authUser?.uid || userId;
    if (effectiveUid !== session.userId) {
      session.userId = effectiveUid;
      roomToUse.participantA = effectiveUid;
      this.currentSession = session;
      saveSession(session);
    }

    // Layer 4 — 3. Initialize Firestore Listeners
    await this.connectFirestoreBackground(roomId, effectiveUid, user);

    // Layer 4 — 4. Flush Offline Outbox
    await this.syncPendingOutbox();

    return true;
  }

  /**
   * Conecta ao Firestore em segundo plano com timeout de resiliência
   */
  private async connectFirestoreBackground(roomId: string, userId: string, user: string): Promise<void> {
    // 1. Aguarda autenticação não-anônima ativa
    if (!isAuthValidAndNonAnonymous()) {
      await waitForAuthCompletion(2500);
    }

    if (!isAuthValidAndNonAnonymous()) {
      console.debug('Talk2TM [Guard]: Conexão Firestore em background suspensa — aguardando autenticação não-anônima.');
      this.setConnectionState('offline');
      return;
    }

    try {
      // 2. Garante PRIMEIRO que a sala exista no Firestore e que o participante com seu UID real esteja registrado
      const joinResult = await joinFirestoreRoom(roomId, userId, user);

      if (joinResult && joinResult.success && joinResult.room) {
        this.currentRoom = joinResult.room;
        await saveLocalRoom(this.currentRoom);
        if (this.currentSession) {
          this.ui.updateRoomInfo(this.currentRoom, this.currentSession);
          this.ui.updateReadReceipts(this.currentRoom, this.currentSession);
        }

        // 3. AGORA que a sala existe e o participante está registrado e autenticado, ativa os listeners em tempo real
        this.setupRealtimeListeners(roomId);

        // 4. Marca como lido com a sala conectada
        this.markChatAsRead();

        // 5. Sincroniza mensagens que estavam pendentes no outbox
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

  private lastMarkedReadTime: number = 0;

  /**
   * Salva e sincroniza a leitura do chat pelo participante atual
   */
  public async markChatAsRead(): Promise<void> {
    if (!this.currentSession) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    try {
      // 1. Salva localmente no IndexedDB imediatamente
      const updatedLocal = await updateLocalLastRead(
        this.currentSession.roomId,
        this.currentSession.displayName,
        nowIso
      );

      if (this.currentRoom) {
        if (!this.currentRoom.lastRead) {
          this.currentRoom.lastRead = {};
        }
        this.currentRoom.lastRead[this.currentSession.displayName] = nowIso;
        this.currentRoom.lastRead[this.currentSession.userId] = nowIso;
        if (this.currentRoom.participantAName === this.currentSession.displayName) {
          this.currentRoom.lastReadA = nowIso;
        } else {
          this.currentRoom.lastReadB = nowIso;
        }
        this.ui.updateReadReceipts(this.currentRoom, this.currentSession);
      } else if (updatedLocal) {
        this.currentRoom = updatedLocal;
        this.ui.updateReadReceipts(updatedLocal, this.currentSession);
      }
    } catch (e) {
      console.debug('Talk2TM: Erro ao persistir leitura localmente:', e);
    }

    // 2. Throttle para chamadas de rede no Firestore (1.5s)
    if (now - this.lastMarkedReadTime < 1500) {
      return;
    }
    this.lastMarkedReadTime = now;

    // 3. Atualiza no Firestore se online e autenticado
    if (navigator.onLine && isAuthValidAndNonAnonymous()) {
      await updateFirestoreLastRead(
        this.currentSession.roomId,
        this.currentSession.userId,
        this.currentSession.displayName,
        nowIso
      );
    }
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

    const currentAuth = getCurrentAuthUser();
    const effectiveSenderId = (currentAuth && !currentAuth.isAnonymous ? currentAuth.uid : null) || this.currentSession.userId;
    if (currentAuth && !currentAuth.isAnonymous && this.currentSession.userId !== currentAuth.uid) {
      this.currentSession.userId = currentAuth.uid;
      saveSession(this.currentSession);
    }

    const msg: Message = {
      messageId,
      room: this.currentSession.roomId,
      sender: this.currentSession.displayName,
      senderId: effectiveSenderId,
      text: sanitized.text,
      clientId,
      createdAt: nowIso,
      status: 'pending',
    };

    await saveLocalMessage(msg);
    await addToOutbox(msg);
    this.ui.appendOrUpdateMessage(msg, true);
    this.markChatAsRead();

    // Explicit guard check: procede APENAS se auth.currentUser != null e auth.currentUser.isAnonymous === false.
    // Evita envios remotos prematuros ou bloqueados pelas regras do Firestore
    if (navigator.onLine) {
      if (!isAuthValidAndNonAnonymous()) {
        await restoreAuthSession(1000);
      }
      if (isAuthValidAndNonAnonymous()) {
        try {
          await sendFirestoreMessage(msg);
          await removeFromOutbox(msg.messageId);
          const syncedMsg: Message = { ...msg, status: 'synced' };
          await saveLocalMessage(syncedMsg);
          this.ui.appendOrUpdateMessage(syncedMsg, true);
        } catch (error) {
          console.warn('Mensagem mantida no outbox local:', error);
        }
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

    // Camada 2.5: A inicialização do Firestore não deve disparar sincronização da outbox antes da conclusão da autenticação necessária
    if (!isAuthValidAndNonAnonymous()) {
      await waitForAuthCompletion(1500);
    }

    if (!isAuthValidAndNonAnonymous()) {
      console.debug('Talk2TM [Guard]: syncPendingOutbox retido — aguardando autenticação não-anônima.');
      return;
    }

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
        this.ui.updateReadReceipts(updatedRoom, this.currentSession);
      }
    });

    this.unsubscribeMessages = subscribeToMessages(
      roomId,
      async (incomingMessages) => {
        if (!this.currentSession) return;
        for (const msg of incomingMessages) {
          // Filtro antes de renderizar e antes de re-salvar localmente:
          // Se apagada neste dispositivo, ignora permanentemente
          if (isMessageHiddenLocally(roomId, msg.messageId)) {
            continue;
          }
          await saveLocalMessage(msg);
          this.ui.appendOrUpdateMessage(msg, msg.senderId === this.currentSession.userId);
        }
        if (this.ui.isChatActive()) {
          this.markChatAsRead();
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

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.currentSession && this.ui.isChatActive()) {
        this.markChatAsRead();
      }
    });
    window.addEventListener('focus', () => {
      if (this.currentSession && this.ui.isChatActive()) {
        this.markChatAsRead();
      }
    });
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
        .then((reg) => {
          reg.update().catch(() => {});
          reg.onupdatefound = () => {
            const installing = reg.installing;
            if (installing) {
              installing.onstatechange = () => {
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                  installing.postMessage({ type: 'SKIP_WAITING' });
                }
              };
            }
          };
        })
        .catch((err) => console.debug('Service Worker erro:', err));

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    }
  }

  public async init(): Promise<void> {
    await initFirebase();

    // Layer 4 — 1. Restore Firebase Auth Session (onAuthStateChanged)
    await restoreAuthSession();

    // Restaura sessão se houver dados salvos e autenticação válida ativa
    const savedSession = getSession();
    if (savedSession && isAuthValidAndNonAnonymous()) {
      this.currentSession = savedSession;
      const savedRoom = await getLocalRoom(savedSession.roomId).catch(() => null);
      if (savedRoom) this.currentRoom = savedRoom;
      this.ui.showChatView(savedSession, savedRoom || undefined);
      this.startSessionTimeout();
      this.resetInactivityTimer();

      try {
        const localHistory = await getLocalMessages(savedSession.roomId, CONFIG.HISTORY_LIMIT);
        for (const msg of localHistory) {
          this.ui.appendOrUpdateMessage(msg, msg.senderId === savedSession.userId);
        }
      } catch (e) {
        console.warn('Erro ao restaurar histórico de mensagens:', e);
      }

      this.markChatAsRead();

      // Layer 4 — 3. Initialize Firestore Listeners
      await this.connectFirestoreBackground(savedSession.roomId, savedSession.userId, savedSession.displayName);

      // Layer 4 — 4. Flush Offline Outbox
      await this.syncPendingOutbox();
      return;
    }

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

  if (typeof window !== 'undefined') {
    (window as unknown as { testRealtimeSyncAtoB: typeof testRealtimeSyncAtoB }).testRealtimeSyncAtoB = testRealtimeSyncAtoB;
  }

  return app;
}
