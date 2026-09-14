import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  Auth,
  User,
} from 'firebase/auth';
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
import { AllowedUser, USER_AUTH_CREDENTIALS } from '../config';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

/**
 * Camada 2 — Estado de Autenticação Único
 * Distingue:
 * - uninitialized (não inicializada)
 * - authenticating (em processo de autenticação)
 * - authenticated_non_anonymous (autenticada não anônima)
 * - anonymous (sessão anônima)
 * - failed (autenticação falhada)
 */
export enum AuthState {
  UNINITIALIZED = 'uninitialized',
  AUTHENTICATING = 'authenticating',
  AUTHENTICATED_NON_ANONYMOUS = 'authenticated_non_anonymous',
  ANONYMOUS = 'anonymous',
  FAILED = 'failed',
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

let firebaseApp: FirebaseApp | null = null;
let firestoreDb: Firestore | null = null;
let firebaseAuth: Auth | null = null;
let activeAuthUser: User | null = null;
let currentAuthState: AuthState = AuthState.UNINITIALIZED;
let ongoingAuthPromise: Promise<User | null> | null = null;
let isConfigured = false;

export function getAuthState(): AuthState {
  return currentAuthState;
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const currentUser = getCurrentAuthUser();
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid || null,
      email: currentUser?.email || null,
      emailVerified: currentUser?.emailVerified || null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId || null,
      providerInfo: currentUser?.providerData
        ? currentUser.providerData.map((p) => ({ providerId: p.providerId, email: p.email }))
        : [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function getCurrentAuthUser(): User | null {
  return firebaseAuth?.currentUser || activeAuthUser || null;
}

/**
 * Verifica com rigor se o usuário está autenticado no Firebase Auth e NÃO é anônimo.
 * Utilizado pelos guard checks de envio e outbox.
 */
export function isAuthValidAndNonAnonymous(): boolean {
  const user = getCurrentAuthUser();
  return !!user && user.isAnonymous === false && (
    currentAuthState === AuthState.AUTHENTICATED_NON_ANONYMOUS ||
    (currentAuthState === AuthState.UNINITIALIZED && !user.isAnonymous)
  );
}

export function getFirebaseAuth(): Auth | null {
  return firebaseAuth;
}

/**
 * Aguarda a conclusão de qualquer processo de autenticação em andamento ou restaura sessão.
 * Camada 2.2: Disponibiliza promessa que permite aguardar a conclusão antes de operações Firestore.
 */
export async function waitForAuthCompletion(timeoutMs: number = 3000): Promise<User | null> {
  const user = getCurrentAuthUser();
  if (user && !user.isAnonymous && currentAuthState === AuthState.AUTHENTICATED_NON_ANONYMOUS) {
    return user;
  }

  if (ongoingAuthPromise) {
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), timeoutMs));
    return await Promise.race([ongoingAuthPromise, timeout]);
  }

  return await restoreAuthSession(timeoutMs);
}

/**
 * Restaura a sessão do Firebase Auth utilizando onAuthStateChanged (Camada 1 & 2)
 */
export async function restoreAuthSession(timeoutMs: number = 1500): Promise<User | null> {
  const { configured } = await initFirebase();
  if (!configured || !firebaseAuth) {
    currentAuthState = AuthState.UNINITIALIZED;
    return null;
  }

  if (firebaseAuth.currentUser && !firebaseAuth.currentUser.isAnonymous) {
    activeAuthUser = firebaseAuth.currentUser;
    currentAuthState = AuthState.AUTHENTICATED_NON_ANONYMOUS;
    return activeAuthUser;
  }

  return new Promise<User | null>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const u = firebaseAuth?.currentUser || null;
        if (u && !u.isAnonymous) {
          activeAuthUser = u;
          currentAuthState = AuthState.AUTHENTICATED_NON_ANONYMOUS;
        } else if (u && u.isAnonymous) {
          currentAuthState = AuthState.ANONYMOUS;
        } else {
          currentAuthState = AuthState.UNINITIALIZED;
        }
        resolve(u);
      }
    }, timeoutMs);

    try {
      const unsubscribe = onAuthStateChanged(
        firebaseAuth!,
        (user) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            activeAuthUser = user;
            if (user && !user.isAnonymous) {
              currentAuthState = AuthState.AUTHENTICATED_NON_ANONYMOUS;
            } else if (user && user.isAnonymous) {
              currentAuthState = AuthState.ANONYMOUS;
            } else {
              currentAuthState = AuthState.UNINITIALIZED;
            }
            unsubscribe();
            resolve(user);
          }
        },
        () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            unsubscribe();
            currentAuthState = AuthState.FAILED;
            resolve(null);
          }
        }
      );
    } catch {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        currentAuthState = AuthState.FAILED;
        resolve(null);
      }
    }
  });
}

