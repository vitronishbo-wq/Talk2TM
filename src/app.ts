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
import { Conversation, ConnectionState, Message, Room, UserSession } from './types';
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
  saveMonitorContext,
  getMonitorContext,
  saveLocalLastReadTimestamp,
  getLocalLastReadTimestamp,
} from './storage/indexeddb';
import {
  initFirebase,
  joinFirestoreRoom,
  sendFirestoreMessage,
  sendFirestoreConversationMessage,
  subscribeToMessages,
  subscribeToConversationMessages,
  subscribeToRoom,
  subscribeToConversation,
  restoreAuthSession,
  silentAuthenticateWithEmail,
  isAuthValidAndNonAnonymous,
  waitForAuthCompletion,
  getCurrentAuthUser,
  getFirebaseAuth,
  updateFirestoreLastRead,
  updateConversationLastRead,
  markFirestoreMessagesDeletedForUser,
  fetchLatestMessagesFromServer,
  fetchChannelMetadataFromServer,
} from './firebase/firestore';
import {
  hasUnreadIncomingMessage,
  getSelfLastReadFromChannel,
  maxIsoDate,
  normalizeAndDeduplicateMessages,
} from './utils/unread';
import { conversationToRoom } from './conversation';
import { ChatUI } from './ui/dom';
import { Unsubscribe } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { testRealtimeSyncAtoB } from './firebase/diagnostic';
import {
  createTalk2TMIdentity,
  getLocalIdentity,
  restoreLocalIdentity,
  LocalIdentity,
} from './identity';

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

  // Monitoramento passivo desacoplado da sessão PIN (apenas para ponto discreto no DEG)
  private unsubscribeMonitorMessages: Unsubscribe | null = null;
  private unsubscribeMonitorChannel: Unsubscribe | null = null;
  private unsubscribeMonitorAuthWait: Unsubscribe | null = null;
  private cachedMonitorMessages: Message[] = [];
  private cachedMonitorChannel: Room | Conversation | null = null;
  private lastWakeUpFetchTime: number = 0;
  private isWakingUp: boolean = false;

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
        const channelId = this.currentSession.conversationId || this.currentSession.roomId;
        const isConv = Boolean(this.currentSession.conversationId);
        const effectiveUid = getCurrentAuthUser()?.uid || this.currentSession.userId;

        // 1. Marca tombstone no armazenamento local/IndexedDB para o canal ativo
        hideMessagesLocally(channelId, messageIds);
        // 2. Remove do IndexedDB local
        await deleteLocalMessages(messageIds);
        // 3. Se houver mensagens no outbox ainda pendentes, remove para não enviar após apagadas
        for (const id of messageIds) {
          await removeFromOutbox(id).catch(() => {});
        }
        // 4. Marca na nuvem como apagada para este usuário (Opção 2 - deletedFor: [uid])
        // Garante que, ao abrir a conta em qualquer outro aparelho, as mensagens não reapareçam
        if (effectiveUid) {
          markFirestoreMessagesDeletedForUser(channelId, messageIds, effectiveUid, isConv).catch((e) => {
            console.warn('Erro ao sincronizar exclusão com o Firestore:', e);
          });
        }
      },
      onCreateIdentity: async (displayName: string) => {
        return await this.handleCreateIdentity(displayName);
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
    this.persistMonitorContext(session);
    saveLocalRoom(roomToUse).catch(console.warn);

    // Interrompe monitor passivo enquanto o chat ativo assume o canal
    this.stopBackgroundMonitor();

    // 1. DESBLOQUEIO IMEDIATO DA INTERFACE DO CHAT (Zero latência)
    this.ui.showChatView(session, roomToUse);
    this.setConnectionState(navigator.onLine ? 'conectando' : 'offline');

    // 2. Inicia temporizadores de sessão e inatividade (5 minutos padrão)
    this.startSessionTimeout();
    this.resetInactivityTimer();

    // 3. Carrega histórico local imediato do IndexedDB (carregando tombstones antes)
    let latestLocalIso: string | null = null;
    try {
      await loadHiddenMessagesFromDB(roomId);
      const localHistory = await getLocalMessages(roomId, CONFIG.HISTORY_LIMIT);
      const normalized = normalizeAndDeduplicateMessages(localHistory, userId, (id) =>
        isMessageHiddenLocally(roomId, id)
      );
      for (const msg of normalized) {
        this.ui.appendOrUpdateMessage(msg, msg.senderId === userId);
        if (!latestLocalIso || msg.createdAt > latestLocalIso) {
          latestLocalIso = msg.createdAt;
        }
      }
      if (normalized.length >= CONFIG.HISTORY_LIMIT) {
        this.ui.setHasOlderMessages(true);
      }
    } catch (dbErr) {
      console.warn('Erro ao ler mensagens locais:', dbErr);
    }

    // Se offline, marca somente até o último item local consultado e apaga o indicador local
    if (!navigator.onLine && this.ui.isChatActive()) {
      await this.markChatAsRead(false, latestLocalIso || undefined);
    }

    // Layer 4 — 2. Complete Silent Auth (if new session)
    // Autenticação transparente sem prompt visual na calculadora
    const authUser = await silentAuthenticateWithEmail(user);
    const effectiveUid = authUser?.uid || userId;
    if (effectiveUid !== session.userId) {
      session.userId = effectiveUid;
      roomToUse.participantA = effectiveUid;
      this.currentSession = session;
      saveSession(session);
      this.persistMonitorContext(session);
    }

    // Layer 4 — 3. Initialize Firestore Listeners + Sincronização imediata das mensagens pendentes
    await this.connectFirestoreBackground(roomId, effectiveUid, user);

    // Layer 4 — 4. Flush Offline Outbox
    await this.syncPendingOutbox();

    return true;
  }

  /**
   * Conecta ao Firestore em segundo plano com timeout de resiliência e amarração estrita de ciclo de vida:
   * 1. Aguarda a consolidação do Firebase Auth (waitForAuthCompletion)
   * 2. Confirma a existência/gravação do participante na sala com o UID real
   * 3. Apenas depois inicia os listeners do Firestore em tempo real
   */
  private async connectFirestoreBackground(roomId: string, userId: string, user: string): Promise<void> {
    // 1. Aguarda rigorosamente a consolidação do Firebase Auth não-anônimo
    let effectiveUid = getCurrentAuthUser()?.uid;
    if (!isAuthValidAndNonAnonymous() || !effectiveUid) {
      const authUser = await waitForAuthCompletion(4000);
      effectiveUid = authUser?.uid || getCurrentAuthUser()?.uid;
    }

    if (!effectiveUid || !isAuthValidAndNonAnonymous()) {
      console.debug('Talk2TM [Guard]: Conexão Firestore em background retida — aguardando consolidação do Firebase Auth.');
      this.setConnectionState('offline');

      // Escuta reativa: quando a autenticação consolidar no Firebase Auth, re-dispara a amarração automaticamente
      const auth = getFirebaseAuth();
      if (auth) {
        const unsub = onAuthStateChanged(auth, (resolvedUser) => {
          if (resolvedUser && !resolvedUser.isAnonymous) {
            unsub();
            console.info(`Talk2TM [Guard]: Auth consolidado (${resolvedUser.uid}). Conectando Firestore com UID real...`);
            this.connectFirestoreBackground(roomId, resolvedUser.uid, user);
          }
        });
      }
      return;
    }

    // Atualiza a sessão ativa com o UID real do Firebase Auth
    if (this.currentSession && this.currentSession.userId !== effectiveUid) {
      this.currentSession.userId = effectiveUid;
      saveSession(this.currentSession);
      this.persistMonitorContext(this.currentSession);
    }

    try {
      // 2. Garante PRIMEIRO que a sala exista no Firestore e que o participante com seu UID real esteja registrado
      const joinResult = await joinFirestoreRoom(roomId, effectiveUid, user);

      if (joinResult && joinResult.success && joinResult.room) {
        this.currentRoom = joinResult.room;
        await saveLocalRoom(this.currentRoom);
        if (this.currentSession) {
          this.ui.updateRoomInfo(this.currentRoom, this.currentSession);
          this.ui.updateReadReceipts(this.currentRoom, this.currentSession);
        }

        // 3. SOMENTE AGORA que a sala existe e o participante com seu UID real está autenticado e confirmado, ativa os listeners
        this.setupRealtimeListeners(roomId);

        // 4. Busca mensagens mais recentes do servidor e só então marca como consultadas/apaga o indicador
        await this.refreshLatestChannelFromServer(roomId, false, effectiveUid);

        if (this.ui.isChatActive() && this.currentSession) {
          await this.markChatAsRead(true);
        }

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
    // Se a sessão ainda existe, reavalia mensagens recentes locais; se expirou, o monitor passivo assume
    if (!this.currentSession) {
      this.startBackgroundMonitor();
    } else {
      const channelId = this.currentSession.conversationId || this.currentSession.roomId;
      getLocalMessages(channelId, CONFIG.HISTORY_LIMIT)
        .then((msgs) => this.evaluateUnreadIndicator(msgs, this.currentRoom))
        .catch(() => {});
    }
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
    // Limpa mensagens do DOM ao encerrar sessão protegida por PIN
    this.ui.clearMessages();
    // Inicia monitor passivo na calculadora sem manter sessão PIN desbloqueada
    this.startBackgroundMonitor();
  }

  private lastMarkedReadTime: number = 0;

  /**
   * Salva e sincroniza a leitura do chat pelo participante atual.
   * Só apaga o indicador do DEG quando as mensagens pendentes tiverem sido efetivamente consultadas.
   */
  public async markChatAsRead(forceSync: boolean = false, customReadAtIso?: string): Promise<void> {
    if (!this.currentSession) return;
    const now = Date.now();
    const nowIso = customReadAtIso || new Date(now).toISOString();
    const channelId = this.currentSession.conversationId || this.currentSession.roomId;

    // Persiste carimbo local monotônico para evitar falsos não-lidos após bloqueio/reabertura
    saveLocalLastReadTimestamp(channelId, nowIso);

    if (this.ui.isChatActive()) {
      this.ui.setCalculatorUnreadDot(false);
    }

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
    if (!forceSync && now - this.lastMarkedReadTime < 1500) {
      return;
    }
    this.lastMarkedReadTime = now;

    // 3. Atualiza no Firestore se online e autenticado
    if (navigator.onLine && isAuthValidAndNonAnonymous()) {
      if (this.currentSession.conversationId) {
        await updateConversationLastRead(
          this.currentSession.conversationId,
          this.currentSession.userId,
          this.currentSession.displayName,
          nowIso
        );
      } else {
        await updateFirestoreLastRead(
          this.currentSession.roomId,
          this.currentSession.userId,
          this.currentSession.displayName,
          nowIso
        );
      }
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

    const channelId = this.currentSession.conversationId || this.currentSession.roomId;
    const clientId = generateId('cli');
    const messageId = `${channelId}_${clientId}`;
    const nowIso = new Date().toISOString();

    const currentAuth = getCurrentAuthUser();
    const effectiveSenderId = (currentAuth && !currentAuth.isAnonymous ? currentAuth.uid : null) || this.currentSession.userId;
    if (currentAuth && !currentAuth.isAnonymous && this.currentSession.userId !== currentAuth.uid) {
      this.currentSession.userId = currentAuth.uid;
      saveSession(this.currentSession);
    }

    const msg: Message = {
      messageId,
      room: channelId,
      conversationId: this.currentSession.conversationId,
      sender: this.currentSession.displayName,
      senderId: effectiveSenderId,
      senderTalk2tmId: this.currentSession.talk2tmId,
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
          if (this.currentSession.conversationId) {
            await sendFirestoreConversationMessage(msg);
          } else {
            await sendFirestoreMessage(msg);
          }
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

    const channelId = this.currentSession.conversationId || this.currentSession.roomId;
    const currentMessages = await getLocalMessages(channelId, 1000);
    if (currentMessages.length === 0) {
      this.ui.setHasOlderMessages(false);
      return;
    }

    const oldestDate = currentMessages[0].createdAt;
    const olderMessages = await getOlderLocalMessages(
      channelId,
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
        if (msg.conversationId) {
          await sendFirestoreConversationMessage(msg);
        } else {
          await sendFirestoreMessage(msg);
        }
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

  private setupRealtimeListeners(channelId: string): void {
    if (this.unsubscribeMessages) {
      this.unsubscribeMessages();
      this.unsubscribeMessages = null;
    }
    if (this.unsubscribeRoom) {
      this.unsubscribeRoom();
      this.unsubscribeRoom = null;
    }

    // Guarda estrita de ciclo de vida: nunca instancia listeners antes da autenticação consolidada
    if (!isAuthValidAndNonAnonymous()) {
      console.debug('Talk2TM [Guard]: setupRealtimeListeners aguardando consolidação do Firebase Auth...');
      const auth = getFirebaseAuth();
      if (auth) {
        const unsubAuth = onAuthStateChanged(auth, (user) => {
          if (user && !user.isAnonymous) {
            unsubAuth();
            console.debug('Talk2TM [Guard]: Auth resolvido, ativando listeners em tempo real...');
            this.setupRealtimeListeners(channelId);
          }
        });
      }
      return;
    }

    const isConversation = Boolean(this.currentSession?.conversationId);

    if (isConversation && this.currentSession?.conversationId) {
      const convId = this.currentSession.conversationId;
      this.unsubscribeRoom = subscribeToConversation(convId, (conv) => {
        const roomEquivalent = conversationToRoom(conv);
        this.currentRoom = roomEquivalent;
        saveLocalRoom(roomEquivalent);
        if (this.currentSession) {
          this.ui.updateRoomInfo(roomEquivalent, this.currentSession);
          this.ui.updateReadReceipts(roomEquivalent, this.currentSession);
        }
      });

      this.unsubscribeMessages = subscribeToConversationMessages(
        convId,
        async (incomingMessages) => {
          if (!this.currentSession) return;
          const myUid = this.currentSession.userId;
          const visibleIncoming: Message[] = [];
          for (const msg of incomingMessages) {
            // Se foi marcada como deletada para este usuário na nuvem, garante tombstone local e não exibe
            if (msg.deletedFor && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(myUid)) {
              hideMessagesLocally(convId, [msg.messageId]);
              await deleteLocalMessages([msg.messageId]);
              continue;
            }
            if (isMessageHiddenLocally(convId, msg.messageId)) {
              continue;
            }
            await saveLocalMessage(msg);
            visibleIncoming.push(msg);
            if (this.ui.isChatActive()) {
              this.ui.appendOrUpdateMessage(msg, msg.senderId === this.currentSession.userId);
            }
          }
          if (this.ui.isChatActive()) {
            await this.markChatAsRead();
          } else {
            await this.evaluateUnreadIndicator(visibleIncoming, this.currentRoom);
          }
        },
        (err) => {
          console.warn('Listener Firestore da conversa offline:', err);
        }
      );
    } else {
      this.unsubscribeRoom = subscribeToRoom(channelId, (updatedRoom) => {
        this.currentRoom = updatedRoom;
        saveLocalRoom(updatedRoom);
        if (this.currentSession) {
          this.ui.updateRoomInfo(updatedRoom, this.currentSession);
          this.ui.updateReadReceipts(updatedRoom, this.currentSession);
        }
      });

      this.unsubscribeMessages = subscribeToMessages(
        channelId,
        async (incomingMessages) => {
          if (!this.currentSession) return;
          const myUid = this.currentSession.userId;
          const visibleIncoming: Message[] = [];
          for (const msg of incomingMessages) {
            // Se foi marcada como deletada para este usuário na nuvem, garante tombstone local e não exibe
            if (msg.deletedFor && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(myUid)) {
              hideMessagesLocally(channelId, [msg.messageId]);
              await deleteLocalMessages([msg.messageId]);
              continue;
            }
            // Filtro antes de renderizar e antes de re-salvar localmente:
            // Se apagada neste dispositivo, ignora permanentemente
            if (isMessageHiddenLocally(channelId, msg.messageId)) {
              continue;
            }
            await saveLocalMessage(msg);
            visibleIncoming.push(msg);
            if (this.ui.isChatActive()) {
              this.ui.appendOrUpdateMessage(msg, msg.senderId === this.currentSession.userId);
            }
          }
          if (this.ui.isChatActive()) {
            await this.markChatAsRead();
          } else {
            await this.evaluateUnreadIndicator(visibleIncoming, this.currentRoom);
          }
        },
        (err) => {
          console.warn('Listener Firestore offline:', err);
        }
      );
    }
  }

  /**
   * Persiste contexto mínimo para monitoramento passivo sem desbloquear sessão PIN
   */
  private persistMonitorContext(session: UserSession): void {
    const channelId = session.conversationId || session.roomId;
    saveMonitorContext({
      channelId,
      isConversation: Boolean(session.conversationId),
      userId: session.userId,
      displayName: session.displayName,
    });
  }

  /**
   * Encerra listeners do monitor passivo quando o chat está ativo ou antes de recriar conexão
   */
  private stopBackgroundMonitor(): void {
    if (this.unsubscribeMonitorMessages) {
      this.unsubscribeMonitorMessages();
      this.unsubscribeMonitorMessages = null;
    }
    if (this.unsubscribeMonitorChannel) {
      this.unsubscribeMonitorChannel();
      this.unsubscribeMonitorChannel = null;
    }
    if (this.unsubscribeMonitorAuthWait) {
      this.unsubscribeMonitorAuthWait();
      this.unsubscribeMonitorAuthWait = null;
    }
  }

  /**
   * Monitor passivo e desacoplado da sessão protegida por PIN:
   * Quando a calculadora está visível (mesmo após expirar o tempo de sessão),
   * acompanha mensagens recebidas apenas para atualizar o ponto discreto de 6px em DEG.
   */
  public startBackgroundMonitor(forceReattach: boolean = false): void {
    if (this.currentSession && this.ui.isChatActive()) {
      return;
    }

    const ctx = getMonitorContext();
    if (!ctx) return;

    if (!isAuthValidAndNonAnonymous()) {
      const auth = getFirebaseAuth();
      if (auth && !this.unsubscribeMonitorAuthWait) {
        this.unsubscribeMonitorAuthWait = onAuthStateChanged(auth, (resolvedUser) => {
          if (resolvedUser && !resolvedUser.isAnonymous) {
            if (this.unsubscribeMonitorAuthWait) {
              this.unsubscribeMonitorAuthWait();
              this.unsubscribeMonitorAuthWait = null;
            }
            this.startBackgroundMonitor(true);
            void this.handleAppWakeUp(true);
          }
        });
      }
      return;
    }

    if (forceReattach) {
      this.stopBackgroundMonitor();
    } else if (this.unsubscribeMonitorMessages) {
      return;
    }

    const effectiveUid = getCurrentAuthUser()?.uid || ctx.userId;

    if (ctx.isConversation) {
      this.unsubscribeMonitorChannel = subscribeToConversation(ctx.channelId, (conv) => {
        this.cachedMonitorChannel = conv;
        void this.evaluateUnreadIndicator(this.cachedMonitorMessages, conv);
      });

      this.unsubscribeMonitorMessages = subscribeToConversationMessages(
        ctx.channelId,
        async (incoming) => {
          const visible: Message[] = [];
          await loadHiddenMessagesFromDB(ctx.channelId).catch(() => {});
          for (const msg of incoming) {
            if (msg.deletedFor && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(effectiveUid)) {
              hideMessagesLocally(ctx.channelId, [msg.messageId]);
              await deleteLocalMessages([msg.messageId]).catch(() => {});
              continue;
            }
            if (isMessageHiddenLocally(ctx.channelId, msg.messageId)) {
              continue;
            }
            await saveLocalMessage(msg).catch(() => {});
            visible.push(msg);
          }
          this.cachedMonitorMessages = visible;
          await this.evaluateUnreadIndicator(visible, this.cachedMonitorChannel);
        },
        (err) => {
          console.debug('Talk2TM [Monitor]: listener em espera:', err?.message);
        }
      );
    } else {
      this.unsubscribeMonitorChannel = subscribeToRoom(ctx.channelId, (room) => {
        this.cachedMonitorChannel = room;
        saveLocalRoom(room).catch(() => {});
        void this.evaluateUnreadIndicator(this.cachedMonitorMessages, room);
      });

      this.unsubscribeMonitorMessages = subscribeToMessages(
        ctx.channelId,
        async (incoming) => {
          const visible: Message[] = [];
          await loadHiddenMessagesFromDB(ctx.channelId).catch(() => {});
          for (const msg of incoming) {
            if (msg.deletedFor && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(effectiveUid)) {
              hideMessagesLocally(ctx.channelId, [msg.messageId]);
              await deleteLocalMessages([msg.messageId]).catch(() => {});
              continue;
            }
            if (isMessageHiddenLocally(ctx.channelId, msg.messageId)) {
              continue;
            }
            await saveLocalMessage(msg).catch(() => {});
            visible.push(msg);
          }
          this.cachedMonitorMessages = visible;
          await this.evaluateUnreadIndicator(visible, this.cachedMonitorChannel);
        },
        (err) => {
          console.debug('Talk2TM [Monitor]: listener em espera:', err?.message);
        }
      );
    }
  }

  /**
   * Avalia com precisão se há mensagens novas não consultadas e atualiza apenas o ponto discreto do DEG.
   */
  private async evaluateUnreadIndicator(
    messages: Message[],
    channelMeta?: Room | Conversation | null
  ): Promise<void> {
    if (this.ui.isChatActive()) {
      this.ui.setCalculatorUnreadDot(false);
      return;
    }

    const ctx = getMonitorContext();
    const channelId =
      this.currentSession?.conversationId ||
      this.currentSession?.roomId ||
      ctx?.channelId ||
      ACCESS_CONFIG.DEFAULT_ROOM;

    const myUid = getCurrentAuthUser()?.uid || this.currentSession?.userId || ctx?.userId || '';
    const myDisplayName = this.currentSession?.displayName || ctx?.displayName || '';

    const localRoomFallback = channelMeta || this.currentRoom || (await getLocalRoom(channelId).catch(() => null));
    const localStoredRead = getLocalLastReadTimestamp(channelId);
    const channelSelfRead = getSelfLastReadFromChannel(localRoomFallback, myUid, myDisplayName);
    const lastReadIso = maxIsoDate(localStoredRead, channelSelfRead);

    let candidateMessages = messages;
    if (candidateMessages.length === 0) {
      candidateMessages = await getLocalMessages(channelId, CONFIG.HISTORY_LIMIT).catch(() => []);
    }

    const hasUnread = hasUnreadIncomingMessage({
      messages: candidateMessages,
      myUid,
      myDisplayName,
      lastReadIso,
      isHiddenFn: (id) => isMessageHiddenLocally(channelId, id),
    });

    this.ui.setCalculatorUnreadDot(hasUnread);
  }

  /**
   * Busca mensagens e metadados recentes diretamente do servidor para o canal informado,
   * garantindo atualização imediata após acordar do repouso ou ao entrar no chat.
   */
  private async refreshLatestChannelFromServer(
    channelId: string,
    isConversation: boolean,
    myUid: string
  ): Promise<Message[]> {
    if (!navigator.onLine || !isAuthValidAndNonAnonymous()) {
      return [];
    }

    const [latestMessages, latestMeta] = await Promise.all([
      fetchLatestMessagesFromServer(channelId, isConversation, myUid).catch(() => []),
      fetchChannelMetadataFromServer(channelId, isConversation).catch(() => null),
    ]);

    if (latestMeta) {
      this.cachedMonitorChannel = latestMeta;
      if (isConversation && 'conversationId' in latestMeta) {
        const roomEquiv = conversationToRoom(latestMeta);
        this.currentRoom = roomEquiv;
        saveLocalRoom(roomEquiv).catch(() => {});
        if (this.currentSession) {
          this.ui.updateRoomInfo(roomEquiv, this.currentSession);
          this.ui.updateReadReceipts(roomEquiv, this.currentSession);
        }
      } else if ('roomId' in latestMeta) {
        this.currentRoom = latestMeta;
        saveLocalRoom(latestMeta).catch(() => {});
        if (this.currentSession) {
          this.ui.updateRoomInfo(latestMeta, this.currentSession);
          this.ui.updateReadReceipts(latestMeta, this.currentSession);
        }
      }
    }

    const visible: Message[] = [];
    await loadHiddenMessagesFromDB(channelId).catch(() => {});
    for (const msg of latestMessages) {
      if (msg.deletedFor && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(myUid)) {
        hideMessagesLocally(channelId, [msg.messageId]);
        await deleteLocalMessages([msg.messageId]).catch(() => {});
        continue;
      }
      if (isMessageHiddenLocally(channelId, msg.messageId)) {
        continue;
      }
      await saveLocalMessage(msg).catch(() => {});
      visible.push(msg);
      if (this.currentSession && this.ui.isChatActive()) {
        this.ui.appendOrUpdateMessage(msg, msg.senderId === myUid);
      }
    }

    return visible;
  }

  /**
   * Recuperação ao retornar do repouso (visibilitychange / focus / online):
   * Reconecta listeners caso o socket do SO tenha dormido e consulta o servidor diretamente.
   */
  public async handleAppWakeUp(force: boolean = false): Promise<void> {
    if (this.isWakingUp) return;
    const now = Date.now();
    if (!force && now - this.lastWakeUpFetchTime < 800) {
      return;
    }

    if (!navigator.onLine) return;

    this.isWakingUp = true;
    const elapsedSinceLastWake = now - this.lastWakeUpFetchTime;
    this.lastWakeUpFetchTime = now;

    try {
      if (!isAuthValidAndNonAnonymous()) {
        await restoreAuthSession(1500);
      }
      if (!isAuthValidAndNonAnonymous()) {
        return;
      }

      if (this.currentSession) {
        const channelId = this.currentSession.conversationId || this.currentSession.roomId;
        const isConv = Boolean(this.currentSession.conversationId);
        const myUid = getCurrentAuthUser()?.uid || this.currentSession.userId;

        // Reanexa listeners se ficou tempo suficiente em repouso para o WebSocket cair
        if (force || elapsedSinceLastWake > 15000 || !this.unsubscribeMessages) {
          this.setupRealtimeListeners(channelId);
        }

        const visible = await this.refreshLatestChannelFromServer(channelId, isConv, myUid);
        if (this.ui.isChatActive()) {
          await this.markChatAsRead();
          await this.syncPendingOutbox();
        } else {
          await this.evaluateUnreadIndicator(visible, this.currentRoom);
        }
      } else {
        const ctx = getMonitorContext();
        if (!ctx) return;

        const effectiveUid = getCurrentAuthUser()?.uid || ctx.userId;
        if (force || elapsedSinceLastWake > 15000 || !this.unsubscribeMonitorMessages) {
          this.startBackgroundMonitor(true);
        }

        const visible = await this.refreshLatestChannelFromServer(ctx.channelId, ctx.isConversation, effectiveUid);
        this.cachedMonitorMessages = visible;
        await this.evaluateUnreadIndicator(visible, this.cachedMonitorChannel);
      }
    } catch (err) {
      console.debug('Talk2TM [WakeUp]: sincronização em segundo plano adiou:', err);
    } finally {
      this.isWakingUp = false;
    }
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
      if (document.visibilityState === 'visible') {
        void this.handleAppWakeUp();
      }
    });
    window.addEventListener('focus', () => {
      void this.handleAppWakeUp();
    });
  }

  private setupNetworkMonitoring(): void {
    window.addEventListener('online', () => {
      this.setConnectionState('online');
      void this.syncPendingOutbox();
      void this.handleAppWakeUp(true);
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
          // Se já houver uma nova versão aguardando ativação, ativa imediatamente
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }

          // Checa atualização no servidor imediatamente
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

          // Auto-atualização transparente quando o usuário reabre ou foca no app
          window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
              reg.update().catch(() => {});
            }
          });

          // Verificação periódica em segundo plano a cada 60 segundos
          setInterval(() => {
            if (navigator.onLine) {
              reg.update().catch(() => {});
            }
          }, 60 * 1000);
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
      this.persistMonitorContext(savedSession);
      const savedRoom = await getLocalRoom(savedSession.roomId).catch(() => null);
      if (savedRoom) this.currentRoom = savedRoom;
      this.ui.showChatView(savedSession, savedRoom || undefined);
      this.startSessionTimeout();
      this.resetInactivityTimer();

      const channelId = savedSession.conversationId || savedSession.roomId;
      let latestLocalIso: string | null = null;
      try {
        await loadHiddenMessagesFromDB(channelId);
        const localHistory = await getLocalMessages(channelId, CONFIG.HISTORY_LIMIT);
        const normalized = normalizeAndDeduplicateMessages(localHistory, savedSession.userId, (id) =>
          isMessageHiddenLocally(channelId, id)
        );
        for (const msg of normalized) {
          this.ui.appendOrUpdateMessage(msg, msg.senderId === savedSession.userId);
          if (!latestLocalIso || msg.createdAt > latestLocalIso) {
            latestLocalIso = msg.createdAt;
          }
        }
      } catch (e) {
        console.warn('Erro ao restaurar histórico de mensagens:', e);
      }

      if (!navigator.onLine && this.ui.isChatActive()) {
        await this.markChatAsRead(false, latestLocalIso || undefined);
      }

      // Layer 4 — 3. Initialize Firestore Listeners + Sync imediato ao entrar
      if (savedSession.conversationId) {
        await this.connectToConversation(savedSession.conversationId);
      } else {
        await this.connectFirestoreBackground(savedSession.roomId, savedSession.userId, savedSession.displayName);
      }

      // Layer 4 — 4. Flush Offline Outbox
      await this.syncPendingOutbox();
      return;
    }

    // Se houver identidade local prévia salva da Fase 2, restaura silenciosamente
    const localIdentity = await restoreLocalIdentity().catch(() => null);
    if (localIdentity && isAuthValidAndNonAnonymous()) {
      console.info(`Talk2TM [Identity]: Identidade ${localIdentity.talk2tmId} restaurada para ${localIdentity.displayName}`);
    }

    this.setConnectionState(navigator.onLine ? 'online' : 'offline');
    this.ui.showCalculatorView();

    // Calculadora visível ao abrir PWA: ativa monitor passivo se já houver contexto e auth válidos
    if (getMonitorContext()) {
      this.startBackgroundMonitor();
      if (navigator.onLine && isAuthValidAndNonAnonymous()) {
        void this.handleAppWakeUp(true);
      }
    }
  }

  /**
   * Onboarding Ultraleve (Fase 2):
   * Cria nova conta e perfil associados ao Talk2TM ID (TM-XXXX-XXXX) sem exigir email ou senha do usuário.
   */
  public async handleCreateIdentity(displayName: string): Promise<string> {
    const identity = await createTalk2TMIdentity(displayName);
    const roomId = ACCESS_CONFIG.DEFAULT_ROOM;

    const session: UserSession = {
      userId: identity.uid,
      displayName: identity.displayName,
      roomId,
      talk2tmId: identity.talk2tmId,
    };

    const nowIso = new Date().toISOString();
    const roomToUse: Room = {
      roomId,
      participantA: identity.uid,
      participantAName: identity.displayName,
      participantB: null,
      participantBName: null,
      createdAt: nowIso,
      lastActivity: nowIso,
    };

    this.currentSession = session;
    this.currentRoom = roomToUse;
    saveSession(session);
    this.persistMonitorContext(session);
    saveLocalRoom(roomToUse).catch(console.warn);

    // Desbloqueio imediato da interface do chat com o novo código
    setTimeout(() => {
      this.stopBackgroundMonitor();
      this.ui.showChatView(session, roomToUse);
      this.setConnectionState(navigator.onLine ? 'online' : 'offline');
      this.startSessionTimeout();
      this.resetInactivityTimer();
    }, 800);

    return identity.talk2tmId;
  }

  /**
   * Conecta a sessão ativa a um canal de conversa bilateral (Fase 4).
   * Carrega histórico local com tombstones, vincula listeners em tempo real e sincroniza outbox.
   */
  public async connectToConversation(conversationId: string): Promise<void> {
    if (!this.currentSession) return;
    this.currentSession.conversationId = conversationId;
    saveSession(this.currentSession);
    this.persistMonitorContext(this.currentSession);
    this.stopBackgroundMonitor();

    // Carrega mensagens locais do IndexedDB para a conversa respeitando tombstones
    let latestLocalIso: string | null = null;
    try {
      await loadHiddenMessagesFromDB(conversationId);
      const localHistory = await getLocalMessages(conversationId, CONFIG.HISTORY_LIMIT);
      const normalized = normalizeAndDeduplicateMessages(localHistory, this.currentSession.userId, (id) =>
        isMessageHiddenLocally(conversationId, id)
      );
      this.ui.clearMessages();
      for (const msg of normalized) {
        this.ui.appendOrUpdateMessage(msg, msg.senderId === this.currentSession.userId);
        if (!latestLocalIso || msg.createdAt > latestLocalIso) {
          latestLocalIso = msg.createdAt;
        }
      }
      if (normalized.length >= CONFIG.HISTORY_LIMIT) {
        this.ui.setHasOlderMessages(true);
      }
    } catch (err) {
      console.warn('Erro ao carregar mensagens locais da conversa:', err);
    }

    if (!navigator.onLine && this.ui.isChatActive()) {
      await this.markChatAsRead(false, latestLocalIso || undefined);
    }

    // Garante consolidação do Firebase Auth antes de amarrar listeners na conversa
    if (!isAuthValidAndNonAnonymous()) {
      await waitForAuthCompletion(3000);
    }

    // Configura listeners em tempo real para conversations/{conversationId} e sincroniza do servidor
    this.setupRealtimeListeners(conversationId);
    const myUid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    await this.refreshLatestChannelFromServer(conversationId, true, myUid);
    if (this.ui.isChatActive()) {
      await this.markChatAsRead(true);
    }
    await this.syncPendingOutbox();
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
