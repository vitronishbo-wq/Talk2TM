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
  normalizeSettingsLanguage,
  saveSettings,
} from './config';
import { initI18n, prefetchLocaleChunks, setAppLocale, t } from './i18n';
import {
  Conversation,
  ConversationInvite,
  ConnectionState,
  DatingDiscoveryFilters,
  DatingDiscoveryResult,
  DatingEvaluationDecision,
  DatingLikeResult,
  DatingMatch,
  DatingProfile,
  DatingProfileInput,
  Message,
  ReportReason,
  ReportSourceType,
  Room,
  UserSession,
} from './types';
import {
  blockUserConnection,
  checkAndRecordMessageBurst,
  isLocallyBlockedPair,
  loadLocalBlockedUids,
  submitModerationReport,
  subscribeToUserBlocks,
} from './safety';
import {
  buildDatingMatchId,
  discoverDatingProfiles,
  ensureConversationForDatingMatch,
  getDatingMatchPartner,
  getOwnDatingProfile,
  getUnmatchedConversationIds,
  getUnseenDatingMatches,
  loadLocalDatingMatches,
  loadSavedDatingFilters,
  loadSavedDatingProfile,
  markDatingMatchChatStarted,
  markDatingMatchSeen,
  recordDatingEvaluation,
  removeOwnDatingPhoto,
  saveLocalDatingFilters,
  saveLocalDatingMatches,
  sendSecretDatingLike,
  setDatingProfileVisibility,
  subscribeToDatingMatchById,
  subscribeToDatingMatches,
  unmatchDatingConnection,
  updateOwnDatingPhoto,
  upsertOwnDatingProfile,
  validateDatingFilters,
} from './dating';
import { dispatchDiscreetNotification } from './notifications';
import { recordUserWeeklyActivityIfNeeded } from './growth';
import {
  attributeRegistrationReferral,
  buildCanonicalReferralUrl,
  buildWhatsAppReferralShareUrl,
  clearPendingReferralCode,
  deriveDeterministicReferralCode,
  extractReferralCodeFromSearch,
  fetchOwnReferralMetrics,
  fetchPublicReferralInvite,
  getPendingReferralCode,
  incrementOwnReferralShareCount,
  loadCachedReferralMetrics,
  savePendingReferralCode,
} from './referral';
import { generateId, sanitizeMessageText } from './utils/sanitize';
import {
  addToOutbox,
  clearSession,
  clearMonitorContext,
  getLocalMessages,
  getOlderLocalMessages,
  getOutboxMessages,
  removeFromOutbox,
  saveLocalMessage,
  saveLocalRoom,
  getLocalRoom,
  saveLocalConversation,
  getLocalConversation,
  getLocalConversationsForUser,
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
  clearBilateralLocalStores,
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
  syncAuthState,
  updateFirestoreLastRead,
  updateConversationLastRead,
  markFirestoreMessagesDeletedForUser,
  fetchLatestMessagesFromServer,
  fetchChannelMetadataFromServer,
  getConversationById,
  getOrCreateConversation,
  sendConversationInviteByPhone,
  fetchUserProfileByTalk2tmId,
  acceptConversationInvite,
  declineConversationInvite,
  cancelConversationInvite,
  subscribeToIncomingInvites,
  subscribeToOutgoingInvites,
  subscribeToUserConversations,
  subscribeToOwnUserProfile,
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
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { testRealtimeSyncAtoB } from './firebase/diagnostic';
import {
  applyLocalResetEpochIfNeeded,
  associateRecoveryEmailWithPin,
  authenticateVaultIdentity,
  completePasswordResetInApp,
  deleteOwnAccountCompletely,
  findLocalIdentityByPin,
  getActiveVaultPinLengths,
  getAllLocalIdentities,
  getLocalIdentity,
  recoverPhoneIdentity,
  regenerateRecoveryCodeWithPin,
  registerPhoneIdentity,
  restoreLocalIdentity,
  sendPasswordResetForRecoveryEmail,
  updateLocalPinForAccount,
  verifyInAppPasswordResetCode,
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
      error: t('app.authEmpty'),
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
    error: t('app.authInvalid'),
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
  private outboxRetryTimerId: ReturnType<typeof setTimeout> | null = null;
  private outboxRetryAttempt: number = 0;
  private isSyncingOutbox: boolean = false;
  private activeChatHeartbeatId: ReturnType<typeof setInterval> | null = null;

  // Hub de Conexões Bilaterais (convites e conversas 1:1)
  private unsubscribeIncomingInvites: Unsubscribe | null = null;
  private unsubscribeOutgoingInvites: Unsubscribe | null = null;
  private unsubscribeUserConversations: Unsubscribe | null = null;
  private unsubscribeHubAuthWait: Unsubscribe | null = null;
  private hubIncomingInvites: ConversationInvite[] = [];
  private hubOutgoingInvites: ConversationInvite[] = [];
  private hubConversations: Conversation[] = [];
  private hubHasRemoteConversationsSnapshot: boolean = false;
  private knownAcceptedInviteIds: Set<string> = new Set();
  private pendingOnboardingSession: UserSession | null = null;
  private isCheckingCustomPin: boolean = false;
  private adminOverlayController: { destroy: () => Promise<void> } | null = null;
  private unsubscribeOwnProfile: Unsubscribe | null = null;
  private unsubscribeUserBlocks: Unsubscribe | null = null;
  private unsubscribeDatingMatches: Unsubscribe | null = null;
  private unsubscribeActiveChatMatch: Unsubscribe | null = null;
  private blockedPeerUids: Set<string> = new Set();
  private hubDatingMatches: DatingMatch[] = [];
  private notifiedUnseenMatchIds: Set<string> = new Set();
  private knownMonitorMsgIds: Set<string> = new Set();
  private hasInitializedMonitorMsgs: boolean = false;
  private lastMonitorChannelId: string | null = null;
  private knownRealtimeMsgIds: Set<string> = new Set();
  private hasInitializedRealtimeMsgs: boolean = false;

  constructor(container: HTMLElement) {
    this.appSettings = loadSettings();

    this.ui = new ChatUI(container, this.appSettings, {
      onUnlockByPin: (password: string) => this.unlockChatWithPassword(password),
      onCheckCustomPin: async (displayValue: string, inputSequence: string) => {
        return await this.tryUnlockCustomPinFromCalculator(displayValue, inputSequence);
      },
      onOpenAdminRoute: () => {
        void this.openAdminOverlay();
      },
      onLockToCalculator: () => this.lockToCalculator(),
      onSendMessage: (text: string) => this.sendMessage(text),
      onLoadOlder: () => this.loadOlderMessages(),
      onUpdateSettings: (settings: AppSettings) => this.updateSettings(settings),
      onDeleteMessagesLocally: async (messageIds: string[]) => {
        if (!this.currentSession) return;
        const channelId = this.currentSession.conversationId || this.currentSession.roomId;
        if (!channelId) return;
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
      onCreateIdentity: async (params) => {
        return await this.handleCreateIdentity(params);
      },
      onFinishOnboarding: async () => {
        await this.handleFinishOnboarding();
      },
      onRecoverIdentity: async (params) => {
        await this.handleRecoverIdentity(params);
      },
      onSendPasswordResetEmail: async (email: string) => {
        return await sendPasswordResetForRecoveryEmail(email);
      },
      onCompleteInAppPasswordReset: async (params) => {
        await this.handleCompleteInAppPasswordReset(params);
      },
      onRegenerateRecoveryCode: async (currentPin: string, customRecoveryCode?: string) => {
        return await this.handleRegenerateRecoveryCode(currentPin, customRecoveryCode);
      },
      onAssociateRecoveryEmail: async (currentPin: string, email: string) => {
        return await this.handleAssociateRecoveryEmail(currentPin, email);
      },
      onChangeLocalPin: async (currentPin: string, newPin: string) => {
        await this.handleChangeLocalPin(currentPin, newPin);
      },
      onSendInvite: async (targetPhone: string) => {
        await this.handleSendInvite(targetPhone);
      },
      onAcceptInvite: async (invite: ConversationInvite) => {
        await this.handleAcceptInvite(invite);
      },
      onDeclineInvite: async (inviteId: string) => {
        await this.handleDeclineInvite(inviteId);
      },
      onCancelInvite: async (inviteId: string) => {
        await this.handleCancelInvite(inviteId);
      },
      onOpenConversation: async (conversationId: string) => {
        await this.connectToConversation(conversationId);
      },
      onShowConnectHub: () => {
        if (this.currentSession?.talk2tmId) {
          void this.openBilateralHub(this.currentSession);
        }
      },
      onLoadDatingWorkspace: async () => {
        return await this.handleLoadDatingWorkspace();
      },
      onSaveDatingProfile: async (input: DatingProfileInput) => {
        return await this.handleSaveDatingProfile(input);
      },
      onSetDatingVisibility: async (opts: { discoverable?: boolean; paused?: boolean }) => {
        return await this.handleSetDatingVisibility(opts);
      },
      onDiscoverDating: async (filters: DatingDiscoveryFilters, cursorUpdatedAt?: string) => {
        return await this.handleDiscoverDating(filters, cursorUpdatedAt);
      },
      onEvaluateDatingProfile: async (
        targetUid: string,
        decision: DatingEvaluationDecision
      ) => {
        await this.handleEvaluateDatingProfile(targetUid, decision);
      },
      onLikeDatingCandidate: async (candidate: DatingProfile) => {
        return await this.handleLikeDatingCandidate(candidate);
      },
      onOpenDatingMatchChat: async (match: DatingMatch) => {
        await this.handleOpenDatingMatchChat(match);
      },
      onUnmatchDating: async (matchId: string) => {
        await this.handleUnmatchDating(matchId);
      },
      onMarkDatingMatchSeen: async (match: DatingMatch) => {
        await this.handleMarkDatingMatchSeen(match);
      },
      onReportTarget: async (params) => {
        await this.handleReportTarget(params);
      },
      onBlockUser: async (targetUid: string, targetName: string) => {
        await this.handleBlockUser(targetUid, targetName);
      },
      onDeleteOwnAccount: async (currentPin: string) => {
        await this.handleDeleteOwnAccount(currentPin);
      },
      onUploadDatingPhoto: async (blob: Blob) => {
        return await this.handleUploadDatingPhoto(blob);
      },
      onRemoveDatingPhoto: async () => {
        return await this.handleRemoveDatingPhoto();
      },
      onTrackReferralShare: async (referralCode: string) => {
        const uid = getCurrentAuthUser()?.uid || this.currentSession?.userId;
        if (!uid) return 0;
        return await incrementOwnReferralShareCount(uid, referralCode);
      },
    });

    this.setupNetworkMonitoring();
    this.setupActivityListeners();
    this.registerServiceWorker();
    prefetchLocaleChunks();
  }

  private async openAdminOverlay(): Promise<void> {
    if (this.adminOverlayController) return;

    // Suspende sessão PIN ou monitor passivo sem apagar o cofre local nem o MonitorContext
    if (this.currentSession) {
      this.leaveSession();
    }
    this.stopBackgroundMonitor();
    this.ui.hideAllPrimaryViews();

    try {
      const { mountAdminOverlay } = await import('./ui/admin');
      if (this.adminOverlayController) return;

      this.adminOverlayController = mountAdminOverlay(this.ui.getAppWrapper(), {
        onExit: () => {
          this.adminOverlayController = null;
          this.ui.showCalculatorView();
          if (getMonitorContext()) {
            this.startBackgroundMonitor(true);
          }
        },
      });
    } catch (err) {
      console.error('Erro ao abrir interface administrativa:', err);
      this.adminOverlayController = null;
      this.ui.showCalculatorView();
      if (getMonitorContext()) {
        this.startBackgroundMonitor(true);
      }
      this.ui.showTemporaryNotice(t('app.adminLoadFailed'));
    }
  }

  private async tryUnlockCustomPinFromCalculator(
    displayValue: string,
    inputSequence: string
  ): Promise<boolean> {
    if (this.adminOverlayController || this.currentSession || this.isCheckingCustomPin) return false;
    const lengths = getActiveVaultPinLengths();
    if (lengths.length === 0) return false;

    this.isCheckingCustomPin = true;
    try {
      const candidates: string[] = [];
      const cleanDisplay = (displayValue || '').trim();
      const cleanSeq = (inputSequence || '').trim();

      if (/^\d{4,8}$/.test(cleanDisplay) && lengths.includes(cleanDisplay.length)) {
        candidates.push(cleanDisplay);
      }
      for (const len of lengths) {
        if (cleanDisplay.length > len) {
          const suffix = cleanDisplay.slice(-len);
          if (/^\d+$/.test(suffix) && !candidates.includes(suffix)) {
            candidates.push(suffix);
          }
        }
        if (cleanSeq.length >= len) {
          const suffix = cleanSeq.slice(-len);
          if (/^\d+$/.test(suffix) && !candidates.includes(suffix)) {
            candidates.push(suffix);
          }
        }
      }

      for (const pin of candidates) {
        const matched = await findLocalIdentityByPin(pin);
        if (matched) {
          await this.unlockWithLocalIdentity(matched, pin);
          return true;
        }
      }
      return false;
    } finally {
      this.isCheckingCustomPin = false;
    }
  }

  /**
   * Ponto central de desbloqueio:
   * Processa a entrada do campo único de PIN/senha e, se válida, desbloqueia IMEDIATAMENTE
   * a interface do chat de forma otimista, sem travar na rede.
   */
  public async unlockChatWithPassword(password: string): Promise<boolean> {
    if (this.adminOverlayController) return false;
    const cleanInput = (password || '').trim();
    const verification = verifyPassword(cleanInput);

    if (!verification.valid || !verification.user || !verification.userId) {
      const vaultMatch = await findLocalIdentityByPin(cleanInput);
      if (vaultMatch) {
        return await this.unlockWithLocalIdentity(vaultMatch, cleanInput);
      }

      const legacyIdentity = getLocalIdentity();
      if (
        legacyIdentity &&
        !legacyIdentity.pinFastHash &&
        cleanInput.toUpperCase() === legacyIdentity.talk2tmId.toUpperCase()
      ) {
        return await this.unlockWithLocalIdentity(legacyIdentity);
      }

      const isTmInput = /^TM-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(cleanInput);
      const hasSavedVault = getAllLocalIdentities().length > 0;
      let errMsg: string;
      if (isTmInput) {
        errMsg = t('pass.errNeedNumericPin');
      } else if (!hasSavedVault) {
        errMsg = t('pass.errNoSavedVault');
      } else {
        errMsg = t('pass.errWrongPin');
      }
      this.ui.showPassError(errMsg);
      this.ui.showTemporaryNotice(errMsg);
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

    // 2. Inicia temporizadores de sessão, inatividade e sync leve de chat ativo
    this.startSessionTimeout();
    this.resetInactivityTimer();
    this.startActiveChatSyncLoop();

    // 3. Carrega histórico local imediato do IndexedDB (carregando tombstones antes)
    let latestLocalIso: string | null = null;
    try {
      await loadHiddenMessagesFromDB(roomId);
      const localHistory = await getLocalMessages(roomId, CONFIG.HISTORY_LIMIT);
      const normalized = normalizeAndDeduplicateMessages(localHistory, userId, (id) =>
        isMessageHiddenLocally(roomId, id)
      );
      for (const msg of normalized) {
        this.ui.appendOrUpdateMessage(msg, this.isOwnMessage(msg, session));
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

        if (this.ui.isChatActive() && document.visibilityState === 'visible' && this.currentSession) {
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
    this.leaveSession();
    this.ui.showCalculatorView();
  }

  private stopOwnProfileSubscription(): void {
    if (this.unsubscribeOwnProfile) {
      this.unsubscribeOwnProfile();
      this.unsubscribeOwnProfile = null;
    }
  }

  private handleAccountSuspended(talk2tmId: string): void {
    if (!this.currentSession || this.currentSession.talk2tmId !== talk2tmId) {
      return;
    }
    this.leaveSession();
    this.stopBackgroundMonitor();
    this.ui.showCalculatorView();
    this.ui.showTemporaryNotice(t('app.accountSuspended'));
  }

  private attachOwnProfileSuspensionGuard(talk2tmId?: string): void {
    this.stopOwnProfileSubscription();
    if (!talk2tmId || !isAuthValidAndNonAnonymous()) {
      return;
    }
    this.unsubscribeOwnProfile = subscribeToOwnUserProfile(talk2tmId, (profile) => {
      if (profile.active === false) {
        this.handleAccountSuspended(talk2tmId);
      }
    });
  }

  private stopUserBlocksSubscription(): void {
    if (this.unsubscribeUserBlocks) {
      this.unsubscribeUserBlocks();
      this.unsubscribeUserBlocks = null;
    }
  }

  private getConversationPartnerUid(
    convOrRoom: { participantA?: string; participantB?: string | null } | null | undefined,
    myUid: string
  ): string | null {
    if (!convOrRoom || !myUid) return null;
    if (convOrRoom.participantA === myUid) return convOrRoom.participantB || null;
    if (convOrRoom.participantB === myUid) return convOrRoom.participantA || null;
    return null;
  }

  private isPeerBlocked(myUid: string, peerUid?: string | null): boolean {
    if (!myUid || !peerUid || myUid === peerUid) return false;
    return this.blockedPeerUids.has(peerUid) || isLocallyBlockedPair(myUid, peerUid);
  }

  private filterUnblockedDatingMatches(matches: DatingMatch[], myUid: string): DatingMatch[] {
    if (!myUid) return matches;
    return matches.filter((m) => !this.isPeerBlocked(myUid, getDatingMatchPartner(m, myUid).uid));
  }

  private syncBlockedStateAcrossViews(myUid: string): void {
    const filteredMatches = this.filterUnblockedDatingMatches(this.hubDatingMatches, myUid);
    if (this.ui.isConnectViewActive()) {
      this.ui.updateDatingMatches(filteredMatches, myUid);
      this.renderConnectHubData();
    }
    if (this.currentSession?.conversationId && this.currentRoom) {
      const partnerUid = this.getConversationPartnerUid(this.currentRoom, myUid);
      const blocked = Boolean(partnerUid && this.isPeerBlocked(myUid, partnerUid));
      this.ui.setChatBlockedState(blocked);
      if (blocked && this.ui.isChatActive()) {
        this.ui.showTemporaryNotice(t('safety.blockedChatNotice'));
      }
    }
  }

  private attachUserBlocksSubscription(uid?: string): void {
    if (!uid) return;
    const localBlocked = loadLocalBlockedUids(uid);
    this.blockedPeerUids = new Set(localBlocked);

    this.stopUserBlocksSubscription();
    if (!isAuthValidAndNonAnonymous()) return;

    this.unsubscribeUserBlocks = subscribeToUserBlocks(uid, (peerUids) => {
      this.blockedPeerUids = peerUids;
      this.syncBlockedStateAcrossViews(uid);
    });
  }

  public leaveSession(): void {
    this.stopAllTimers();
    this.stopActiveChatSyncLoop();
    this.stopActiveChatMatchSubscription();
    this.stopConnectHubListeners();
    this.stopOwnProfileSubscription();
    this.stopUserBlocksSubscription();
    this.blockedPeerUids.clear();
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
    // Continua tentando drenar outbox pendente em segundo plano se houver Auth ativo
    void this.syncPendingOutbox();
    // Inicia monitor passivo na calculadora sem manter sessão PIN desbloqueada
    this.startBackgroundMonitor();
  }

  private lastMarkedReadTime: number = 0;

  /**
   * Identifica se uma mensagem pertence ao utilizador atual mesmo antes de o Firebase Auth
   * consolidar o UID real (ex.: cache local com usr_truman/usr_maezinha vs uid real).
   */
  private isOwnMessage(msg: Message, session: UserSession): boolean {
    const authUid = getCurrentAuthUser()?.uid;
    return (
      msg.senderId === session.userId ||
      (Boolean(authUid) && msg.senderId === authUid) ||
      (Boolean(session.displayName) && msg.sender === session.displayName) ||
      (Boolean(session.talk2tmId) && msg.senderTalk2tmId === session.talk2tmId)
    );
  }

  /**
   * Resolve o displayName legível de mensagens de conversa bilateral a partir dos metadados da conversa,
   * evitando exibir o código bruto TM-XXXX-XXXX quando o nome de exibição é conhecido.
   */
  private resolveConversationSenderName(msg: Message, roomOverride?: Room | null): Message {
    const room = roomOverride || this.currentRoom;
    const session = this.currentSession;
    if (!session?.conversationId && !msg.conversationId) {
      return msg;
    }
    let resolvedName = msg.sender;
    if (room) {
      if (msg.senderId === room.participantA && room.participantAName) {
        resolvedName = room.participantAName;
      } else if (msg.senderId === room.participantB && room.participantBName) {
        resolvedName = room.participantBName;
      }
    }
    if ((!resolvedName || /^TM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(resolvedName)) && session) {
      if (msg.senderId === session.userId || (session.talk2tmId && msg.senderTalk2tmId === session.talk2tmId)) {
        resolvedName = session.displayName;
      }
    }
    return resolvedName === msg.sender ? msg : { ...msg, sender: resolvedName };
  }

  /**
   * Salva e sincroniza a leitura do chat pelo participante atual.
   * Só apaga o indicador do DEG quando as mensagens pendentes tiverem sido efetivamente consultadas.
   */
  public async markChatAsRead(forceSync: boolean = false, customReadAtIso?: string): Promise<void> {
    if (!this.currentSession) return;
    const now = Date.now();
    const nowIso = customReadAtIso || new Date(now).toISOString();
    const channelId = this.currentSession.conversationId || this.currentSession.roomId;

    // Persiste carimbo local monotônico por utilizador para evitar mistura ou falsos não-lidos
    saveLocalLastReadTimestamp(channelId, nowIso, this.currentSession.userId);

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
      this.ui.showTemporaryNotice(sanitized.error || t('chat.msgInvalid'));
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

    if (this.currentSession.conversationId) {
      const partnerUid = this.getConversationPartnerUid(this.currentRoom, effectiveSenderId);
      if (partnerUid && this.isPeerBlocked(effectiveSenderId, partnerUid)) {
        this.ui.setChatBlockedState(true);
        this.ui.showTemporaryNotice(t('safety.blockedChatNotice'));
        return;
      }
    }

    try {
      checkAndRecordMessageBurst(effectiveSenderId, sanitized.text);
    } catch (rateErr: any) {
      this.ui.showTemporaryNotice(rateErr?.message || t('safety.errRateLimitMessages'));
      return;
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
    if (this.currentSession.conversationId) {
      void markDatingMatchChatStarted({
        conversationId: this.currentSession.conversationId,
        myUid: effectiveSenderId,
        participantA: this.currentRoom?.participantA,
        participantB: this.currentRoom?.participantB,
      });
    }

    // Explicit guard check: procede APENAS se auth.currentUser != null e auth.currentUser.isAnonymous === false.
    // Aguarda consolidação rápida do Auth se ainda estiver finalizando nos primeiros segundos após abrir o chat.
    if (navigator.onLine) {
      if (!isAuthValidAndNonAnonymous()) {
        await waitForAuthCompletion(3000);
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
          if (this.currentSession && this.ui.isChatActive()) {
            this.ui.appendOrUpdateMessage(syncedMsg, true);
          }
          return;
        } catch (error) {
          console.warn('Mensagem mantida no outbox local para reenvio automático:', error);
          this.scheduleOutboxRetry();
        }
      } else {
        this.scheduleOutboxRetry();
      }
    } else {
      this.scheduleOutboxRetry();
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
      const resolvedOlder = olderMessages.map((m) => this.resolveConversationSenderName(m));
      this.ui.prependMessages(
        resolvedOlder,
        this.currentSession.userId,
        this.currentSession.displayName
      );
    }

    if (olderMessages.length < CONFIG.HISTORY_LIMIT) {
      this.ui.setHasOlderMessages(false);
    }
  }

  public updateSettings(newSettings: AppSettings): void {
    const normalizedLanguage = normalizeSettingsLanguage(newSettings.language);
    const nextSettings: AppSettings = { ...newSettings, language: normalizedLanguage };
    this.appSettings = nextSettings;
    saveSettings(nextSettings);

    if (this.currentSession) {
      this.startSessionTimeout();
      this.resetInactivityTimer();
    }

    void setAppLocale(normalizedLanguage).then(() => {
      this.ui.refreshLocale();
      this.ui.showTemporaryNotice(t('settings.updated'));
    });
  }

  private scheduleOutboxRetry(): void {
    if (this.outboxRetryTimerId) return;
    const delays = [4000, 10000, 20000, 30000];
    const delayMs = delays[Math.min(this.outboxRetryAttempt, delays.length - 1)];
    this.outboxRetryAttempt++;
    this.outboxRetryTimerId = setTimeout(() => {
      this.outboxRetryTimerId = null;
      void this.syncPendingOutbox();
    }, delayMs);
  }

  private startActiveChatSyncLoop(): void {
    if (this.activeChatHeartbeatId) return;
    this.activeChatHeartbeatId = setInterval(() => {
      if (
        !this.currentSession ||
        !this.ui.isChatActive() ||
        document.visibilityState !== 'visible' ||
        !navigator.onLine ||
        this.isWakingUp ||
        !isAuthValidAndNonAnonymous()
      ) {
        return;
      }
      const channelId = this.currentSession.conversationId || this.currentSession.roomId;
      const isConv = Boolean(this.currentSession.conversationId);
      const myUid = getCurrentAuthUser()?.uid || this.currentSession.userId;
      void this.refreshLatestChannelFromServer(channelId, isConv, myUid).then(() => {
        if (this.currentSession && this.ui.isChatActive()) {
          void this.markChatAsRead();
        }
      });
      void this.syncPendingOutbox();
    }, 25000);
  }

  private stopActiveChatSyncLoop(): void {
    if (this.activeChatHeartbeatId) {
      clearInterval(this.activeChatHeartbeatId);
      this.activeChatHeartbeatId = null;
    }
  }

  private async syncPendingOutbox(): Promise<void> {
    if (this.isSyncingOutbox) return;
    if (!navigator.onLine) {
      const offlinePending = await getOutboxMessages().catch(() => []);
      if (offlinePending.length > 0) this.scheduleOutboxRetry();
      return;
    }

    this.isSyncingOutbox = true;
    try {
      // Camada 2.5: Aguarda consolidação da autenticação necessária
      if (!isAuthValidAndNonAnonymous()) {
        await waitForAuthCompletion(2500);
      }

      if (!isAuthValidAndNonAnonymous()) {
        const pendingAuth = await getOutboxMessages().catch(() => []);
        if (pendingAuth.length > 0) {
          this.scheduleOutboxRetry();
        }
        return;
      }

      const pending = await getOutboxMessages();
      if (pending.length === 0) {
        this.outboxRetryAttempt = 0;
        return;
      }

      if (this.currentSession && this.ui.isChatActive()) {
        this.setConnectionState('sincronizando');
      }

      let hasFailures = false;
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
          if (this.currentSession && this.ui.isChatActive()) {
            this.ui.appendOrUpdateMessage(syncedMsg, this.isOwnMessage(syncedMsg, this.currentSession));
          }
        } catch (err) {
          hasFailures = true;
          console.warn('Erro ao sincronizar mensagem pendente:', msg.messageId, err);
        }
      }

      if (this.currentSession && this.ui.isChatActive()) {
        this.setConnectionState('online');
      }

      if (hasFailures) {
        this.scheduleOutboxRetry();
      } else {
        this.outboxRetryAttempt = 0;
      }
    } finally {
      this.isSyncingOutbox = false;
    }
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
    this.knownRealtimeMsgIds.clear();
    this.hasInitializedRealtimeMsgs = false;

    if (isConversation && this.currentSession?.conversationId) {
      const convId = this.currentSession.conversationId;
      this.unsubscribeRoom = subscribeToConversation(convId, (conv) => {
        const roomEquivalent = conversationToRoom(conv);
        this.currentRoom = roomEquivalent;
        saveLocalRoom(roomEquivalent);
        if (!this.unsubscribeActiveChatMatch && conv.participantA && conv.participantB) {
          this.attachActiveChatMatchGuard(conv.participantA, conv.participantB, convId);
        }
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
            const resolvedMsg = this.resolveConversationSenderName(msg);
            visibleIncoming.push(resolvedMsg);
            if (this.ui.isChatActive()) {
              this.ui.appendOrUpdateMessage(resolvedMsg, this.isOwnMessage(resolvedMsg, this.currentSession));
            }
          }
          await this.handleRealtimeIncomingBatch(visibleIncoming);
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
              this.ui.appendOrUpdateMessage(msg, this.isOwnMessage(msg, this.currentSession));
            }
          }
          await this.handleRealtimeIncomingBatch(visibleIncoming);
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
    if (!channelId) return;
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

    if (this.lastMonitorChannelId !== ctx.channelId) {
      this.knownMonitorMsgIds.clear();
      this.hasInitializedMonitorMsgs = false;
      this.lastMonitorChannelId = ctx.channelId;
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
          this.processMonitorNotificationCandidates(
            visible,
            ctx.channelId,
            effectiveUid,
            ctx.displayName,
            this.cachedMonitorChannel
          );
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
          this.processMonitorNotificationCandidates(
            visible,
            ctx.channelId,
            effectiveUid,
            ctx.displayName,
            this.cachedMonitorChannel
          );
        },
        (err) => {
          console.debug('Talk2TM [Monitor]: listener em espera:', err?.message);
        }
      );
    }
  }

  private async handleRealtimeIncomingBatch(visibleIncoming: Message[]): Promise<void> {
    if (!this.currentSession) return;
    const isVisibleChat = this.ui.isChatActive() && document.visibilityState === 'visible';
    const hasIncomingFromPartner = visibleIncoming.some(
      (m) => !this.isOwnMessage(m, this.currentSession!)
    );

    if (isVisibleChat) {
      for (const m of visibleIncoming) {
        this.knownRealtimeMsgIds.add(m.messageId);
      }
      this.hasInitializedRealtimeMsgs = true;
      await this.markChatAsRead(hasIncomingFromPartner);
      return;
    }

    if (!this.hasInitializedRealtimeMsgs) {
      for (const m of visibleIncoming) {
        this.knownRealtimeMsgIds.add(m.messageId);
      }
      this.hasInitializedRealtimeMsgs = true;
    } else {
      const newlyArrived = visibleIncoming.filter(
        (m) => !this.knownRealtimeMsgIds.has(m.messageId) && !this.isOwnMessage(m, this.currentSession!)
      );
      for (const m of visibleIncoming) {
        this.knownRealtimeMsgIds.add(m.messageId);
      }
      const latestNew = newlyArrived[newlyArrived.length - 1];
      if (latestNew) {
        void dispatchDiscreetNotification({
          kind: 'message',
          settings: this.appSettings,
          eventKey: latestNew.messageId,
          isAppForegroundContext: false,
        });
      }
    }

    if (!this.ui.isChatActive()) {
      await this.evaluateUnreadIndicator(visibleIncoming, this.currentRoom);
    }
  }

  private processMonitorNotificationCandidates(
    messages: Message[],
    channelId: string,
    myUid: string,
    myDisplayName: string,
    channelMeta?: Room | Conversation | null
  ): void {
    if (!this.hasInitializedMonitorMsgs) {
      for (const m of messages) {
        this.knownMonitorMsgIds.add(m.messageId);
      }
      this.hasInitializedMonitorMsgs = true;
      return;
    }

    const localStoredRead = getLocalLastReadTimestamp(channelId, myUid);
    const channelSelfRead = getSelfLastReadFromChannel(channelMeta, myUid, myDisplayName);
    const lastReadIso = maxIsoDate(localStoredRead, channelSelfRead);

    const newIncoming = messages.filter((m) => {
      if (this.knownMonitorMsgIds.has(m.messageId)) return false;
      const isOwn =
        m.senderId === myUid ||
        (Boolean(myDisplayName) && m.sender === myDisplayName);
      if (isOwn) return false;
      if (isMessageHiddenLocally(channelId, m.messageId)) return false;
      return !lastReadIso || m.createdAt > lastReadIso;
    });

    for (const m of messages) {
      this.knownMonitorMsgIds.add(m.messageId);
    }

    const latest = newIncoming[newIncoming.length - 1];
    if (latest) {
      void dispatchDiscreetNotification({
        kind: 'message',
        settings: this.appSettings,
        eventKey: latest.messageId,
        isAppForegroundContext: false,
      });
    }
  }

  private syncWeeklyActivityTelemetry(uid: string, forceCitySync: boolean = false): void {
    if (!uid) return;
    const savedDating = loadSavedDatingProfile(uid);
    void recordUserWeeklyActivityIfNeeded({
      uid,
      city: savedDating?.city || null,
      cityKey: savedDating?.cityKey || null,
      countryCode: savedDating?.countryCode || null,
      forceCitySync,
    });
  }

  /**
   * Avalia com precisão se há mensagens novas não consultadas e atualiza apenas o ponto discreto do DEG.
   */
  private async evaluateUnreadIndicator(
    messages: Message[],
    channelMeta?: Room | Conversation | null
  ): Promise<void> {
    if (this.ui.isChatActive() && document.visibilityState === 'visible') {
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
    const localStoredRead = getLocalLastReadTimestamp(channelId, myUid);
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
      const resolvedMsg = isConversation ? this.resolveConversationSenderName(msg) : msg;
      visible.push(resolvedMsg);
      if (this.currentSession && this.ui.isChatActive()) {
        this.ui.appendOrUpdateMessage(resolvedMsg, this.isOwnMessage(resolvedMsg, this.currentSession));
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
        if (!channelId) {
          if (this.ui.isConnectViewActive() && !this.unsubscribeIncomingInvites) {
            this.attachConnectHubListeners(this.currentSession);
          }
          return;
        }
        const isConv = Boolean(this.currentSession.conversationId);
        const myUid = getCurrentAuthUser()?.uid || this.currentSession.userId;

        // Reanexa listeners se ficou tempo suficiente em repouso para o WebSocket cair
        if (force || elapsedSinceLastWake > 15000 || !this.unsubscribeMessages) {
          this.setupRealtimeListeners(channelId);
        }

        const visible = await this.refreshLatestChannelFromServer(channelId, isConv, myUid);
        if (this.ui.isChatActive() && document.visibilityState === 'visible') {
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
        this.processMonitorNotificationCandidates(
          visible,
          ctx.channelId,
          effectiveUid,
          ctx.displayName,
          this.cachedMonitorChannel
        );
      }

      // Garante drenagem de mensagens pendentes no outbox mesmo em segundo plano
      await this.syncPendingOutbox();
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

    // Limpeza única de contas/caches antigos antes da época v2 (preserva Truman x Mãezinha)
    const epochReset = applyLocalResetEpochIfNeeded(undefined, getCurrentAuthUser()?.email);
    if (epochReset.cleared) {
      if (epochReset.shouldSignOutAuth) {
        const auth = getFirebaseAuth();
        if (auth) {
          await signOut(auth).catch(() => {});
          syncAuthState(null);
        }
      }
      await clearBilateralLocalStores().catch(() => {});
    }

    // Segurança padrão: o PWA SEMPRE inicia bloqueado na calculadora.
    // Mensagens nunca são exibidas automaticamente ao abrir o app sem digitar o PIN.
    const savedSession = getSession();
    if (savedSession) {
      if (!getMonitorContext()) {
        this.persistMonitorContext(savedSession);
      }
      clearSession();
    }
    this.currentSession = null;
    this.currentRoom = null;
    this.ui.clearMessages();

    // Migração silenciosa: se o aparelho já esteve autenticado anteriormente no Firebase Auth
    // mas ainda não tem MonitorContext salvo, reconstrói o contexto passivo sem desbloquear o chat.
    if (!getMonitorContext() && isAuthValidAndNonAnonymous()) {
      const authUser = getCurrentAuthUser();
      const email = authUser?.email || '';
      if (authUser && email === 'truman@talk2tm.internal') {
        saveMonitorContext({
          channelId: ACCESS_CONFIG.DEFAULT_ROOM,
          isConversation: false,
          userId: authUser.uid,
          displayName: 'Truman',
        });
      } else if (authUser && email === 'maezinha@talk2tm.internal') {
        saveMonitorContext({
          channelId: ACCESS_CONFIG.DEFAULT_ROOM,
          isConversation: false,
          userId: authUser.uid,
          displayName: 'Mãezinha',
        });
      }
    }

    // Limpa contexto legado de sala pessoal individual (modelo anterior substituído por conversa bilateral)
    const existingCtx = getMonitorContext();
    if (existingCtx && !existingCtx.isConversation && existingCtx.channelId.startsWith('room_tm_')) {
      clearMonitorContext();
    }

    // Se houver identidade local prévia, restaura metadados internos silenciosamente (sem abrir chat)
    const localIdentity = await restoreLocalIdentity().catch(() => null);
    if (localIdentity && isAuthValidAndNonAnonymous()) {
      console.info(`Talk2TM [Identity]: Conta local restaurada para ${localIdentity.displayName}`);
    }

    this.setConnectionState(navigator.onLine ? 'online' : 'offline');

    // Se o utilizador abriu um link nativo de redefinição (?mode=resetPassword&oobCode=...), mostra fluxo direto
    if (typeof window !== 'undefined' && window.location?.search) {
      const searchParams = new URLSearchParams(window.location.search);
      const mode = searchParams.get('mode');
      const oobCode = searchParams.get('oobCode');
      if (mode === 'resetPassword' && oobCode) {
        if (window.history?.replaceState) {
          window.history.replaceState({}, '', window.location.pathname);
        }
        try {
          const resetEmail = await verifyInAppPasswordResetCode(oobCode);
          this.ui.showInAppPasswordResetView(oobCode, resetEmail);
          return;
        } catch (err: any) {
          this.ui.showRecoveryView();
          this.ui.showTemporaryNotice(
            err?.message || t('recovery.errOobInvalid')
          );
          return;
        }
      }

      const refCode = extractReferralCodeFromSearch(window.location.search);
      if (refCode) {
        savePendingReferralCode(refCode);
        if (window.history?.replaceState) {
          window.history.replaceState({}, '', window.location.pathname);
        }
        const invite = await fetchPublicReferralInvite(refCode).catch(() => null);
        this.ui.showReferralLandingView({
          code: refCode,
          referrerDisplayName: invite?.referrerDisplayName,
        });
        return;
      }
    }

    this.ui.showCalculatorView();

    // Calculadora visível ao abrir PWA: ativa apenas o monitor passivo para o ponto no DEG
    if (getMonitorContext()) {
      this.startBackgroundMonitor();
      if (navigator.onLine && isAuthValidAndNonAnonymous()) {
        void this.handleAppWakeUp(true);
      }
    }
  }

  private getLastConversationStorageKey(uid: string): string {
    return `talk2tm_last_conv_${uid}`;
  }

  private getSavedLastConversationId(uid: string): string | null {
    try {
      const fromStorage = typeof localStorage !== 'undefined'
        ? localStorage.getItem(this.getLastConversationStorageKey(uid))
        : null;
      if (fromStorage) return fromStorage;
    } catch {
      // ignora erro de localStorage
    }
    const ctx = getMonitorContext();
    if (ctx && ctx.isConversation && ctx.userId === uid && ctx.channelId) {
      return ctx.channelId;
    }
    return null;
  }

  private saveLastConversationId(uid: string, conversationId: string): void {
    try {
      if (typeof localStorage !== 'undefined' && uid && conversationId) {
        localStorage.setItem(this.getLastConversationStorageKey(uid), conversationId);
      }
    } catch {
      // ignora erro de localStorage
    }
  }

  /**
   * Desbloqueio otimista (zero latência) para contas locais por PIN numérico.
   * Abre a UI imediatamente do cache local e autentica/sincroniza o cofre em segundo plano.
   */
  private async unlockWithLocalIdentity(identity: LocalIdentity, pin?: string): Promise<boolean> {
    const session: UserSession = {
      userId: identity.uid,
      displayName: identity.displayName,
      roomId: '',
      talk2tmId: identity.talk2tmId,
      phoneMasked: identity.phoneMasked,
      recoveryEmail: identity.recoveryEmail,
      pendingRecoveryEmail: identity.pendingRecoveryEmail,
    };

    this.currentSession = session;
    saveSession(session);
    this.stopBackgroundMonitor();
    this.startSessionTimeout();
    this.resetInactivityTimer();

    const authPromise = authenticateVaultIdentity(identity, pin).catch(() => null);
    const lastConvId = this.getSavedLastConversationId(identity.uid);

    if (lastConvId) {
      // Renderiza o chat imediatamente a partir do IndexedDB antes mesmo de aguardar Auth remoto
      session.conversationId = lastConvId;
      session.roomId = lastConvId;
      saveSession(session);
      const localConv = await getLocalConversation(lastConvId).catch(() => null);
      const localRoom = localConv ? conversationToRoom(localConv) : await getLocalRoom(lastConvId).catch(() => null);
      if (localRoom) this.currentRoom = localRoom;
      this.ui.showChatView(session, localRoom || undefined);
      this.setConnectionState(navigator.onLine ? 'conectando' : 'offline');

      // Aguarda eventual troca de conta no Firebase Auth para multi-conta no mesmo aparelho
      const authRes = await authPromise;
      if (authRes) {
        let changed = false;
        if (authRes.displayName && authRes.displayName !== session.displayName) {
          session.displayName = authRes.displayName;
          changed = true;
        }
        if (authRes.identity.recoveryEmail !== session.recoveryEmail) {
          session.recoveryEmail = authRes.identity.recoveryEmail;
          changed = true;
        }
        if (authRes.identity.pendingRecoveryEmail !== session.pendingRecoveryEmail) {
          session.pendingRecoveryEmail = authRes.identity.pendingRecoveryEmail;
          changed = true;
        }
        if (changed) {
          saveSession(session);
        }
      }
      if (this.currentSession && this.currentSession.userId === identity.uid) {
        const activeUid = getCurrentAuthUser()?.uid || identity.uid;
        this.attachOwnProfileSuspensionGuard(identity.talk2tmId);
        this.attachUserBlocksSubscription(activeUid);
        this.syncWeeklyActivityTelemetry(activeUid);
        await this.connectToConversation(lastConvId);
      }
    } else {
      // Abre Hub de Conexões imediatamente com pré-carregamento do IndexedDB e consolida Auth/Firestore em segundo plano
      this.hubHasRemoteConversationsSnapshot = false;
      this.hubIncomingInvites = [];
      this.hubOutgoingInvites = [];
      this.hubConversations = [];
      this.ui.showConnectView(session);
      this.renderConnectHubData();
      this.setConnectionState(navigator.onLine ? 'conectando' : 'offline');
      void this.preloadLocalHubConversations(session.userId);
      const authRes = await authPromise;
      if (authRes) {
        let changed = false;
        if (authRes.displayName && authRes.displayName !== session.displayName) {
          session.displayName = authRes.displayName;
          changed = true;
        }
        if (authRes.identity.recoveryEmail !== session.recoveryEmail) {
          session.recoveryEmail = authRes.identity.recoveryEmail;
          changed = true;
        }
        if (authRes.identity.pendingRecoveryEmail !== session.pendingRecoveryEmail) {
          session.pendingRecoveryEmail = authRes.identity.pendingRecoveryEmail;
          changed = true;
        }
        if (changed) {
          saveSession(session);
        }
      }
      if (this.currentSession && this.currentSession.userId === identity.uid) {
        const activeUid = getCurrentAuthUser()?.uid || identity.uid;
        this.attachOwnProfileSuspensionGuard(identity.talk2tmId);
        this.attachUserBlocksSubscription(activeUid);
        this.syncWeeklyActivityTelemetry(activeUid);
        await this.openBilateralHub(session);
      }
    }

    return true;
  }

  /**
   * Cadastro Zero Custos (4 campos + Chave Pessoal de Recuperação escolhida ou gerada + e-mail opcional):
   * Cria identidade e prepara sessão para entrar imediatamente.
   */
  public async handleCreateIdentity(params: {
    displayName: string;
    phone: string;
    pin: string;
    recoveryCode?: string;
    recoveryEmail?: string;
  }): Promise<{ talk2tmId: string; recoveryCode: string; e164Phone: string }> {
    const result = await registerPhoneIdentity(params);

    const pendingRef = getPendingReferralCode();
    if (pendingRef) {
      await attributeRegistrationReferral({
        newUid: result.identity.uid,
        newTalk2tmId: result.identity.talk2tmId,
        referralCode: pendingRef,
      }).catch(() => {});
      clearPendingReferralCode();
    }

    this.pendingOnboardingSession = {
      userId: result.identity.uid,
      displayName: result.identity.displayName,
      roomId: '',
      talk2tmId: result.identity.talk2tmId,
      phoneMasked: result.identity.phoneMasked,
      recoveryEmail: result.identity.recoveryEmail,
      pendingRecoveryEmail: result.identity.pendingRecoveryEmail,
    };

    return {
      talk2tmId: result.identity.talk2tmId,
      recoveryCode: result.recoveryCode,
      e164Phone: result.e164Phone,
    };
  }

  public async handleFinishOnboarding(): Promise<void> {
    const session = this.pendingOnboardingSession;
    this.pendingOnboardingSession = null;
    if (!session) {
      const local = getLocalIdentity();
      if (local) {
        await this.unlockWithLocalIdentity(local);
      } else {
        this.ui.showPassEntryView();
      }
      return;
    }

    this.currentSession = session;
    this.currentRoom = null;
    saveSession(session);
    this.stopBackgroundMonitor();
    this.startSessionTimeout();
    this.resetInactivityTimer();
    this.attachUserBlocksSubscription(session.userId);
    this.syncWeeklyActivityTelemetry(session.userId);
    await this.openBilateralHub(session);
  }

  public async handleRecoverIdentity(params: {
    phone?: string;
    recoveryEmail?: string;
    recoveryCode: string;
    newPin: string;
  }): Promise<void> {
    const identity = await recoverPhoneIdentity(params);
    await this.unlockWithLocalIdentity(identity, params.newPin.trim());
  }

  public async handleCompleteInAppPasswordReset(params: {
    oobCode: string;
    recoveryCode: string;
    newPin: string;
  }): Promise<void> {
    const identity = await completePasswordResetInApp(params);
    await this.unlockWithLocalIdentity(identity, params.newPin.trim());
  }

  public async handleRegenerateRecoveryCode(currentPin: string, customRecoveryCode?: string): Promise<string> {
    if (!this.currentSession) {
      throw new Error(t('app.activeSessionRequired'));
    }
    const uid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    const res = await regenerateRecoveryCodeWithPin(uid, currentPin, customRecoveryCode);
    return res.recoveryCode;
  }

  public async handleAssociateRecoveryEmail(
    currentPin: string,
    email: string
  ): Promise<{ status: 'already_active' | 'verification_sent'; email: string }> {
    if (!this.currentSession) {
      throw new Error(t('app.activeSessionRequired'));
    }
    const uid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    const res = await associateRecoveryEmailWithPin(uid, currentPin, email);
    if (res.status === 'already_active') {
      this.currentSession.recoveryEmail = res.email;
      this.currentSession.pendingRecoveryEmail = undefined;
    } else {
      this.currentSession.pendingRecoveryEmail = res.email;
    }
    saveSession(this.currentSession);
    return res;
  }

  public async handleChangeLocalPin(currentPin: string, newPin: string): Promise<void> {
    if (!this.currentSession) {
      throw new Error(t('app.activeSessionRequired'));
    }
    const uid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    await updateLocalPinForAccount(uid, currentPin, newPin);
  }

  private stopActiveChatMatchSubscription(): void {
    if (this.unsubscribeActiveChatMatch) {
      this.unsubscribeActiveChatMatch();
      this.unsubscribeActiveChatMatch = null;
    }
  }

  private attachActiveChatMatchGuard(
    participantA: string,
    participantB: string,
    conversationId: string
  ): void {
    this.stopActiveChatMatchSubscription();
    if (!participantA || !participantB || !isAuthValidAndNonAnonymous()) return;
    const matchId = buildDatingMatchId(participantA, participantB);
    this.unsubscribeActiveChatMatch = subscribeToDatingMatchById(matchId, (match) => {
      if (match?.status === 'unmatched' && this.currentSession?.conversationId === conversationId) {
        const sessionSnapshot = this.currentSession;
        const uid = getCurrentAuthUser()?.uid || sessionSnapshot.userId;
        const nextMatches = this.hubDatingMatches.some((m) => m.matchId === match.matchId)
          ? this.hubDatingMatches.map((m) => (m.matchId === match.matchId ? match : m))
          : [match, ...this.hubDatingMatches];
        this.hubDatingMatches = nextMatches;
        saveLocalDatingMatches(uid, nextMatches);
        void this.openBilateralHub(sessionSnapshot).then(() => {
          this.ui.showTemporaryNotice(t('dating.unmatchedChatClosed'));
        });
      }
    });
  }

  private stopConnectHubListeners(): void {
    if (this.unsubscribeIncomingInvites) {
      this.unsubscribeIncomingInvites();
      this.unsubscribeIncomingInvites = null;
    }
    if (this.unsubscribeOutgoingInvites) {
      this.unsubscribeOutgoingInvites();
      this.unsubscribeOutgoingInvites = null;
    }
    if (this.unsubscribeUserConversations) {
      this.unsubscribeUserConversations();
      this.unsubscribeUserConversations = null;
    }
    if (this.unsubscribeDatingMatches) {
      this.unsubscribeDatingMatches();
      this.unsubscribeDatingMatches = null;
    }
    if (this.unsubscribeHubAuthWait) {
      this.unsubscribeHubAuthWait();
      this.unsubscribeHubAuthWait = null;
    }
  }

  private renderConnectHubData(): void {
    const myUid = getCurrentAuthUser()?.uid || this.currentSession?.userId || '';
    const unmatchedIds = getUnmatchedConversationIds(this.hubDatingMatches);
    this.ui.updateConnectHubData({
      incoming: this.hubIncomingInvites.filter((inv) => !this.isPeerBlocked(myUid, inv.fromUid)),
      outgoing: this.hubOutgoingInvites.filter((inv) => !this.isPeerBlocked(myUid, inv.toUid)),
      conversations: this.hubConversations.filter((c) => {
        if (unmatchedIds.has(c.conversationId)) return false;
        const partnerUid = this.getConversationPartnerUid(c, myUid);
        return !this.isPeerBlocked(myUid, partnerUid);
      }),
    });
  }

  private async preloadLocalHubConversations(uid: string): Promise<void> {
    if (!uid) return;
    const cached = await getLocalConversationsForUser(uid).catch(() => []);
    if (
      this.hubHasRemoteConversationsSnapshot ||
      !this.ui.isConnectViewActive() ||
      this.currentSession?.userId !== uid
    ) {
      return;
    }
    if (cached.length > 0) {
      this.hubConversations = cached;
      this.renderConnectHubData();
    }
  }

  /**
   * Abre o Hub de Conexões Bilaterais (descoberta por número exato de telefone + pré-carregamento local de conversas).
   */
  public async openBilateralHub(session: UserSession): Promise<void> {
    this.stopActiveChatSyncLoop();
    this.stopActiveChatMatchSubscription();
    if (this.unsubscribeMessages) {
      this.unsubscribeMessages();
      this.unsubscribeMessages = null;
    }
    if (this.unsubscribeRoom) {
      this.unsubscribeRoom();
      this.unsubscribeRoom = null;
    }

    const hubSession: UserSession = {
      ...session,
      roomId: '',
      conversationId: undefined,
    };
    this.currentSession = hubSession;
    this.currentRoom = null;
    saveSession(hubSession);

    const sameHubConversations =
      this.hubConversations.length > 0 &&
      this.hubConversations.every(
        (c) => c.participantA === hubSession.userId || c.participantB === hubSession.userId
      );

    this.hubIncomingInvites = [];
    this.hubOutgoingInvites = [];
    this.hubHasRemoteConversationsSnapshot = false;
    if (!sameHubConversations) {
      this.hubConversations = [];
      this.notifiedUnseenMatchIds.clear();
    }
    this.knownAcceptedInviteIds.clear();
    this.hubDatingMatches = loadLocalDatingMatches(hubSession.userId);
    this.blockedPeerUids = new Set(loadLocalBlockedUids(hubSession.userId));

    this.ui.showConnectView(hubSession);
    this.renderImmediateReferralMetrics(hubSession.userId);
    this.setConnectionState(navigator.onLine ? 'online' : 'offline');
    this.startSessionTimeout();
    this.resetInactivityTimer();
    this.ui.updateDatingMatches(
      this.filterUnblockedDatingMatches(this.hubDatingMatches, hubSession.userId),
      hubSession.userId
    );
    this.renderConnectHubData();

    // Pré-carrega conversas já sincronizadas no IndexedDB imediatamente (sem bloquear Auth/rede)
    void this.preloadLocalHubConversations(hubSession.userId);

    if (!isAuthValidAndNonAnonymous()) {
      await waitForAuthCompletion(3000);
    }

    const effectiveUid = getCurrentAuthUser()?.uid || hubSession.userId;
    if (this.currentSession?.talk2tmId) {
      this.attachOwnProfileSuspensionGuard(this.currentSession.talk2tmId);
    }
    this.attachUserBlocksSubscription(effectiveUid);
    this.attachConnectHubListeners(hubSession);
    if (isAuthValidAndNonAnonymous()) {
      void this.refreshOwnReferralMetrics(effectiveUid, hubSession.displayName);
    }
  }

  private renderImmediateReferralMetrics(uid: string): void {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const cached = loadCachedReferralMetrics(uid);
    if (cached) {
      this.ui.updateReferralMetrics(cached);
      return;
    }
    const code = deriveDeterministicReferralCode(uid);
    const inviteUrl = buildCanonicalReferralUrl(origin, code);
    const shareText = t('referral.whatsappShareText', { url: inviteUrl });
    this.ui.updateReferralMetrics({
      referralCode: code,
      inviteUrl,
      whatsappUrl: buildWhatsAppReferralShareUrl(shareText),
      invitesSharedCount: 0,
      convertedCount: 0,
    });
  }

  private async refreshOwnReferralMetrics(uid: string, displayName: string): Promise<void> {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const summary = await fetchOwnReferralMetrics(
      uid,
      displayName,
      origin,
      (inviteUrl) => t('referral.whatsappShareText', { url: inviteUrl })
    ).catch(() => null);
    if (summary && this.ui.isConnectViewActive()) {
      this.ui.updateReferralMetrics(summary);
    }
  }

  private attachConnectHubListeners(session: UserSession): void {
    this.stopConnectHubListeners();

    if (!isAuthValidAndNonAnonymous()) {
      const auth = getFirebaseAuth();
      if (auth) {
        this.unsubscribeHubAuthWait = onAuthStateChanged(auth, (resolved) => {
          if (resolved && !resolved.isAnonymous && this.ui.isConnectViewActive()) {
            if (session.talk2tmId) {
              this.attachOwnProfileSuspensionGuard(session.talk2tmId);
            }
            this.attachUserBlocksSubscription(resolved.uid);
            this.attachConnectHubListeners({ ...session, userId: resolved.uid });
            void this.refreshOwnReferralMetrics(resolved.uid, session.displayName);
          }
        });
      }
      return;
    }

    const myUid = getCurrentAuthUser()?.uid || session.userId;
    let initialOutgoingSnapshot = true;

    this.unsubscribeIncomingInvites = subscribeToIncomingInvites(myUid, (invites) => {
      this.hubIncomingInvites = invites;
      this.renderConnectHubData();
    });

    this.unsubscribeOutgoingInvites = subscribeToOutgoingInvites(myUid, (invites) => {
      this.hubOutgoingInvites = invites;
      if (initialOutgoingSnapshot) {
        initialOutgoingSnapshot = false;
        invites.forEach((inv) => {
          if (inv.status === 'accepted') {
            this.knownAcceptedInviteIds.add(inv.inviteId);
          }
        });
      } else {
        // Quando Conta B acaba de aceitar um convite pendente nosso, abre a conversa bilateral automaticamente
        const newlyAccepted = invites.find(
          (inv) =>
            inv.status === 'accepted' &&
            !this.knownAcceptedInviteIds.has(inv.inviteId) &&
            !this.isPeerBlocked(myUid, inv.toUid)
        );
        if (newlyAccepted && this.ui.isConnectViewActive()) {
          this.knownAcceptedInviteIds.add(newlyAccepted.inviteId);
          void this.openAcceptedConversationFromInvite(newlyAccepted, session);
        }
      }
      this.renderConnectHubData();
    });

    this.unsubscribeUserConversations = subscribeToUserConversations(myUid, (conversations, meta) => {
      // Se o snapshot vier apenas de cache vazio offline e já pré-carregámos do IndexedDB, preserva os dados locais
      if (meta?.fromCache && conversations.length === 0 && this.hubConversations.length > 0) {
        return;
      }
      this.hubHasRemoteConversationsSnapshot = !meta?.fromCache || conversations.length > 0;
      this.hubConversations = conversations;
      conversations.forEach((c) => saveLocalConversation(c).catch(() => {}));
      this.renderConnectHubData();
    });

    this.unsubscribeDatingMatches = subscribeToDatingMatches(myUid, (matches) => {
      this.hubDatingMatches = matches;
      const visibleMatches = this.filterUnblockedDatingMatches(matches, myUid);
      this.renderConnectHubData();
      this.ui.updateDatingMatches(visibleMatches, myUid);

      const unseen = getUnseenDatingMatches(visibleMatches, myUid);
      const isDatingForeground =
        this.ui.isConnectViewActive() &&
        this.ui.getActiveConnectTab() === 'dating' &&
        document.visibilityState === 'visible';
      for (const m of unseen) {
        if (!this.notifiedUnseenMatchIds.has(m.matchId)) {
          this.notifiedUnseenMatchIds.add(m.matchId);
          if (this.ui.getActiveConnectTab() === 'connections') {
            const partner = getDatingMatchPartner(m, myUid);
            this.ui.showTemporaryNotice(
              t('dating.matchToastNotice', { name: partner.displayName || partner.talk2tmId })
            );
          }
          void dispatchDiscreetNotification({
            kind: 'match',
            settings: this.appSettings,
            eventKey: m.matchId,
            isAppForegroundContext: isDatingForeground,
          });
        }
      }
    });
  }

  private async openAcceptedConversationFromInvite(
    invite: ConversationInvite,
    session: UserSession
  ): Promise<void> {
    if (!session.talk2tmId) return;
    let conv = await getConversationById(invite.conversationId);
    if (!conv && invite.toUid) {
      const partnerProfile = await fetchUserProfileByTalk2tmId(invite.toTalk2tmId).catch(() => null);
      const partnerDisplayName = partnerProfile?.displayName || invite.toTalk2tmId;
      conv = await getOrCreateConversation(
        { uid: session.userId, talk2tmId: session.talk2tmId, displayName: session.displayName },
        { uid: invite.toUid, talk2tmId: invite.toTalk2tmId, displayName: partnerDisplayName }
      ).catch(() => null);
    }
    if (conv) {
      await saveLocalConversation(conv).catch(() => {});
      if (this.ui.isConnectViewActive()) {
        await this.connectToConversation(conv.conversationId);
      }
    }
  }

  private async handleSendInvite(targetPhone: string): Promise<void> {
    if (!this.currentSession || !this.currentSession.talk2tmId) {
      throw new Error(t('err.identityNeededInvite'));
    }
    if (!isAuthValidAndNonAnonymous()) {
      await restoreLocalIdentity();
      await waitForAuthCompletion(3000);
    }
    const myUid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    const res = await sendConversationInviteByPhone(
      {
        uid: myUid,
        talk2tmId: this.currentSession.talk2tmId,
        displayName: this.currentSession.displayName,
      },
      targetPhone
    );
    if (res.status === 'already_connected' && res.conversation) {
      this.ui.showConnectFeedback(t('connect.readyOpening'));
      await this.connectToConversation(res.conversation.conversationId);
    } else {
      if (res.invite?.inviteId && res.targetDisplayName) {
        this.ui.cacheOutgoingInviteTargetName(res.invite.inviteId, res.targetDisplayName);
      }
      this.ui.showConnectFeedback(t('connect.inviteSentTo', { name: res.targetDisplayName || '' }));
    }
  }

  private async handleAcceptInvite(invite: ConversationInvite): Promise<void> {
    if (!this.currentSession || !this.currentSession.talk2tmId) {
      throw new Error(t('err.identityNeededAccept'));
    }
    if (!isAuthValidAndNonAnonymous()) {
      await restoreLocalIdentity();
      await waitForAuthCompletion(3000);
    }
    const myUid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    const conv = await acceptConversationInvite(invite, {
      uid: myUid,
      talk2tmId: this.currentSession.talk2tmId,
      displayName: this.currentSession.displayName,
    });
    await saveLocalConversation(conv).catch(() => {});
    await saveLocalRoom(conversationToRoom(conv)).catch(() => {});
    await this.connectToConversation(conv.conversationId);
  }

  private async handleDeclineInvite(inviteId: string): Promise<void> {
    await declineConversationInvite(inviteId);
    this.ui.showConnectFeedback(t('connect.inviteDeclined'));
  }

  private async handleCancelInvite(inviteId: string): Promise<void> {
    await cancelConversationInvite(inviteId);
    this.ui.showConnectFeedback(t('connect.inviteCancelled'));
  }

  private async ensureActiveNonAnonUid(): Promise<string> {
    if (!this.currentSession || !this.currentSession.talk2tmId) {
      throw new Error(t('err.identityNeededInvite'));
    }
    if (!isAuthValidAndNonAnonymous()) {
      await restoreLocalIdentity();
      await waitForAuthCompletion(3000);
    }
    return getCurrentAuthUser()?.uid || this.currentSession.userId;
  }

  private async handleLoadDatingWorkspace(): Promise<{
    profile: DatingProfile | null;
    filters: DatingDiscoveryFilters;
    discovery: DatingDiscoveryResult | null;
    matches: DatingMatch[];
  }> {
    const uid = await this.ensureActiveNonAnonUid();
    const profile = await getOwnDatingProfile(uid);
    if (profile) {
      void recordUserWeeklyActivityIfNeeded({
        uid,
        city: profile.city,
        cityKey: profile.cityKey,
        countryCode: profile.countryCode,
      });
    }
    const filters = loadSavedDatingFilters(
      uid,
      profile?.seeking || 'all',
      profile?.countryCode || ''
    );
    let discovery: DatingDiscoveryResult | null = null;
    if (profile && profile.discoverable && !profile.paused && !profile.suspended) {
      discovery = await discoverDatingProfiles({
        viewerProfile: profile,
        filters,
      });
    }
    const rawMatches = this.hubDatingMatches.length > 0 ? this.hubDatingMatches : loadLocalDatingMatches(uid);
    const matches = this.filterUnblockedDatingMatches(rawMatches, uid);
    return { profile, filters, discovery, matches };
  }

  private async handleSaveDatingProfile(input: DatingProfileInput): Promise<{
    profile: DatingProfile;
    discovery: DatingDiscoveryResult | null;
  }> {
    const uid = await this.ensureActiveNonAnonUid();
    const talk2tmId = this.currentSession?.talk2tmId;
    if (!talk2tmId) {
      throw new Error(t('err.identityNeededInvite'));
    }
    const profile = await upsertOwnDatingProfile(uid, talk2tmId, input);
    void recordUserWeeklyActivityIfNeeded({
      uid,
      city: profile.city,
      cityKey: profile.cityKey,
      countryCode: profile.countryCode,
      forceCitySync: true,
    });
    const filters = loadSavedDatingFilters(uid, profile.seeking, profile.countryCode);
    saveLocalDatingFilters(uid, filters);

    let discovery: DatingDiscoveryResult | null = null;
    if (profile.discoverable && !profile.paused && !profile.suspended) {
      discovery = await discoverDatingProfiles({
        viewerProfile: profile,
        filters,
      });
    }
    return { profile, discovery };
  }

  private async handleSetDatingVisibility(opts: {
    discoverable?: boolean;
    paused?: boolean;
  }): Promise<DatingProfile> {
    const uid = await this.ensureActiveNonAnonUid();
    return await setDatingProfileVisibility(uid, opts);
  }

  private async handleUploadDatingPhoto(blob: Blob): Promise<DatingProfile> {
    const uid = await this.ensureActiveNonAnonUid();
    return await updateOwnDatingPhoto({ uid, fileBlob: blob });
  }

  private async handleRemoveDatingPhoto(): Promise<DatingProfile> {
    const uid = await this.ensureActiveNonAnonUid();
    return await removeOwnDatingPhoto(uid);
  }

  private async handleDiscoverDating(
    filters: DatingDiscoveryFilters,
    cursorUpdatedAt?: string
  ): Promise<DatingDiscoveryResult> {
    const uid = await this.ensureActiveNonAnonUid();
    const profile = await getOwnDatingProfile(uid);
    if (!profile) {
      throw new Error(t('dating.errProfileNotFound'));
    }
    const cleanFilters = validateDatingFilters(filters, profile.countryCode);
    saveLocalDatingFilters(uid, cleanFilters);
    return await discoverDatingProfiles({
      viewerProfile: profile,
      filters: cleanFilters,
      cursorUpdatedAt,
    });
  }

  private async handleEvaluateDatingProfile(
    targetUid: string,
    decision: DatingEvaluationDecision
  ): Promise<void> {
    const uid = await this.ensureActiveNonAnonUid();
    await recordDatingEvaluation(uid, targetUid, decision);
  }

  private async handleLikeDatingCandidate(candidate: DatingProfile): Promise<DatingLikeResult> {
    const uid = await this.ensureActiveNonAnonUid();
    const viewerProfile = await getOwnDatingProfile(uid);
    if (!viewerProfile) {
      throw new Error(t('dating.errProfileNotFound'));
    }
    const res = await sendSecretDatingLike({ viewerProfile, candidate });
    if (res.matched && res.match) {
      this.notifiedUnseenMatchIds.add(res.match.matchId);
      const nextMatches = this.hubDatingMatches.some((m) => m.matchId === res.match!.matchId)
        ? this.hubDatingMatches.map((m) => (m.matchId === res.match!.matchId ? res.match! : m))
        : [res.match, ...this.hubDatingMatches];
      this.hubDatingMatches = nextMatches;
      saveLocalDatingMatches(uid, nextMatches);
      if (res.conversation) {
        await saveLocalConversation(res.conversation).catch(() => {});
        await saveLocalRoom(conversationToRoom(res.conversation)).catch(() => {});
        if (!this.hubConversations.some((c) => c.conversationId === res.conversation!.conversationId)) {
          this.hubConversations = [res.conversation, ...this.hubConversations];
        }
      }
      this.ui.updateDatingMatches(nextMatches, uid);
      this.renderConnectHubData();
    }
    return res;
  }

  private async handleOpenDatingMatchChat(match: DatingMatch): Promise<void> {
    const uid = await this.ensureActiveNonAnonUid();
    const updatedMatch = await markDatingMatchSeen(match, uid);
    if (updatedMatch) {
      this.hubDatingMatches = this.hubDatingMatches.map((m) =>
        m.matchId === updatedMatch.matchId ? updatedMatch : m
      );
      this.ui.updateDatingMatches(this.hubDatingMatches, uid);
    }
    const conv = await ensureConversationForDatingMatch(match);
    await saveLocalConversation(conv).catch(() => {});
    await saveLocalRoom(conversationToRoom(conv)).catch(() => {});
    await this.connectToConversation(conv.conversationId);
  }

  private async handleUnmatchDating(matchId: string): Promise<void> {
    const uid = await this.ensureActiveNonAnonUid();
    const updated = await unmatchDatingConnection(matchId, uid);
    const nextMatches = this.hubDatingMatches.some((m) => m.matchId === updated.matchId)
      ? this.hubDatingMatches.map((m) => (m.matchId === updated.matchId ? updated : m))
      : [updated, ...this.hubDatingMatches];
    this.hubDatingMatches = nextMatches;
    saveLocalDatingMatches(uid, nextMatches);
    this.ui.updateDatingMatches(nextMatches, uid);
    this.renderConnectHubData();
    this.ui.showTemporaryNotice(t('dating.unmatchDoneNotice'));
  }

  private async handleMarkDatingMatchSeen(match: DatingMatch): Promise<void> {
    const uid = await this.ensureActiveNonAnonUid();
    const updated = await markDatingMatchSeen(match, uid);
    if (updated) {
      this.hubDatingMatches = this.hubDatingMatches.map((m) =>
        m.matchId === updated.matchId ? updated : m
      );
      this.ui.updateDatingMatches(this.filterUnblockedDatingMatches(this.hubDatingMatches, uid), uid);
    }
  }

  private async handleReportTarget(params: {
    targetUid: string;
    targetTalk2tmId?: string;
    targetDisplayName?: string;
    sourceType: ReportSourceType;
    channelId?: string;
    itemRefId?: string;
    reason: ReportReason;
    details?: string;
    evidenceSnapshot: string;
  }): Promise<void> {
    const uid = await this.ensureActiveNonAnonUid();
    const talk2tmId = this.currentSession?.talk2tmId;
    if (!talk2tmId) {
      throw new Error(t('err.identityNeededInvite'));
    }
    await submitModerationReport({
      reporterUid: uid,
      reporterTalk2tmId: talk2tmId,
      ...params,
    });
  }

  private async handleBlockUser(targetUid: string, _targetName: string): Promise<void> {
    const uid = await this.ensureActiveNonAnonUid();
    await blockUserConnection({
      blockerUid: uid,
      blockerTalk2tmId: this.currentSession?.talk2tmId,
      blockedUid: targetUid,
    });
    this.blockedPeerUids.add(targetUid);

    const activeConvPartner =
      this.currentSession?.conversationId && this.currentRoom
        ? this.getConversationPartnerUid(this.currentRoom, uid)
        : null;

    if (activeConvPartner && activeConvPartner === targetUid && this.currentSession) {
      await this.openBilateralHub(this.currentSession);
      this.ui.showTemporaryNotice(t('safety.blockedDoneNotice'));
      return;
    }

    this.syncBlockedStateAcrossViews(uid);
    if (this.ui.getActiveConnectTab() !== 'dating') {
      this.ui.showConnectFeedback(t('safety.blockedDoneNotice'));
    }
  }

  private async handleDeleteOwnAccount(currentPin: string): Promise<void> {
    if (!this.currentSession || !this.currentSession.talk2tmId) {
      throw new Error(t('safety.errCannotDeleteLegacy'));
    }
    const uid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    const convIds = Array.from(
      new Set([
        ...this.hubConversations.map((c) => c.conversationId),
        ...(this.currentSession.conversationId ? [this.currentSession.conversationId] : []),
      ])
    );

    await deleteOwnAccountCompletely({
      uid,
      currentPin,
      conversationIds: convIds,
    });

    this.stopAllTimers();
    this.stopActiveChatSyncLoop();
    this.stopActiveChatMatchSubscription();
    this.stopConnectHubListeners();
    this.stopOwnProfileSubscription();
    this.stopUserBlocksSubscription();
    this.stopBackgroundMonitor();
    this.blockedPeerUids.clear();
    this.hubIncomingInvites = [];
    this.hubOutgoingInvites = [];
    this.hubConversations = [];
    this.hubDatingMatches = [];

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

    const monitor = getMonitorContext();
    if (monitor && monitor.userId === uid) {
      clearMonitorContext();
    }

    this.ui.clearMessages();
    this.ui.hideAllPrimaryViews();
    this.ui.showLockView();
    this.ui.showTemporaryNotice(t('safety.deleteAccountDoneNotice'));
  }

  /**
   * Conecta a sessão ativa a um canal de conversa bilateral (Fase 4).
   * Carrega metadados da conversa (participantA + participantB), histórico local com tombstones,
   * vincula listeners em tempo real e sincroniza outbox.
   */
  public async connectToConversation(conversationId: string): Promise<void> {
    if (!this.currentSession) return;
    this.stopConnectHubListeners();
    this.stopActiveChatMatchSubscription();

    const effectiveUid = getCurrentAuthUser()?.uid || this.currentSession.userId;
    this.currentSession.userId = effectiveUid;
    this.currentSession.conversationId = conversationId;
    this.currentSession.roomId = conversationId;
    saveSession(this.currentSession);
    this.persistMonitorContext(this.currentSession);
    this.saveLastConversationId(effectiveUid, conversationId);
    this.stopBackgroundMonitor();

    // Garante consolidação do Firebase Auth antes de consultar metadados/listeners na conversa
    if (!isAuthValidAndNonAnonymous()) {
      await waitForAuthCompletion(3000);
    }

    if (this.currentSession?.talk2tmId && isAuthValidAndNonAnonymous()) {
      this.attachOwnProfileSuspensionGuard(this.currentSession.talk2tmId);
    }
    this.attachUserBlocksSubscription(effectiveUid);

    // Carrega metadados da conversa bilateral para resolver nomes de participantA/participantB e lastRead
    let convRoom: Room | null = await getLocalRoom(conversationId).catch(() => null);
    if (!convRoom) {
      const localConv = await getLocalConversation(conversationId).catch(() => null);
      if (localConv) {
        convRoom = conversationToRoom(localConv);
      }
    }
    if (!convRoom) {
      const remoteConv =
        this.hubConversations.find((c) => c.conversationId === conversationId) ||
        (await getConversationById(conversationId));
      if (remoteConv) {
        await saveLocalConversation(remoteConv).catch(() => {});
        convRoom = conversationToRoom(remoteConv);
        await saveLocalRoom(convRoom).catch(() => {});
      }
    }

    if (convRoom) {
      this.currentRoom = convRoom;
      if (convRoom.participantA && convRoom.participantB) {
        this.attachActiveChatMatchGuard(convRoom.participantA, convRoom.participantB, conversationId);
      }
    }

    this.ui.showChatView(this.currentSession, convRoom || undefined);
    const partnerUid = this.getConversationPartnerUid(convRoom, effectiveUid);
    if (partnerUid && this.isPeerBlocked(effectiveUid, partnerUid)) {
      this.ui.setChatBlockedState(true);
      this.ui.showTemporaryNotice(t('safety.blockedChatNotice'));
    }
    this.setConnectionState(navigator.onLine ? 'conectando' : 'offline');
    this.startSessionTimeout();
    this.resetInactivityTimer();
    this.startActiveChatSyncLoop();

    // Carrega mensagens locais do IndexedDB para a conversa respeitando tombstones
    let latestLocalIso: string | null = null;
    try {
      await loadHiddenMessagesFromDB(conversationId);
      const localHistory = await getLocalMessages(conversationId, CONFIG.HISTORY_LIMIT);
      const normalized = normalizeAndDeduplicateMessages(localHistory, effectiveUid, (id) =>
        isMessageHiddenLocally(conversationId, id)
      );
      this.ui.clearMessages();
      for (const msg of normalized) {
        const resolved = this.resolveConversationSenderName(msg, convRoom);
        this.ui.appendOrUpdateMessage(resolved, this.isOwnMessage(resolved, this.currentSession));
        if (!latestLocalIso || resolved.createdAt > latestLocalIso) {
          latestLocalIso = resolved.createdAt;
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

    // Configura listeners em tempo real para conversations/{conversationId} e sincroniza do servidor
    this.setupRealtimeListeners(conversationId);
    await this.refreshLatestChannelFromServer(conversationId, true, effectiveUid);
    if (this.ui.isChatActive() && document.visibilityState === 'visible') {
      await this.markChatAsRead(true);
    }
    await this.syncPendingOutbox();
    this.setConnectionState(navigator.onLine ? 'online' : 'offline');
  }
}

/**
 * Inicializador da aplicação
 */
export async function startApp(container?: HTMLElement): Promise<Talk2TMApp> {
  const root = container || document.getElementById('root');
  if (!root) throw new Error('Elemento #root não encontrado no DOM');

  const savedSettings = loadSettings();
  await initI18n(savedSettings.language);

  const app = new Talk2TMApp(root);
  await app.init();

  if (typeof window !== 'undefined') {
    (window as unknown as { testRealtimeSyncAtoB: typeof testRealtimeSyncAtoB }).testRealtimeSyncAtoB = testRealtimeSyncAtoB;
  }

  return app;
}