/**
 * Autenticação silenciosa e não-bloqueante no Firebase Auth mapeada aos PINs de entrada.
 * Executa signInWithEmailAndPassword() utilizando as credenciais pré-provisionadas
 * sem exibir NENHUM elemento de login visual na interface da calculadora (Camadas 1, 2 e 3).
 *
 * Regras estritas:
 * - Não cria contas automaticamente no cliente (1.6)
 * - Não utiliza criação de contas dentro de blocos catch (1.7)
 * - Não exibe erro através de telas de login (1.8)
 */
export async function silentAuthenticateWithEmail(userType: AllowedUser): Promise<User | null> {
  const { configured } = await initFirebase();
  if (!configured || !firebaseAuth) {
    currentAuthState = AuthState.FAILED;
    return null;
  }

  // Purga sessão anônima residual herdada de versões anteriores
  if (firebaseAuth.currentUser && firebaseAuth.currentUser.isAnonymous) {
    try {
      await signOut(firebaseAuth);
    } catch {
      // continua
    }
  }

  const creds = USER_AUTH_CREDENTIALS[userType];
  const current = firebaseAuth.currentUser;
  if (current && !current.isAnonymous && current.email === creds.email) {
    activeAuthUser = current;
    currentAuthState = AuthState.AUTHENTICATED_NON_ANONYMOUS;
    return current;
  }

  currentAuthState = AuthState.AUTHENTICATING;

  const authPromise = (async () => {
    try {
      try {
        await setPersistence(firebaseAuth!, browserLocalPersistence);
      } catch {
        // continua se persistência já ativa
      }

      const result = await signInWithEmailAndPassword(firebaseAuth!, creds.email, creds.pass);
      activeAuthUser = result.user;
      currentAuthState = AuthState.AUTHENTICATED_NON_ANONYMOUS;
      console.info(`Talk2TM [Layer 1]: Autenticação silenciosa ativa para ${userType} (UID: ${result.user.uid}).`);
      return result.user;
    } catch (err: any) {
      currentAuthState = AuthState.FAILED;
      if (err?.code === 'auth/operation-not-allowed') {
        console.error(
          'Talk2TM [Layer 1]: Provedor "E-mail/senha" desativado no Firebase Console. Ative em Authentication > Sign-in method > E-mail/senha.'
        );
      } else {
        console.debug('Talk2TM [Layer 1]: Autenticação remota retornou:', err?.code || err?.message);
      }
      return null;
    } finally {
      ongoingAuthPromise = null;
    }
  })();

  ongoingAuthPromise = authPromise;
  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500));
  return await Promise.race([authPromise, timeoutPromise]);
}

/**
 * Tenta inicializar o Firebase com persistência local avançada (Camadas 06 e 07)
 * Suporta:
 * 1. Variáveis de ambiente Vite (import.meta.env.VITE_FIREBASE_*) para Render, GitHub Pages, Firebase Hosting e produção
 * 2. Fallback Firebase Hosting (/__/firebase/init.json) quando executado em talk2tm.web.app
 * 3. Fallback para /firebase-applet-config.json gerado automaticamente no Google AI Studio
 */
