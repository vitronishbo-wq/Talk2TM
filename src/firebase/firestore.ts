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
  getDocFromServer,
  getDocs,
  getDocsFromServer,
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
  arrayUnion,
  writeBatch,
} from 'firebase/firestore';
import { Conversation, ConversationInvite, ConversationMessage, Message, PhoneDirectoryEntry, Room, UserProfile } from '../types';
import { AllowedUser, USER_AUTH_CREDENTIALS } from '../config';
import { maxIsoDate, selectLatestMessages } from '../utils/unread';
import { hashPhoneNumber, normalizePhoneNumber } from '../utils/phone';

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

export function syncAuthState(user: User | null): void {
  activeAuthUser = user;
  if (user && !user.isAnonymous) {
    currentAuthState = AuthState.AUTHENTICATED_NON_ANONYMOUS;
  } else if (user && user.isAnonymous) {
    currentAuthState = AuthState.ANONYMOUS;
  } else {
    currentAuthState = AuthState.UNINITIALIZED;
  }
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
    currentAuthState === AuthState.UNINITIALIZED ||
    currentAuthState === AuthState.FAILED
  );
}

export function getFirebaseAuth(): Auth | null {
  return firebaseAuth;
}

export function getFirebaseDB(): Firestore | null {
  return firestoreDb;
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

      let result;
      try {
        // Tenta autenticar primeiro com a senha de 6 dígitos correspondente ao PIN cadastrado no console
        result = await signInWithEmailAndPassword(firebaseAuth!, creds.email, creds.pinPass);
      } catch (pinErr: any) {
        if (
          pinErr?.code === 'auth/invalid-credential' ||
          pinErr?.code === 'auth/wrong-password' ||
          String(pinErr?.message || '').includes('INVALID_LOGIN_CREDENTIALS') ||
          String(pinErr).includes('INVALID_LOGIN_CREDENTIALS')
        ) {
          console.debug(`Talk2TM [Auth]: Tentando senha secundária de contingência para ${creds.email}...`);
          result = await signInWithEmailAndPassword(firebaseAuth!, creds.email, creds.pass);
        } else {
          throw pinErr;
        }
      }
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
      onAuthStateChanged(firebaseAuth, (user) => {
        if (currentAuthState !== AuthState.AUTHENTICATING || (user && !user.isAnonymous)) {
          syncAuthState(user);
        }
      });
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
            limit(80)
          )
        : query(
            collection(firestoreDb!, 'messages'),
            where('room', '==', roomId)
          );

      activeUnsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const currentUid = getCurrentAuthUser()?.uid;
          const messages: Message[] = [];
          snapshot.forEach((d) => {
            const data = d.data() as Message;
            // Se a mensagem foi marcada como apagada para este usuário na nuvem, ignora
            if (currentUid && data.deletedFor && Array.isArray(data.deletedFor) && data.deletedFor.includes(currentUid)) {
              return;
            }
            messages.push({
              ...data,
              messageId: data.messageId || d.id,
              status: 'synced',
            });
          });
          // Seleciona as mais recentes e ordena cronologicamente (nunca descarta recentes no fallback)
          onNewMessages(selectLatestMessages(messages, 80));
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

  let partnerName = currentUserName === 'Truman' ? 'Mãezinha' : 'Truman';
  if (room.participantAName && room.participantBName) {
    if (room.participantAName === currentUserName || (currentUserId && room.participantA === currentUserId)) {
      partnerName = room.participantBName;
    } else if (room.participantBName === currentUserName || (currentUserId && room.participantB === currentUserId)) {
      partnerName = room.participantAName;
    }
  }

  let partnerId: string | null = null;
  if (currentUserId) {
    if (room.participantA === currentUserId) {
      partnerId = room.participantB || null;
    } else if (room.participantB === currentUserId) {
      partnerId = room.participantA || null;
    }
  }
  if (!partnerId) {
    if (room.participantAName === partnerName) {
      partnerId = room.participantA;
    } else if (room.participantBName === partnerName) {
      partnerId = room.participantB || null;
    }
  }

  const candidates: Array<string | null | undefined> = [];
  if (room.lastRead) {
    if (partnerName && room.lastRead[partnerName]) {
      candidates.push(room.lastRead[partnerName]);
    }
    if (partnerId && room.lastRead[partnerId]) {
      candidates.push(room.lastRead[partnerId]);
    }
  }
  if (
    (partnerId && room.participantA === partnerId) ||
    (partnerName && room.participantAName === partnerName)
  ) {
    candidates.push(room.lastReadA);
  }
  if (
    (partnerId && room.participantB === partnerId) ||
    (partnerName && room.participantBName === partnerName)
  ) {
    candidates.push(room.lastReadB);
  }

  return maxIsoDate(...candidates);
}

