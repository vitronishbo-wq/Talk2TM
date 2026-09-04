import './style.css';
import {
  CONFIG,
  ACCESS_CONFIG,
  AppSettings,
  getUserByPin,
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

// Estado global do cliente
let currentSession: UserSession | null = null;
let currentRoom: Room | null = null;
let connectionState: ConnectionState = 'conectando';
let unsubscribeMessages: Unsubscribe | null = null;
let unsubscribeRoom: Unsubscribe | null = null;
let ui: ChatUI;

// Configurações de Sessão e Inatividade
let appSettings: AppSettings = loadSettings();
let sessionTimeoutId: ReturnType<typeof setTimeout> | null = null;
let inactivityTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * Atualiza o estado textual da conexão
 */
function setConnectionState(newState: ConnectionState): void {
  connectionState = newState;
  ui.updateConnectionState(newState);
}

/**
 * Gerenciador de Bloqueio por Inatividade (Ex: 5 segundos sem teclar)
 */
function resetInactivityTimer(): void {
  if (inactivityTimerId) {
    clearTimeout(inactivityTimerId);
    inactivityTimerId = null;
  }

  // Só monitora se o usuário estiver ativamente no chat
  if (!currentSession || appSettings.inactivityLockSeconds <= 0) return;

  inactivityTimerId = setTimeout(() => {
    // 5 segundos sem teclar/interagir: bloqueio automático imediato
    handleLockToCalculator();
  }, appSettings.inactivityLockSeconds * 1000);
}

/**
 * Inicia ou reinicia o temporizador de sessão máxima (Ex: 15 min)
 */
function startSessionTimeout(): void {
  if (sessionTimeoutId) {
    clearTimeout(sessionTimeoutId);
    sessionTimeoutId = null;
  }

  if (appSettings.sessionTimeoutMinutes <= 0) return;

  sessionTimeoutId = setTimeout(() => {
    // Tempo de sessão findo: desconecta-se por si e volta para a calculadora
    handleLeave();
    handleLockToCalculator();
  }, appSettings.sessionTimeoutMinutes * 60 * 1000);
}

function stopAllTimers(): void {
  if (sessionTimeoutId) {
    clearTimeout(sessionTimeoutId);
    sessionTimeoutId = null;
  }
  if (inactivityTimerId) {
    clearTimeout(inactivityTimerId);
    inactivityTimerId = null;
  }
}

/**
 * Escuta eventos universais de digitação e toque para renovar o timer de inatividade
 */
function setupActivityListeners(): void {
  const renewActivity = () => {
    if (currentSession) {
      resetInactivityTimer();
    }
  };

  window.addEventListener('keydown', renewActivity, { passive: true });
  window.addEventListener('input', renewActivity, { passive: true });
  window.addEventListener('touchstart', renewActivity, { passive: true });
  window.addEventListener('pointerdown', renewActivity, { passive: true });
}

/**
 * Sincroniza a fila de mensagens pendentes (outbox) quando online
 */
async function syncPendingOutbox(): Promise<void> {
  if (!navigator.onLine) return;
  const pending = await getOutboxMessages();
  if (pending.length === 0) return;

  setConnectionState('sincronizando');

  for (const msg of pending) {
    try {
      await sendFirestoreMessage(msg);
      await removeFromOutbox(msg.messageId);
      const syncedMsg: Message = { ...msg, status: 'synced' };
      await saveLocalMessage(syncedMsg);
      ui.appendOrUpdateMessage(syncedMsg, syncedMsg.senderId === currentSession?.userId);
    } catch (err) {
      console.warn('Erro ao sincronizar mensagem pendente:', msg.messageId, err);
    }
  }

  setConnectionState('online');
}

/**
 * Manipulador de envio de mensagem
 */
async function handleSendMessage(rawText: string): Promise<void> {
  if (!currentSession) return;
  resetInactivityTimer();

  const sanitized = sanitizeMessageText(rawText);
  if (!sanitized.valid) {
    ui.showTemporaryNotice(sanitized.error || 'Mensagem inválida');
    return;
  }

  const clientId = generateId('cli');
  const messageId = `${currentSession.roomId}_${clientId}`;
  const nowIso = new Date().toISOString();

  const msg: Message = {
    messageId,
    room: currentSession.roomId,
    sender: currentSession.displayName,
    senderId: currentSession.userId,
    text: sanitized.text,
    clientId,
    createdAt: nowIso,
    status: 'pending',
  };

  await saveLocalMessage(msg);
  await addToOutbox(msg);
  ui.appendOrUpdateMessage(msg, true);

  if (navigator.onLine) {
    try {
      await sendFirestoreMessage(msg);
      await removeFromOutbox(msg.messageId);
      const syncedMsg: Message = { ...msg, status: 'synced' };
      await saveLocalMessage(syncedMsg);
      ui.appendOrUpdateMessage(syncedMsg, true);
    } catch (error) {
      console.warn('Mensagem salva localmente:', error);
    }
  }
}

/**
 * Desbloqueio e Entrada Direta por Senha
 * A senha digitada determina diretamente o usuário:
 *   852456 -> Truman
 *   135790 -> Mãezinha
 */
async function handleUnlockByPin(pin: string): Promise<void> {
  const user = getUserByPin(pin);

  if (!user) {
    ui.showPassError('Senha inválida.');
    return;
  }

  setConnectionState('conectando');

  const roomId = ACCESS_CONFIG.DEFAULT_ROOM;
  const userId = user === 'Truman' ? 'usr_truman' : 'usr_maezinha';

  const session: UserSession = {
    userId,
    displayName: user,
    roomId,
  };

  const joinResult = await joinFirestoreRoom(roomId, userId, user);

  if (!joinResult.success) {
    setConnectionState(navigator.onLine ? 'online' : 'offline');
    ui.showPassError(joinResult.error || 'Não foi possível acessar a sala.');
    return;
  }

  currentSession = session;
  currentRoom = joinResult.room;
  saveSession(session);
  await saveLocalRoom(currentRoom);

  // Exibe tela do chat
  ui.showChatView(session, currentRoom);

  // Inicia temporizadores de inatividade (5s) e sessão
  startSessionTimeout();
  resetInactivityTimer();

  // 1. Carrega histórico local
  const localHistory = await getLocalMessages(roomId, CONFIG.HISTORY_LIMIT);
  for (const m of localHistory) {
    ui.appendOrUpdateMessage(m, m.senderId === userId);
  }

  if (localHistory.length >= CONFIG.HISTORY_LIMIT) {
    ui.setHasOlderMessages(true);
  }

  // 2. Conecta listeners de tempo real
  setupRealtimeListeners(roomId);

  // 3. Sincroniza fila pendente
  await syncPendingOutbox();

  setConnectionState(navigator.onLine ? 'online' : 'offline');
}

/**
 * Carrega mensagens históricas anteriores
 */
async function handleLoadOlder(): Promise<void> {
  if (!currentSession) return;
  resetInactivityTimer();

  const currentMessages = await getLocalMessages(currentSession.roomId, 1000);
  if (currentMessages.length === 0) {
    ui.setHasOlderMessages(false);
    return;
  }

  const oldestDate = currentMessages[0].createdAt;
  const olderMessages = await getOlderLocalMessages(
    currentSession.roomId,
    oldestDate,
    CONFIG.HISTORY_LIMIT
  );

  if (olderMessages.length > 0) {
    ui.prependMessages(olderMessages, currentSession.userId);
  }

  if (olderMessages.length < CONFIG.HISTORY_LIMIT) {
    ui.setHasOlderMessages(false);
  }
}

/**
 * Desconecta e limpa sessão
 */
function handleLeave(): void {
  stopAllTimers();
  if (unsubscribeMessages) {
    unsubscribeMessages();
    unsubscribeMessages = null;
  }
  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }
  currentSession = null;
  currentRoom = null;
  clearSession();
}

