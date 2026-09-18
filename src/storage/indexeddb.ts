import { Conversation, ConversationMessage, Message, Room, UserSession } from '../types';

const DB_NAME = 'talk2tm_local_v1';
const DB_VERSION = 3;

let dbInstance: IDBDatabase | null = null;

export async function getLocalDB(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('rooms')) {
        db.createObjectStore('rooms', { keyPath: 'roomId' });
      }

      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'conversationId' });
      }

      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'messageId' });
        msgStore.createIndex('room', 'room', { unique: false });
        msgStore.createIndex('room_createdAt', ['room', 'createdAt'], { unique: false });
        msgStore.createIndex('clientId', 'clientId', { unique: false });
      }

      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'messageId' });
      }

      // Store para mensagens apagadas/ocultadas localmente neste dispositivo
      if (!db.objectStoreNames.contains('hidden_messages')) {
        const hiddenStore = db.createObjectStore('hidden_messages', { keyPath: 'key' });
        hiddenStore.createIndex('room', 'room', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(new Error('Falha ao abrir IndexedDB local do Talk2TM'));
    };
  });
}

/**
 * Salva ou atualiza uma mensagem localmente garantindo idempotência
 */
export async function saveLocalMessage(msg: Message): Promise<void> {
  const channelId = msg.conversationId || msg.room;
  // Se a mensagem foi marcada como ocultada/apagada localmente neste dispositivo, ignora
  if (isMessageHiddenLocally(channelId, msg.messageId) || isMessageHiddenLocally(msg.room, msg.messageId)) {
    return;
  }

  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    store.put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Tombstone local: Mensagens apagadas apenas neste dispositivo
 * Armazenamento multi-camada: Memória (acesso síncrono O(1) ultra-rápido) +
 * IndexedDB (para escalabilidade durável e ilimitada) +
 * localStorage (cache espelho imediato).
 */
const HIDDEN_KEY_PREFIX = 'talk2tm_hidden_';
const inMemoryHiddenSets: Map<string, Set<string>> = new Map();

export function getHiddenMessageIds(roomId: string): Set<string> {
  let set = inMemoryHiddenSets.get(roomId);
  if (!set) {
    set = new Set<string>();
    // Inicializa a partir do localStorage para disponibilidade síncrona imediata
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(`${HIDDEN_KEY_PREFIX}${roomId}`);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            arr.forEach((id) => set!.add(id));
          }
        }
      }
    } catch {
      // Falha silenciosa
    }
    inMemoryHiddenSets.set(roomId, set);
  }
  return set;
}

/**
 * Carrega a lista completa de IDs ocultos do IndexedDB para a memória da sessão
 */
export async function loadHiddenMessagesFromDB(roomId: string): Promise<Set<string>> {
  const currentSet = getHiddenMessageIds(roomId);
  if (typeof indexedDB === 'undefined') {
    return currentSet;
  }
  try {
    const db = await getLocalDB();
    if (db.objectStoreNames.contains('hidden_messages')) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('hidden_messages', 'readonly');
        const store = tx.objectStore('hidden_messages');
        const index = store.index('room');
        const req = index.openCursor(IDBKeyRange.only(roomId));
        req.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            if (cursor.value && cursor.value.messageId) {
              currentSet.add(cursor.value.messageId);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(tx.error);
      });
    }
  } catch (err) {
    console.debug('Talk2TM [Storage]: Erro ao carregar tombstones do IndexedDB:', err);
  }
  return currentSet;
}

export function hideMessagesLocally(roomId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return;

  const currentSet = getHiddenMessageIds(roomId);
  messageIds.forEach((id) => currentSet.add(id));

  // 1. Atualiza cache espelho no localStorage
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(
        `${HIDDEN_KEY_PREFIX}${roomId}`,
        JSON.stringify(Array.from(currentSet))
      );
    }
  } catch (err) {
    console.debug('Talk2TM [Storage]: Erro ao salvar tombstone local em localStorage:', err);
  }

  // 2. Persiste assincronamente no IndexedDB para durabilidade sem limitação de cota
  if (typeof indexedDB !== 'undefined') {
    getLocalDB()
      .then((db) => {
        if (!db.objectStoreNames.contains('hidden_messages')) return;
        const tx = db.transaction('hidden_messages', 'readwrite');
        const store = tx.objectStore('hidden_messages');
        const now = new Date().toISOString();
        messageIds.forEach((id) => {
          store.put({
            key: `${roomId}_${id}`,
            room: roomId,
            messageId: id,
            hiddenAt: now,
          });
        });
      })
      .catch((err) => {
        console.debug('Talk2TM [Storage]: Erro ao gravar hidden_messages no IndexedDB:', err);
      });
  }
}

export function isMessageHiddenLocally(roomId: string, messageId: string): boolean {
  return getHiddenMessageIds(roomId).has(messageId);
}

/**
 * Remove mensagens da tabela de mensagens do IndexedDB local
 */