/**
 * Envia mensagem para o canal da conversa bilateral (conversations/{conversationId}/messages/{messageId}).
 * Respeita a regra de segurança isConversationParticipant e senderId == request.auth.uid.
 */
export async function sendFirestoreConversationMessage(msg: Message | ConversationMessage): Promise<void> {
  const { db } = await initFirebase();
  if (!db) return;

  if (!isAuthValidAndNonAnonymous()) {
    console.warn('Talk2TM [Guard]: Escrita rejeitada em sendFirestoreConversationMessage — usuário não autenticado ou anônimo.');
    throw new Error('Operação cancelada: requer autenticação não-anônima ativa.');
  }

  const authUser = firebaseAuth?.currentUser;
  const effectiveSenderId = authUser ? authUser.uid : msg.senderId;
  const conversationId = ('conversationId' in msg && msg.conversationId) ? msg.conversationId : ('room' in msg ? msg.room : '');

  if (!conversationId) {
    throw new Error('conversationId obrigatório para enviar mensagem de conversa.');
  }

  const docRef = doc(db, 'conversations', conversationId, 'messages', msg.messageId);
  const nowIso = msg.createdAt || new Date().toISOString();

  const payload: ConversationMessage = {
    messageId: msg.messageId,
    conversationId,
    senderId: effectiveSenderId,
    senderTalk2tmId: ('senderTalk2tmId' in msg && msg.senderTalk2tmId) ? msg.senderTalk2tmId : ('sender' in msg ? msg.sender : ''),
    text: msg.text,
    clientId: msg.clientId,
    createdAt: nowIso,
    status: 'synced',
  };

  try {
    await setDoc(docRef, payload);
    // Atualiza updatedAt na conversa em segundo plano
    try {
      const convDocRef = doc(db, 'conversations', conversationId);
      await updateDoc(convDocRef, {
        updatedAt: nowIso,
      });
    } catch {
      // Ignora erro não-bloqueante na atualização do pai
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `conversations/${conversationId}/messages/${msg.messageId}`);
  }
}

/**
 * Escuta mensagens de uma conversa em tempo real
 */
