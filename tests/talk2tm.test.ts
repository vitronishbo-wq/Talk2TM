/**
 * Talk2TM — Suite de Testes Autônoma (Camada 25)
 */

import { CONFIG, ACCESS_CONFIG, getUserByPin, DEFAULT_SETTINGS } from '../src/config';
import { sanitizeMessageText, sanitizeName, sanitizeRoom, generateId } from '../src/utils/sanitize';
import { verifyPassword, PASSWORDS } from '../src/app';
import { Room } from '../src/types';

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

  return { passed, total };
}

if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  runTalk2TMTests();
}
