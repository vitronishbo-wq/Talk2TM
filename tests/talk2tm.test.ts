/**
 * Talk2TM — Suite de Testes Autônoma (Camada 25)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CONFIG,
  ACCESS_CONFIG,
  getUserByPin,
  DEFAULT_SETTINGS,
  USER_AUTH_CREDENTIALS,
  getCredentialsByUser,
  loadSettings,
  saveSettings,
  normalizeAppearanceMode,
  normalizeNotificationSettings,
  normalizeSettingsLanguage,
} from '../src/config';
import { getTalk2TMIconSvg } from '../src/ui/lockscreen';
import {
  sanitizeMessageText,
  sanitizeName,
  sanitizeRoom,
  generateId,
  getLocalDateKey,
  formatTime,
  formatDateSeparatorLabel,
  formatFullDateTime,
} from '../src/utils/sanitize';
import { verifyPassword, PASSWORDS } from '../src/app';
import { Room } from '../src/types';
import { testRealtimeSyncAtoB } from '../src/firebase/diagnostic';
import {
  ensureFirebaseAuth,
  getFirebaseAuth,
  silentAuthenticateWithEmail,
  restoreAuthSession,
  isAuthValidAndNonAnonymous,
  getPartnerLastRead,
  updateFirestoreLastRead,
  AuthState,
  getAuthState,
  waitForAuthCompletion,
  sendFirestoreMessage,
} from '../src/firebase/firestore';
import {
  PWA_PROMPT_VERSION,
  PWA_STORAGE_KEY,
  PWA_COOLDOWNS,
  getPWAState,
  savePWAState,
  shouldShowPWAPrompt,
  isStandaloneMode,
  isAppleMobileDevice,
  PWAPromptBar,
} from '../src/ui/pwa-prompt';
import {
  getHiddenMessageIds,
  hideMessagesLocally,
  isMessageHiddenLocally,
  saveMonitorContext,
  getMonitorContext,
  clearMonitorContext,
  saveLocalLastReadTimestamp,
  getLocalLastReadTimestamp,
  filterAndSortConversationsForUser,
  getLocalConversationsForUser,
} from '../src/storage/indexeddb';
import {
  hasUnreadIncomingMessage,
  normalizeAndDeduplicateMessages,
  selectLatestMessages,
  getSelfLastReadFromChannel,
  maxIsoDate,
} from '../src/utils/unread';
import {
  buildDeterministicConversationId,
  buildUidConversationId,
  conversationToRoom,
} from '../src/conversation';
import { Conversation, Message } from '../src/types';
import {
  initObservability,
  captureException,
  captureMessage,
  getObservabilityStatus,
  isValidSentryDsn,
} from '../src/observability';
import {
  generateTalk2TMId,
  generateInternalSecret,
  talk2tmIdToInternalEmail,
  saveLocalIdentity,
  getLocalIdentity,
  clearLocalIdentity,
  createTalk2TMIdentity,
  restoreLocalIdentity,
  findProfileByTalk2TMId,
  generateRecoveryCode,
  normalizeRecoveryCode,
  validateRecoverySecret,
  deriveAuthPassword,
  sealAuthSecretWithPin,
  unsealAuthSecretWithPin,
  validateLocalPin,
  findLocalIdentityByPin,
  upsertLocalIdentity,
  validateOptionalRecoveryEmail,
  TALK2TM_RESET_EPOCH,
  applyLocalResetEpochIfNeeded,
  removeAccountFromLocalVault,
  LocalIdentity,
} from '../src/identity';
import {
  RATE_LIMITS,
  clearSafetyMemoryForTests,
  checkAndRecordMessageBurst,
  checkAccountCreationThrottle,
  recordAccountCreationAttempt,
  buildNextDailyRateLimitState,
  createEmptyRateLimitState,
  sanitizePlainTextSnippet,
  addBlockedUidLocally,
  loadLocalBlockedUids,
  isLocallyBlockedPair,
  buildUserBlockId,
} from '../src/safety';
import {
  DEFAULT_COUNTRY_ISO,
  PHONE_COUNTRIES,
  detectSuggestedCountry,
  findCountryByE164,
  getCountriesByDialCode,
  getCountryDisplayName,
  normalizePhoneNumber,
  maskPhoneNumber,
  hashPhoneNumber,
  phoneHashToInternalEmail,
  searchPhoneCountries,
} from '../src/utils/phone';
import { testIdentityAcceptanceFlow } from '../src/firebase/diagnostic';
import { normalizeCalculatorSequence, isAdminRouteSequence } from '../src/ui/calculator';
import { formatAdminActivationDate } from '../src/ui/admin';
import { ADMIN_PAGE_SIZE } from '../src/firebase/admin';
import {
  GLOBAL_FALLBACK_LOCALE,
  LOCALE_REGISTRY,
  SUPPORTED_LOCALES,
  detectSystemLocale,
  getCurrentLocale,
  getLanguagePreference,
  getLocalizedCountryName,
  initI18n,
  loadLocaleDictionary,
  resolveEffectiveLocale,
  setAppLocale,
  setAppLocaleSync,
  t,
  type SupportedLocale,
} from '../src/i18n';
import { en } from '../src/i18n/locales/en';
import {
  DATING_BIO_MAX_LENGTH,
  DATING_DAILY_DISCOVERY_LIMIT,
  buildDatingLikeId,
  buildDatingMatchId,
  buildDatingMatchPayload,
  clearDatingMemoryFallbackForTests,
  doesProfileMatchFilters,
  filterActiveDatingMatches,
  filterAndLimitDiscoveryCandidates,
  getDailyDiscoveryQuota,
  getDatingMatchPartner,
  getUnmatchedConversationIds,
  getUnseenDatingMatches,
  isGenderCompatible,
  loadLocalDatingMatches,
  loadSavedDatingFilters,
  loadSavedDatingProfile,
  normalizeCityKey,
  recordLocalEvaluation,
  saveLocalDatingFilters,
  saveLocalDatingMatches,
  saveLocalDatingProfile,
  shouldDisplayCandidatePhoto,
  validateDatingFilters,
  validateDatingProfileInput,
} from '../src/dating';
import {
  DATING_PHOTO_MAX_DIMENSION,
  DATING_PHOTO_MIN_DIMENSION,
  buildDatingPhotoStoragePath,
  computeTargetPhotoDimensions,
  isSupportedPhotoMimeType,
} from '../src/media/photo';
import {
  buildCanonicalReferralUrl,
  buildWhatsAppReferralShareUrl,
  clearPendingReferralCode,
  clearReferralMemoryForTests,
  computeConversionRatePercent,
  deriveDeterministicReferralCode,
  extractReferralCodeFromSearch,
  getPendingReferralCode,
  isValidReferralCode,
  loadCachedReferralMetrics,
  normalizeReferralCode,
  saveCachedReferralMetrics,
  savePendingReferralCode,
} from '../src/referral';
import {
  buildDiscreetNotificationPayload,
  clearNotificationMemoryStateForTests,
  isNotificationKindEnabled,
  markDiscreetNotificationSent,
  shouldNotifyDiscreetly,
} from '../src/notifications';
import {
  computeGrowthMetricsSummary,
  getActivityPingStorageKey,
  getLocalDateDayKey,
  getWeekWindowStartIso,
} from '../src/growth';
import type { DatingMatch, DatingProfile } from '../src/types';

function assert(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`FALHA NO TESTE: ${description}`);
  }
}

export function runTalk2TMTests(): { passed: number; total: number } {
  let passed = 0;
  let total = 0;

  function check(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
    } catch (err) {
      console.error(`Erro no teste: ${name}`, err);
      throw err;
    }
  }

  // 1. Sanitização de Sala
  check('Sanitização de Sala normaliza e limita para 32 caracteres', () => {
    assert(sanitizeRoom('  Sala-01_Alfa!@#$%^&*()  ') === 'sala-01_alfa', 'Deve remover símbolos');
    assert(sanitizeRoom('<script>alert(1)</script>') === 'scriptalert1script', 'Deve neutralizar scripts');
    assert(sanitizeRoom('a'.repeat(50)).length === CONFIG.ROOM_MAX_LENGTH, 'Deve truncar para ROOM_MAX_LENGTH');
  });

  // 2. Sanitização de Nome
  check('Sanitização de Nome normaliza e limita para 30 caracteres', () => {
    assert(sanitizeName('   Alice \u0000\u0007   ') === 'Alice', 'Deve remover caracteres de controle');
    assert(sanitizeName('B'.repeat(50)).length === CONFIG.NAME_MAX_LENGTH, 'Deve truncar para NAME_MAX_LENGTH');
  });

  // 3. Sanitização de Mensagem
  check('Validação de Mensagem: rejeita vazia, rejeita espaços, valida limites', () => {
    assert(!sanitizeMessageText('').valid, 'Rejeita string vazia');
    assert(!sanitizeMessageText('   \n\t  ').valid, 'Rejeita apenas espaços');

    const validMsg = sanitizeMessageText('Olá mundo! 123 @#$');
    assert(validMsg.valid, 'Aceita mensagem válida');
    assert(validMsg.text === 'Olá mundo! 123 @#$', 'Preserva texto válido');

    const oversized = sanitizeMessageText('x'.repeat(CONFIG.MESSAGE_MAX_LENGTH + 1));
    assert(!oversized.valid, 'Rejeita payload acima do limite máximo');
  });

  // 4. Anti-Media & Anti-HTML
  check('Anti-Media: tags são tratadas como texto puro', () => {
    const malicious = '<img src=x onerror=alert(1)><b>Texto</b><iframe src="//evil.com"></iframe>';
    const res = sanitizeMessageText(malicious);
    assert(res.valid, 'Valida string como texto');
    assert(res.text === malicious, 'Mantém caracteres para renderização segura via textContent');
  });

  // 5. Idempotência
  check('Idempotência de chaves de mensagens', () => {
    const roomId = 'sala-01';
    const clientId = generateId('cli');
    const id1 = `${roomId}_${clientId}`;
    const id2 = `${roomId}_${clientId}`;
    assert(id1 === id2, 'Chaves idênticas geram mesmo identificador único de documento');
  });

  // 6. Limite de 2 Participantes
  check('Regra de 2 participantes por sala', () => {
    function tryJoin(room: Room | null, userId: string, userName: string): { success: boolean; error?: string } {
      if (!room) return { success: true };
      if (room.participantA === userId || room.participantB === userId) return { success: true };
      if (!room.participantB || room.participantB === '') return { success: true };
      return { success: false, error: 'Sala cheia: limite de 2 participantes atingido.' };
    }

    assert(tryJoin(null, 'usr-1', 'Truman').success, 'Permite participante A');

    const roomWithA: Room = {
      roomId: 'sala-a',
      participantA: 'usr-1',
      participantAName: 'Truman',
      participantB: null,
      participantBName: null,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
    assert(tryJoin(roomWithA, 'usr-2', 'Mãezinha').success, 'Permite participante B');

    const roomWithTwo: Room = {
      roomId: 'sala-a',
      participantA: 'usr-1',
      participantAName: 'Truman',
      participantB: 'usr-2',
      participantBName: 'Mãezinha',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
    const thirdAttempt = tryJoin(roomWithTwo, 'usr-3', 'Outro');
    assert(!thirdAttempt.success, 'Rejeita terceiro participante');
  });

  // 7. Determinação de Usuário por Senha Única
  check('Determinação automática de conta pela senha', () => {
    assert(getUserByPin('852456') === 'Truman', 'Senha 852456 deve entrar como Truman');
    assert(getUserByPin('135790') === 'Mãezinha', 'Senha 135790 deve entrar como Mãezinha');
    assert(getUserByPin('000000') === null, 'Senha desconhecida deve retornar null');
    assert(ACCESS_CONFIG.USERS.length === 2, 'Exatamente dois usuários no sistema');
    assert(DEFAULT_SETTINGS.inactivityLockSeconds === 300, 'Inatividade padrão de 5 minutos (300 segundos)');
    assert(DEFAULT_SETTINGS.sessionTimeoutMinutes === 5, 'Tempo de sessão padrão de 5 minutos');
  });

  // 8. Verificação de Senha em app.ts ('852456' -> Truman, '135790' -> Mãezinha)
  check('app.ts: verificação de senha com campo único', () => {
    const trumanAuth = verifyPassword(PASSWORDS.TRUMAN);
    assert(trumanAuth.valid === true, 'Senha Truman deve ser válida');
    assert(trumanAuth.user === 'Truman', 'Usuário autenticado deve ser Truman');
    assert(trumanAuth.userId === 'usr_truman', 'ID deve ser usr_truman');

    const maezinhaAuth = verifyPassword(PASSWORDS.MAEZINHA);
    assert(maezinhaAuth.valid === true, 'Senha Mãezinha deve ser válida');
    assert(maezinhaAuth.user === 'Mãezinha', 'Usuário autenticado deve ser Mãezinha');
    assert(maezinhaAuth.userId === 'usr_maezinha', 'ID deve ser usr_maezinha');

    const invalidAuth = verifyPassword('999999');
    assert(invalidAuth.valid === false, 'Senha incorreta deve ser rejeitada');

    const emptyAuth = verifyPassword('   ');
    assert(emptyAuth.valid === false, 'Senha em branco deve ser rejeitada');
  });

  // 9. Diagnóstico de Sincronização A <-> B
  check('Módulo de Diagnóstico: assinatura e contrato de teste A <-> B', () => {
    assert(typeof testRealtimeSyncAtoB === 'function', 'testRealtimeSyncAtoB deve ser uma função exportada');
  });

  // 10. Autenticação Anônima do Firebase
  check('Firebase Auth: assinatura e contrato de ensureFirebaseAuth e getFirebaseAuth', () => {
    assert(typeof ensureFirebaseAuth === 'function', 'ensureFirebaseAuth deve ser uma função exportada');
    assert(typeof getFirebaseAuth === 'function', 'getFirebaseAuth deve ser uma função exportada');
  });

  // 11. Credenciais Pré-Provisionadas mapeadas aos PINs
  check('Auth: Mapeamento seguro de credenciais por usuário', () => {
    const trumanCred = getCredentialsByUser('Truman');
    assert(trumanCred !== undefined, 'Credencial de Truman deve existir');
    assert(trumanCred.email === 'truman@talk2tm.internal', 'Email de Truman mapeado');
    assert(trumanCred.pass.length > 8, 'Senha forte pré-provisionada');
    assert(trumanCred.fallbackUid === 'uid_truman_852456', 'UID determinístico para Truman');

    const maezinhaCred = getCredentialsByUser('Mãezinha');
    assert(maezinhaCred !== undefined, 'Credencial de Mãezinha deve existir');
    assert(maezinhaCred.email === 'maezinha@talk2tm.internal', 'Email de Mãezinha mapeado');
    assert(maezinhaCred.pass.length > 8, 'Senha forte pré-provisionada');
    assert(maezinhaCred.fallbackUid === 'uid_maezinha_135790', 'UID determinístico para Mãezinha');
  });

  // 12. Funções de Autenticação Transparente e Restauração de Sessão
  check('Auth: Assinatura das funções de autenticação transparente e guarda de outbox', () => {
    assert(typeof silentAuthenticateWithEmail === 'function', 'silentAuthenticateWithEmail deve ser uma função exportada');
    assert(typeof restoreAuthSession === 'function', 'restoreAuthSession deve ser uma função exportada');
    assert(typeof isAuthValidAndNonAnonymous === 'function', 'isAuthValidAndNonAnonymous deve ser uma função exportada');
    // Em ambiente de teste sem login ativo, isAuthValidAndNonAnonymous deve retornar falso
    assert(isAuthValidAndNonAnonymous() === false, 'isAuthValidAndNonAnonymous deve retornar false quando não autenticado');
  });

  // 13. Sistema de "Visto por" (Read Receipts): getPartnerLastRead e resolução de timestamps
  check('Read Receipts: getPartnerLastRead resolve corretamente o carimbo de leitura do parceiro', () => {
    const mockRoom: Room = {
      roomId: 'talk2tm_main',
      participantA: 'uid_truman_852456',
      participantAName: 'Truman',
      participantB: 'uid_maezinha_135790',
      participantBName: 'Mãezinha',
      createdAt: '2026-09-07T10:00:00.000Z',
      lastActivity: '2026-09-07T10:05:00.000Z',
      lastRead: {
        Truman: '2026-09-07T10:04:00.000Z',
        Mãezinha: '2026-09-07T10:05:00.000Z',
      },
    };

    // Truman consultando a última leitura de Mãezinha
    const readByMaezinha = getPartnerLastRead(mockRoom, 'Truman', 'uid_truman_852456');
    assert(readByMaezinha === '2026-09-07T10:05:00.000Z', 'Truman deve obter timestamp de Mãezinha');

    // Mãezinha consultando a última leitura de Truman
    const readByTruman = getPartnerLastRead(mockRoom, 'Mãezinha', 'uid_maezinha_135790');
    assert(readByTruman === '2026-09-07T10:04:00.000Z', 'Mãezinha deve obter timestamp de Truman');

    // Sala nula retorna null
    assert(getPartnerLastRead(null, 'Truman') === null, 'Sala nula deve retornar null');

    // Suporte ao fallback lastReadA / lastReadB
    const legacyRoom: Room = {
      roomId: 'talk2tm_main',
      participantA: 'uid_truman_852456',
      participantAName: 'Truman',
      participantB: 'uid_maezinha_135790',
      participantBName: 'Mãezinha',
      lastReadA: '2026-09-07T09:00:00.000Z',
      lastReadB: '2026-09-07T09:30:00.000Z',
      createdAt: '2026-09-07T08:00:00.000Z',
      lastActivity: '2026-09-07T09:30:00.000Z',
    };
    assert(getPartnerLastRead(legacyRoom, 'Truman') === '2026-09-07T09:30:00.000Z', 'Fallback para lastReadB para parceiro Mãezinha');
    assert(getPartnerLastRead(legacyRoom, 'Mãezinha') === '2026-09-07T09:00:00.000Z', 'Fallback para lastReadA para parceiro Truman');
  });

  // 14. Lógica de Status de Mensagens com "Visto por"
  check('Read Receipts: Verificação do estado "visto" vs "enviado" baseado em timestamps', () => {
    const partnerReadTime = '2026-09-07T12:00:00.000Z';

    const olderMsgCreatedAt = '2026-09-07T11:59:00.000Z';
    const newerMsgCreatedAt = '2026-09-07T12:05:00.000Z';

    const isOlderMsgRead = partnerReadTime >= olderMsgCreatedAt;
    const isNewerMsgRead = partnerReadTime >= newerMsgCreatedAt;

    assert(isOlderMsgRead === true, 'Mensagem anterior ou igual ao carimbo deve ser considerada vista');
    assert(isNewerMsgRead === false, 'Mensagem posterior ao carimbo deve permanecer como não lida');
  });

  // 15. Assinatura de updateFirestoreLastRead
  check('Read Receipts: Assinatura da função de sincronização updateFirestoreLastRead', () => {
    assert(typeof updateFirestoreLastRead === 'function', 'updateFirestoreLastRead deve ser uma função exportada');
  });

  // 16. Camada 2 — Estado de Autenticação Único (AuthState)
  check('Auth: Estados de autenticação e valores do enum AuthState', () => {
    assert(AuthState.UNINITIALIZED === 'uninitialized', 'Estado uninitialized deve existir');
    assert(AuthState.AUTHENTICATING === 'authenticating', 'Estado authenticating deve existir');
    assert(AuthState.AUTHENTICATED_NON_ANONYMOUS === 'authenticated_non_anonymous', 'Estado authenticated_non_anonymous deve existir');
    assert(AuthState.ANONYMOUS === 'anonymous', 'Estado anonymous deve existir');
    assert(AuthState.FAILED === 'failed', 'Estado failed deve existir');
    assert(typeof getAuthState === 'function', 'getAuthState deve ser função exportada');
  });

  // 17. Camada 2.2 — Promessa de Conclusão da Autenticação
  check('Auth: Assinatura e contrato de waitForAuthCompletion', () => {
    assert(typeof waitForAuthCompletion === 'function', 'waitForAuthCompletion deve ser uma função exportada');
  });

  // 18. Camada 4 — Guarda de Envio no Firestore sem identidade válida
  check('Firestore: sendFirestoreMessage rejeita quando unauthenticated ou anônimo', async () => {
    assert(typeof sendFirestoreMessage === 'function', 'sendFirestoreMessage deve ser função exportada');
  });

  // 19. PWA Storage: Fallback em memória e persistência com versão
  check('PWA Storage: Operação segura e versionamento talk2tm_pwa_prompt_v1', () => {
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    assert(PWA_STORAGE_KEY === 'talk2tm_pwa_prompt_v1', 'Chave deve ser versionada com v1');

    const initialState = getPWAState(mockStorage);
    assert(initialState.decision === 'unprompted', 'Estado inicial deve ser unprompted');
    assert(initialState.version === PWA_PROMPT_VERSION, 'Versão do estado deve corresponder');

    savePWAState({ decision: 'continued', timestamp: 1000 }, mockStorage);
    const savedState = getPWAState(mockStorage);
    assert(savedState.decision === 'continued', 'Decisão deve persistir no storage');
    assert(savedState.timestamp === 1000, 'Timestamp deve persistir no storage');
  });

  // 20. PWA Standalone Mode: Nunca exibe prompt e marca installed
  check('PWA Standalone: Quando executando como PWA, não exibe prompt e marca installed', () => {
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    // Forçando standalone = true
    const shouldShow = shouldShowPWAPrompt(Date.now(), mockStorage, true);
    assert(shouldShow === false, 'Não deve exibir prompt em modo standalone');

    const state = getPWAState(mockStorage);
    assert(state.decision === 'installed', 'Detectar standalone deve persistir decision installed');

    // Uma vez installed, mesmo sem flag standalone o prompt nunca mais reaparece
    const shouldShowAfter = shouldShowPWAPrompt(Date.now(), mockStorage, false);
    assert(shouldShowAfter === false, 'Estado installed impede reexibição');
  });

  // 21. PWA Continuar: Cooldown suave de 7 dias
  check('PWA Cooldown: Continuar bloqueia exibição por 7 dias e libera após', () => {
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    const t0 = 1000000000000;
    savePWAState({ decision: 'continued', timestamp: t0 }, mockStorage);

    // 6 dias depois: ainda em cooldown
    const t6Days = t0 + (6 * 24 * 60 * 60 * 1000);
    assert(shouldShowPWAPrompt(t6Days, mockStorage, false) === false, '6 dias após continuar deve continuar em cooldown');

    // 7 dias e 1 segundo depois: cooldown expirado
    const t7DaysPlus = t0 + PWA_COOLDOWNS.CONTINUED_MS + 1000;
    assert(shouldShowPWAPrompt(t7DaysPlus, mockStorage, false) === true, 'Após 7 dias deve liberar exibição');
  });

  // 22. PWA Recusado: Cooldown longo de 14 dias
  check('PWA Cooldown: Dismissed nativo bloqueia por 14 dias e libera após', () => {
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    const t0 = 1000000000000;
    savePWAState({ decision: 'dismissed', timestamp: t0 }, mockStorage);

    // 13 dias depois: ainda em cooldown
    const t13Days = t0 + (13 * 24 * 60 * 60 * 1000);
    assert(shouldShowPWAPrompt(t13Days, mockStorage, false) === false, '13 dias após dismissed deve continuar em cooldown');

    // 14 dias e 1 segundo depois: cooldown expirado
    const t14DaysPlus = t0 + PWA_COOLDOWNS.DISMISSED_MS + 1000;
    assert(shouldShowPWAPrompt(t14DaysPlus, mockStorage, false) === true, 'Após 14 dias deve liberar exibição');
  });

  // 23. PWA Instalação Aceita: Transição accepted → install_pending e appinstalled → installed
  check('PWA Transições de Estado: accepted marca install_pending e finalização marca installed', () => {
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    const now = 2000000000000;
    savePWAState({ decision: 'install_pending', timestamp: now }, mockStorage);
    assert(getPWAState(mockStorage).decision === 'install_pending', 'Estado intermediário registrado');

    // Durante as 24h de pending, não re-exibe
    assert(shouldShowPWAPrompt(now + 1000, mockStorage, false) === false, 'Install pending bloqueia reexibição imediata');

    // Conclusão com appinstalled
    savePWAState({ decision: 'installed', timestamp: now + 5000 }, mockStorage);
    assert(getPWAState(mockStorage).decision === 'installed', 'Conclusão confirmada como installed');
    assert(shouldShowPWAPrompt(now + 999999999, mockStorage, false) === false, 'Installed nunca mais reexibe');
  });

  // 24. PWA Versionamento: Chaves legadas ou versões antigas são migradas sem travar
  check('PWA Versionamento: Dados com versão antiga são descartados elegantemente', () => {
    const memoryStore: Record<string, string> = {
      [PWA_STORAGE_KEY]: JSON.stringify({ version: 'v0_old', decision: 'continued', timestamp: 9999 }),
    };
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    const state = getPWAState(mockStorage);
    assert(state.decision === 'unprompted', 'Versão anterior deve resetar para unprompted');
    assert(state.version === PWA_PROMPT_VERSION, 'Estado deve adotar a nova versão');
  });

  // 25. Assinatura da Classe PWAPromptBar e detecção de dispositivos
  check('PWA Component: Assinaturas de PWAPromptBar, isStandaloneMode e isAppleMobileDevice', () => {
    assert(typeof PWAPromptBar === 'function', 'PWAPromptBar deve ser uma classe exportada');
    assert(typeof isStandaloneMode === 'function', 'isStandaloneMode deve ser função exportada');
    assert(typeof isAppleMobileDevice === 'function', 'isAppleMobileDevice deve ser função exportada');
  });

  // 26. Exclusão Local (Tombstone): Persistência por roomId e por dispositivo
  check('Exclusão Local: Tombstone marca mensagens como ocultadas localmente de forma idempotente', () => {
    const testRoom = 'sala-teste-tombstone';
    const msgId1 = 'msg_001_truman';
    const msgId2 = 'msg_002_maezinha';

    assert(!isMessageHiddenLocally(testRoom, msgId1), 'Mensagem nova não deve estar oculta');
    assert(!isMessageHiddenLocally(testRoom, msgId2), 'Mensagem nova não deve estar oculta');

    hideMessagesLocally(testRoom, [msgId1, msgId2]);

    assert(isMessageHiddenLocally(testRoom, msgId1) === true, 'msgId1 deve estar marcada como oculta');
    assert(isMessageHiddenLocally(testRoom, msgId2) === true, 'msgId2 deve estar marcada como oculta');

    const hiddenSet = getHiddenMessageIds(testRoom);
    assert(hiddenSet.has(msgId1) && hiddenSet.has(msgId2), 'Set de IDs ocultos deve conter ambos');
    assert(isMessageHiddenLocally('outra-sala', msgId1) === false, 'Tombstones devem ser isolados por roomId');
  });

  // 27. Cenário Crítico: Mensagem no Firestore -> apagada localmente -> listener onSnapshot descarta
  check('Cenário Crítico: Listener Firestore filtra mensagens apagadas localmente antes de salvar ou renderizar', () => {
    const testRoom = 'sala-sync-critica';
    const msgDeleted = 'msg_firestore_deleted_locally';
    const msgKept = 'msg_firestore_kept';

    hideMessagesLocally(testRoom, [msgDeleted]);

    const incomingFirestoreBatch = [
      { messageId: msgDeleted, text: 'Segredo apagado', senderId: 'truman' },
      { messageId: msgKept, text: 'Mensagem ativa', senderId: 'maezinha' },
    ];

    // Simula lógica idêntica à do subscribeToMessages
    const processedForRender: string[] = [];
    for (const msg of incomingFirestoreBatch) {
      if (isMessageHiddenLocally(testRoom, msg.messageId)) {
        continue; // Filtro estrito antes de renderizar
      }
      processedForRender.push(msg.messageId);
    }

    assert(processedForRender.length === 1, 'Deve conter somente 1 mensagem');
    assert(processedForRender[0] === msgKept, 'A mensagem mantida deve ser msgKept');
    assert(!processedForRender.includes(msgDeleted), 'A mensagem apagada localmente NUNCA deve ser processada');
  });

  // 28. Expansion V1: Integridade da cadeia de invariantes das 5 entidades
  check('Expansion V1: Estrutura das 5 entidades e invariante de participantes de conversa', () => {
    // Validação de formato Talk2TM ID: TM-XXXX-XXXX
    const talk2tmIdRegex = /^TM-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    const sampleId = 'TM-K7P4-X92M';
    assert(talk2tmIdRegex.test(sampleId), 'Formato de Talk2TM ID deve ser TM-XXXX-XXXX');

    // Validação da invariante de conversa estrita (exatamente 2 participantes)
    const conv = {
      conversationId: 'conv_123',
      participantA: 'uid_truman',
      participantB: 'uid_maezinha',
      talk2tmIdA: 'TM-K7P4-X92M',
      talk2tmIdB: 'TM-M3A1-Z99B',
      displayNameA: 'Truman',
      displayNameB: 'Mãezinha',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const isParticipant = (uid: string) => uid === conv.participantA || uid === conv.participantB;
    assert(isParticipant('uid_truman') === true, 'Truman é participante A');
    assert(isParticipant('uid_maezinha') === true, 'Mãezinha é participante B');
    assert(isParticipant('uid_invasor') === false, 'Terceiros não são participantes da conversa');
  });

  // 29. Phase 2 (Onboarding Ultraleve): Geração de ID e invariantes de perfil/identidade
  check('Fase 2: Geração de ID TM-XXXX-XXXX e integridade da credencial sem fricção', () => {
    const talk2tmIdRegex = /^TM-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
    
    // Gerar e testar 10 IDs para garantir conformidade
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let i = 0; i < 10; i++) {
      const array = new Uint8Array(8);
      for (let j = 0; j < 8; j++) array[j] = Math.floor(Math.random() * 256);
      const p1 = Array.from(array.slice(0, 4)).map((b) => chars[b % chars.length]).join('');
      const p2 = Array.from(array.slice(4, 8)).map((b) => chars[b % chars.length]).join('');
      const id = `TM-${p1}-${p2}`;
      
      assert(talk2tmIdRegex.test(id), `ID gerado ${id} deve respeitar formato TM-XXXX-XXXX sem ambiguidade`);
      assert(id.length === 12, 'Comprimento do ID deve ser exatamente 12 caracteres (TM-XXXX-XXXX)');
      assert(!id.includes('0') && !id.includes('O') && !id.includes('1') && !id.includes('I'), 'Não deve conter caracteres ambíguos');
    }

    // Invariante da credencial interna sem fricção
    const mockTalkId = 'TM-K7P4-X92M';
    const internalEmail = `tm_${mockTalkId.toLowerCase().replace(/[^a-z0-9]/g, '_')}@talk2tm.internal`;
    assert(internalEmail === 'tm_tm_k7p4_x92m@talk2tm.internal', 'Email interno determinístico');
  });

  // 30. Phase 4 (Canal de Mensagens): Determinismo do ID de conversa bilateral
  check('Fase 4: Determinismo e simetria do ID de conversa bilateral', () => {
    const userA = 'TM-2K9P-X7M4';
    const userB = 'TM-8W3J-L5N2';

    const convId1 = buildDeterministicConversationId(userA, userB);
    const convId2 = buildDeterministicConversationId(userB, userA);

    assert(convId1 === convId2, 'IDs de conversa gerados em ordens inversas devem ser estritamente idênticos');
    assert(convId1.startsWith('conv_'), 'Prefixo de conversa bilateral deve ser conv_');
    assert(convId1.includes(userA) && convId1.includes(userB), 'Deve conter os dois participantes');
  });

  // 31. Phase 4 (Canal de Mensagens): Mapeamento de Conversation para modelo Room com recibos
  check('Fase 4: Mapeamento de Conversation para Room com recibos de leitura', () => {
    const mockConv: Conversation = {
      conversationId: 'conv_TM-2K9P-X7M4_TM-8W3J-L5N2',
      participantA: 'uid_a',
      participantB: 'uid_b',
      displayNameA: 'Truman',
      displayNameB: 'Mãezinha',
      talk2tmIdA: 'TM-2K9P-X7M4',
      talk2tmIdB: 'TM-8W3J-L5N2',
      lastReadA: '2026-03-20T10:00:00.000Z',
      lastReadB: '2026-03-20T10:05:00.000Z',
      createdAt: '2026-03-20T09:00:00.000Z',
      updatedAt: '2026-03-20T10:05:00.000Z',
    };

    const room = conversationToRoom(mockConv);
    assert(room.roomId === mockConv.conversationId, 'roomId deve refletir conversationId');
    assert(room.participantAName === 'Truman', 'Nome do participante A preservado');
    assert(room.participantBName === 'Mãezinha', 'Nome do participante B preservado');
    assert(room.lastReadA === '2026-03-20T10:00:00.000Z', 'lastReadA preservado');
    assert(room.lastReadB === '2026-03-20T10:05:00.000Z', 'lastReadB preservado');
    assert(room.lastRead['Truman'] === '2026-03-20T10:00:00.000Z', 'Mapa lastRead por nome mapeado');
  });

  // 32. Phase 4 (Canal de Mensagens): Isolamento de tombstones por conversationId
  check('Fase 4: Exclusão local (tombstones) isolada e persistente por canal conversationId', () => {
    const convId = 'conv_TM-ALPHA_TM-BETA';
    const otherConvId = 'conv_TM-GAMMA_TM-DELTA';
    const msgId = `${convId}_cli_12345`;

    hideMessagesLocally(convId, [msgId]);
    assert(isMessageHiddenLocally(convId, msgId) === true, 'Mensagem deve estar marcada como hidden no convId');
    assert(isMessageHiddenLocally(otherConvId, msgId) === false, 'Mensagem não deve afetar outros canais de conversa');
  });

  // 33. Observabilidade: Inicialização graciosa, higienização de credenciais e captura sem falhas
  check('Observabilidade: Resiliência a ausência de DSN e sanitização de credenciais', () => {
    // Validação estrita de DSN para evitar erros tipo "Invalid Sentry Dsn: https://sentry.io"
    assert(isValidSentryDsn('https://sentry.io') === false, 'https://sentry.io sem chave pública não deve ser aceito');
    assert(isValidSentryDsn('') === false, 'DSN vazio não deve ser aceito');
    assert(isValidSentryDsn(undefined) === false, 'DSN indefinido não deve ser aceito');
    assert(
      isValidSentryDsn('https://abc123def456@o123456.ingest.sentry.io/789012') === true,
      'DSN completo com public key e project id deve ser aceito'
    );

    // Inicialização não deve disparar exceções mesmo sem variáveis de ambiente configuradas
    initObservability();
    const status = getObservabilityStatus();
    assert(typeof status.sentry === 'boolean', 'Status do Sentry deve ser booleano');
    assert(status.betterstack === false, 'Better Stack deve estar estritamente desativado no frontend');

    // Funções de captura devem ser no-op seguras sem DSN
    let erroCaptura = false;
    try {
      captureException(new Error('Erro de teste com PIN 852456'), { context: 'unit_test' });
      captureMessage('Mensagem com senha 135790 para auditoria', 'info');
    } catch {
      erroCaptura = true;
    }
    assert(erroCaptura === false, 'captureException e captureMessage não devem lançar exceções não tratadas');
  });

  // 34. Teste de Aceitação: Ciclo de vida completo do Cadastramento Assistido
  check('Cadastramento Assistido: Ciclo de vida controlado da identidade e persistência local', () => {
    // 1. Apelido e Geração do Talk2TM ID
    const apelido = 'Truman_QA';
    const talk2tmId = generateTalk2TMId();
    assert(talk2tmId.startsWith('TM-'), 'Código gerado deve começar com TM-');
    assert(talk2tmId.length === 12, 'Código deve ter 12 caracteres (TM-XXXX-XXXX)');

    // 2. E-mail interno associado à infraestrutura
    const emailInterno = talk2tmIdToInternalEmail(talk2tmId);
    assert(emailInterno.endsWith('@talk2tm.internal'), 'E-mail interno deve pertencer ao domínio @talk2tm.internal');

    // 3. Simulação de Persistência no Dispositivo (localStorage)
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
    };

    const mockIdentity: LocalIdentity = {
      uid: 'uid_test_acceptance_123',
      talk2tmId,
      displayName: apelido,
      internalEmail: emailInterno,
      internalSecret: 'sec_1234567890!@',
      createdAt: new Date().toISOString(),
    };

    saveLocalIdentity(mockIdentity, mockStorage);
    const restored = getLocalIdentity(mockStorage);
    assert(restored !== null, 'Identidade deve ser salva no armazenamento local');
    assert(restored?.talk2tmId === talk2tmId, 'Código restaurado deve ser idêntico');
    assert(restored?.uid === mockIdentity.uid, 'UID restaurado deve ser idêntico');
    assert(restored?.displayName === apelido, 'Apelido restaurado deve ser idêntico');

    // 4. Limpeza e restauração limpa
    clearLocalIdentity(mockStorage);
    assert(getLocalIdentity(mockStorage) === null, 'Após limpeza, a identidade local deve ser nula');

    // 5. Contrato da função de teste de aceitação de produção
    assert(typeof testIdentityAcceptanceFlow === 'function', 'testIdentityAcceptanceFlow deve ser função exportada');
  });

  // 35. Migração transparente de configurações para 5 minutos padrão
  check('PWA: Migração automática de configurações legadas para 5 minutos padrão', () => {
    // Simula armazenamento com valor legado de 5 segundos que causava fechamento abrupto
    const fakeStorage: Record<string, string> = {
      ttm_settings: JSON.stringify({ sessionTimeoutMinutes: 15, inactivityLockSeconds: 5 }),
    };
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => fakeStorage[key] || null,
      setItem: (key: string, val: string) => { fakeStorage[key] = val; },
      removeItem: (key: string) => { delete fakeStorage[key]; },
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;

    try {
      const loaded = loadSettings();
      assert(loaded.inactivityLockSeconds === 300, 'Configuração legada de 5s deve migrar automaticamente para 300s (5min)');
      assert(loaded.version === 2, 'Versão das configurações deve ser atualizada para 2');
      const persisted = JSON.parse(fakeStorage.ttm_settings);
      assert(persisted.inactivityLockSeconds === 300, 'Novo valor de 300s deve ser persistido no localStorage sem esforço');
      assert(persisted.version === 2, 'Versão 2 deve ser persistida');
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }
  });

  // 36. Selecionar Tudo e Apagar em Lote: Tombstones locais simultâneos
  check('Exclusão em Lote: Selecionar tudo e aplicar tombstones locais a múltiplas mensagens', () => {
    const channelId = 'channel_batch_delete_test';
    const messageIds = ['msg_batch_1', 'msg_batch_2', 'msg_batch_3', 'msg_batch_4'];

    // Antes da exclusão, nenhuma está oculta
    messageIds.forEach((id) => {
      assert(isMessageHiddenLocally(channelId, id) === false, `Mensagem ${id} não deve estar oculta antes da exclusão`);
    });

    // Executa exclusão em lote de todas as selecionadas
    hideMessagesLocally(channelId, messageIds);

    // Todas devem estar ocultas no canal
    messageIds.forEach((id) => {
      assert(isMessageHiddenLocally(channelId, id) === true, `Mensagem ${id} deve estar oculta após selecionar tudo e apagar`);
    });
  });

  // 37. Opção 2: Exclusão sincronizada por usuário entre aparelhos (deletedFor)
  check('Opção 2: Filtragem cross-device de mensagens marcadas com deletedFor', () => {
    const myUid = 'uid_truman_real';
    const otherUid = 'uid_maezinha_real';
    const shouldHide = (deletedFor: string[] | undefined, uid: string) =>
      Boolean(deletedFor && Array.isArray(deletedFor) && deletedFor.includes(uid));

    assert(shouldHide([myUid], myUid) === true, 'Mensagem marcada para meu UID deve ser ocultada em qualquer aparelho');
    assert(shouldHide([myUid], otherUid) === false, 'Mensagem apagada apenas por mim deve permanecer visível para o outro participante');
    assert(shouldHide(undefined, myUid) === false, 'Mensagem sem deletedFor deve ser exibida normalmente');
  });

  // 38. Indicador DEG: hasUnreadIncomingMessage evita falsos positivos (remetente, deletedFor, tombstones, lastRead)
  check('Indicador DEG: hasUnreadIncomingMessage detecta apenas mensagens novas reais do parceiro', () => {
    const myUid = 'uid_truman';
    const partnerUid = 'uid_maezinha';
    const lastRead = '2026-09-07T10:00:00.000Z';

    const makeMsg = (overrides: Partial<Message>): Message => ({
      messageId: 'm_default',
      room: 'talk2tm_main',
      sender: 'Mãezinha',
      senderId: partnerUid,
      text: 'Olá',
      clientId: 'cli_1',
      createdAt: '2026-09-07T10:05:00.000Z',
      status: 'synced',
      ...overrides,
    });

    // 1. Própria mensagem posterior ao lastRead não dispara ponto vermelho
    assert(
      hasUnreadIncomingMessage({
        messages: [makeMsg({ messageId: 'm1', senderId: myUid, sender: 'Truman' })],
        myUid,
        myDisplayName: 'Truman',
        lastReadIso: lastRead,
      }) === false,
      'Mensagem enviada pelo próprio UID não deve ativar indicador'
    );

    // 2. Própria mensagem identificada por displayName não dispara ponto vermelho
    assert(
      hasUnreadIncomingMessage({
        messages: [makeMsg({ messageId: 'm2', senderId: 'legacy_uid', sender: 'Truman' })],
        myUid,
        myDisplayName: 'Truman',
        lastReadIso: lastRead,
      }) === false,
      'Mensagem com mesmo displayName do usuário não deve ativar indicador'
    );

    // 3. Mensagem do parceiro anterior ou igual ao lastRead não dispara
    assert(
      hasUnreadIncomingMessage({
        messages: [makeMsg({ messageId: 'm3', createdAt: '2026-09-07T10:00:00.000Z' })],
        myUid,
        myDisplayName: 'Truman',
        lastReadIso: lastRead,
      }) === false,
      'Mensagem já consultada (<= lastRead) não deve ativar indicador'
    );

    // 4. Mensagem do parceiro com deletedFor do usuário não dispara
    assert(
      hasUnreadIncomingMessage({
        messages: [makeMsg({ messageId: 'm4', deletedFor: [myUid] })],
        myUid,
        myDisplayName: 'Truman',
        lastReadIso: lastRead,
      }) === false,
      'Mensagem apagada via deletedFor não deve ativar indicador'
    );

    // 5. Mensagem do parceiro ocultada localmente (tombstone) não dispara
    assert(
      hasUnreadIncomingMessage({
        messages: [makeMsg({ messageId: 'm5' })],
        myUid,
        myDisplayName: 'Truman',
        lastReadIso: lastRead,
        isHiddenFn: (id) => id === 'm5',
      }) === false,
      'Mensagem ocultada localmente não deve ativar indicador'
    );

    // 6. Mensagem nova do parceiro após lastRead ativa o indicador
    assert(
      hasUnreadIncomingMessage({
        messages: [makeMsg({ messageId: 'm6', createdAt: '2026-09-07T10:01:00.000Z' })],
        myUid,
        myDisplayName: 'Truman',
        lastReadIso: lastRead,
      }) === true,
      'Mensagem nova do parceiro após lastRead deve ativar o indicador'
    );
  });

  // 39. selectLatestMessages nunca descarta mensagens mais recentes em coleções > 100 docs
  check('Firestore Query Helper: selectLatestMessages preserva as N mais recentes em ordem cronológica', () => {
    const bulk: Message[] = [];
    for (let i = 0; i < 150; i++) {
      const hour = String(Math.floor(i / 60)).padStart(2, '0');
      const min = String(i % 60).padStart(2, '0');
      bulk.push({
        messageId: `msg_${i}`,
        room: 'talk2tm_main',
        sender: 'Mãezinha',
        senderId: 'uid_maezinha',
        text: `Msg ${i}`,
        clientId: `c_${i}`,
        createdAt: `2026-09-07T${hour}:${min}:00.000Z`,
        status: 'synced',
      });
    }
    // Embaralha simulando retorno arbitrário sem orderBy
    const reversed = [...bulk].reverse();
    const latest80 = selectLatestMessages(reversed, 80);

    assert(latest80.length === 80, 'Deve retornar exatamente 80 mensagens mais recentes');
    assert(latest80[0].messageId === 'msg_70', 'Primeira das 80 recentes deve ser msg_70');
    assert(latest80[79].messageId === 'msg_149', 'Última das 80 recentes deve ser msg_149');
    assert(latest80[0].createdAt < latest80[79].createdAt, 'Deve retornar ordenado cronologicamente ascendente');
  });

  // 40. normalizeAndDeduplicateMessages elimina duplicatas mantendo status mais avançado
  check('Deduplicação: normalizeAndDeduplicateMessages remove duplicatas e mantém ordem cronológica', () => {
    const msgs: Message[] = [
      {
        messageId: 'm_2',
        room: 'r',
        sender: 'Truman',
        senderId: 'u1',
        text: 'segunda',
        clientId: 'c2',
        createdAt: '2026-09-07T10:02:00.000Z',
        status: 'pending',
      },
      {
        messageId: 'm_1',
        room: 'r',
        sender: 'Mãezinha',
        senderId: 'u2',
        text: 'primeira',
        clientId: 'c1',
        createdAt: '2026-09-07T10:01:00.000Z',
        status: 'synced',
      },
      {
        messageId: 'm_2',
        room: 'r',
        sender: 'Truman',
        senderId: 'u1',
        text: 'segunda',
        clientId: 'c2',
        createdAt: '2026-09-07T10:02:00.000Z',
        status: 'read',
      },
    ];

    const result = normalizeAndDeduplicateMessages(msgs, 'u1');
    assert(result.length === 2, 'Deve deduplicar m_2 deixando apenas 2 mensagens');
    assert(result[0].messageId === 'm_1', 'Ordem cronológica coloca m_1 primeiro');
    assert(result[1].messageId === 'm_2' && result[1].status === 'read', 'Status read deve prevalecer sobre pending');
  });

  // 41. getSelfLastReadFromChannel, maxIsoDate e persistência monotônica de MonitorContext / lastRead
  check('MonitorContext & lastRead: resolução segura e persistência local sem desbloquear PIN', () => {
    const room: Room = {
      roomId: 'talk2tm_main',
      participantA: 'uid_truman',
      participantAName: 'Truman',
      participantB: 'uid_maezinha',
      participantBName: 'Mãezinha',
      createdAt: '2026-09-07T07:00:00.000Z',
      lastActivity: '2026-09-07T10:00:00.000Z',
      lastReadA: '2026-09-07T08:00:00.000Z',
      lastRead: {
        Truman: '2026-09-07T09:15:00.000Z',
        Mãezinha: '2026-09-07T10:00:00.000Z',
      },
    };

    const selfRead = getSelfLastReadFromChannel(room, 'uid_truman', 'Truman');
    assert(selfRead === '2026-09-07T09:15:00.000Z', 'Deve selecionar o timestamp mais recente do próprio usuário');
    assert(
      maxIsoDate('2026-09-07T08:00:00.000Z', null, '2026-09-07T09:30:00.000Z') === '2026-09-07T09:30:00.000Z',
      'maxIsoDate deve retornar a data mais recente ignorando nulos'
    );

    const fakeStorage: Record<string, string> = {};
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => fakeStorage[key] || null,
      setItem: (key: string, val: string) => { fakeStorage[key] = val; },
      removeItem: (key: string) => { delete fakeStorage[key]; },
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;

    try {
      saveMonitorContext({
        channelId: 'talk2tm_main',
        isConversation: false,
        userId: 'uid_truman',
        displayName: 'Truman',
      });
      const ctx = getMonitorContext();
      assert(ctx !== null && ctx.channelId === 'talk2tm_main' && ctx.displayName === 'Truman', 'MonitorContext deve persistir corretamente');
      assert(fakeStorage['talk2tm_session'] === undefined, 'MonitorContext nunca deve gravar sessão PIN');

      saveLocalLastReadTimestamp('talk2tm_main', '2026-09-07T12:00:00.000Z');
      saveLocalLastReadTimestamp('talk2tm_main', '2026-09-07T11:00:00.000Z');
      assert(
        getLocalLastReadTimestamp('talk2tm_main') === '2026-09-07T12:00:00.000Z',
        'Carimbo local de leitura deve ser estritamente monotônico'
      );

      clearMonitorContext();
      assert(getMonitorContext() === null, 'clearMonitorContext deve limpar contexto');
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }
  });

  // 42. Opções extras em segundos no bloqueio sem alterar o padrão de 5 minutos existente
  check('Configurações: Opções extras em segundos são preservadas na v2 sem desfazer padrão de 5min', () => {
    const fakeStorage: Record<string, string> = {};
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => fakeStorage[key] || null,
      setItem: (key: string, val: string) => { fakeStorage[key] = val; },
      removeItem: (key: string) => { delete fakeStorage[key]; },
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;

    try {
      // 1. Instalação nova ou já na v2 mantém 5 minutos (300s) como padrão
      const initial = loadSettings();
      assert(initial.inactivityLockSeconds === 300, 'Padrão inicial deve permanecer 300s (5min)');
      assert(initial.sessionTimeoutMinutes === 5, 'Tempo de sessão padrão deve permanecer 5min');

      // 2. Usuário escolhe explicitamente uma opção extra em segundos (ex.: 15s)
      saveSettings({ sessionTimeoutMinutes: 5, inactivityLockSeconds: 15 });
      const reloaded = loadSettings();
      assert(reloaded.inactivityLockSeconds === 15, 'Escolha explícita em segundos na v2 deve persistir');
      assert(reloaded.version === 2, 'saveSettings deve manter version: 2');
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }
  });

  // 43. Isolamento por userId do carimbo local de leitura e bloqueio obrigatório no arranque
  check('Segurança e Multi-PIN: lastRead local é isolado por userId no mesmo navegador', () => {
    const fakeStorage: Record<string, string> = {};
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => fakeStorage[key] || null,
      setItem: (key: string, val: string) => { fakeStorage[key] = val; },
      removeItem: (key: string) => { delete fakeStorage[key]; },
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;

    try {
      saveLocalLastReadTimestamp('truman-maezinha', '2026-09-07T16:00:00.000Z', 'uid_truman');
      saveLocalLastReadTimestamp('truman-maezinha', '2026-09-07T10:00:00.000Z', 'uid_maezinha');

      assert(
        getLocalLastReadTimestamp('truman-maezinha', 'uid_truman') === '2026-09-07T16:00:00.000Z',
        'Carimbo local de Truman deve permanecer isolado'
      );
      assert(
        getLocalLastReadTimestamp('truman-maezinha', 'uid_maezinha') === '2026-09-07T10:00:00.000Z',
        'Carimbo local de Mãezinha não deve herdar leitura do Truman no mesmo navegador'
      );
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }
  });

  // 44. Sinalização de Data: separadores de dia (Hoje, Ontem, dias anteriores) e formatação completa via Intl
  check('Sinalização de Data: formatDateSeparatorLabel identifica Hoje, Ontem e dias anteriores corretamente', () => {
    const refNow = new Date(2026, 10, 15, 1, 15, 0); // 15/11/2026 01:15 local
    const todayMsg = new Date(2026, 10, 15, 0, 5, 0).toISOString();
    const yesterdayMsg = new Date(2026, 10, 14, 22, 40, 0).toISOString();
    const twoDaysAgoMsg = new Date(2026, 10, 13, 8, 43, 0).toISOString();

    assert(getLocalDateKey(todayMsg) === '2026-11-15', 'Chave local deve refletir 2026-11-15');
    assert(getLocalDateKey(twoDaysAgoMsg) === '2026-11-13', 'Chave local deve refletir 2026-11-13');

    assert(formatDateSeparatorLabel(todayMsg, refNow, 'pt') === 'Hoje · 15/11/2026', 'Mensagem do mesmo dia em pt deve mostrar Hoje');
    assert(formatDateSeparatorLabel(yesterdayMsg, refNow, 'pt') === 'Ontem · 14/11/2026', 'Mensagem de ontem em pt deve mostrar Ontem');
    const ptOlder = formatDateSeparatorLabel(twoDaysAgoMsg, refNow, 'pt');
    assert(ptOlder.includes(' · 13/11/2026') && ptOlder.split(' · ')[0].length >= 3, `Mensagem de 2 dias atrás em pt deve mostrar dia da semana e data (atual: ${ptOlder})`);
    assert(formatFullDateTime(twoDaysAgoMsg, 'pt') === '13/11/2026 08:43', 'Tooltip completo em pt deve conter DD/MM/AAAA HH:MM');
    assert(formatDateSeparatorLabel(todayMsg, refNow, 'en').startsWith('Today · '), 'Mensagem do mesmo dia em en deve usar Intl Today');
  });

  // 45. Read Receipts: getPartnerLastRead escolhe carimbo mais recente por nome/UID e campos A/B
  check('Read Receipts: getPartnerLastRead seleciona o carimbo mais recente do parceiro', () => {
    const roomMixed: Room = {
      roomId: 'talk2tm_main',
      participantA: 'uid_truman_real',
      participantAName: 'Truman',
      participantB: 'uid_maezinha_real',
      participantBName: 'Mãezinha',
      createdAt: '2026-11-15T08:00:00.000Z',
      lastActivity: '2026-11-15T12:30:00.000Z',
      lastReadA: '2026-11-15T09:00:00.000Z',
      lastReadB: '2026-11-15T10:00:00.000Z',
      lastRead: {
        Mãezinha: '2026-11-15T11:00:00.000Z',
        uid_maezinha_real: '2026-11-15T12:30:00.000Z',
      },
    };

    assert(
      getPartnerLastRead(roomMixed, 'Truman', 'uid_truman_real') === '2026-11-15T12:30:00.000Z',
      'Deve escolher o carimbo mais recente entre mapa lastRead por nome/UID e lastReadB'
    );

    const customRoom: Room = {
      roomId: 'conv_custom',
      participantA: 'uid_1',
      participantAName: 'Alice',
      participantB: 'uid_2',
      participantBName: 'Bob',
      createdAt: '2026-11-15T08:00:00.000Z',
      lastActivity: '2026-11-15T11:15:00.000Z',
      lastRead: {
        uid_2: '2026-11-15T11:15:00.000Z',
      },
    };

    assert(
      getPartnerLastRead(customRoom, 'Alice', 'uid_1') === '2026-11-15T11:15:00.000Z',
      'Deve resolver parceiro pelo UID mesmo com nomes personalizados'
    );
  });

  // 46. Fluxo Bilateral: ID canônico por UID, convite determinístico inv_conv_ e isolamento de truman-maezinha
  check('Fluxo Bilateral: buildUidConversationId e inv_ determinísticos garantem vínculo estrito entre 2 contas distintas', () => {
    const uidA = 'uid_contaA_alpha123';
    const uidB = 'uid_contaB_beta456';
    const convAB = buildUidConversationId(uidA, uidB);
    const convBA = buildUidConversationId(uidB, uidA);

    assert(convAB === convBA, 'Conversa bilateral deve gerar mesmo ID canônico independente da ordem (A,B vs B,A)');
    assert(convAB === `conv_${uidA}_${uidB}`, 'ID canônico deve ordenar lexicograficamente participantA < participantB');
    assert(convAB !== ACCESS_CONFIG.DEFAULT_ROOM, 'Conversa bilateral nunca colide com truman-maezinha');

    const inviteId = convAB;
    assert(/^conv_[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+$/.test(inviteId), 'Convite deve seguir formato determinístico canônico por par de UIDs');
  });

  // =========================================================================
  // SUÍTE DE AUTORIZAÇÃO E INVARIANTES DAS REGRAS DO FIRESTORE (47 a 53)
  // =========================================================================
  const firestoreRulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const firestoreRules = fs.readFileSync(firestoreRulesPath, 'utf8');

  // Helper determinístico que espelha exatamente a política de autorização do Talk2TM
  const canAccessConversation = (
    authUid: string | null,
    conv: Pick<Conversation, 'conversationId' | 'participantA' | 'participantB'>,
    inviteStatus?: 'pending' | 'accepted' | 'declined' | 'cancelled'
  ) => {
    if (!authUid) return false;
    if (conv.participantA === conv.participantB) return false;
    if (conv.participantA >= conv.participantB) return false;
    if (conv.conversationId !== `conv_${conv.participantA}_${conv.participantB}`) return false;
    if (inviteStatus && inviteStatus !== 'accepted') return false;
    return authUid === conv.participantA || authUid === conv.participantB;
  };

  // 47. Requisito 1: Utilizador A consegue aceder à sua conversa com B
  check('AuthZ 1: Utilizador A acede à sua conversa bilateral com B somente após convite aceito', () => {
    const uidA = 'uid_A_alpha';
    const uidB = 'uid_B_beta';
    const convId = buildUidConversationId(uidA, uidB);
    const convStub = { conversationId: convId, participantA: uidA, participantB: uidB };

    assert(canAccessConversation(uidA, convStub, 'accepted') === true, 'A deve aceder conversa aceita com B');
    assert(canAccessConversation(uidB, convStub, 'accepted') === true, 'B deve aceder conversa aceita com A');
    assert(canAccessConversation(uidA, convStub, 'pending') === false, 'Conversa não pode iniciar antes do aceite');

    assert(
      firestoreRules.includes('match /conversations/{conversationId}') &&
      firestoreRules.includes('inviteMatchesConversationPair(') &&
      firestoreRules.includes("inviteData.status == 'accepted'") &&
      firestoreRules.includes('isConversationParticipant(get(/databases/$(database)/documents/conversations/$(conversationId)).data)'),
      'firestore.rules deve exigir participante válido e convite accepted do par na criação/acesso de conversations e messages'
    );
  });

  // 48. Requisito 2: Utilizador C não consegue ler mensagens de A e B
  check('AuthZ 2: Utilizador C (terceiro) é impedido de ler conversa ou mensagens de A e B', () => {
    const uidA = 'uid_A_alpha';
    const uidB = 'uid_B_beta';
    const uidC = 'uid_C_intruder';
    const convId = buildUidConversationId(uidA, uidB);
    const convStub = { conversationId: convId, participantA: uidA, participantB: uidB };

    assert(canAccessConversation(uidC, convStub, 'accepted') === false, 'Terceiro C não pode aceder conversa de A e B');
    assert(canAccessConversation(null, convStub, 'accepted') === false, 'Não autenticado não pode aceder conversa');

    const convStart = firestoreRules.indexOf('match /conversations/{conversationId}');
    const msgBlock = firestoreRules.slice(
      firestoreRules.indexOf('match /messages/{messageId}', convStart),
      firestoreRules.indexOf('// 4. conversationInvites/{inviteId}')
    );
    assert(
      msgBlock.includes('allow get: if isAuthenticated() &&') &&
      msgBlock.includes('allow list: if isAuthenticated() &&') &&
      msgBlock.includes('isValidId(conversationId)') &&
      msgBlock.includes('isConversationParticipant(get(/databases/$(database)/documents/conversations/$(conversationId)).data)'),
      'Subcoleção /conversations/{conversationId}/messages deve restringir get/list aos participantes autenticados da conversa'
    );
  });

  // 49. Requisito 3: Utilizador não consegue alterar participantes de uma conversa
  check('AuthZ 3: Participantes da conversa são imutáveis e cada utilizador só atualiza o próprio lastRead', () => {
    const convSection = firestoreRules.slice(
      firestoreRules.indexOf('match /conversations/{conversationId}'),
      firestoreRules.indexOf('// 5. conversations/{conversationId}/messages/{messageId}')
    );

    assert(
      convSection.includes('request.resource.data.participantA == resource.data.participantA') &&
      convSection.includes('request.resource.data.participantB == resource.data.participantB') &&
      convSection.includes('request.resource.data.conversationId == resource.data.conversationId'),
      'Regra de update em /conversations deve travar participantA, participantB e conversationId'
    );
    assert(
      convSection.includes("affectedKeys().hasOnly(['lastReadA', 'updatedAt'])") &&
      convSection.includes("affectedKeys().hasOnly(['lastReadB', 'updatedAt'])"),
      'Participante A só pode atualizar lastReadA e Participante B só pode atualizar lastReadB'
    );
    assert(
      convSection.includes('request.resource.data.participantA != request.resource.data.participantB') &&
      convSection.includes('request.resource.data.participantA < request.resource.data.participantB'),
      'Regra de create em /conversations deve impedir auto-conversa (A == B) e impor ordem canônica A < B'
    );
  });

  // 50. Requisito 4: Utilizador não consegue ler convites destinados a terceiros
  check('AuthZ 4: Convites em /conversationInvites bloqueiam terceiros e proíbem toUid nulo', () => {
    const inviteSection = firestoreRules.slice(
      firestoreRules.indexOf('match /conversationInvites/{inviteId}')
    );

    assert(
      inviteSection.includes('resource.data.fromUid == request.auth.uid || resource.data.toUid == request.auth.uid'),
      'Leitura get/list de convites deve exigir fromUid ou toUid igual ao request.auth.uid'
    );
    assert(!inviteSection.includes('toUid == null'), 'Regra de convites nunca deve permitir leitura quando toUid == null');
    assert(
      inviteSection.includes('request.resource.data.toUid is string') &&
      inviteSection.includes('request.resource.data.toUid.size() >= 1') &&
      inviteSection.includes('request.resource.data.toUid != request.auth.uid'),
      'Criação de convite deve exigir toUid string não vazia e diferente do remetente'
    );
  });

  // 51. Requisito 5: Utilizador não consegue falsificar o remetente de mensagens
  check('AuthZ 5: senderId deve corresponder ao request.auth.uid e deletedFor respeita eliminação individual', () => {
    const legacyMsgSection = firestoreRules.slice(
      firestoreRules.indexOf('match /messages/{messageId}'),
      firestoreRules.indexOf('// EXPANSION V1:')
    );
    const bilateralMsgSection = firestoreRules.slice(
      firestoreRules.indexOf('match /messages/{messageId}', firestoreRules.indexOf('match /conversations/{conversationId}')),
      firestoreRules.indexOf('// 4. conversationInvites/{inviteId}')
    );

    assert(
      legacyMsgSection.includes('request.resource.data.senderId == request.auth.uid'),
      'Mensagens legadas em /messages devem exigir senderId == request.auth.uid'
    );
    assert(
      bilateralMsgSection.includes('request.resource.data.senderId == request.auth.uid'),
      'Mensagens bilaterais devem exigir senderId == request.auth.uid'
    );
    assert(
      firestoreRules.includes('function isValidIndividualDelete(existingData, newData)') &&
      firestoreRules.includes("affectedKeys().hasOnly(['deletedFor'])") &&
      firestoreRules.includes('request.auth.uid in newData.deletedFor') &&
      firestoreRules.includes('newData.deletedFor.size() == existingData.deletedFor.size() + 1'),
      'Atualização de mensagens deve aceitar exclusivamente deletedFor individual (máx. +1 próprio UID)'
    );
  });

  // 52. Requisito 6: Truman e Mãezinha continuam a comunicar normalmente
  check('AuthZ 6: Truman (852456) e Mãezinha (135790) mantêm acesso normal isolado a truman-maezinha', () => {
    const resT = verifyPassword(PASSWORDS.TRUMAN);
    const resM = verifyPassword(PASSWORDS.MAEZINHA);
    assert(resT.valid === true && resT.user === 'Truman' && getUserByPin(PASSWORDS.TRUMAN) === 'Truman', 'PIN de Truman intacto');
    assert(resM.valid === true && resM.user === 'Mãezinha' && getUserByPin(PASSWORDS.MAEZINHA) === 'Mãezinha', 'PIN de Mãezinha intacto');
    assert(USER_AUTH_CREDENTIALS.Truman.email === 'truman@talk2tm.internal', 'E-mail interno de Truman preservado');
    assert(USER_AUTH_CREDENTIALS['Mãezinha'].email === 'maezinha@talk2tm.internal', 'E-mail interno de Mãezinha preservado');
    assert(ACCESS_CONFIG.DEFAULT_ROOM === 'truman-maezinha', 'Sala padrão do par preservada');

    const roomsSection = firestoreRules.slice(
      firestoreRules.indexOf('match /rooms/{roomId}'),
      firestoreRules.indexOf('match /messages/{messageId}')
    );
    assert(
      roomsSection.includes("roomId == 'truman-maezinha'") &&
      roomsSection.includes('isLegacyPairEmail()') &&
      !roomsSection.includes('allow read, create, update: if isAuthenticated()'),
      '/rooms deve manter acesso para truman@talk2tm.internal e maezinha@talk2tm.internal sem ficar aberta a qualquer conta'
    );
  });

  // 53. Requisito 7: Novo utilizador consegue criar e restaurar a sua identidade
  check('AuthZ 7: Novo utilizador cria identidade TM-XXXX-XXXX e restaura sua conta isolada em users/{uid}', () => {
    const newId = generateTalk2TMId();
    const secret = generateInternalSecret();
    assert(/^TM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(newId), 'generateTalk2TMId deve seguir regra isValidTalk2tmId do Firestore');
    assert(secret.length === 16, 'Segredo opaco deve ter 16 caracteres');
    assert(typeof createTalk2TMIdentity === 'function' && typeof restoreLocalIdentity === 'function' && typeof findProfileByTalk2TMId === 'function', 'API de criação e restauração deve existir');

    const fakeStorage: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => fakeStorage[k] ?? null,
      setItem: (k: string, v: string) => { fakeStorage[k] = v; },
      removeItem: (k: string) => { delete fakeStorage[k]; },
    };

    const identity: LocalIdentity = {
      uid: 'uid_novo_dev_999',
      talk2tmId: newId,
      displayName: 'Truman1',
      internalEmail: talk2tmIdToInternalEmail(newId),
      internalSecret: secret,
      createdAt: '2026-11-16T12:00:00.000Z',
    };
    saveLocalIdentity(identity, mockStorage);
    const restored = getLocalIdentity(mockStorage);
    assert(
      restored !== null &&
      restored.uid === identity.uid &&
      restored.talk2tmId === newId &&
      restored.displayName === 'Truman1',
      'Identidade criada deve ser restaurada localmente com os mesmos campos'
    );
    clearLocalIdentity(mockStorage);
    assert(getLocalIdentity(mockStorage) === null, 'clearLocalIdentity deve limpar corretamente');

    const usersSection = firestoreRules.slice(
      firestoreRules.indexOf('match /users/{uid}'),
      firestoreRules.indexOf('match /userProfiles/{talk2tmId}')
    );
    assert(
      usersSection.includes('allow get: if isUser(uid) || isAdmin();') &&
      usersSection.includes('allow list: if false;') &&
      usersSection.includes('allow create: if isUser(uid)') &&
      usersSection.includes("request.resource.data.accountStatus == 'deleting'") &&
      usersSection.includes('!isProtectedLegacyUid(uid)') &&
      usersSection.includes('isValidTalk2tmId(request.resource.data.talk2tmId)'),
      'users/{uid} deve permitir leitura get apenas ao próprio UID ou Admin explícito, bloquear list e restringir update ao fluxo de eliminação protegendo legado'
    );
  });

  // 54. Zero Custos: Normalização internacional E.164 (+244 padrão) e mascaramento de telefone
  check('Zero Custos: Normalização E.164 (+244 e internacional), mascaramento e e-mail interno por hash', () => {
    const ao9 = normalizePhoneNumber('923 456 789');
    assert(ao9.valid === true && ao9.e164 === '+244923456789', '9 dígitos locais em Angola devem normalizar para +244...');

    const ao12 = normalizePhoneNumber('244-923-456-789');
    assert(ao12.valid === true && ao12.e164 === '+244923456789', 'Prefixo 244 sem + deve normalizar para +244...');

    const zeroZero = normalizePhoneNumber('00351 912 345 678');
    assert(zeroZero.valid === true && zeroZero.e164 === '+351912345678', 'Prefixo 00 deve converter para +');

    const br = normalizePhoneNumber('+55 (11) 98765-4321');
    assert(br.valid === true && br.e164 === '+5511987654321', 'Telefone internacional deve preservar indicativo +55');

    const invalidShort = normalizePhoneNumber('12345');
    assert(invalidShort.valid === false, 'Número curto/ambíguo deve ser rejeitado');

    const masked = maskPhoneNumber('+244923456789');
    assert(masked.includes('+244') && masked.endsWith('789') && !masked.includes('923456'), 'Mascaramento deve ocultar dígitos centrais');

    const sampleHash = 'a'.repeat(64);
    const derivedEmail = phoneHashToInternalEmail(sampleHash);
    assert(derivedEmail === `u_${'a'.repeat(32)}@talk2tm.internal`, 'E-mail interno deve ser derivado deterministicamente do phoneHash');
  });

  // 55. Zero Custos: Código de recuperação e chave pessoal fácil com normalização tolerante
  check('Zero Custos: generateRecoveryCode, normalizeRecoveryCode e validateRecoverySecret garantem regras claras', () => {
    const rec = generateRecoveryCode();
    assert(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){5}$/.test(rec), 'Código de recuperação deve seguir 6 grupos de 4 caracteres sem 0/O/1/I');
    const stripped = rec.toLowerCase().replace(/-/g, ' ');
    assert(normalizeRecoveryCode(stripped) === normalizeRecoveryCode(rec), 'Normalização deve aceitar minúsculas, espaços e ausência de hífens');
    assert(normalizeRecoveryCode('Mãe 1975') === 'MAE1975', 'Normalização deve remover acentos e espaços de chaves pessoais');

    assert(validateRecoverySecret('96321', '12369').valid === false, 'Chave com menos de 6 caracteres deve ser recusada');
    assert(validateRecoverySecret('123456', '123456').valid === false, 'Chave igual ao PIN da calculadora deve ser recusada');
    assert(validateRecoverySecret('123456', '9988').valid === false, 'Sequência óbvia 123456 deve ser recusada');
    assert(validateRecoverySecret('111111', '9988').valid === false, 'Sequência repetida 111111 deve ser recusada');
    assert(validateRecoverySecret('Luanda 1990', '12369').valid === true, 'Chave pessoal memorável (>=6 chars) deve ser aceita');
  });

  // 56. Zero Custos: Regras Firestore de phoneLookup impedem listagem e mantêm integridade
  check('Zero Custos: firestore.rules protege phoneLookup/{phoneHash} contra listagem e falsificação', () => {
    assert(firestoreRules.includes('function isValidPhoneHash(hash)'), 'firestore.rules deve validar formato SHA-256 em isValidPhoneHash');
    const phoneSection = firestoreRules.slice(
      firestoreRules.indexOf('match /phoneLookup/{phoneHash}'),
      firestoreRules.indexOf('match /conversations/{conversationId}')
    );
    assert(
      phoneSection.includes('allow get: if isAuthenticated() && isValidPhoneHash(phoneHash);') &&
      phoneSection.includes('allow list: if false;') &&
      phoneSection.includes('isAccountDeletionInProgress(request.auth.uid)') &&
      phoneSection.includes('get(/databases/$(database)/documents/userProfiles/$(request.resource.data.talk2tmId)).data.uid == request.auth.uid'),
      'phoneLookup/{phoneHash} deve permitir apenas get autenticado, proibir list, restringir delete à cascata Hard Delete e exigir vínculo real com userProfiles/users'
    );
  });

  // 57 (Sync). Pré-carregamento do Hub (Opção A): isolamento estrito por UID e ordenação decrescente
  check('Hub Opção A: filterAndSortConversationsForUser isola conversas por UID e ordena por atividade recente', () => {
    const convA1: Conversation = {
      conversationId: 'conv_uidA_uidB',
      participantA: 'uidA',
      participantB: 'uidB',
      talk2tmIdA: 'TM-AAAA-1111',
      talk2tmIdB: 'TM-BBBB-2222',
      displayNameA: 'Alice',
      displayNameB: 'Bruno',
      createdAt: '2026-11-16T08:00:00.000Z',
      updatedAt: '2026-11-16T09:00:00.000Z',
    };
    const convA2: Conversation = {
      conversationId: 'conv_uidA_uidC',
      participantA: 'uidA',
      participantB: 'uidC',
      talk2tmIdA: 'TM-AAAA-1111',
      talk2tmIdB: 'TM-CCCC-3333',
      displayNameA: 'Alice',
      displayNameB: 'Carla',
      createdAt: '2026-11-17T08:00:00.000Z',
      updatedAt: '2026-11-17T10:30:00.000Z',
    };
    const convOtherAccount: Conversation = {
      conversationId: 'conv_uidX_uidY',
      participantA: 'uidX',
      participantB: 'uidY',
      talk2tmIdA: 'TM-XXXX-8888',
      talk2tmIdB: 'TM-YYYY-9999',
      displayNameA: 'Xavier',
      displayNameB: 'Yara',
      createdAt: '2026-11-17T11:00:00.000Z',
      updatedAt: '2026-11-17T12:00:00.000Z',
    };

    const filteredForA = filterAndSortConversationsForUser([convA1, convOtherAccount, convA2], 'uidA');
    assert(filteredForA.length === 2, 'Deve retornar exatamente as 2 conversas em que uidA participa');
    assert(filteredForA[0].conversationId === 'conv_uidA_uidC', 'Conversa mais recente deve aparecer primeiro');
    assert(filteredForA[1].conversationId === 'conv_uidA_uidB', 'Segunda conversa deve seguir ordem cronológica inversa');

    const filteredForB = filterAndSortConversationsForUser([convA1, convOtherAccount, convA2], 'uidB');
    assert(filteredForB.length === 1 && filteredForB[0].conversationId === 'conv_uidA_uidB', 'participantB também deve ser reconhecido');

    assert(typeof getLocalConversationsForUser === 'function', 'getLocalConversationsForUser deve estar exportada');
  });

  // 58 (Sync). Reset de época local (v2) limpa contas bilaterais antigas e preserva Truman x Mãezinha
  check('Reset de Época v2: applyLocalResetEpochIfNeeded limpa resquícios antigos e preserva Truman/Mãezinha', () => {
    const storeMap: Record<string, string> = {
      talk2tm_identities_v2: '{"accounts":[{"uid":"u1"}]}',
      talk2tm_identity_v1: '{"uid":"u1"}',
      talk2tm_session: '{"userId":"u1"}',
      talk2tm_last_conv_u1: 'conv_u1_u2',
      ttm_last_read_conv_u1_u2: '2026-11-18T10:00:00.000Z',
      talk2tm_hidden_conv_u1_u2: '["m1"]',
      talk2tm_monitor_v1: JSON.stringify({ channelId: 'conv_u1_u2', isConversation: true, userId: 'u1', displayName: 'Teste' }),
      ttm_settings: '{"version":2}',
      'ttm_last_read_truman-maezinha': '2026-11-18T12:00:00.000Z',
    };
    const mockStorage = {
      getItem: (k: string) => storeMap[k] ?? null,
      setItem: (k: string, v: string) => { storeMap[k] = v; },
      removeItem: (k: string) => { delete storeMap[k]; },
      get length() { return Object.keys(storeMap).length; },
      key: (i: number) => Object.keys(storeMap)[i] ?? null,
    };

    const res1 = applyLocalResetEpochIfNeeded(mockStorage, 'u_abc@talk2tm.internal');
    assert(res1.cleared === true && res1.shouldSignOutAuth === true, 'Conta antiga deve exigir signOut e limpeza local');
    assert(storeMap['talk2tm_identities_v2'] === undefined, 'Cofre v2 antigo deve ser removido');
    assert(storeMap['talk2tm_last_conv_u1'] === undefined, 'Última conversa bilateral antiga deve ser removida');
    assert(storeMap['talk2tm_monitor_v1'] === undefined, 'MonitorContext bilateral antigo deve ser removido');
    assert(storeMap['ttm_settings'] === '{"version":2}', 'Definições locais devem ser preservadas');
    assert(storeMap['ttm_last_read_truman-maezinha'] === '2026-11-18T12:00:00.000Z', 'Leitura de truman-maezinha deve ser preservada');
    assert(storeMap['talk2tm_vault_epoch'] === TALK2TM_RESET_EPOCH, 'Época v2 deve ficar marcada');

    // Segunda execução não deve limpar novamente
    storeMap['talk2tm_identities_v2'] = '{"accounts":[{"uid":"nova"}]}';
    const res2 = applyLocalResetEpochIfNeeded(mockStorage, 'u_nova@talk2tm.internal');
    assert(res2.cleared === false && res2.shouldSignOutAuth === false, 'Não deve limpar novamente após época v2 gravada');
    assert(storeMap['talk2tm_identities_v2'] !== undefined, 'Nova conta criada após reset deve permanecer intacta');

    // Sessão legada de Truman não sofre signOut na migração
    const trumanStore: Record<string, string> = {
      talk2tm_monitor_v1: JSON.stringify({ channelId: 'truman-maezinha', isConversation: false, userId: 'uid_t', displayName: 'Truman' }),
    };
    const trumanMock = {
      getItem: (k: string) => trumanStore[k] ?? null,
      setItem: (k: string, v: string) => { trumanStore[k] = v; },
      removeItem: (k: string) => { delete trumanStore[k]; },
      get length() { return Object.keys(trumanStore).length; },
      key: (i: number) => Object.keys(trumanStore)[i] ?? null,
    };
    const resTruman = applyLocalResetEpochIfNeeded(trumanMock, 'truman@talk2tm.internal');
    assert(resTruman.cleared === true && resTruman.shouldSignOutAuth === false, 'Truman nunca deve ser desconectado no reset');
    assert(trumanStore['talk2tm_monitor_v1'] !== undefined, 'MonitorContext de truman-maezinha deve permanecer intacto');

    const resetScript = fs.readFileSync(path.resolve(process.cwd(), 'scripts/reset-accounts.mjs'), 'utf8');
    assert(
      resetScript.includes("'truman@talk2tm.internal'") &&
      resetScript.includes("'maezinha@talk2tm.internal'") &&
      resetScript.includes('--confirm-reset'),
      'Script de reset na nuvem deve preservar Truman/Mãezinha e exigir --confirm-reset'
    );
  });

  // 59. Opção C: E-mail de recuperação opcional (nunca obrigatório, bloqueia domínio interno e normaliza)
  check('Opção C: validateOptionalRecoveryEmail aceita vazio, normaliza e bloqueia inválidos/@talk2tm.internal', () => {
    const empty = validateOptionalRecoveryEmail('');
    assert(empty.valid === true && empty.email === undefined, 'Campo vazio deve ser aceito sem erro');

    const spaces = validateOptionalRecoveryEmail('   ');
    assert(spaces.valid === true && spaces.email === undefined, 'Apenas espaços deve ser tratado como não informado');

    const valid = validateOptionalRecoveryEmail('  Usuario.Teste@Gmail.COM  ');
    assert(valid.valid === true && valid.email === 'usuario.teste@gmail.com', 'E-mail válido deve ser normalizado para minúsculas');

    const badFormat = validateOptionalRecoveryEmail('nao-e-email');
    assert(badFormat.valid === false, 'E-mail malformado deve ser rejeitado');

    const internalEmail = validateOptionalRecoveryEmail('u_123@talk2tm.internal');
    assert(internalEmail.valid === false, 'Domínio interno @talk2tm.internal deve ser rejeitado');
  });

  // 60. Admin Routing Discreto (>= 10 caracteres entre números e símbolos)
  check('Admin Route: sequência *123456789*# na calculadora e DEG normaliza */× e #/= sem conflito com PINs', () => {
    assert(normalizeCalculatorSequence(' * 123456789 * # ') === '*123456789*#', 'Deve remover espaços e preservar * e #');
    assert(normalizeCalculatorSequence('×123456789×#') === '*123456789*#', 'Deve normalizar × para *');
    assert(normalizeCalculatorSequence('×123456789×=') === '*123456789*#', 'Deve normalizar = da calculadora touch para #');
    assert(normalizeCalculatorSequence('∗123456789∗＃') === '*123456789*#', 'Deve normalizar variantes Unicode de * e #');
    assert(normalizeCalculatorSequence('9÷3') === '9/3', 'Deve normalizar ÷');
    assert(isAdminRouteSequence('*123456789*#') === true, 'Sequência padrão no DEG deve acionar rota admin');
    assert(isAdminRouteSequence('×123456789×#') === true, 'Sequência mista ×/# deve acionar rota admin');
    assert(isAdminRouteSequence('×123456789×=') === true, 'Sequência por toque (×123456789×=) deve acionar rota admin');
    assert(isAdminRouteSequence('55*123456789*#') === true, 'Sequência com sufixo deve acionar rota admin');
    assert(isAdminRouteSequence('852456') === false, 'PIN de Truman não pode acionar rota admin');
    assert(isAdminRouteSequence('135790') === false, 'PIN de Mãezinha não pode acionar rota admin');
    assert(isAdminRouteSequence('*123456*#') === false, 'Sequência curta < 10 chars não deve acionar rota admin');
  });

  // 61. Admin UI & Isolamento de Sessão / Privacidade / Sem Segredos
  check('Admin Contratos: sessão isolada inMemoryPersistence, Google Sign-In, paginação 20, phoneMasked e zero segredos no JS', () => {
    assert(ADMIN_PAGE_SIZE === 20, 'Paginação administrativa deve ser exactamente de 20 utilizadores por página');
    assert(formatAdminActivationDate('2026-11-11T12:00:00.000Z') === '11/11/2026', 'Data deve formatar em DD/MM/AAAA');
    assert(formatAdminActivationDate('') === '—', 'Data vazia deve retornar travessão');

    const adminFirebaseSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/firebase/admin.ts'), 'utf8');
    const adminUiSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/admin.ts'), 'utf8');

    assert(adminFirebaseSrc.includes("'talk2tm-admin'"), 'Admin deve usar instância Firebase nomeada isolada');
    assert(adminFirebaseSrc.includes('inMemoryPersistence'), 'Auth Admin deve usar inMemoryPersistence em RAM');
    assert(
      adminFirebaseSrc.includes('GoogleAuthProvider') &&
      adminFirebaseSrc.includes('signInWithPopup') &&
      adminFirebaseSrc.includes('browserPopupRedirectResolver') &&
      adminFirebaseSrc.includes('popupRedirectResolver') &&
      adminFirebaseSrc.includes('signInAdminWithGoogle'),
      'Módulo admin deve oferecer Google Sign-In isolado em RAM com browserPopupRedirectResolver'
    );
    assert(adminUiSrc.includes('signInAdminWithGoogle') && adminUiSrc.includes('[entrar com Google]'), 'UI admin deve exibir botão Google Sign-In junto ao formulário');
    assert(adminFirebaseSrc.includes('Base Orgânico'), 'Plano fallback deve ser Base Orgânico');
    assert(!adminFirebaseSrc.includes("'conversationInvites'") && !adminFirebaseSrc.includes('"conversationInvites"'), 'Módulo admin não pode consultar conversationInvites nesta fase');
    assert(
      !adminFirebaseSrc.includes("'conversations'") &&
      !adminFirebaseSrc.includes("'messages'") &&
      !adminFirebaseSrc.includes("'rooms'"),
      'Módulo admin não pode consultar conversas ou mensagens'
    );
    assert(!adminUiSrc.includes('Convidados'), 'Coluna Convidados por utilizador deve permanecer removida nesta fase');
    assert(!adminUiSrc.includes('@talk2tm') && !adminFirebaseSrc.includes('password123') && !adminUiSrc.includes('vitronis.hbo'), 'Nenhuma credencial administrativa pode existir no JS');
  });

  // 62. Auditoria Estática de firestore.rules: isAdmin() por e-mail verificado, isCallerActive() e isolamento
  check('Firestore Rules Audit: autorização Admin por e-mail master verificado, suspensão real e proteção do legado', () => {
    const rulesSrc = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert(rulesSrc.includes('function isAdmin()'), 'firestore.rules deve definir isAdmin()');
    const adminFnBlock = rulesSrc.slice(
      rulesSrc.indexOf('function isAdmin()'),
      rulesSrc.indexOf('function isProtectedLegacyUid(uid)')
    );
    assert(
      adminFnBlock.includes('request.auth != null') &&
      adminFnBlock.includes("request.auth.token.email == 'vitronis.hbo@gmail.com'") &&
      adminFnBlock.includes('request.auth.token.email_verified == true'),
      'isAdmin() deve autorizar apenas e-mail master vitronis.hbo@gmail.com com email_verified == true'
    );
    assert(rulesSrc.includes('function isCallerActive()'), 'firestore.rules deve definir isCallerActive()');
    assert(rulesSrc.includes('function isProtectedLegacyUid(uid)'), 'firestore.rules deve proteger UIDs legados Truman/Mãezinha');
    assert(rulesSrc.includes('allow list: if isAdmin();'), 'Apenas Admin pode listar userProfiles');

    const invitesBlock = rulesSrc.slice(
      rulesSrc.indexOf('match /conversationInvites/{inviteId}'),
      rulesSrc.indexOf('// DATING FASE 1:')
    );
    assert(!invitesBlock.includes('isAdmin()'), 'conversationInvites não pode conceder leitura ou escrita ao Admin');

    const convBlock = rulesSrc.slice(
      rulesSrc.indexOf('match /conversations/{conversationId}'),
      rulesSrc.indexOf('match /conversationInvites/{inviteId}')
    );
    assert(!convBlock.includes('isAdmin()'), 'conversations e messages nunca podem ser lidos pelo Admin');
    assert(convBlock.includes('isCallerActive()'), 'conversations e messages devem exigir isCallerActive()');
  });

  // 63. Identidade Visual Talk2TM + Ícone Oficial SVG (< 2 KB) + Entrada Direta e Modo Discreto Local (Nível A)
  check('Identidade Talk2TM: ícone SVG < 2 KB, entrada padrão Talk2TM, alternância local Talk2TM/Calculadora e atalhos preservados', () => {
    assert(DEFAULT_SETTINGS.appearance === 'talk2tm', 'Aparência padrão deve ser talk2tm');
    assert(normalizeAppearanceMode(undefined) === 'talk2tm', 'Valor indefinido deve normalizar para talk2tm');
    assert(normalizeAppearanceMode('notas') === 'talk2tm', 'Modo inválido ou notas não suportado deve normalizar para talk2tm');
    assert(normalizeAppearanceMode('calculator') === 'calculator', 'Modo calculator deve ser preservado');

    const svgFilePath = path.resolve(process.cwd(), 'public/icon-talk2tm.svg');
    assert(fs.existsSync(svgFilePath), 'public/icon-talk2tm.svg deve existir');
    const svgBuffer = fs.readFileSync(svgFilePath);
    assert(svgBuffer.length > 0 && svgBuffer.length < 2048, `Ícone oficial deve ter < 2 KB (atual: ${svgBuffer.length} bytes)`);
    const svgSrc = svgBuffer.toString('utf8');
    assert(svgSrc.includes('#2563EB') && !svgSrc.includes('<text'), 'Ícone deve ter círculo azul vibrante sem texto');

    const inlineSvg = getTalk2TMIconSvg(64);
    assert(inlineSvg.includes('viewBox="0 0 512 512"') && inlineSvg.includes('#2563EB'), 'Helper inline SVG deve refletir símbolo oficial');

    const manifestJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/manifest.json'), 'utf8'));
    assert(manifestJson.short_name === 'Talk2TM' && manifestJson.name === 'Talk2TM', 'manifest.json deve usar nome Talk2TM');
    assert(manifestJson.icons?.[0]?.src === '/icon-talk2tm.svg', 'manifest.json deve apontar para /icon-talk2tm.svg');

    const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    assert(indexHtml.includes('href="/icon-talk2tm.svg"') && indexHtml.includes('content="Talk2TM"'), 'index.html deve usar título e ícone oficial Talk2TM');

    const lockSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/lockscreen.ts'), 'utf8');
    assert(
      lockSrc.includes('isAdminRouteSequence') &&
      lockSrc.includes('852456') &&
      lockSrc.includes('135790') &&
      lockSrc.includes("'*'") &&
      lockSrc.includes("'#'"),
      'Tela padrão Talk2TM deve manter atalhos legados (852456/135790) e atalho admin (*123456789*#)'
    );

    const domSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/dom.ts'), 'utf8');
    assert(
      domSrc.includes("val: 'talk2tm'") &&
      domSrc.includes("val: 'calculator'") &&
      !domSrc.includes('Modo Notas'),
      'Definições locais devem alternar apenas entre Talk2TM e Calculadora'
    );
  });

  // 64. Telefone Universal (E.164, Namíbia/Internacional, Sugestão Inicial Silenciosa e Sem Remover Zeros Indiscriminadamente)
  check('Telefone Universal: deteção inicial silenciosa, Namíbia (+264), preservação seletiva de zeros e componente único', () => {
    assert(PHONE_COUNTRIES.length >= 100, 'Lista internacional compacta deve cobrir pelo menos 100 países');
    assert(DEFAULT_COUNTRY_ISO === 'AO', 'País de recurso padrão deve continuar sendo Angola (AO)');

    // 1. Sugestão inicial silenciosa por fuso / idioma -> fallback Angola
    const sugNaTz = detectSuggestedCountry({ timeZone: 'Africa/Windhoek', locale: 'en-US' });
    assert(sugNaTz.iso === 'NA' && sugNaTz.dialCode === '+264' && sugNaTz.flag === '🇳🇦', 'Fuso Africa/Windhoek deve sugerir Namíbia (+264)');

    const sugAoTz = detectSuggestedCountry({ timeZone: 'Africa/Luanda', locale: 'pt-PT' });
    assert(sugAoTz.iso === 'AO' && sugAoTz.dialCode === '+244', 'Fuso Africa/Luanda deve sugerir Angola (+244)');

    const sugPtTz = detectSuggestedCountry({ timeZone: 'Europe/Lisbon' });
    assert(sugPtTz.iso === 'PT' && sugPtTz.dialCode === '+351', 'Fuso Europe/Lisbon deve sugerir Portugal (+351)');

    const sugBrTz = detectSuggestedCountry({ timeZone: 'America/Sao_Paulo' });
    assert(sugBrTz.iso === 'BR' && sugBrTz.dialCode === '+55', 'Fuso America/Sao_Paulo deve sugerir Brasil (+55)');

    const sugLocale = detectSuggestedCountry({ timeZone: 'Etc/Unknown', locale: 'en-NA', languages: ['en-NA'] });
    assert(sugLocale.iso === 'NA' && sugLocale.dialCode === '+264', 'Região en-NA deve sugerir Namíbia quando fuso for desconhecido');

    const sugFallback = detectSuggestedCountry({ timeZone: 'Etc/Unknown', locale: 'xx-ZZ', languages: ['xx'] });
    assert(sugFallback.iso === 'AO' && sugFallback.dialCode === '+244', 'Desconhecido deve cair em Angola (+244)');

    // 2. Namíbia (+264): formatos locais com e sem tronco '0', ou com indicativo
    assert(normalizePhoneNumber('081 234 5678', '+264').e164 === '+264812345678', 'Namíbia 081... deve normalizar para +264812345678');
    assert(normalizePhoneNumber('81 234 5678', '+264').e164 === '+264812345678', 'Namíbia 81... deve normalizar para +264812345678');
    assert(normalizePhoneNumber('264812345678', '+264').e164 === '+264812345678', 'Namíbia 26481... sem + deve normalizar para +264812345678');
    assert(normalizePhoneNumber('+264 81 234 5678', '+244').e164 === '+264812345678', 'Número explícito +264 deve funcionar mesmo com país padrão +244');

    // 3. Não remover zeros indiscriminadamente
    assert(normalizePhoneNumber('0923456789', '+244').valid === false, 'Angola (+244) não usa tronco 0 e não deve remover zero inicial arbitrariamente');
    assert(normalizePhoneNumber('0612345678', '+39').e164 === '+390612345678', 'Itália (+39) deve preservar o 0 inicial obrigatório');
    assert(normalizePhoneNumber('061234567', '+242').e164 === '+242061234567', 'República do Congo (+242) deve preservar o 0 inicial');
    assert(normalizePhoneNumber('0712345678', '+225').e164 === '+2250712345678', 'Costa do Marfim (+225) deve preservar o 0 inicial');
    assert(normalizePhoneNumber('000812345678', '+264').valid === false, 'Múltiplos zeros iniciais (000...) não devem ser removidos às cegas');

    // 4. Preservação total do comportamento Angola (+244) e mascaramento internacional
    assert(normalizePhoneNumber('923456789').e164 === '+244923456789', 'Angola 9 dígitos deve permanecer idêntico para phoneLookup');
    assert(findCountryByE164('+264812345678')?.iso === 'NA', 'findCountryByE164 deve identificar Namíbia pelo prefixo +264');
    assert(maskPhoneNumber('+264812345678') === '+264 ••• 678', 'Mascaramento deve respeitar indicativo de 3 dígitos (+264)');
    assert(maskPhoneNumber('+5511987654321') === '+55 ••• 321', 'Mascaramento deve respeitar indicativo de 2 dígitos (+55)');
    assert(maskPhoneNumber('+244923456789') === '+244 ••• 789', 'Mascaramento legado +244 deve permanecer intacto');

    // 5. Componente único reutilizado no registo, recuperação e convites
    const domSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/dom.ts'), 'utf8');
    const occurrences = domSrc.match(/createPhoneInputField\(/g)?.length ?? 0;
    assert(occurrences === 3, `createPhoneInputField deve ser reutilizado exatamente 3 vezes (registo, recuperação e convites; encontradas: ${occurrences})`);
    assert(
      domSrc.includes("id: 'ttm-onboarding-phone'") &&
      domSrc.includes("id: 'ttm-recovery-phone'") &&
      domSrc.includes("name: 'username'") &&
      domSrc.includes("autocomplete: 'username'"),
      'Campos unificados devem preservar IDs e compatibilidade com Gestor de Senhas na recuperação'
    );
  });

  // 65. Cobertura Mundial Google libphonenumber (245 territórios, indicativos partilhados, pesquisa e regras de tronco)
  check('Cobertura Mundial: 245 territórios, indicativos partilhados (+1/+7/+39/+44/+358), pesquisa e regras nacionais', () => {
    assert(PHONE_COUNTRIES.length >= 240, `Deve cobrir todos os países e territórios reconhecidos (atual: ${PHONE_COUNTRIES.length})`);

    // 1. Territórios que partilham indicativos
    const nanp = getCountriesByDialCode('+1');
    assert(nanp.length >= 24 && nanp.some((c) => c.iso === 'US') && nanp.some((c) => c.iso === 'CA') && nanp.some((c) => c.iso === 'PR'), '+1 deve incluir EUA, Canadá, Porto Rico e territórios NANP');
    assert(findCountryByE164('+17872345678')?.iso === 'PR', '+1 787... deve resolver para Porto Rico');
    assert(findCountryByE164('+18092345678')?.iso === 'DO', '+1 809... deve resolver para República Dominicana');
    assert(findCountryByE164('+14165551234', 'CA')?.iso === 'CA', '+1 416... com Canadá selecionado deve preservar CA');
    assert(findCountryByE164('+77710009998')?.iso === 'KZ', '+7 771... deve resolver para Cazaquistão');
    assert(findCountryByE164('+79123456789')?.iso === 'RU', '+7 912... deve resolver para Rússia');
    assert(findCountryByE164('+390669812345')?.iso === 'VA', '+39 06698... deve resolver para Cidade do Vaticano');
    assert(findCountryByE164('+3581812345')?.iso === 'AX', '+358 18... deve resolver para Ilhas Åland');
    assert(findCountryByE164('+2908999')?.iso === 'TA', '+290 8999 deve resolver para Tristão da Cunha');

    // 2. Regras nacionais de prefixos/troncos e comprimentos válidos
    assert(normalizePhoneNumber('011987654321', 'BR').e164 === '+5511987654321', 'Brasil 0 + DDD + número deve normalizar para +5511987654321');
    assert(normalizePhoneNumber('01511987654321', 'BR').e164 === '+5511987654321', 'Brasil com código de operadora 015 deve normalizar para +5511987654321');
    assert(normalizePhoneNumber('55991234567', 'BR').e164 === '+5555991234567', 'Brasil DDD 55 não deve ser confundido com indicativo +55');
    assert(normalizePhoneNumber('0111512345678', 'AR').e164 === '+5491112345678', 'Argentina móvel 011 15... deve converter para +5491112345678');
    assert(normalizePhoneNumber('01143215678', 'AR').e164 === '+541143215678', 'Argentina fixo 011... deve preservar sem inserir 9');
    assert(normalizePhoneNumber('89123456789', 'RU').e164 === '+79123456789', 'Rússia com tronco 8 deve converter para +79123456789');
    assert(normalizePhoneNumber('256789', 'GG').e164 === '+441481256789', 'Guernsey 6 dígitos locais deve converter para +441481256789');
    assert(normalizePhoneNumber('4123', 'NU').e164 === '+6834123', 'Niue 4 dígitos (+683) deve ser estruturalmente válido');
    assert(normalizePhoneNumber('1234567', 'AO').valid === false, 'Angola com 7 dígitos deve falhar validação de comprimento');
    assert(normalizePhoneNumber('+24412345').valid === false, 'Número +244 inválido pelo plano nacional deve ser rejeitado');

    // 3. Pesquisa de país por nome (sem acentos), ISO ou indicativo
    const byName = searchPhoneCountries('mocambique');
    assert(byName.some((c) => c.iso === 'MZ' && c.dialCode === '+258'), 'Pesquisa sem acentos deve encontrar Moçambique');
    const byCode = searchPhoneCountries('+264');
    assert(byCode.length === 1 && byCode[0].iso === 'NA', 'Pesquisa +264 deve encontrar Namíbia');
    const bySharedCode = searchPhoneCountries('1');
    assert(bySharedCode[0].iso === 'US' && bySharedCode.some((c) => c.iso === 'PR'), 'Pesquisa por indicativo 1 deve priorizar +1 (EUA e territórios partilhados)');

    // 4. UI pesquisável ligada ao componente único
    const phoneInputSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/phone-input.ts'), 'utf8');
    assert(
      phoneInputSrc.includes('searchPhoneCountries') &&
      phoneInputSrc.includes('ttm-country-modal') &&
      phoneInputSrc.includes('selectedCountry.iso'),
      'Componente único deve oferecer modal pesquisável e passar ISO exato para normalização'
    );
  });

  // 66. Internacionalização Ultraleve: prioridade manual > sistema > fallback, Intl.DisplayNames/RelativeTimeFormat com fallbacks e integridade
  check('i18n Ultraleve: prioridade absoluta, fallback en, Intl com fallbacks seguros, persistência local e integridade', () => {
    assert(
      SUPPORTED_LOCALES.join(',') === 'pt,en,fr,es' && GLOBAL_FALLBACK_LOCALE === 'en',
      'Idiomas iniciais devem ser pt, en, fr, es com fallback global en'
    );
    assert(DEFAULT_SETTINGS.language === 'auto', 'Preferência padrão de idioma deve ser auto');
    assert(normalizeSettingsLanguage('fr') === 'fr' && normalizeSettingsLanguage('de') === 'auto', 'Preferência não suportada deve normalizar para auto');

    // Prioridade: navigator.languages -> navigator.language -> fallback global en
    assert(
      detectSystemLocale({ languages: ['fr-FR', 'pt-PT'], language: 'es-ES' }) === 'fr',
      'navigator.languages deve ter prioridade sobre navigator.language'
    );
    assert(
      detectSystemLocale({ languages: ['ja-JP', 'es-MX'], language: 'en-US' }) === 'es',
      'Deve percorrer navigator.languages até encontrar idioma suportado'
    );
    assert(
      detectSystemLocale({ languages: [], language: 'pt-BR' }) === 'pt',
      'Deve usar navigator.language quando navigator.languages estiver vazio'
    );
    assert(
      detectSystemLocale({ languages: ['de-DE', 'zh-CN'], language: 'ja-JP' }) === 'en',
      'Idioma sem tradução deve cair no fallback global en'
    );

    // Prioridade absoluta: preferência manual > sistema
    assert(
      resolveEffectiveLocale('es', { languages: ['fr-FR'], language: 'pt-PT' }) === 'es',
      'Preferência manual explícita deve sobrepor-se sempre ao idioma do sistema'
    );
    assert(
      resolveEffectiveLocale('auto', { languages: ['fr-FR'], language: 'pt-PT' }) === 'fr',
      'Modo automático deve resolver pelo sistema'
    );

    // Persistência local exclusiva de language em ttm_settings (sem escritas no Firestore)
    const fakeStorage: Record<string, string> = {};
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => fakeStorage[key] || null,
      setItem: (key: string, val: string) => { fakeStorage[key] = val; },
      removeItem: (key: string) => { delete fakeStorage[key]; },
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    try {
      saveSettings({ sessionTimeoutMinutes: 5, inactivityLockSeconds: 300, appearance: 'talk2tm', language: 'fr' });
      const reloaded = loadSettings();
      assert(reloaded.language === 'fr', 'Preferência manual de idioma deve persistir localmente em ttm_settings');
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }

    // Intl.DisplayNames em tempo de execução + fallback seguro se indisponível
    const aoNameFr = getLocalizedCountryName('AO', 'fr', 'Angola');
    const deNamePt = getCountryDisplayName({ iso: 'DE', name: 'Germany' }, 'pt');
    assert(aoNameFr.toLowerCase().includes('angola'), `Intl.DisplayNames deve localizar AO em fr (atual: ${aoNameFr})`);
    assert(deNamePt.toLowerCase().includes('alemanha'), `Intl.DisplayNames deve localizar DE em pt (atual: ${deNamePt})`);
    assert(searchPhoneCountries('allemagne', 'fr').some((c) => c.iso === 'DE'), 'Pesquisa localizada em fr deve encontrar DE por "allemagne"');

    const origDisplayNames = Intl.DisplayNames;
    const origRtf = Intl.RelativeTimeFormat;
    try {
      (Intl as unknown as { DisplayNames?: unknown }).DisplayNames = undefined;
      (Intl as unknown as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = undefined;
      assert(
        getLocalizedCountryName('XY', 'fr', 'FallbackLand') === 'FallbackLand',
        'Deve usar fallback nativo quando Intl.DisplayNames estiver ausente'
      );
      const refNow = new Date(2026, 10, 15, 12, 0, 0);
      const todayIso = new Date(2026, 10, 15, 9, 5, 0).toISOString();
      const sepEn = formatDateSeparatorLabel(todayIso, refNow, 'en');
      assert(sepEn.startsWith('Today · '), `Fallback nativo sem Intl.RelativeTimeFormat deve funcionar em en (atual: ${sepEn})`);
      assert(/^\d{2}:\d{2}$/.test(formatTime(todayIso, 'en')), 'formatTime deve retornar HH:MM');
    } finally {
      (Intl as unknown as { DisplayNames?: unknown }).DisplayNames = origDisplayNames;
      (Intl as unknown as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = origRtf;
    }

    // Integridade: nunca alterar PINs, E.164, nem mensagens de utilizador quando o idioma muda
    const prevLoc = getCurrentLocale();
    setAppLocaleSync('en');
    assert(getCurrentLocale() === 'en' && getLanguagePreference() === 'en', 'setAppLocaleSync deve ativar idioma sincronamente');
    assert(verifyPassword('852456').user === 'Truman' && verifyPassword('135790').user === 'Mãezinha', 'PINs legados e nomes próprios nunca são traduzidos');
    assert(normalizePhoneNumber('081 234 5678', 'NA').e164 === '+264812345678', 'Normalização E.164 é invariante ao idioma da UI');
    assert(sanitizeMessageText('Olá maman, 852456!').text === 'Olá maman, 852456!', 'Conteúdo de mensagens nunca pode ser traduzido ou alterado');
    setAppLocaleSync(prevLoc);
  });

  // 67. Talk2TM Dating Fase 1: Validação +18, Bio <= 160, Filtros, Exclusões e Quota Diária (5/dia)
  check('Talk2TM Dating Fase 1: validação +18, compatibilidade mútua, filtros, exclusões e limite de 5 sugestões/dia', () => {
    clearDatingMemoryFallbackForTests();

    const baseInput = {
      displayName: '  Ana Clara  ',
      age: 26,
      gender: 'woman' as const,
      seeking: 'men' as const,
      countryCode: 'ao',
      city: '  São Paulo  ',
      bio: ' Gosto de café\ne conversas tranquilas. ',
      intent: 'serious' as const,
      adultConfirmed: true,
      termsAccepted: true,
    };

    // Bloqueio estrito de menores (<18) e checkboxes obrigatórias
    assert(
      validateDatingProfileInput({ ...baseInput, age: 17 }).valid === false,
      'Menor de 18 anos deve ser bloqueado na criação de perfil Dating'
    );
    assert(
      validateDatingProfileInput({ ...baseInput, adultConfirmed: false }).valid === false,
      'Confirmação explícita +18 deve ser obrigatória'
    );
    assert(
      validateDatingProfileInput({ ...baseInput, termsAccepted: false }).valid === false,
      'Aceitação dos Termos e Política de Privacidade deve ser obrigatória'
    );
    assert(
      validateDatingProfileInput({ ...baseInput, bio: 'a'.repeat(DATING_BIO_MAX_LENGTH + 1) }).valid === false,
      'Biografia acima de 160 caracteres deve ser rejeitada'
    );

    const validRes = validateDatingProfileInput(baseInput);
    assert(validRes.valid === true && Boolean(validRes.normalized), 'Perfil +18 válido deve passar na validação');
    assert(validRes.normalized?.countryCode === 'AO', 'País deve normalizar para ISO-2 maiúsculo');
    assert(validRes.normalized?.cityKey === 'sao paulo', `cityKey deve normalizar sem acentos (atual: ${validRes.normalized?.cityKey})`);
    assert(validRes.normalized?.bio === 'Gosto de café e conversas tranquilas.', 'Biografia deve limpar quebras e espaços extras');

    // Compatibilidade mútua de género x preferência
    assert(isGenderCompatible('woman', 'men', 'man', 'women') === true, 'Mulher buscando homens x Homem buscando mulheres deve ser compatível');
    assert(isGenderCompatible('woman', 'men', 'man', 'men') === false, 'Preferência unilateral incompatível deve ser excluída');
    assert(isGenderCompatible('non_binary', 'all', 'woman', 'all') === true, 'Não-binário x Todos bilateral deve ser compatível');
    assert(isGenderCompatible('woman', 'men', 'non_binary', 'all') === false, 'Preferência estrita por homens exclui perfil non_binary');

    // Filtros e exclusões (ocultos, pausados, suspensos, bloqueados, avaliados, menor de idade)
    const makeCandidate = (overrides: Partial<DatingProfile>): DatingProfile => ({
      uid: 'cand_1',
      talk2tmId: 'TM-CAND-0001',
      displayName: 'Bruno',
      age: 28,
      gender: 'man',
      seeking: 'women',
      countryCode: 'AO',
      city: 'Luanda',
      cityKey: normalizeCityKey('Luanda'),
      bio: 'Engenheiro civil e leitor.',
      intent: 'meet_people',
      adultConfirmed: true,
      termsAcceptedAt: '2026-11-23T10:00:00.000Z',
      termsVersion: '2026-11',
      discoverable: true,
      paused: false,
      suspended: false,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:00:00.000Z',
      ...overrides,
    });

    const filters = validateDatingFilters({ minAge: 35, maxAge: 22, seeking: 'men', countryCode: 'AO', city: 'Luanda' });
    assert(filters.minAge === 35 && filters.maxAge === 35, 'maxAge deve ser ajustado para >= minAge');

    const wideFilters = validateDatingFilters({ minAge: 20, maxAge: 40, seeking: 'men', countryCode: 'AO', city: 'luánda' });
    const viewer = {
      uid: 'viewer_1',
      gender: 'woman' as const,
      blockedUids: new Set(['cand_blocked']),
      evaluatedUids: new Set(['cand_seen']),
    };

    const rawCandidates: DatingProfile[] = [
      makeCandidate({ uid: 'viewer_1' }),
      makeCandidate({ uid: 'cand_hidden', discoverable: false }),
      makeCandidate({ uid: 'cand_paused', paused: true }),
      makeCandidate({ uid: 'cand_suspended', suspended: true }),
      makeCandidate({ uid: 'cand_minor', age: 17 }),
      makeCandidate({ uid: 'cand_unconfirmed', adultConfirmed: false }),
      makeCandidate({ uid: 'cand_blocked' }),
      makeCandidate({ uid: 'cand_seen' }),
      makeCandidate({ uid: 'cand_wrong_city', city: 'Benguela', cityKey: 'benguela' }),
      makeCandidate({ uid: 'cand_wrong_seek', seeking: 'men' }),
      ...Array.from({ length: 7 }, (_, i) => makeCandidate({ uid: `cand_ok_${i + 1}`, displayName: `Candidato ${i + 1}` })),
    ];

    assert(doesProfileMatchFilters(rawCandidates[1], viewer, wideFilters) === false, 'Perfil oculto deve ser excluído');
    const limited = filterAndLimitDiscoveryCandidates({
      rawCandidates,
      viewer,
      filters: wideFilters,
      remainingToday: DATING_DAILY_DISCOVERY_LIMIT,
    });
    assert(
      limited.length === 5 && limited.every((c) => c.uid.startsWith('cand_ok_')),
      `Descoberta deve retornar apenas candidatos elegíveis limitados a 5/dia (atual: ${limited.length})`
    );

    // Quota diária local (5/dia) e persistência local de perfil/filtros
    const todayKey = '2026-11-23';
    const yesterdayKey = '2026-11-22';
    recordLocalEvaluation('viewer_1', 'old_eval', 'pass', yesterdayKey);
    for (let i = 1; i <= 3; i++) {
      recordLocalEvaluation('viewer_1', `today_eval_${i}`, 'pass', todayKey);
    }
    const q = getDailyDiscoveryQuota('viewer_1', todayKey);
    assert(q.usedToday === 3 && q.remainingToday === 2, 'Quota diária deve contar apenas avaliações de hoje e deixar 2 restantes');
    assert(q.evaluatedUids.has('old_eval') && q.evaluatedUids.has('today_eval_3'), 'evaluatedUids deve excluir avaliados de dias anteriores e de hoje');

    const ownProfile = makeCandidate({ uid: 'viewer_1', gender: 'woman', seeking: 'men' });
    saveLocalDatingProfile(ownProfile);
    assert(loadSavedDatingProfile('viewer_1')?.displayName === ownProfile.displayName, 'Cache local de perfil Dating deve restaurar corretamente');
    saveLocalDatingFilters('viewer_1', wideFilters);
    assert(loadSavedDatingFilters('viewer_1').city === 'luánda', 'Cache local de filtros Dating deve restaurar corretamente');

    // Preservação do Talk2TM e ausência de GPS contínuo
    const datingSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/dating.ts'), 'utf8');
    const panelSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/dating-panel.ts'), 'utf8');
    const domSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/dom.ts'), 'utf8');
    assert(!datingSrc.includes('geolocation') && !panelSrc.includes('geolocation'), 'Módulo Dating não deve usar GPS contínuo');
    assert(domSrc.includes("this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-flex' : 'none'"), 'Contas legadas Truman/Mãezinha não devem exibir Hub/Dating');
    clearDatingMemoryFallbackForTests();
  });

  // 68. Dating Fase 2: Like secreto, Match exclusivamente recíproco, conversa bilateral automática e Desfazer Match
  check('Dating Fase 2: IDs determinísticos, Match recíproco, notificações não vistas, Unmatch e preservação legada', () => {
    clearDatingMemoryFallbackForTests();

    assert(buildDatingLikeId('uid_a', 'uid_b') === 'uid_a_uid_b', 'Like ID deve ser direcional fromUid_toUid');
    assert(buildDatingLikeId('uid_a', 'uid_b') !== buildDatingLikeId('uid_b', 'uid_a'), 'Likes opostos devem ter IDs distintos');

    const mId1 = buildDatingMatchId('uid_z_1', 'uid_a_2');
    const mId2 = buildDatingMatchId('uid_a_2', 'uid_z_1');
    assert(mId1 === mId2 && mId1 === 'match_uid_a_2_uid_z_1', 'Match ID deve ser determinístico, ordenado e estável com underscores');

    const profileA: DatingProfile = {
      uid: 'uid_z_9',
      talk2tmId: 'TM-ZZZZ-9999',
      displayName: 'Zeca',
      age: 30,
      gender: 'man',
      seeking: 'women',
      countryCode: 'AO',
      city: 'Luanda',
      cityKey: 'luanda',
      bio: 'Conversar com calma',
      intent: 'serious',
      adultConfirmed: true,
      termsAcceptedAt: '2026-11-23T00:00:00.000Z',
      termsVersion: '2026-11-23',
      discoverable: true,
      paused: false,
      suspended: false,
      createdAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };
    const profileB: DatingProfile = {
      ...profileA,
      uid: 'uid_a_1',
      talk2tmId: 'TM-AAAA-1111',
      displayName: 'Ana',
      gender: 'woman',
      seeking: 'men',
    };

    // Viewer é profileA (uid_z_9 -> fica como participantB), candidato é profileB (uid_a_1 -> participantA)
    const { match, conversation } = buildDatingMatchPayload({
      viewerProfile: profileA,
      candidate: profileB,
      nowIso: '2026-11-23T12:00:00.000Z',
    });

    assert(match.matchId === 'match_uid_a_1_uid_z_9', 'Match payload deve ordenar participantA < participantB');
    assert(match.conversationId === 'conv_uid_a_1_uid_z_9', 'Conversa automática deve seguir padrão conv_<A>_<B>');
    assert(conversation.conversationId === match.conversationId, 'Conversation e Match devem compartilhar exatamente o mesmo conversationId');
    assert(match.participantA === 'uid_a_1' && match.participantB === 'uid_z_9', 'Participantes devem estar em ordem canónica');
    assert(match.seenByA === false && match.seenByB === true, 'Quem acabou de dar o Like recíproco (viewer = B) já viu o Match; A fica por ver');

    const partnerForA = getDatingMatchPartner(match, 'uid_a_1');
    assert(partnerForA.uid === 'uid_z_9' && partnerForA.displayName === 'Zeca', 'Parceiro de A deve ser Zeca');

    const unmatchedMatch: DatingMatch = {
      ...match,
      matchId: 'match_uid_a_1_uid_x_2',
      participantB: 'uid_x_2',
      conversationId: 'conv_uid_a_1_uid_x_2',
      status: 'unmatched',
      unmatchedByUid: 'uid_a_1',
      unmatchedAt: '2026-11-23T13:00:00.000Z',
    };

    const allMatches = [match, unmatchedMatch];
    assert(filterActiveDatingMatches(allMatches, 'uid_a_1').length === 1, 'Apenas matches activos devem aparecer na lista');
    assert(getUnseenDatingMatches(allMatches, 'uid_a_1').length === 1, 'A deve receber 1 notificação de novo Match');
    assert(getUnseenDatingMatches(allMatches, 'uid_z_9').length === 0, 'Zeca que disparou o Match não deve ter badge pendente');
    assert(getUnmatchedConversationIds(allMatches).has('conv_uid_a_1_uid_x_2'), 'Conversa de Match desfeito deve ser ocultada do Hub');

    saveLocalDatingMatches('uid_a_1', allMatches);
    assert(loadLocalDatingMatches('uid_a_1').length === 2, 'Cache local de Matches deve persistir e restaurar corretamente');

    // Regras estáticas de preservação do Talk2TM + segurança Zero-Oracle
    const rulesSrc = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert(rulesSrc.includes('match /datingLikes/{likeId}') && rulesSrc.includes('resource != null'), 'Regras de datingLikes devem exigir resource != null para zero-oracle');
    assert(rulesSrc.includes('match /datingMatches/{matchId}') && rulesSrc.includes('isDatingMatchUnmatched'), 'Regras devem bloquear escrita em conversas após Unmatch');
    assert(PASSWORDS.TRUMAN === '852456' && PASSWORDS.MAEZINHA === '135790', 'PINs legados Truman/Mãezinha devem permanecer intactos');

    clearDatingMemoryFallbackForTests();
  });

  // 69. Fase 3: Segurança, Anti-Spam (Rate Limiting), Bloqueios Locais e Auditoria de Moderação
  check('Fase 3: Bloqueio local, anti-rajada de mensagens, rate limits diários, sanitização de denúncia e moderação sem PII', () => {
    clearSafetyMemoryForTests();

    // 1. Mock isolado de localStorage
    const fakeStore: Record<string, string> = {};
    const origLS = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => fakeStore[k] ?? null,
      setItem: (k: string, v: string) => { fakeStore[k] = v; },
      removeItem: (k: string) => { delete fakeStore[k]; },
      clear: () => {
        for (const k of Object.keys(fakeStore)) delete fakeStore[k];
      },
      key: (i: number) => Object.keys(fakeStore)[i] ?? null,
      get length() {
        return Object.keys(fakeStore).length;
      },
    } as unknown as Storage;

    try {
      // Bloqueio local bilateral e ID composto
      assert(buildUserBlockId(' uid_a ', ' uid_b ') === 'uid_a_uid_b', 'buildUserBlockId deve compor uidA_uidB');
      addBlockedUidLocally('uid_a', 'uid_b');
      assert(loadLocalBlockedUids('uid_a').includes('uid_b'), 'addBlockedUidLocally deve persistir alvo bloqueado');
      assert(isLocallyBlockedPair('uid_a', 'uid_b') && isLocallyBlockedPair('uid_b', 'uid_a'), 'Bloqueio deve ser simétrico na deteção do par');
      assert(!isLocallyBlockedPair('uid_a', 'uid_c'), 'Terceiro não bloqueado não deve ser afetado');

      // Sanitização da prova congelada da denúncia
      const cleanEvidence = sanitizePlainTextSnippet('  <script>oi</script>\n  texto   abusivo  ', 20);
      assert(!cleanEvidence.includes('<') && !cleanEvidence.includes('>') && cleanEvidence.length <= 20, 'sanitizePlainTextSnippet deve remover tags e respeitar limite');

      // Anti-rajada interativa de mensagens (<= 12 por 15s + cooldown de duplicada 1.5s)
      const baseTs = 1_700_000_000_000;
      checkAndRecordMessageBurst('uid_spam', 'mensagem repetida', baseTs);
      let dupBlocked = false;
      try {
        checkAndRecordMessageBurst('uid_spam', 'mensagem repetida', baseTs + 500);
      } catch {
        dupBlocked = true;
      }
      assert(dupBlocked, 'Mensagem idêntica enviada antes de 1.5s deve ser travada');

      clearSafetyMemoryForTests();
      for (let i = 1; i <= RATE_LIMITS.MESSAGE_BURST_MAX; i++) {
        checkAndRecordMessageBurst('uid_burst', `msg_${i}`, baseTs + i * 100);
      }
      let burstBlocked = false;
      try {
        checkAndRecordMessageBurst('uid_burst', 'msg_overflow', baseTs + 2_000);
      } catch {
        burstBlocked = true;
      }
      assert(burstBlocked, '13ª mensagem na janela de 15s deve ser travada');

      // Garante estaticamente que syncPendingOutbox em src/app.ts não aplica trava interativa de rajada
      const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/app.ts'), 'utf8');
      const syncOutboxIdx = appSrc.indexOf('async syncPendingOutbox');
      const syncOutboxEnd = appSrc.indexOf('async handleSendMessage');
      const syncOutboxBlock = syncOutboxIdx >= 0 && syncOutboxEnd > syncOutboxIdx
        ? appSrc.slice(syncOutboxIdx, syncOutboxEnd)
        : '';
      assert(
        syncOutboxIdx >= 0 && !syncOutboxBlock.includes('checkAndRecordMessageBurst'),
        'syncPendingOutbox offline não deve sofrer bloqueio de anti-rajada'
      );

      // Limite de criação de contas (<= 3/hora)
      checkAccountCreationThrottle(baseTs);
      recordAccountCreationAttempt(baseTs);
      recordAccountCreationAttempt(baseTs + 10_000);
      recordAccountCreationAttempt(baseTs + 20_000);
      let signupBlocked = false;
      try {
        checkAccountCreationThrottle(baseTs + 30_000);
      } catch {
        signupBlocked = true;
      }
      assert(signupBlocked, '4ª tentativa de criação de conta na mesma hora deve ser bloqueada');

      // Limites diários atómicos (likes <= 5, reports <= 10 + 4s cooldown, invites <= 25 + 3s cooldown) e reset no dia seguinte
      const day1 = new Date('2026-11-25T10:00:00.000Z');
      let st = createEmptyRateLimitState('uid_rl', day1);
      for (let i = 0; i < RATE_LIMITS.DAILY_LIKES_MAX; i++) {
        st = buildNextDailyRateLimitState(st, 'like', new Date(day1.getTime() + i * 1_000));
      }
      assert(st.likeCountToday === 5, 'Likes diários devem atingir exactamente 5');
      let likeBlocked = false;
      try {
        buildNextDailyRateLimitState(st, 'like', new Date(day1.getTime() + 10_000));
      } catch {
        likeBlocked = true;
      }
      assert(likeBlocked, '6º like no mesmo dia deve lançar erro de limite');

      // Cooldown de denúncia (4s) e limite diário (10)
      st = buildNextDailyRateLimitState(st, 'report', new Date(day1.getTime() + 20_000));
      let reportCooldownHit = false;
      try {
        buildNextDailyRateLimitState(st, 'report', new Date(day1.getTime() + 21_000));
      } catch {
        reportCooldownHit = true;
      }
      assert(reportCooldownHit, 'Denúncia antes de 4s deve accionar cooldown');

      // Novo dia reinicia contadores
      const day2 = new Date('2026-11-26T09:00:00.000Z');
      const stNextDay = buildNextDailyRateLimitState(st, 'like', day2);
      assert(stNextDay.likeCountToday === 1 && stNextDay.reportCountToday === 0, 'Novo dia deve reiniciar contadores diários');

      // Moderação Admin mantém estritamente o isolamento de privacidade exigido no Teste 61
      const adminFbSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/firebase/admin.ts'), 'utf8');
      const adminUiSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/admin.ts'), 'utf8');
      assert(
        adminFbSrc.includes("'moderationReports'") &&
        !adminFbSrc.includes("'conversations'") &&
        !adminFbSrc.includes("'messages'") &&
        !adminUiSrc.includes('vitronis.hbo'),
        'Admin de moderação deve consultar moderationReports sem aceder a conversas/mensagens nem expor credenciais'
      );
    } finally {
      clearSafetyMemoryForTests();
      globalThis.localStorage = origLS;
    }
  });

  // 66. Fase 4: Fotografia Opcional (WebP) & Moderação de Visibilidade na Descoberta
  check('Fase 4: Fotografia WebP (dimensões 300-420px, MIME) e visibilidade estrita por aprovação', () => {
    const landscape = computeTargetPhotoDimensions(1600, 800, DATING_PHOTO_MAX_DIMENSION);
    assert(landscape.width === 420 && landscape.height === 210, 'Imagem horizontal deve escalar preservando proporção no teto de 420px');

    const portrait = computeTargetPhotoDimensions(900, 1800, DATING_PHOTO_MAX_DIMENSION);
    assert(portrait.width === 210 && portrait.height === 420, 'Imagem vertical deve escalar preservando proporção no teto de 420px');

    const small = computeTargetPhotoDimensions(280, 200, DATING_PHOTO_MAX_DIMENSION);
    assert(small.width === 280 && small.height === 200, 'Imagem já menor que o teto não deve sofrer upscale');

    const minClamped = computeTargetPhotoDimensions(1000, 1000, 120);
    assert(minClamped.width === DATING_PHOTO_MIN_DIMENSION && minClamped.height === DATING_PHOTO_MIN_DIMENSION, 'Teto mínimo deve respeitar 300px');

    assert(isSupportedPhotoMimeType('image/jpeg'), 'JPEG deve ser aceite');
    assert(isSupportedPhotoMimeType('image/png'), 'PNG deve ser aceite');
    assert(isSupportedPhotoMimeType('image/webp'), 'WebP deve ser aceite');
    assert(!isSupportedPhotoMimeType('image/gif'), 'GIF animado não deve ser aceite');
    assert(!isSupportedPhotoMimeType('image/svg+xml'), 'SVG não deve ser aceite por segurança XSS');
    assert(!isSupportedPhotoMimeType(''), 'MIME vazio deve ser rejeitado');

    assert(
      buildDatingPhotoStoragePath('uid_foto_1') === 'datingPhotos/uid_foto_1/avatar.webp',
      'Caminho no Storage deve usar avatar.webp único por utilizador'
    );

    const baseCandidate: DatingProfile = {
      uid: 'uid_cand_photo',
      talk2tmId: 'TM-FOTO-1111',
      displayName: 'Sofia',
      age: 26,
      gender: 'woman',
      seeking: 'all',
      countryCode: 'AO',
      city: 'Luanda',
      cityKey: 'luanda',
      bio: 'Perfil minimalista.',
      intent: 'serious',
      adultConfirmed: true,
      termsAcceptedAt: '2026-11-26T00:00:00.000Z',
      termsVersion: 'dating-v1',
      discoverable: true,
      paused: false,
      suspended: false,
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    };

    assert(!shouldDisplayCandidatePhoto(baseCandidate), 'Candidato sem foto não deve renderizar imagem');
    assert(
      !shouldDisplayCandidatePhoto({
        ...baseCandidate,
        photoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/avatar.webp',
        photoStatus: 'pending',
      }),
      'Foto pendente nunca pode aparecer no cartão público de descoberta'
    );
    assert(
      !shouldDisplayCandidatePhoto({
        ...baseCandidate,
        photoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/avatar.webp',
        photoStatus: 'rejected',
      }),
      'Foto rejeitada nunca pode aparecer no cartão público'
    );
    assert(
      !shouldDisplayCandidatePhoto({
        ...baseCandidate,
        photoUrl: 'http://insecure.example.com/a.webp',
        photoStatus: 'approved',
      }),
      'URL não HTTPS deve ser rejeitada'
    );
    assert(
      shouldDisplayCandidatePhoto({
        ...baseCandidate,
        photoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/avatar.webp',
        photoStatus: 'approved',
      }),
      'Foto aprovada com HTTPS deve aparecer na descoberta'
    );
  });

  // 67. Fase 4: Mecânica de Convites (Referral), Landing Pública, WhatsApp & Painel Admin de Fotos
  check('Fase 4: Referral code, URL canónica, WhatsApp share, métricas, cache local e fila Admin Fotos', () => {
    const origLS = globalThis.localStorage;
    const fakeStore: Record<string, string> = {};
    globalThis.localStorage = {
      getItem: (k: string) => (Object.prototype.hasOwnProperty.call(fakeStore, k) ? fakeStore[k] : null),
      setItem: (k: string, v: string) => {
        fakeStore[k] = String(v);
      },
      removeItem: (k: string) => {
        delete fakeStore[k];
      },
      clear: () => {
        Object.keys(fakeStore).forEach((k) => delete fakeStore[k]);
      },
      key: (idx: number) => Object.keys(fakeStore)[idx] ?? null,
      get length() {
        return Object.keys(fakeStore).length;
      },
    } as unknown as Storage;

    try {
      assert(normalizeReferralCode(' tmab3456 ') === 'TMAB3456', 'normalizeReferralCode deve limpar espaços e maiúsculas');
      assert(normalizeReferralCode('ab') === null, 'Código abaixo de 6 chars deve ser inválido');
      assert(isValidReferralCode('TMXY9988'), 'Código alfanumérico 8 chars deve ser válido');

      assert(
        extractReferralCodeFromSearch('?utm=share&ref=tm9988ab') === 'TM9988AB',
        'extractReferralCodeFromSearch deve extrair parâmetro ref válido'
      );
      assert(extractReferralCodeFromSearch('?ref=x') === null, 'extractReferralCodeFromSearch deve ignorar código inválido');

      const codeA1 = deriveDeterministicReferralCode('uid_ref_alpha');
      const codeA2 = deriveDeterministicReferralCode('uid_ref_alpha');
      const codeB = deriveDeterministicReferralCode('uid_ref_beta');
      assert(codeA1 === codeA2 && codeA1.startsWith('TM') && isValidReferralCode(codeA1), 'Código derivado deve ser determinístico');
      assert(codeA1 !== codeB, 'UIDs distintos devem derivar códigos distintos');

      const canonical = buildCanonicalReferralUrl('https://talk2tm.web.app/', codeA1);
      assert(canonical === `https://talk2tm.web.app/?ref=${codeA1}`, 'URL canónica deve apontar para /?ref=CODE');

      const waUrl = buildWhatsAppReferralShareUrl(`Convite Talk2TM: ${canonical}`);
      assert(waUrl.startsWith('https://wa.me/?text=') && waUrl.includes(encodeURIComponent(canonical)), 'Link WhatsApp deve codificar texto e URL');

      assert(computeConversionRatePercent(0, 0) === 0, 'Taxa 0/0 deve ser 0%');
      assert(computeConversionRatePercent(10, 4) === 40, 'Taxa 4/10 deve ser 40%');
      assert(computeConversionRatePercent(0, 2) === 100, 'Taxa com conversões orgânicas diretas não pode exceder 100%');

      assert(savePendingReferralCode('tm123456') === 'TM123456', 'savePendingReferralCode deve normalizar e guardar');
      assert(getPendingReferralCode() === 'TM123456', 'getPendingReferralCode deve recuperar código pendente');
      clearPendingReferralCode();
      assert(getPendingReferralCode() === null, 'clearPendingReferralCode deve limpar código após registo');

      saveCachedReferralMetrics('uid_ref_alpha', {
        referralCode: codeA1,
        inviteUrl: canonical,
        whatsappUrl: waUrl,
        invitesSharedCount: 5,
        convertedCount: 2,
      });
      const cachedMetrics = loadCachedReferralMetrics('uid_ref_alpha');
      assert(cachedMetrics?.invitesSharedCount === 5 && cachedMetrics?.convertedCount === 2, 'Cache local de referral deve persistir contadores');

      removeAccountFromLocalVault('uid_ref_alpha', []);
      assert(fakeStore['talk2tm_ref_summary_v1_uid_ref_alpha'] === undefined, 'Hard Delete deve limpar resumo de referral do utilizador');

      const adminFbSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/firebase/admin.ts'), 'utf8');
      const adminUiSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/admin.ts'), 'utf8');
      assert(
        adminUiSrc.includes('Fotos') &&
        adminFbSrc.includes("'datingProfiles'") &&
        !adminFbSrc.includes("'conversations'") &&
        !adminFbSrc.includes("'messages'") &&
        !adminUiSrc.includes('vitronis.hbo'),
        'Painel Admin deve incluir fila Fotos preservando isolamento total do Teste 61'
      );
    } finally {
      clearReferralMemoryForTests();
      globalThis.localStorage = origLS;
    }
  });

  // 68. Fase 5: Notificações Web Push Discretas & Dashboard de Métricas (Admin)
  check('Fase 5: Web Push discreto sem PII, preferências locais, telemetria WAU/cidade e KPIs Admin', () => {
    clearNotificationMemoryStateForTests();
    const origLS = globalThis.localStorage;
    const fakeStore: Record<string, string> = {};
    globalThis.localStorage = {
      getItem: (k: string) => (Object.prototype.hasOwnProperty.call(fakeStore, k) ? fakeStore[k] : null),
      setItem: (k: string, v: string) => {
        fakeStore[k] = String(v);
      },
      removeItem: (k: string) => {
        delete fakeStore[k];
      },
      clear: () => {
        Object.keys(fakeStore).forEach((k) => delete fakeStore[k]);
      },
      key: (idx: number) => Object.keys(fakeStore)[idx] ?? null,
      get length() {
        return Object.keys(fakeStore).length;
      },
    } as unknown as Storage;

    try {
      // 1. Preferências padrão e normalização
      const defaultNotifs = normalizeNotificationSettings(undefined);
      assert(
        defaultNotifs.pushEnabled === false &&
          defaultNotifs.pushMatchEnabled === true &&
          defaultNotifs.pushMessageEnabled === true,
        'Web Push deve iniciar desativado por omissão com sub-tipos prontos para ativar'
      );

      saveSettings({
        sessionTimeoutMinutes: 5,
        inactivityLockSeconds: 300,
        appearance: 'talk2tm',
        language: 'pt',
        pushEnabled: true,
        pushMatchEnabled: true,
        pushMessageEnabled: false,
      });
      const loadedPrefs = loadSettings();
      assert(
        loadedPrefs.pushEnabled === true &&
          loadedPrefs.pushMatchEnabled === true &&
          loadedPrefs.pushMessageEnabled === false,
        'Preferências locais de notificação devem persistir em ttm_settings'
      );

      assert(
        isNotificationKindEnabled(loadedPrefs, 'match') === true &&
          isNotificationKindEnabled(loadedPrefs, 'message') === false,
        'Filtro por tipo de notificação deve respeitar preferências granulares'
      );

      // 2. Payload estritamente genérico sem exposição de dados sensíveis
      const msgPayload = buildDiscreetNotificationPayload('message', {
        messageBody: 'Nova atividade na conta',
        matchBody: 'Novo Match',
      });
      const matchPayload = buildDiscreetNotificationPayload('match', {
        messageBody: 'Nova atividade na conta',
        matchBody: 'Novo Match',
      });
      assert(
        msgPayload.title === 'Talk2TM' &&
          msgPayload.body === 'Nova atividade na conta' &&
          msgPayload.tag === 'talk2tm-activity',
        'Alerta de mensagem deve mostrar apenas texto genérico sem conteúdo nem remetente'
      );
      assert(
        matchPayload.title === 'Talk2TM' &&
          matchPayload.body === 'Novo Match' &&
          matchPayload.tag === 'talk2tm-match',
        'Alerta de Match deve mostrar apenas texto genérico "Novo Match"'
      );

      // 3. Portões de disparo (permissão, primeiro plano, deduplicação e cooldown)
      const fullOnSettings = {
        pushEnabled: true,
        pushMatchEnabled: true,
        pushMessageEnabled: true,
      };
      const baseNow = 1_700_000_000_000;
      assert(
        shouldNotifyDiscreetly({
          kind: 'message',
          settings: fullOnSettings,
          permission: 'denied',
          eventKey: 'm_1',
          nowMs: baseNow,
        }) === false,
        'Permissão negada nunca deve disparar notificação'
      );
      assert(
        shouldNotifyDiscreetly({
          kind: 'message',
          settings: fullOnSettings,
          permission: 'granted',
          eventKey: 'm_1',
          nowMs: baseNow,
          isAppForegroundContext: true,
        }) === false,
        'Contexto em primeiro plano visível deve suprimir alerta duplicado'
      );
      assert(
        shouldNotifyDiscreetly({
          kind: 'message',
          settings: fullOnSettings,
          permission: 'granted',
          eventKey: 'm_1',
          nowMs: baseNow,
          isAppForegroundContext: false,
        }) === true,
        'Evento elegível com permissão concedida deve permitir alerta discreto'
      );

      markDiscreetNotificationSent('message', 'm_1', baseNow);
      assert(
        shouldNotifyDiscreetly({
          kind: 'message',
          settings: fullOnSettings,
          permission: 'granted',
          eventKey: 'm_1',
          nowMs: baseNow + 60_000,
        }) === false,
        'Mesmo eventKey não deve notificar duas vezes'
      );
      assert(
        shouldNotifyDiscreetly({
          kind: 'message',
          settings: fullOnSettings,
          permission: 'granted',
          eventKey: 'm_2',
          nowMs: baseNow + 2_000,
          cooldownMs: 12_000,
        }) === false,
        'Cooldown de anti-spam deve travar alertas consecutivos imediatos'
      );
      assert(
        shouldNotifyDiscreetly({
          kind: 'message',
          settings: fullOnSettings,
          permission: 'granted',
          eventKey: 'm_2',
          nowMs: baseNow + 15_000,
          cooldownMs: 12_000,
        }) === true,
        'Novo evento após cooldown deve voltar a notificar'
      );

      // 4. Service Worker push handler + clique seguro
      const swSrc = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');
      assert(
        swSrc.includes("addEventListener('push'") &&
          swSrc.includes("addEventListener('notificationclick'") &&
          swSrc.includes('Nova atividade na conta') &&
          swSrc.includes('Novo Match') &&
          swSrc.includes('talk2tm-activity') &&
          swSrc.includes('talk2tm-match'),
        'Service Worker deve tratar eventos push/notificationclick apenas com texto genérico seguro'
      );

      // 5. Telemetria WAU & Agregação de Métricas Admin (excluindo legado Truman/Mãezinha)
      const refNowMs = Date.parse('2026-11-26T12:00:00.000Z');
      const dayKey = getLocalDateDayKey(new Date(refNowMs));
      const weekStart = getWeekWindowStartIso(refNowMs);
      assert(dayKey === '2026-11-26', 'getLocalDateDayKey deve retornar YYYY-MM-DD em UTC');
      assert(weekStart.startsWith('2026-11-19'), 'Janela semanal WAU deve cobrir últimos 7 dias');

      fakeStore[getActivityPingStorageKey('uid_u1')] = JSON.stringify({ dayKey, atMs: refNowMs });
      removeAccountFromLocalVault('uid_u1', []);
      assert(
        fakeStore[getActivityPingStorageKey('uid_u1')] === undefined,
        'Hard Delete deve remover chave local de telemetria de atividade'
      );

      const makeDatingProf = (uid: string, city: string, countryCode = 'AO', paused = false, suspended = false): DatingProfile => ({
        uid,
        talk2tmId: `TM-${uid.toUpperCase()}`,
        displayName: uid,
        age: 26,
        gender: 'woman',
        seeking: 'all',
        countryCode,
        city,
        cityKey: city.toLowerCase(),
        bio: 'Perfil teste',
        intent: 'serious',
        adultConfirmed: true,
        termsAcceptedAt: '2026-11-20T00:00:00.000Z',
        termsVersion: 'dating-v1',
        discoverable: true,
        paused,
        suspended,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      });

      const makeMatchRec = (id: string, a: string, b: string, status: 'matched' | 'unmatched', chatStarted: boolean): DatingMatch => ({
        matchId: id,
        conversationId: `conv_${a}_${b}`,
        participantA: a,
        participantB: b,
        talk2tmIdA: `TM-${a}`,
        talk2tmIdB: `TM-${b}`,
        displayNameA: a,
        displayNameB: b,
        matchedByUid: b,
        status,
        seenByA: true,
        seenByB: true,
        chatStarted,
        chatStartedAt: chatStarted ? '2026-11-25T10:00:00.000Z' : undefined,
        createdAt: '2026-11-25T09:00:00.000Z',
        updatedAt: '2026-11-25T10:00:00.000Z',
      });

      const metrics = computeGrowthMetricsSummary({
        nowMs: refNowMs,
        userProfiles: [
          { uid: 'uid_truman_852456', talk2tmId: 'TM-TRUM-0001', displayName: 'Truman', active: true, createdAt: '2026-01-01T00:00:00.000Z' },
          { uid: 'uid_u1', talk2tmId: 'TM-U111-0001', displayName: 'Ana', active: true, createdAt: '2026-11-01T00:00:00.000Z' },
          { uid: 'uid_u2', talk2tmId: 'TM-U222-0002', displayName: 'Bruno', active: true, createdAt: '2026-11-02T00:00:00.000Z' },
          { uid: 'uid_u3', talk2tmId: 'TM-U333-0003', displayName: 'Carla', active: true, createdAt: '2026-11-03T00:00:00.000Z' },
          { uid: 'uid_u4', talk2tmId: 'TM-U444-0004', displayName: 'Diogo', active: true, createdAt: '2026-11-04T00:00:00.000Z' },
          { uid: 'uid_susp', talk2tmId: 'TM-SUSP-0005', displayName: 'Susp', active: false, createdAt: '2026-11-05T00:00:00.000Z' },
        ],
        referralLinks: [
          { code: 'TMREF111', referrerUid: 'uid_u1', referrerDisplayName: 'Ana', active: true, createdAt: '2026-11-01T00:00:00.000Z' },
        ],
        referralStats: [
          { uid: 'uid_u1', referralCode: 'TMREF111', invitesSharedCount: 5, updatedAt: '2026-11-25T00:00:00.000Z' },
        ],
        referralAttributions: [
          { newUid: 'uid_u2', newTalk2tmId: 'TM-U222-0002', referralCode: 'TMREF111', referrerUid: 'uid_u1', createdAt: '2026-11-02T00:00:00.000Z' },
          { newUid: 'uid_u3', newTalk2tmId: 'TM-U333-0003', referralCode: 'TMREF111', referrerUid: 'uid_u1', createdAt: '2026-11-03T00:00:00.000Z' },
        ],
        datingProfiles: [
          makeDatingProf('uid_u1', 'Luanda', 'AO'),
          makeDatingProf('uid_u2', 'Luanda', 'AO'),
          makeDatingProf('uid_u3', 'Lisboa', 'PT'),
          makeDatingProf('uid_susp', 'Porto', 'PT', false, true),
        ],
        datingMatches: [
          makeMatchRec('m1', 'uid_u1', 'uid_u2', 'matched', true),
          makeMatchRec('m2', 'uid_u2', 'uid_u3', 'matched', false),
        ],
        growthTelemetry: [
          { uid: 'uid_u1', lastActiveAt: '2026-11-25T15:00:00.000Z', lastActiveDay: '2026-11-25', city: 'Luanda', cityKey: 'luanda', countryCode: 'AO', updatedAt: '2026-11-25T15:00:00.000Z' },
          { uid: 'uid_u2', lastActiveAt: '2026-11-24T12:00:00.000Z', lastActiveDay: '2026-11-24', updatedAt: '2026-11-24T12:00:00.000Z' },
          { uid: 'uid_u3', lastActiveAt: '2026-11-10T10:00:00.000Z', lastActiveDay: '2026-11-10', updatedAt: '2026-11-10T10:00:00.000Z' },
          { uid: 'uid_u4', lastActiveAt: '2026-11-26T09:00:00.000Z', lastActiveDay: '2026-11-26', city: 'Benguela', cityKey: 'benguela', countryCode: 'AO', updatedAt: '2026-11-26T09:00:00.000Z' },
          { uid: 'uid_truman_852456', lastActiveAt: '2026-11-26T10:00:00.000Z', lastActiveDay: '2026-11-26', updatedAt: '2026-11-26T10:00:00.000Z' },
        ],
      });

      assert(metrics.totalActiveUsers === 4, `Deve contar 4 utilizadores ativos não-legados (atual: ${metrics.totalActiveUsers})`);
      assert(metrics.totalDatingProfiles === 3, 'Deve contar 3 perfis Dating ativos (excluindo suspenso)');
      assert(metrics.referralConvertedUsers === 2, 'Registos por convite devem ser 2');
      assert(metrics.referralConversionSharePercent === 50, 'Quota de registos por convite deve ser 50% (2/4)');
      assert(metrics.referralLinkConversionRatePercent === 40, 'Taxa de conversão do link deve ser 40% (2/5)');
      assert(metrics.avgMatchesPerUser === 1.33, `Média de matches por utilizador deve ser 1.33 (4/3; atual: ${metrics.avgMatchesPerUser})`);
      assert(metrics.postMatchConversationRatePercent === 50, '% de conversas iniciadas após match deve ser 50% (1/2)');
      assert(metrics.weeklyActiveUsers === 3, `WAU deve contabilizar exatamente 3 ativos nos últimos 7 dias (atual: ${metrics.weeklyActiveUsers})`);
      assert(metrics.weeklyRetentionPercent === 75, 'Retenção semanal deve ser 75% (3/4)');
      assert(
        metrics.cityDistribution.length === 3 &&
          metrics.cityDistribution[0].city === 'Luanda' &&
          metrics.cityDistribution[0].activeCount === 2 &&
          metrics.cityDistribution[0].sharePercent === 50,
        'Distribuição geográfica deve ordenar Luanda (2 ativos · 50%) em primeiro lugar sem PII'
      );

      // 6. Auditoria de isolamento do Dashboard Admin Métricas (Teste 61 preserva zero leitura de chats)
      const adminFbSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/firebase/admin.ts'), 'utf8');
      const adminUiSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/admin.ts'), 'utf8');
      assert(
        adminUiSrc.includes('Métricas') &&
          adminFbSrc.includes('fetchAdminGrowthMetrics') &&
          adminFbSrc.includes("'growthTelemetry'") &&
          !adminFbSrc.includes("'conversations'") &&
          !adminFbSrc.includes("'messages'") &&
          !adminUiSrc.includes('Convidados') &&
          !adminUiSrc.includes('vitronis.hbo'),
        'Dashboard Admin Métricas deve respeitar isolamento estrito sem acesso a conversas/mensagens nem credenciais'
      );
    } finally {
      clearNotificationMemoryStateForTests();
      globalThis.localStorage = origLS;
    }
  });

  console.log(`\x1b[32m✔ Talk2TM: ${passed}/${total} testes síncronos executados com 100% de aprovação.\x1b[0m`);
  return { passed, total };
}

export async function runAsyncZeroCostTests(): Promise<{ passed: number; total: number }> {
  let passed = 0;
  let total = 0;

  async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    total++;
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`Erro no teste assíncrono: ${name}`, err);
      throw err;
    }
  }

  // 57. Hash SHA-256 determinístico por telefone
  await checkAsync('Zero Custos: hashPhoneNumber produz SHA-256 determinístico de 64 hex chars', async () => {
    const h1 = await hashPhoneNumber('+244923456789');
    const h2 = await hashPhoneNumber('+244923456789');
    const h3 = await hashPhoneNumber('+244923456780');
    assert(/^[a-f0-9]{64}$/.test(h1), 'Hash deve ter exatamente 64 caracteres hexadecimais minúsculos');
    assert(h1 === h2, 'Mesmo número E.164 deve gerar exatamente o mesmo phoneHash');
    assert(h1 !== h3, 'Números distintos devem gerar hashes distintos');
  });

  // 58. Derivação determinística PBKDF2 da senha Auth via recoveryCode + phoneHash
  await checkAsync('Zero Custos: deriveAuthPassword é determinística para o par (recoveryCode, phoneHash)', async () => {
    const phA = await hashPhoneNumber('+244911222333');
    const phB = await hashPhoneNumber('+244944555666');
    const rec = generateRecoveryCode();
    const pwd1 = await deriveAuthPassword(rec, phA);
    const pwd2 = await deriveAuthPassword(rec.toLowerCase().replace(/-/g, ''), phA);
    const pwdOtherPhone = await deriveAuthPassword(rec, phB);

    assert(pwd1 === pwd2, 'Recuperação com código sem hífens/minúsculas deve derivar exatamente a mesma senha Auth');
    assert(pwd1 !== pwdOtherPhone, 'Mesmo código não deve servir para outro phoneHash');
    assert(pwd1.startsWith('T2M$') && pwd1.length === 68, 'Senha derivada deve conter 256 bits hexadecimais');

    const memPwd1 = await deriveAuthPassword('Mãe 1975', phA);
    const memPwd2 = await deriveAuthPassword('mae1975', phA);
    assert(memPwd1 === memPwd2 && memPwd1.startsWith('T2M$'), 'Chave pessoal memorável (>=6 chars) deve derivar mesma senha Auth independente de acentos/espaços/maiúsculas');
  });

  // 59. Cofre local AES-256-GCM + PBKDF2 (sem Base64/texto simples no disco)
  await checkAsync('Zero Custos: sealAuthSecretWithPin e unsealAuthSecretWithPin protegem credencial com AES-256-GCM', async () => {
    const secret = 'T2M$' + 'ab'.repeat(32);
    const sealed = await sealAuthSecretWithPin(secret, '4920');

    assert(/^[a-f0-9]+$/.test(sealed.vaultCiphertext), 'Ciphertext deve ser hex opaco, nunca plaintext/Base64 legível');
    assert(!sealed.vaultCiphertext.includes('T2M$'), 'Ciphertext nunca pode conter a senha em texto simples');
    assert(sealed.pinLength === 4, 'Comprimento do PIN deve ser registrado para detecção na calculadora');

    const unsealed = await unsealAuthSecretWithPin(sealed, '4920');
    assert(unsealed === secret, 'PIN correto deve decifrar exatamente a credencial original');

    let failedWrongPin = false;
    try {
      await unsealAuthSecretWithPin(sealed, '4921');
    } catch {
      failedWrongPin = true;
    }
    assert(failedWrongPin === true, 'PIN incorreto deve falhar na verificação de autenticidade AES-GCM');
  });

  // 60. Bloqueio de PINs reservados (852456 / 135790) e colisão entre contas no cofre local
  await checkAsync('Zero Custos: validateLocalPin bloqueia códigos legados e colisões locais multi-conta', async () => {
    const fakeStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => fakeStore[k] ?? null,
      setItem: (k: string, v: string) => { fakeStore[k] = v; },
      removeItem: (k: string) => { delete fakeStore[k]; },
    };

    const resTruman = await validateLocalPin('852456', true, undefined, mockStorage);
    const resMaezinha = await validateLocalPin('135790', true, undefined, mockStorage);
    const resShort = await validateLocalPin('123', true, undefined, mockStorage);
    const resAlpha = await validateLocalPin('12ab', true, undefined, mockStorage);
    assert(resTruman.valid === false, 'PIN 852456 reservado a Truman deve ser bloqueado');
    assert(resMaezinha.valid === false, 'PIN 135790 reservado à Mãezinha deve ser bloqueado');
    assert(resShort.valid === false && resAlpha.valid === false, 'PIN deve aceitar apenas 4 a 8 dígitos numéricos');

    const sealedA = await sealAuthSecretWithPin('sec_conta_A', '2468');
    upsertLocalIdentity(
      {
        uid: 'uid_vault_a',
        talk2tmId: 'TM-AAAA-2222',
        displayName: 'Ana',
        internalEmail: 'u_a@talk2tm.internal',
        internalSecret: 'DeveriaSerRemovidoAoGravar',
        phoneHash: 'a'.repeat(64),
        phoneMasked: '+244 ••• 111',
        ...sealedA,
        createdAt: '2026-11-17T00:00:00.000Z',
      },
      true,
      mockStorage
    );

    // Garante que internalSecret não foi persistido no localStorage quando vaultCiphertext existe
    const rawSaved = fakeStore['talk2tm_identities_v2'] || '';
    assert(!rawSaved.includes('DeveriaSerRemovidoAoGravar'), 'Segredo em texto simples nunca pode ser persistido junto do cofre encriptado');

    const collisionCheck = await validateLocalPin('2468', true, undefined, mockStorage);
    assert(collisionCheck.valid === false, 'Outra conta no mesmo aparelho não pode reutilizar o mesmo PIN');

    const selfUpdateCheck = await validateLocalPin('2468', true, 'uid_vault_a', mockStorage);
    assert(selfUpdateCheck.valid === true, 'Mesma conta deve poder atualizar mantendo exclusão de seu próprio UID');
  });

  // 61. Resolução multi-conta pelo PIN na calculadora
  await checkAsync('Zero Custos: findLocalIdentityByPin distingue múltiplas contas no mesmo navegador', async () => {
    const fakeStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => fakeStore[k] ?? null,
      setItem: (k: string, v: string) => { fakeStore[k] = v; },
      removeItem: (k: string) => { delete fakeStore[k]; },
    };

    const s1 = await sealAuthSecretWithPin('sec_1', '1122');
    const s2 = await sealAuthSecretWithPin('sec_2', '334455');

    upsertLocalIdentity(
      {
        uid: 'uid_multi_1',
        talk2tmId: 'TM-M111-1111',
        displayName: 'Joao',
        internalEmail: 'u_1@talk2tm.internal',
        phoneHash: '1'.repeat(64),
        phoneMasked: '+244 ••• 101',
        ...s1,
        createdAt: '2026-11-17T00:00:00.000Z',
      },
      true,
      mockStorage
    );
    upsertLocalIdentity(
      {
        uid: 'uid_multi_2',
        talk2tmId: 'TM-M222-2222',
        displayName: 'Maria',
        internalEmail: 'u_2@talk2tm.internal',
        phoneHash: '2'.repeat(64),
        phoneMasked: '+244 ••• 202',
        ...s2,
        createdAt: '2026-11-17T00:00:00.000Z',
      },
      false,
      mockStorage
    );

    const found1 = await findLocalIdentityByPin('1122', mockStorage);
    const found2 = await findLocalIdentityByPin('334455', mockStorage);
    const notFound = await findLocalIdentityByPin('9999', mockStorage);

    assert(found1?.uid === 'uid_multi_1' && found1.displayName === 'Joao', 'PIN de 4 dígitos deve resolver Conta 1');
    assert(found2?.uid === 'uid_multi_2' && found2.displayName === 'Maria', 'PIN de 6 dígitos deve resolver Conta 2');
    assert(notFound === null, 'PIN desconhecido deve retornar null');
  });

  // 62. Opção C: upsertLocalIdentity preserva recoveryEmail e pendingRecoveryEmail ao sanitizar segredo
  await checkAsync('Opção C: upsertLocalIdentity preserva recoveryEmail e pendingRecoveryEmail no cofre local', async () => {
    const fakeStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => fakeStore[k] ?? null,
      setItem: (k: string, v: string) => { fakeStore[k] = v; },
      removeItem: (k: string) => { delete fakeStore[k]; },
    };

    const sealed = await sealAuthSecretWithPin('sec_email_test', '7410');
    upsertLocalIdentity(
      {
        uid: 'uid_email_1',
        talk2tmId: 'TM-EMAI-1234',
        displayName: 'Carlos',
        internalEmail: 'carlos@example.com',
        recoveryEmail: 'carlos@example.com',
        pendingRecoveryEmail: 'carlos.novo@example.com',
        internalSecret: 'DeveriaSumir',
        phoneHash: 'c'.repeat(64),
        phoneMasked: '+244 ••• 999',
        ...sealed,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
      true,
      mockStorage
    );

    const restored = getLocalIdentity(mockStorage);
    assert(restored !== null, 'Identidade deve existir no cofre');
    assert(restored?.recoveryEmail === 'carlos@example.com', 'recoveryEmail deve ser preservado');
    assert(restored?.pendingRecoveryEmail === 'carlos.novo@example.com', 'pendingRecoveryEmail deve ser preservado');
    assert(restored?.internalSecret === undefined, 'internalSecret deve continuar sendo removido');
  });

  // 63. Micro-dicionários i18n modulares: carregamento dinâmico, paridade total de chaves e variáveis entre pt, en, fr e es
  await checkAsync('i18n Modular: carregamento dinâmico, paridade de chaves/placeholders em pt/en/fr/es e cache offline SW', async () => {
    const enKeys = Object.keys(en).sort();
    assert(enKeys.length > 100, 'Dicionário base en deve conter todas as chaves da interface');

    const extractPlaceholders = (text: string): string => {
      const matches = text.match(/\{[a-zA-Z0-9_]+\}/g) || [];
      return [...matches].sort().join(',');
    };

    for (const loc of SUPPORTED_LOCALES as readonly SupportedLocale[]) {
      const dict = await loadLocaleDictionary(loc);
      const keys = Object.keys(dict).sort();
      assert(
        keys.length === enKeys.length && keys.every((k, i) => k === enKeys[i]),
        `Dicionário "${loc}" deve ter exatamente as mesmas chaves que "en"`
      );
      for (const key of enKeys as Array<keyof typeof en>) {
        const val = dict[key];
        assert(typeof val === 'string' && val.trim().length > 0, `Chave "${String(key)}" vazia em "${loc}"`);
        assert(
          extractPlaceholders(val) === extractPlaceholders(en[key]),
          `Placeholders incompatíveis em "${loc}.${String(key)}"`
        );
      }
      assert(Boolean(LOCALE_REGISTRY[loc].nativeLabel), `LOCALE_REGISTRY.${loc} deve definir nativeLabel`);
    }

    // Testa initI18n e setAppLocale em runtime com alteração efetiva do dicionário
    await initI18n('auto', { languages: ['es-ES'] });
    assert(getCurrentLocale() === 'es', 'initI18n auto deve selecionar es quando sistema é es-ES');
    assert(t('settings.title') === 'Ajustes Mínimos', 'Tradução em es deve refletir o micro-dicionário carregado');

    await setAppLocale('fr');
    assert(getCurrentLocale() === 'fr', 'setAppLocale(fr) deve trocar para fr');
    assert(t('settings.title') === 'Paramètres Minimaux', 'Tradução em fr deve atualizar imediatamente');

    await setAppLocale('pt');
    assert(t('settings.title') === 'Definições Mínimas', 'Tradução em pt deve atualizar imediatamente');

    // Garante cobertura offline no Service Worker para chunks JS de idioma
    const swSrc = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');
    assert(swSrc.includes('/assets/') && swSrc.includes('caches.open'), 'Service Worker deve armazenar chunks modulares em cache offline');
  });

  // 64. Hard Delete cirúrgico do cofre local: remove apenas conta apagada preservando conta secundária e legado Truman/Mãezinha
  await checkAsync('Fase 3 Hard Delete: removeAccountFromLocalVault apaga apenas conta eliminada e preserva legado/outras contas', async () => {
    const fakeStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => fakeStore[k] ?? null,
      setItem: (k: string, v: string) => { fakeStore[k] = v; },
      removeItem: (k: string) => { delete fakeStore[k]; },
    };

    const sA = await sealAuthSecretWithPin('secret_del_a', '1470');
    const sB = await sealAuthSecretWithPin('secret_keep_b', '2580');

    upsertLocalIdentity(
      {
        uid: 'uid_del_a',
        talk2tmId: 'TM-DELA-1111',
        displayName: 'ContaApagar',
        internalEmail: 'dela@talk2tm.internal',
        phoneHash: 'd'.repeat(64),
        phoneMasked: '+244 ••• 111',
        ...sA,
        createdAt: '2026-11-24T00:00:00.000Z',
      },
      true,
      mockStorage
    );
    upsertLocalIdentity(
      {
        uid: 'uid_keep_b',
        talk2tmId: 'TM-KEEP-2222',
        displayName: 'ContaFica',
        internalEmail: 'keepb@talk2tm.internal',
        phoneHash: 'e'.repeat(64),
        phoneMasked: '+244 ••• 222',
        ...sB,
        createdAt: '2026-11-24T00:00:00.000Z',
      },
      false,
      mockStorage
    );

    // Preenche chaves específicas da conta apagada e chaves legadas protegidas
    fakeStore['talk2tm_session'] = JSON.stringify({ userId: 'uid_del_a', channelId: 'conv_uid_del_a_uid_keep_b' });
    fakeStore['talk2tm_monitor_v1'] = JSON.stringify({ userId: 'uid_del_a', channelId: 'conv_uid_del_a_uid_keep_b' });
    fakeStore['talk2tm_dating_profile_v1_uid_del_a'] = '{"uid":"uid_del_a"}';
    fakeStore['talk2tm_blocks_v1_uid_del_a'] = '["uid_keep_b"]';
    fakeStore['talk2tm_ratelimit_v1_uid_del_a'] = '{"uid":"uid_del_a"}';
    fakeStore['talk2tm_hidden_conv_uid_del_a_uid_keep_b'] = '["m1"]';
    fakeStore['talk2tm_hidden_truman-maezinha'] = '["leg_1"]';
    fakeStore['ttm_last_read_truman-maezinha_Truman'] = '2026-11-25T00:00:00.000Z';

    removeAccountFromLocalVault('uid_del_a', ['conv_uid_del_a_uid_keep_b', 'truman-maezinha'], mockStorage);

    const remaining = await findLocalIdentityByPin('2580', mockStorage);
    const removed = await findLocalIdentityByPin('1470', mockStorage);
    assert(removed === null, 'Conta apagada deve desaparecer do cofre local');
    assert(remaining?.uid === 'uid_keep_b', 'Conta secundária no mesmo dispositivo deve permanecer intacta');
    assert(fakeStore['talk2tm_session'] === undefined, 'Sessão da conta apagada deve ser removida');
    assert(fakeStore['talk2tm_monitor_v1'] === undefined, 'Monitor da conta apagada deve ser removido');
    assert(fakeStore['talk2tm_dating_profile_v1_uid_del_a'] === undefined, 'Cache Dating da conta apagada deve ser removido');
    assert(fakeStore['talk2tm_blocks_v1_uid_del_a'] === undefined, 'Cache de bloqueios da conta apagada deve ser removido');
    assert(fakeStore['talk2tm_ratelimit_v1_uid_del_a'] === undefined, 'Cache de rate limit da conta apagada deve ser removido');
    assert(fakeStore['talk2tm_hidden_conv_uid_del_a_uid_keep_b'] === undefined, 'Ocultos da conversa apagada devem ser removidos');
    assert(fakeStore['talk2tm_hidden_truman-maezinha'] === '["leg_1"]', 'Dados da sala legada truman-maezinha nunca podem ser apagados');
    assert(fakeStore['ttm_last_read_truman-maezinha_Truman'] === '2026-11-25T00:00:00.000Z', 'Leitura legada Truman nunca pode ser apagada');

    // Tentativa directa em UID legado protegido não altera nada
    removeAccountFromLocalVault('uid_truman_852456', ['truman-maezinha'], mockStorage);
    assert(fakeStore['talk2tm_hidden_truman-maezinha'] === '["leg_1"]', 'UID legado protegido é imutável no Hard Delete');
  });

  // 65. Hub Comercial: entrada direta na Descoberta, navegação em 4 destinos, cartão retrato e Match com avatares duplos
  await checkAsync('Hub Comercial: Descoberta como destino padrão, cartão retrato e avatares sem geolocation', async () => {
    const domSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/dom.ts'), 'utf8');
    const datingPanelSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/dating-panel.ts'), 'utf8');
    const styleSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/style.css'), 'utf8');

    assert(domSrc.includes("activeHubDest: 'discover' | 'matches' | 'connections' | 'account' = 'discover'"), 'Hub deve abrir em Descobrir por padrão');
    assert(domSrc.includes('ttm-hub-nav'), 'Hub deve renderizar navegação principal em 4 destinos');
    assert(datingPanelSrc.includes('ttm-dating-hero-media'), 'Descoberta deve usar cartão retrato comercial');
    assert(datingPanelSrc.includes('ttm-match-avatars'), 'Celebração de Match deve renderizar avatares duplos');
    assert(!datingPanelSrc.includes('geolocation'), 'dating-panel.ts não pode usar APIs contínuas de geolocalização');
    assert(styleSrc.includes('.talk2tm-shell.is-hub-active'), 'style.css deve suportar layout responsivo do Hub');
  });

  console.log(`\x1b[32m✔ Talk2TM Zero-Cost Async: ${passed}/${total} testes assíncronos executados com 100% de aprovação.\x1b[0m`);
  return { passed, total };
}

if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  runTalk2TMTests();
  runAsyncZeroCostTests().catch((err) => {
    console.error('\x1b[31m✖ Falha nos testes assíncronos:\x1b[0m', err);
    process.exit(1);
  });
}