export function subscribeToConversationMessages(
  conversationId: string,
  onNewMessages: (messages: Message[]) => void,
  onError: (err: Error) => void
): Unsubscribe | null {
  if (!firestoreDb || !isAuthValidAndNonAnonymous()) {
    console.debug('Talk2TM [Guard]: subscribeToConversationMessages retido — autenticação necessária.');
    return null;
  }

  let activeUnsubscribe: Unsubscribe | null = null;

  const startListening = (withOrderBy: boolean) => {
    try {
      const messagesCollection = collection(firestoreDb!, 'conversations', conversationId, 'messages');
      const q = withOrderBy
        ? query(messagesCollection, orderBy('createdAt', 'desc'), limit(80))
        : query(messagesCollection);

      activeUnsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const currentUid = getCurrentAuthUser()?.uid;
          const messages: Message[] = [];
          snapshot.forEach((d) => {
            const data = d.data() as any;
            // Se a mensagem foi marcada como apagada para este usuário na nuvem, ignora
            if (currentUid && data.deletedFor && Array.isArray(data.deletedFor) && data.deletedFor.includes(currentUid)) {
              return;
            }
            messages.push({
              messageId: data.messageId || d.id,
              room: conversationId,
              conversationId: conversationId,
              sender: data.senderTalk2tmId || data.sender || '',
              senderTalk2tmId: data.senderTalk2tmId || '',
              senderId: data.senderId,
              text: data.text,
              clientId: data.clientId,
              createdAt: data.createdAt,
              status: 'synced',
              deletedFor: data.deletedFor || [],
            });
          });
          // Seleciona as mais recentes e ordena cronologicamente (nunca descarta recentes no fallback)
          onNewMessages(selectLatestMessages(messages, 80));
        },
        (err) => {
          if (withOrderBy) {
            console.warn('Talk2TM: Listener de conversa com orderBy pendente. Ativando listener resiliente...', err);
            startListening(false);
          } else {
            console.warn('Erro no listener de mensagens da conversa:', err);
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
 * Escuta atualizações do documento da conversa em tempo real
 */
export function subscribeToConversation(
  conversationId: string,
  onConversationUpdate: (conv: Conversation) => void
): Unsubscribe | null {
  if (!firestoreDb || !isAuthValidAndNonAnonymous()) {
    console.debug('Talk2TM [Guard]: subscribeToConversation retido — autenticação necessária.');
    return null;
  }

  const docRef = doc(firestoreDb, 'conversations', conversationId);
  return onSnapshot(
    docRef,
    (snap) => {
      if (snap.exists()) {
        onConversationUpdate(snap.data() as Conversation);
      }
    },
    (err) => {
      console.warn('Erro no listener da conversa:', err);
    }
  );
}

/**
 * Atualiza carimbo de leitura de conversa bilateral
 */
export async function updateConversationLastRead(
  conversationId: string,
  userId: string,
  _userName: string,
  readAtIso: string
): Promise<void> {
  const { db, configured } = await initFirebase();
  if (!configured || !db) return;
  if (!isAuthValidAndNonAnonymous()) return;

  try {
    const convDocRef = doc(db, 'conversations', conversationId);
    const snap = await getDoc(convDocRef);
    if (!snap.exists()) return;
    const conv = snap.data() as Conversation;

    const updates: Record<string, any> = {
      updatedAt: readAtIso,
    };
    if (conv.participantA === userId) {
      updates.lastReadA = readAtIso;
    } else if (conv.participantB === userId) {
      updates.lastReadB = readAtIso;
    }

    await updateDoc(convDocRef, updates);
  } catch (error) {
    console.debug('Talk2TM: Falha silenciosa ao sincronizar lastRead na conversa:', error);
  }
}

/**
 * Obtém ou cria uma conversa bilateral entre dois participantes
 */
export async function getOrCreateConversation(
  userA: { uid: string; talk2tmId: string; displayName: string },
  userB: { uid: string; talk2tmId: string; displayName: string }
): Promise<Conversation> {
  if (!userA.uid || !userB.uid || userA.uid === userB.uid) {
    throw new Error('Conversa bilateral exige dois participantes distintos.');
  }

  const { db } = await initFirebase();
  const sortedUids = [userA.uid, userB.uid].sort();
  const conversationId = `conv_${sortedUids[0]}_${sortedUids[1]}`;

  const isAFirst = userA.uid === sortedUids[0];
  const pA = isAFirst ? userA : userB;
  const pB = isAFirst ? userB : userA;

  const now = new Date().toISOString();

  if (db && isAuthValidAndNonAnonymous()) {
    try {
      const convRef = doc(db, 'conversations', conversationId);
      const snap = await getDoc(convRef);
      if (snap.exists()) {
        return snap.data() as Conversation;
      }
      const newConv: Conversation = {
        conversationId,
        participantA: pA.uid,
        participantB: pB.uid,
        talk2tmIdA: pA.talk2tmId,
        talk2tmIdB: pB.talk2tmId,
        displayNameA: pA.displayName,
        displayNameB: pB.displayName,
        createdAt: now,
        updatedAt: now,
      };
      await setDoc(convRef, newConv);
      return newConv;
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `conversations/${conversationId}`);
    }
  }

  // Fallback offline
  return {
    conversationId,
    participantA: pA.uid,
    participantB: pB.uid,
    talk2tmIdA: pA.talk2tmId,
    talk2tmIdB: pB.talk2tmId,
    displayNameA: pA.displayName,
    displayNameB: pB.displayName,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Obtém uma conversa bilateral pelo ID caso o utilizador seja participante.
 */
export async function getConversationById(conversationId: string): Promise<Conversation | null> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) return null;
  try {
    const snap = await getDoc(doc(db, 'conversations', conversationId));
    return snap.exists() ? (snap.data() as Conversation) : null;
  } catch {
    return null;
  }
}

/**
 * Consulta um perfil público interno pelo Talk2TM ID.
 */
export async function fetchUserProfileByTalk2tmId(talk2tmId: string): Promise<UserProfile | null> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) return null;
  try {
    const snap = await getDoc(doc(db, 'userProfiles', talk2tmId.trim().toUpperCase()));
    return snap.exists() ? (snap.data() as UserProfile) : null;
  } catch {
    return null;
  }
}

async function sendInviteToTargetProfile(
  db: Firestore,
  fromUser: { uid: string; talk2tmId: string; displayName: string },
  targetProfile: UserProfile
): Promise<{ status: 'invited' | 'already_connected'; invite?: ConversationInvite; conversation?: Conversation }> {
  if (targetProfile.uid === fromUser.uid) {
    throw new Error('Não é possível convidar a própria conta.');
  }

  const sortedUids = [fromUser.uid, targetProfile.uid].sort();
  const conversationId = `conv_${sortedUids[0]}_${sortedUids[1]}`;

  // Se já existe conversa bilateral entre A e B, reutiliza diretamente
  try {
    const existingConv = await getDoc(doc(db, 'conversations', conversationId));
    if (existingConv.exists()) {
      return {
        status: 'already_connected',
        conversation: existingConv.data() as Conversation,
      };
    }
  } catch {
    // Segue para envio do convite se ainda não existir
  }

  const now = new Date().toISOString();
  const inviteId = conversationId;
  const inviteRef = doc(db, 'conversationInvites', inviteId);

  try {
    const existingInviteSnap = await getDoc(inviteRef);
    if (existingInviteSnap.exists()) {
      const existingInvite = existingInviteSnap.data() as ConversationInvite;
      if (existingInvite.status === 'pending') {
        if (existingInvite.fromUid === fromUser.uid) {
          return { status: 'invited', invite: existingInvite };
        }
        // A outra conta já enviou convite pendente para nós: aceita e abre a conversa bilateral!
        const acceptedConv = await acceptConversationInvite(existingInvite, fromUser);
        return { status: 'already_connected', conversation: acceptedConv };
      }
      if (existingInvite.status === 'accepted') {
        const conv = await getOrCreateConversation(
          {
            uid: targetProfile.uid,
            talk2tmId: targetProfile.talk2tmId,
            displayName: targetProfile.displayName,
          },
          fromUser
        );
        return { status: 'already_connected', conversation: conv };
      }
      // Se estava recusado ou cancelado, reabre como novo convite pendente
      await updateDoc(inviteRef, {
        fromUid: fromUser.uid,
        fromDisplayName: fromUser.displayName.slice(0, 30),
        fromTalk2tmId: fromUser.talk2tmId,
        toTalk2tmId: targetProfile.talk2tmId,
        toUid: targetProfile.uid,
        status: 'pending',
        updatedAt: now,
      });
      return {
        status: 'invited',
        invite: {
          ...existingInvite,
          fromUid: fromUser.uid,
          fromDisplayName: fromUser.displayName.slice(0, 30),
          fromTalk2tmId: fromUser.talk2tmId,
          toTalk2tmId: targetProfile.talk2tmId,
          toUid: targetProfile.uid,
          status: 'pending',
          updatedAt: now,
        },
      };
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `conversationInvites/${inviteId}`);
  }

  const invite: ConversationInvite = {
    inviteId,
    fromUid: fromUser.uid,
    fromDisplayName: fromUser.displayName.slice(0, 30),
    fromTalk2tmId: fromUser.talk2tmId,
    toTalk2tmId: targetProfile.talk2tmId,
    toUid: targetProfile.uid,
    conversationId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  try {
    await setDoc(inviteRef, invite);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `conversationInvites/${inviteId}`);
  }

  return { status: 'invited', invite };
}

/**
 * Descoberta e Convite por Número de Telefone exato (via hash SHA-256 em phoneLookup).
 * Não expõe números brutos nem permite enumeração de utilizadores.
 */
export async function sendConversationInviteByPhone(
  fromUser: { uid: string; talk2tmId: string; displayName: string },
  rawTargetPhone: string
): Promise<{
  status: 'invited' | 'already_connected';
  invite?: ConversationInvite;
  conversation?: Conversation;
  targetDisplayName: string;
}> {
  const phoneCheck = normalizePhoneNumber(rawTargetPhone);
  if (!phoneCheck.valid || !phoneCheck.e164) {
    throw new Error(phoneCheck.error || 'Número de telefone inválido.');
  }

  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) {
    throw new Error('Sessão autenticada necessária para procurar contactos e enviar convite.');
  }

  const phoneHash = await hashPhoneNumber(phoneCheck.e164);
  let directoryEntry: PhoneDirectoryEntry | null = null;
  try {
    const lookupSnap = await getDoc(doc(db, 'phoneLookup', phoneHash));
    if (lookupSnap.exists()) {
      directoryEntry = lookupSnap.data() as PhoneDirectoryEntry;
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `phoneLookup/${phoneHash}`);
  }

  if (!directoryEntry || directoryEntry.active === false) {
    throw new Error('Nenhum utilizador encontrado com este número.');
  }
  if (directoryEntry.uid === fromUser.uid) {
    throw new Error('Não é possível enviar convite para o seu próprio número.');
  }

  // Confirma perfil ativo em userProfiles (mantém consistência de regras)
  let targetProfile: UserProfile | null = null;
  try {
    const profileSnap = await getDoc(doc(db, 'userProfiles', directoryEntry.talk2tmId));
    if (profileSnap.exists()) {
      targetProfile = profileSnap.data() as UserProfile;
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `userProfiles/${directoryEntry.talk2tmId}`);
  }

  if (!targetProfile || targetProfile.active === false) {
    throw new Error('Contacto indisponível no momento.');
  }

  const res = await sendInviteToTargetProfile(db, fromUser, targetProfile);
  return {
    ...res,
    targetDisplayName: targetProfile.displayName,
  };
}