export async function initFirebase(): Promise<{ db: Firestore | null; configured: boolean }> {
  if (firestoreDb) {
    return { db: firestoreDb, configured: isConfigured };
  }

  let config: Record<string, string | undefined> | null = null;

  // 1. Prioridade: Variáveis de ambiente VITE_FIREBASE_* (Render, GitHub Actions, Vercel, .env)
  const metaEnv: Record<string, string | undefined> =
    typeof import.meta !== 'undefined' && import.meta?.env ? (import.meta.env as unknown as Record<string, string | undefined>) : {};
  const procEnv: Record<string, string | undefined> =
    typeof process !== 'undefined' && process?.env ? (process.env as unknown as Record<string, string | undefined>) : {};
  const envProjectId = metaEnv.VITE_FIREBASE_PROJECT_ID || procEnv.VITE_FIREBASE_PROJECT_ID;
  const envApiKey = metaEnv.VITE_FIREBASE_API_KEY || procEnv.VITE_FIREBASE_API_KEY;

  if (envProjectId && envApiKey) {
    const rawAuthDomain = (metaEnv.VITE_FIREBASE_AUTH_DOMAIN || procEnv.VITE_FIREBASE_AUTH_DOMAIN)?.trim();
    const cleanAuthDomain =
      rawAuthDomain && !rawAuthDomain.startsWith('://') && rawAuthDomain !== '://firebaseapp.com' && rawAuthDomain.includes('.')
        ? rawAuthDomain.replace(/^https?:\/\//, '')
        : `${envProjectId}.firebaseapp.com`;

    config = {
      apiKey: envApiKey,
      authDomain: cleanAuthDomain,
      projectId: envProjectId,
      storageBucket: metaEnv.VITE_FIREBASE_STORAGE_BUCKET || procEnv.VITE_FIREBASE_STORAGE_BUCKET || `${envProjectId}.firebasestorage.app`,
      messagingSenderId: metaEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || procEnv.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: metaEnv.VITE_FIREBASE_APP_ID || procEnv.VITE_FIREBASE_APP_ID,
    };
  } else {
    // 2. Fallback Firebase Hosting para domínios *.web.app ou *.firebaseapp.com
    if (typeof window !== 'undefined' && window.location) {
      const host = window.location.hostname;
      if (host.includes('web.app') || host.includes('firebaseapp.com')) {
        try {
          const hostingRes = await fetch('/__/firebase/init.json');
          if (hostingRes.ok) {
            const hostingConfig = await hostingRes.json();
            if (hostingConfig && hostingConfig.projectId) {
              config = hostingConfig;
            }
          }
        } catch {
          // segue para os outros fallbacks
        }
      }
    }

    // 3. Fallback: carregar firebase-applet-config.json se existir no bundle/servidor
    if (!config || !config.projectId) {
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
    }

    // 4. Fallback estático padrão do projeto gen-lang-client-0618196986
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

    try {
      firebaseAuth = getAuth(firebaseApp);
      try {
        await setPersistence(firebaseAuth, browserLocalPersistence);
      } catch (pErr) {
        console.debug('Talk2TM: Persistência local configurada ou padrão:', pErr);
      }
    } catch (authInitErr) {
      console.debug('Talk2TM: Inicialização do Firebase Auth ignorada:', authInitErr);
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
 * Garante que o usuário esteja autenticado no Firebase Auth (restaura sessão persistente)
 */
export async function ensureFirebaseAuth(): Promise<User | null> {
  const { configured } = await initFirebase();
  if (!configured || !firebaseAuth) {
    return null;
  }

  if (firebaseAuth.currentUser && !firebaseAuth.currentUser.isAnonymous) {
    activeAuthUser = firebaseAuth.currentUser;
    return firebaseAuth.currentUser;
  }

  return await restoreAuthSession(1500);
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
  // Garante que o UID real do Firebase Auth seja vinculado sob participantA / participantB
  const currentAuth = getCurrentAuthUser();
  const effectiveUid = currentAuth?.uid || userId;

  const nowIso = new Date().toISOString();
  const fallbackRoom: Room = {
    roomId,
    participantA: effectiveUid,
    participantAName: userName,
    participantB: null,
    participantBName: null,
    createdAt: nowIso,
    lastActivity: nowIso,
  };

  try {
    const initPromise = initFirebase();
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
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
          participantA: effectiveUid,
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

      // 1. Se já é um dos participantes pelo UID exato
      if (data.participantA === effectiveUid || data.participantB === effectiveUid) {
        await updateDoc(roomDocRef, {
          lastActivity: nowIso,
        });
        return { success: true, room: { ...data, lastActivity: nowIso } };
      }

      // 2. Se o participante A tem o mesmo nome (atualiza UID com o UID real autenticado do Firebase Auth)
      if (data.participantAName === userName) {
        await updateDoc(roomDocRef, {
          participantA: effectiveUid,
          lastActivity: nowIso,
        });
        return {
          success: true,
          room: { ...data, participantA: effectiveUid, lastActivity: nowIso },
        };
      }

      // 3. Se o participante B tem o mesmo nome (atualiza UID com o UID real autenticado do Firebase Auth)
      if (data.participantBName === userName) {
        await updateDoc(roomDocRef, {
          participantB: effectiveUid,
          lastActivity: nowIso,
        });
        return {
          success: true,
          room: { ...data, participantB: effectiveUid, lastActivity: nowIso },
        };
      }

      // 4. Se a vaga B está disponível
      if (!data.participantB || data.participantB === '') {
        const updated = {
          participantB: effectiveUid,
          participantBName: userName,
          lastActivity: nowIso,
        };

        await updateDoc(roomDocRef, updated);

        return {
          success: true,
          room: {
            ...data,
            participantB: effectiveUid,
            participantBName: userName,
            lastActivity: nowIso,
          },
        };
      }

      // Sala já possui 2 participantes distintos
      return {
        success: false,
        room: data,
        error: 'Sala cheia: limite de 2 participantes atingido.',
      };
    };

    const result = await Promise.race([
      fetchSnap(),
      new Promise<{ success: boolean; room: Room }>((resolve) =>
        setTimeout(() => resolve({ success: true, room: fallbackRoom }), 5000)
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
 * Envia mensagem para o Firestore com ID determinístico para idempotência (Camada 09).
 * Layer 2: Procede APENAS com usuário autenticado e não-anônimo.
 */
export async function sendFirestoreMessage(msg: Message): Promise<void> {
  const { db } = await initFirebase();
  if (!db) return;

  // Layer 2: Explicit guard check — proceed ONLY if auth.currentUser != null and auth.currentUser.isAnonymous === false.
  if (!isAuthValidAndNonAnonymous()) {
    console.warn('Talk2TM [Layer 2 Guard]: Escrita rejeitada em sendFirestoreMessage — usuário não autenticado ou anônimo.');
    throw new Error('Operação cancelada: requer autenticação não-anônima ativa.');
  }

  const authUser = firebaseAuth?.currentUser;
  const effectiveSenderId = authUser ? authUser.uid : msg.senderId;

  const docRef = doc(db, 'messages', msg.messageId);
  const payload: Message = {
    messageId: msg.messageId,
    room: msg.room,
    sender: msg.sender,
    senderId: effectiveSenderId,
    text: msg.text,
    clientId: msg.clientId,
    createdAt: msg.createdAt || new Date().toISOString(),
    status: 'synced',
  };

  try {
    await setDoc(docRef, payload);
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
  if (!firestoreDb || !isAuthValidAndNonAnonymous()) {
    console.debug('Talk2TM [Guard]: subscribeToMessages retido — autenticação necessária.');
    return null;
  }

  let activeUnsubscribe: Unsubscribe | null = null;

  const startListening = (withOrderBy: boolean) => {
    try {
      const q = withOrderBy
        ? query(
            collection(firestoreDb!, 'messages'),
            where('room', '==', roomId),
            orderBy('createdAt', 'desc'),
            limit(50)
          )
        : query(
            collection(firestoreDb!, 'messages'),
            where('room', '==', roomId),
            limit(100)
          );

      activeUnsubscribe = onSnapshot(
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
          // Garante ordem cronológica estável cliente-side
          messages.sort((a, b) => (a.createdAt > b.createdAt ? 1 : a.createdAt < b.createdAt ? -1 : 0));
          onNewMessages(messages);
        },
        (err) => {
          if (withOrderBy) {
            console.warn('Talk2TM: Query com índice composto pendente. Ativando listener resiliente...', err);
            startListening(false);
          } else {
            console.warn('Erro no listener de mensagens:', err);
            onError(err);
          }
        }
      );
    } catch (e) {
      if (withOrderBy) {
        startListening(false);
      } else {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  };

  startListening(true);

  return () => {
    if (activeUnsubscribe) {
      activeUnsubscribe();
    }
  };
}

/**
 * Escuta status da sala em tempo real
 */
export function subscribeToRoom(
  roomId: string,
  onRoomUpdate: (room: Room) => void
): Unsubscribe | null {
  if (!firestoreDb || !isAuthValidAndNonAnonymous()) {
    console.debug('Talk2TM [Guard]: subscribeToRoom retido — autenticação necessária.');
    return null;
  }

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

/**
 * Atualiza a data da última leitura de um participante no Firestore
 */
export async function updateFirestoreLastRead(
  roomId: string,
  userId: string,
  userName: string,
  readAtIso: string
): Promise<void> {
  const { db, configured } = await initFirebase();
  if (!configured || !db) return;
  if (!isAuthValidAndNonAnonymous()) return;

  try {
    const roomDocRef = doc(db, 'rooms', roomId);
    await updateDoc(roomDocRef, {
      [`lastRead.${userName}`]: readAtIso,
      [`lastRead.${userId}`]: readAtIso,
      lastActivity: readAtIso,
    });
  } catch (error) {
    console.debug('Talk2TM: Falha silenciosa ao sincronizar lastRead no Firestore:', error);
  }
}

/**
 * Retorna a data ISO da última leitura do parceiro na sala
 */
export function getPartnerLastRead(
  room: Room | null,
  currentUserName: string,
  currentUserId?: string
): string | null {
  if (!room) return null;
  const partnerName = currentUserName === 'Truman' ? 'Mãezinha' : 'Truman';
  const partnerId = room.participantAName === partnerName ? room.participantA : room.participantB;

  if (room.lastRead) {
    if (room.lastRead[partnerName]) return room.lastRead[partnerName];
    if (partnerId && room.lastRead[partnerId]) return room.lastRead[partnerId];
  }
  if (room.participantAName === partnerName && room.lastReadA) return room.lastReadA;
  if (room.participantBName === partnerName && room.lastReadB) return room.lastReadB;
  return null;
}
