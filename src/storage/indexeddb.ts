import { Message, Room, UserSession } from '../types';

const DB_NAME = 'talk2tm_local_v1';
const DB_VERSION = 1;

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

      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'messageId' });
        msgStore.createIndex('room', 'room', { unique: false });
        msgStore.createIndex('room_createdAt', ['room', 'createdAt'], { unique: false });
        msgStore.createIndex('clientId', 'clientId', { unique: false });
      }

      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'messageId' });
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
 * Recupera as últimas N mensagens de uma sala em ordem cronológica (Camada 11)
 */
export async function getLocalMessages(roomId: string, limitCount = 50): Promise<Message[]> {
  const db = await getLocalDB();
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
        list.push(cursor.value);
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
        list.push(cursor.value);
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