/**
 * Fluxo Bilateral: Conta A procura Talk2TM ID da Conta B e envia convite direcionado (toUid obrigatório).
 */
export async function sendConversationInvite(
  fromUser: { uid: string; talk2tmId: string; displayName: string },
  targetTalk2tmId: string
): Promise<{ status: 'invited' | 'already_connected'; invite?: ConversationInvite; conversation?: Conversation }> {
  const cleanTargetId = targetTalk2tmId.trim().toUpperCase();
  if (!/^TM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleanTargetId)) {
    throw new Error('Código inválido. Use o formato TM-XXXX-XXXX.');
  }
  if (cleanTargetId === fromUser.talk2tmId) {
    throw new Error('Não é possível enviar convite para o próprio código.');
  }

  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) {
    throw new Error('Sessão autenticada necessária para enviar convite.');
  }

  let targetProfile: UserProfile | null = null;
  try {
    const profileSnap = await getDoc(doc(db, 'userProfiles', cleanTargetId));
    if (profileSnap.exists()) {
      targetProfile = profileSnap.data() as UserProfile;
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `userProfiles/${cleanTargetId}`);
  }

  if (!targetProfile || targetProfile.active === false) {
    throw new Error('Código Talk2TM não encontrado.');
  }

  return await sendInviteToTargetProfile(db, fromUser, targetProfile);
}