export async function deleteLocalMessages(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    messageIds.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Recupera as últimas N mensagens de uma sala em ordem cronológica (Camada 11)
 */
export async function getLocalMessages(roomId: string, limitCount = 50): Promise<Message[]> {
  const db = await getLocalDB();
  const hiddenSet = getHiddenMessageIds(roomId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const index = store.index('room_createdAt');

    const range = IDBKeyRange.bound([roomId, ''], [roomId, '\uffff']);
    const request = index.openCursor(range, 'prev'); // decrescente para pegar as mais recentes

    const list: Message[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor && list.length < limitCount) {
        const msg = cursor.value;
        if (!hiddenSet.has(msg.messageId)) {
          list.push(msg);
        }
        cursor.continue();
      } else {
        // Ordena cronologicamente (mais antiga para mais recente para leitura linear)
        resolve(list.reverse());
      }
    };

    request.onerror = () => reject(tx.error);
  });
}

/**
 * Recupera mensagens anteriores para paginação no scroll / botão de histórico
 */
export async function getOlderLocalMessages(
  roomId: string,
  beforeIsoDate: string,
  limitCount = 50
): Promise<Message[]> {
  const db = await getLocalDB();
  const hiddenSet = getHiddenMessageIds(roomId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const index = store.index('room_createdAt');

    const range = IDBKeyRange.bound([roomId, ''], [roomId, beforeIsoDate], false, true);
    const request = index.openCursor(range, 'prev');

    const list: Message[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor && list.length < limitCount) {
        const msg = cursor.value;
        if (!hiddenSet.has(msg.messageId)) {
          list.push(msg);
        }
        cursor.continue();
      } else {
        resolve(list.reverse());
      }
    };

    request.onerror = () => reject(tx.error);
  });
}

/**
 * Salva sala no armazenamento local
 */
export async function saveLocalRoom(room: Room): Promise<void> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('rooms', 'readwrite');
    tx.objectStore('rooms').put(room);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Recupera sala do armazenamento local
 */
export async function getLocalRoom(roomId: string): Promise<Room | null> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('rooms', 'readonly');
    const request = tx.objectStore('rooms').get(roomId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(tx.error);
  });
}

/**
 * Atualiza localmente a data da última leitura de um participante na sala
 */
export async function updateLocalLastRead(
  roomId: string,
  userKey: string,
  readAtIso: string
): Promise<Room | null> {
  const room = await getLocalRoom(roomId);
  if (!room) return null;

  if (!room.lastRead) {
    room.lastRead = {};
  }
  room.lastRead[userKey] = readAtIso;

  if (room.participantAName === userKey || room.participantA === userKey) {
    room.lastReadA = readAtIso;
  }
  if (room.participantBName === userKey || room.participantB === userKey) {
    room.lastReadB = readAtIso;
  }
  room.lastActivity = readAtIso;

  await saveLocalRoom(room);
  return room;
}

/**
 * Fila offline (outbox) para mensagens pendentes de sincronização
 */
export async function addToOutbox(msg: Message): Promise<void> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOutboxMessages(): Promise<Message[]> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readonly');
    const request = tx.objectStore('outbox').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(tx.error);
  });
}

export async function removeFromOutbox(messageId: string): Promise<void> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(messageId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Armazenamento de sessão rápida (localStorage para reabertura de aba sem rebuild)
const SESSION_KEY = 'talk2tm_session';

export function saveSession(session: UserSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Falha silenciosa se armazenamento restrito
  }
}

export function getSession(): UserSession | null {
  try {
    const data = localStorage.getItem(SESSION_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Falha silenciosa
  }
}

/**
 * Persistência local ultra-rápida para entidade Conversation
 */
export async function saveLocalConversation(conv: Conversation): Promise<void> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('conversations', 'readwrite');
    tx.objectStore('conversations').put(conv);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLocalConversation(conversationId: string): Promise<Conversation | null> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('conversations', 'readonly');
    const request = tx.objectStore('conversations').get(conversationId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(tx.error);
  });
}

export async function getAllLocalConversations(): Promise<Conversation[]> {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('conversations', 'readonly');
    const request = tx.objectStore('conversations').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(tx.error);
  });
}

/**
 * Salva mensagem de conversa unificada com idempotência e suporte offline
 */
export async function saveLocalConversationMessage(msg: ConversationMessage | Message): Promise<void> {
  const channelId = ('conversationId' in msg && msg.conversationId) ? msg.conversationId : ('room' in msg ? msg.room : '');
  const unifiedMsg: Message = {
    messageId: msg.messageId,
    room: channelId,
    conversationId: channelId,
    sender: ('sender' in msg && msg.sender) ? msg.sender : (('senderTalk2tmId' in msg && msg.senderTalk2tmId) ? msg.senderTalk2tmId : ''),
    senderId: msg.senderId,
    senderTalk2tmId: ('senderTalk2tmId' in msg && msg.senderTalk2tmId) ? msg.senderTalk2tmId : undefined,
    text: msg.text,
    clientId: msg.clientId,
    createdAt: msg.createdAt,
    status: msg.status || 'synced',
  };
  return saveLocalMessage(unifiedMsg);
}

export async function getLocalConversationMessages(conversationId: string, limitCount = 50): Promise<Message[]> {
  return getLocalMessages(conversationId, limitCount);
}

export async function getOlderLocalConversationMessages(
  conversationId: string,
  beforeIsoDate: string,
  limitCount = 50
): Promise<Message[]> {
  return getOlderLocalMessages(conversationId, beforeIsoDate, limitCount);
}
