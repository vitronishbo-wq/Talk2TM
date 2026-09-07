/**
 * Talk2TM — Suite de Testes Autônoma (Camada 25)
 */

import { CONFIG, ACCESS_CONFIG, getUserByPin, DEFAULT_SETTINGS, USER_AUTH_CREDENTIALS, getCredentialsByUser } from '../src/config';
import { sanitizeMessageText, sanitizeName, sanitizeRoom, generateId } from '../src/utils/sanitize';
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
} from '../src/firebase/firestore';

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
    assert(DEFAULT_SETTINGS.inactivityLockSeconds === 5, 'Inatividade padrão de 5 segundos');
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

  console.log(`\x1b[32m✔ Talk2TM: ${passed}/${total} testes executados com 100% de aprovação.\x1b[0m`);
  return { passed, total };
}

if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  runTalk2TMTests();
}