/**
 * Conta B aceita convite pendente e cria a conversa bilateral (participantA + participantB).
 */
export async function acceptConversationInvite(
  invite: ConversationInvite,
  currentUser: { uid: string; talk2tmId: string; displayName: string }
): Promise<Conversation> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) {
    throw new Error('Autenticação ativa necessária para aceitar o convite.');
  }

  const now = new Date().toISOString();
  try {
    await updateDoc(doc(db, 'conversationInvites', invite.inviteId), {
      status: 'accepted',
      updatedAt: now,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `conversationInvites/${invite.inviteId}`);
  }

  return await getOrCreateConversation(
    {
      uid: invite.fromUid,
      talk2tmId: invite.fromTalk2tmId,
      displayName: invite.fromDisplayName,
    },
    currentUser
  );
}

/**
 * Conta B recusa um convite pendente.
 */
export async function declineConversationInvite(inviteId: string): Promise<void> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) return;
  try {
    await updateDoc(doc(db, 'conversationInvites', inviteId), {
      status: 'declined',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `conversationInvites/${inviteId}`);
  }
}

/**
 * Conta A cancela um convite pendente enviado.
 */
export async function cancelConversationInvite(inviteId: string): Promise<void> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) return;
  try {
    await updateDoc(doc(db, 'conversationInvites', inviteId), {
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `conversationInvites/${inviteId}`);
  }
}