/**
 * Camuflagem imediata: volta para a calculadora
 */
function handleLockToCalculator(): void {
  stopAllTimers();
  ui.showCalculatorView();
}

/**
 * Atualização de Definições Mínimas (tempo de sessão e inatividade)
 */
function handleUpdateSettings(newSettings: AppSettings): void {
  appSettings = newSettings;
  saveSettings(newSettings);

  if (currentSession) {
    startSessionTimeout();
    resetInactivityTimer();
  }
}

/**
 * Configura listeners em tempo real para a sala
 */
function setupRealtimeListeners(roomId: string): void {
  if (unsubscribeMessages) unsubscribeMessages();
  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = subscribeToRoom(roomId, (updatedRoom) => {
    currentRoom = updatedRoom;
    saveLocalRoom(updatedRoom);
    if (currentSession) {
      ui.updateRoomInfo(updatedRoom, currentSession);
    }
  });

  unsubscribeMessages = subscribeToMessages(
    roomId,
    async (incomingMessages) => {
      if (!currentSession) return;
      for (const msg of incomingMessages) {
        await saveLocalMessage(msg);
        ui.appendOrUpdateMessage(msg, msg.senderId === currentSession.userId);
      }
    },
    (err) => {
      console.warn('Listener Firestore offline:', err);
    }
  );
}

/**
 * Monitoramento de eventos de rede
 */
function setupNetworkMonitoring(): void {
  window.addEventListener('online', () => {
    setConnectionState('online');
    syncPendingOutbox();
  });

  window.addEventListener('offline', () => {
    setConnectionState('offline');
  });
}

/**
 * Registro de Service Worker para PWA
 */
function registerServiceWorker(): void {
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.debug('Service Worker erro:', err));
  }
}

/**
 * Ponto de entrada
 */
async function bootstrap(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Elemento #root não encontrado no DOM');

  ui = new ChatUI(root, appSettings, {
    onUnlockByPin: handleUnlockByPin,
    onLockToCalculator: handleLockToCalculator,
    onSendMessage: handleSendMessage,
    onLoadOlder: handleLoadOlder,
    onUpdateSettings: handleUpdateSettings,
  });

  setupNetworkMonitoring();
  setupActivityListeners();
  registerServiceWorker();

  await initFirebase();
  setConnectionState(navigator.onLine ? 'online' : 'offline');

  // O app sempre inicia camuflado pela Calculadora
  ui.showCalculatorView();
}

bootstrap().catch((err) => {
  console.error('Falha fatal na inicialização do Talk2TM:', err);
});
