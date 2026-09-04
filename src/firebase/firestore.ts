import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  Firestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  Unsubscribe,
  serverTimestamp,
} from 'firebase/firestore';
import { Message, Room } from '../types';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: true,
      tenantId: null,
      providerInfo: [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let firebaseApp: FirebaseApp | null = null;
let firestoreDb: Firestore | null = null;
let isConfigured = false;

/**
 * Tenta inicializar o Firebase com persistência local avançada (Camadas 06 e 07)
 */
export async function initFirebase(): Promise<{ db: Firestore | null; configured: boolean }> {
  if (firestoreDb) {
    return { db: firestoreDb, configured: isConfigured };
  }

  try {
    // Tenta carregar configuração do firebase-applet-config.json se existir
    const response = await fetch('/firebase-applet-config.json');
    if (!response.ok) {
      console.warn('Talk2TM: Rodando com mecanismo local offline (sem firebase-applet-config.json).');
      return { db: null, configured: false };
    }

    const config = await response.json();
    if (!config || !config.projectId) {
      return { db: null, configured: false };
    }

    if (!getApps().length) {
      firebaseApp = initializeApp(config);
    } else {
      firebaseApp = getApps()[0];
    }

    try {
      firestoreDb = initializeFirestore(firebaseApp, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch {
      // Fallback se abas múltiplas não suportadas
      firestoreDb = initializeFirestore(firebaseApp, {});
    }

    isConfigured = true;
    console.info('Talk2TM: Firestore inicializado com persistência local.');
    return { db: firestoreDb, configured: true };
  } catch (err) {
    console.warn('Talk2TM: Inicialização remota não configurada. Modo offline local ativo.', err);
    return { db: null, configured: false };
  }
}

/**
 * Entra ou cria uma sala garantindo a regra de no máximo 2 participantes (Camadas 12 e 13)
 */
export async function joinFirestoreRoom(
  roomId: string,
  userId: string,
  userName: string
): Promise<{ success: boolean; room: Room; error?: string }> {
  const { db } = await initFirebase();
  const nowIso = new Date().toISOString();

  if (!db) {
    // Modo local / offline
    const localRoom: Room = {
      roomId,
      participantA: userId,
      participantAName: userName,
      createdAt: nowIso,
      lastActivity: nowIso,
    };
    return { success: true, room: localRoom };
  }

  const roomDocRef = doc(db, 'rooms', roomId);

  try {
    const snap = await getDoc(roomDocRef);

    if (!snap.exists()) {
      // Cria sala com participante A
      const newRoom: Room = {
        roomId,
        participantA: userId,
        participantAName: userName,
        participantB: null,
        participantBName: null,
        createdAt: nowIso,
        lastActivity: nowIso,
      };

      await setDoc(roomDocRef, {
        ...newRoom,
        createdAtServer: serverTimestamp(),
        lastActivityServer: serverTimestamp(),
      });

      return { success: true, room: newRoom };
    }

    const data = snap.data() as Room;

    // Se já é um dos participantes (reconexão / reload)
    if (data.participantA === userId || data.participantB === userId) {
      await updateDoc(roomDocRef, {
        lastActivity: nowIso,
        lastActivityServer: serverTimestamp(),
      });
      return { success: true, room: data };
    }

    // Se a vaga B está disponível
    if (!data.participantB || data.participantB === '') {
      const updated: Partial<Room> = {
        participantB: userId,
        participantBName: userName,
        lastActivity: nowIso,
      };

      await updateDoc(roomDocRef, {
        ...updated,
        lastActivityServer: serverTimestamp(),
      });

      return {
        success: true,
        room: {
          ...data,
          participantB: userId,
          participantBName: userName,
          lastActivity: nowIso,
        },
      };
    }

    // Sala já possui 2 participantes
    return {
      success: false,
      room: data,
      error: 'Sala cheia: limite de 2 participantes atingido.',
    };
  } catch (error) {
    // Tolerância offline: se não puder ler da nuvem, permite entrada local
    console.warn('Erro ao conectar na sala do Firestore (offline provável):', error);
    const fallbackRoom: Room = {
      roomId,
      participantA: userId,
      participantAName: userName,
      createdAt: nowIso,
      lastActivity: nowIso,
    };
    return { success: true, room: fallbackRoom };
  }
}

/**
 * Envia mensagem para o Firestore com ID determinístico para idempotência (Camada 09)
 */
export async function sendFirestoreMessage(msg: Message): Promise<void> {
  const { db } = await initFirebase();
  if (!db) return;

  const docRef = doc(db, 'messages', msg.messageId);

  try {
    await setDoc(docRef, {
      ...msg,
      status: 'synced',
      createdAtServer: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `messages/${msg.messageId}`);
  }
}

/**
 * Escuta mensagens de uma sala em tempo real com histórico limitado (Camada 06 e 11)
 */
export function subscribeToMessages(
  roomId: string,
  onNewMessages: (messages: Message[]) => void,
  onError: (err: Error) => void
): Unsubscribe | null {
  if (!firestoreDb) return null;

  const q = query(
    collection(firestoreDb, 'messages'),
    where('room', '==', roomId),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const messages: Message[] = [];
      snapshot.forEach((d) => {
        const data = d.data() as Message;
        messages.push({
          ...data,
          status: 'synced',
        });
      });
      // Inverte para ordem cronológica de exibição
      onNewMessages(messages.reverse());
    },
    (err) => {
      console.warn('Erro no listener de mensagens:', err);
      onError(err);
    }
  );
}

/**
 * Escuta status da sala em tempo real
 */
export function subscribeToRoom(
  roomId: string,
  onRoomUpdate: (room: Room) => void
): Unsubscribe | null {
  if (!firestoreDb) return null;

  const docRef = doc(firestoreDb, 'rooms', roomId);
  return onSnapshot(
    docRef,
    (snap) => {
      if (snap.exists()) {
        onRoomUpdate(snap.data() as Room);
      }
    },
    (err) => {
      console.warn('Erro no listener da sala:', err);
    }
  );
}