/**
 * Escuta convites pendentes recebidos por Conta B.
 */
export function subscribeToIncomingInvites(
  myUid: string,
  onUpdate: (invites: ConversationInvite[]) => void
): Unsubscribe | null {
  if (!firestoreDb || !isAuthValidAndNonAnonymous() || !myUid) return null;
  const q = query(collection(firestoreDb, 'conversationInvites'), where('toUid', '==', myUid));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: ConversationInvite[] = [];
      snapshot.forEach((d) => {
        const inv = d.data() as ConversationInvite;
        if (inv.status === 'pending') {
          list.push(inv);
        }
      });
      list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      onUpdate(list);
    },
    (err) => {
      console.warn('Erro ao ouvir convites recebidos:', err);
    }
  );
}

/**
 * Escuta convites enviados por Conta A (pendentes ou recém-aceitos).
 */
export function subscribeToOutgoingInvites(
  myUid: string,
  onUpdate: (invites: ConversationInvite[]) => void
): Unsubscribe | null {
  if (!firestoreDb || !isAuthValidAndNonAnonymous() || !myUid) return null;
  const q = query(collection(firestoreDb, 'conversationInvites'), where('fromUid', '==', myUid));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: ConversationInvite[] = [];
      snapshot.forEach((d) => {
        const inv = d.data() as ConversationInvite;
        if (inv.status === 'pending' || inv.status === 'accepted') {
          list.push(inv);
        }
      });
      list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      onUpdate(list);
    },
    (err) => {
      console.warn('Erro ao ouvir convites enviados:', err);
    }
  );
}

/**
 * Escuta todas as conversas bilaterais em que o utilizador é participantA ou participantB.
 */
export function subscribeToUserConversations(
  myUid: string,
  onUpdate: (conversations: Conversation[], meta?: { fromCache: boolean }) => void
): Unsubscribe | null {
  if (!firestoreDb || !isAuthValidAndNonAnonymous() || !myUid) return null;

  const convMapA = new Map<string, Conversation>();
  const convMapB = new Map<string, Conversation>();
  let fromCacheA = true;
  let fromCacheB = true;

  const emitMerged = () => {
    const merged = new Map<string, Conversation>();
    convMapA.forEach((v, k) => merged.set(k, v));
    convMapB.forEach((v, k) => merged.set(k, v));
    const list = Array.from(merged.values()).sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
    onUpdate(list, { fromCache: fromCacheA && fromCacheB });
  };

  const unsubA = onSnapshot(
    query(collection(firestoreDb, 'conversations'), where('participantA', '==', myUid)),
    (snap) => {
      fromCacheA = snap.metadata.fromCache;
      convMapA.clear();
      snap.forEach((d) => {
        const c = d.data() as Conversation;
        convMapA.set(c.conversationId || d.id, c);
      });
      emitMerged();
    },
    (err) => console.warn('Erro ao ouvir conversas (A):', err)
  );

  const unsubB = onSnapshot(
    query(collection(firestoreDb, 'conversations'), where('participantB', '==', myUid)),
    (snap) => {
      fromCacheB = snap.metadata.fromCache;
      convMapB.clear();
      snap.forEach((d) => {
        const c = d.data() as Conversation;
        convMapB.set(c.conversationId || d.id, c);
      });
      emitMerged();
    },
    (err) => console.warn('Erro ao ouvir conversas (B):', err)
  );

  return () => {
    unsubA();
    unsubB();
  };
}

/**
 * Marca mensagens como deletadas na nuvem para o usuário especificado (deletedFor: [uid]).
 * Isso impede que as mensagens voltem a aparecer quando a mesma conta for aberta em outros aparelhos,
 * mantendo o histórico visível apenas para o outro participante da conversa.
 */
