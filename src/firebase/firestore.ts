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
 * Suporta:
 * 1. Variáveis de ambiente Vite (import.meta.env.VITE_FIREBASE_*) para Render, GitHub Pages, Firebase Hosting e produção
 * 2. Fallback para /firebase-applet-config.json gerado automaticamente no Google AI Studio
 */
export async function initFirebase(): Promise<{ db: Firestore | null; configured: boolean }> {
  if (firestoreDb) {
    return { db: firestoreDb, configured: isConfigured };
  }

  let config: Record<string, string | undefined> | null = null;

  // 1. Prioridade: Variáveis de ambiente VITE_FIREBASE_* (Render, GitHub Actions, Vercel, .env)
  if (import.meta.env.VITE_FIREBASE_PROJECT_ID && import.meta.env.VITE_FIREBASE_API_KEY) {
    const rawAuthDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
    const cleanAuthDomain =
      rawAuthDomain && !rawAuthDomain.startsWith('://') && rawAuthDomain !== '://firebaseapp.com' && rawAuthDomain.includes('.')
        ? rawAuthDomain.replace(/^https?:\/\//, '')
        : `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`;

    config = {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: cleanAuthDomain,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebasestorage.app`,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    };
  } else {
    // 2. Fallback: carregar firebase-applet-config.json se existir no bundle/servidor
    try {
      const response = await fetch('/firebase-applet-config.json');
      if (response.ok) {
        const fetched = await response.json();
        if (fetched && fetched.projectId) {
          config = fetched;
        }
      }
    } catch {
      // Ignora erro se a requisição falhar
    }

    // 3. Fallback estático padrão do projeto gen-lang-client-0618196986
    if (!config || !config.projectId) {
      config = {
        apiKey: 'AIzaSyCfwTvVhyrRZHk4zzzRweShyVdMnimnzm0',
        authDomain: 'gen-lang-client-0618196986.firebaseapp.com',
        projectId: 'gen-lang-client-0618196986',
        storageBucket: 'gen-lang-client-0618196986.firebasestorage.app',
        messagingSenderId: '511328922010',
        appId: '1:511328922010:web:58c5982b1ab704d93f3223',
      };
    }
  }

  if (!config || !config.projectId) {
    console.warn('Talk2TM: Rodando com mecanismo local offline (sem credenciais remotas do Firebase).');
    return { db: null, configured: false };
  }

  try {
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
    console.warn('Talk2TM: Inicialização remota falhou. Modo offline local ativo.', err);
    return { db: null, configured: false };
  }
}

/**
 * Entra ou cria uma sala garantindo a regra de no máximo 2 participantes (Camadas 12 e 13)
 * Com timeout estrito de 2 segundos para nunca travar a interface do usuário em redes lentas ou offline.
 */
export async function joinFirestoreRoom(
  roomId: string,
  userId: string,
  userName: string
): Promise<{ success: boolean; room: Room; error?: string }> {
  const nowIso = new Date().toISOString();
  const fallbackRoom: Room = {
    roomId,
    participantA: userId,
    participantAName: userName,
    participantB: null,
    participantBName: null,
    createdAt: nowIso,
    lastActivity: nowIso,
  };

  try {
    const initPromise = initFirebase();
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
    const initRes = await Promise.race([initPromise, timeoutPromise]);

    if (!initRes || !initRes.db) {
      // Modo local / offline imediato
      return { success: true, room: fallbackRoom };
    }

    const db = initRes.db;
    const roomDocRef = doc(db, 'rooms', roomId);

    const fetchSnap = async () => {
      const snap = await getDoc(roomDocRef);

      if (!snap.exists()) {
        const newRoom: Room = {
          roomId,
          participantA: userId,
          participantAName: userName,
          participantB: null,
          participantBName: null,
          createdAt: nowIso,
          lastActivity: nowIso,
        };

        await setDoc(roomDocRef, newRoom);
        return { success: true, room: newRoom };
      }

      const data = snap.data() as Room;

      // Se já é um dos participantes (reconexão / reload)
      if (data.participantA === userId || data.participantB === userId) {
        await updateDoc(roomDocRef, {
          lastActivity: nowIso,
        });
        return { success: true, room: data };
      }

      // Se a vaga B está disponível
      if (!data.participantB || data.participantB === '') {
        const updated = {
          participantB: userId,
          participantBName: userName,
          lastActivity: nowIso,
        };

        await updateDoc(roomDocRef, updated);

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
    };

    const result = await Promise.race([
      fetchSnap(),
      new Promise<{ success: boolean; room: Room }>((resolve) =>
        setTimeout(() => resolve({ success: true, room: fallbackRoom }), 2000)
      ),
    ]);

    return result;
  } catch (error) {
    // Tolerância offline total: se falhar conexão remota, opera localmente
    console.warn('Talk2TM: Firestore não acessível no momento. Operando com armazenamento local.', error);
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