export async function markFirestoreMessagesDeletedForUser(
  channelId: string,
  messageIds: string[],
  userId: string,
  isConversation: boolean = false
): Promise<void> {
  if (!firestoreDb || messageIds.length === 0 || !userId) return;

  try {
    const batch = writeBatch(firestoreDb);
    for (const msgId of messageIds) {
      const docRef = isConversation
        ? doc(firestoreDb, 'conversations', channelId, 'messages', msgId)
        : doc(firestoreDb, 'messages', msgId);

      batch.update(docRef, {
        deletedFor: arrayUnion(userId),
      });
    }
    await batch.commit();
    console.info(`Talk2TM [Sync]: ${messageIds.length} mensagens marcadas como excluídas no Firestore para ${userId}`);
  } catch (err) {
    console.warn('Erro ao marcar mensagens como excluídas no Firestore:', err);
  }
}

/**
 * Busca diretamente no servidor Firestore as mensagens mais recentes de uma sala ou conversa.
 * Essencial após retorno do PWA do repouso (visibilitychange / focus / online) para garantir
 * recuperação imediata mesmo quando o WebSocket em segundo plano foi suspenso pelo sistema operacional.
 */
export async function fetchLatestMessagesFromServer(
  channelId: string,
  isConversation: boolean = false,
  myUid?: string
): Promise<Message[]> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) {
    return [];
  }

  const effectiveUid = myUid || getCurrentAuthUser()?.uid || '';

  const mapSnapshot = (snapshot: { forEach: (cb: (d: { id: string; data: () => any }) => void) => void }): Message[] => {
    const messages: Message[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      if (effectiveUid && data.deletedFor && Array.isArray(data.deletedFor) && data.deletedFor.includes(effectiveUid)) {
        return;
      }
      if (isConversation) {
        messages.push({
          messageId: data.messageId || d.id,
          room: channelId,
          conversationId: channelId,
          sender: data.senderTalk2tmId || data.sender || '',
          senderTalk2tmId: data.senderTalk2tmId || '',
          senderId: data.senderId,
          text: data.text,
          clientId: data.clientId,
          createdAt: data.createdAt,
          status: 'synced',
          deletedFor: data.deletedFor || [],
        });
      } else {
        messages.push({
          ...data,
          messageId: data.messageId || d.id,
          status: 'synced',
        } as Message);
      }
    });
    return selectLatestMessages(messages, 80);
  };

  const orderedQuery = isConversation
    ? query(collection(db, 'conversations', channelId, 'messages'), orderBy('createdAt', 'desc'), limit(80))
    : query(collection(db, 'messages'), where('room', '==', channelId), orderBy('createdAt', 'desc'), limit(80));

  const unorderedQuery = isConversation
    ? query(collection(db, 'conversations', channelId, 'messages'))
    : query(collection(db, 'messages'), where('room', '==', channelId));

  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('firestore_server_timeout')), ms)),
    ]);

  try {
    const snap = await withTimeout(getDocsFromServer(orderedQuery), 4500);
    return mapSnapshot(snap);
  } catch {
    // Pode falhar por índice composto ausente, timeout de socket ou rede momentaneamente indisponível
    try {
      const snapUnordered = await withTimeout(getDocsFromServer(unorderedQuery), 4500);
      return mapSnapshot(snapUnordered);
    } catch {
      try {
        const cachedOrdered = await getDocs(orderedQuery);
        return mapSnapshot(cachedOrdered);
      } catch {
        try {
          const cachedUnordered = await getDocs(unorderedQuery);
          return mapSnapshot(cachedUnordered);
        } catch {
          return [];
        }
      }
    }
  }
}

/**
 * Busca metadados atualizados da sala ou conversa diretamente do servidor
 * para manter lastRead sincronizado entre dispositivos.
 */
export async function fetchChannelMetadataFromServer(
  channelId: string,
  isConversation: boolean = false
): Promise<Room | Conversation | null> {
  const { db, configured } = await initFirebase();
  if (!configured || !db || !isAuthValidAndNonAnonymous()) {
    return null;
  }

  const docRef = isConversation ? doc(db, 'conversations', channelId) : doc(db, 'rooms', channelId);
  try {
    const snap = await Promise.race([
      getDocFromServer(docRef),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('firestore_meta_timeout')), 4000)),
    ]);
    return snap.exists() ? (snap.data() as Room | Conversation) : null;
  } catch {
    try {
      const cached = await getDoc(docRef);
      return cached.exists() ? (cached.data() as Room | Conversation) : null;
    } catch {
      return null;
    }
  }
}

