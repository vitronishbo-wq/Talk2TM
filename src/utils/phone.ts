/**
 * Talk2TM — Normalização E.164, Mascaramento e Hash de Telefone (Zero Custos)
 *
 * - Normalização internacional com padrão Angola (+244) para números nacionais de 9 dígitos.
 * - O número é declarado pelo utilizador (sem verificação paga por SMS).
 * - Nunca armazenamos ou expomos o número bruto em coleções públicas: apenas hash SHA-256.
 */

export interface PhoneNormalizationResult {
  valid: boolean;
  e164?: string;
  error?: string;
}

/**
 * Normaliza um número de telefone para o formato internacional E.164 (ex: +244923456789).
 * Regras:
 * - Remove espaços, hífens, parênteses e pontos.
 * - Converte prefixo internacional '00' para '+'.
 * - Se não possuir '+', aceita padrão angolano de 9 dígitos começando por '9' -> +2449XXXXXXXX
 *   ou 12 dígitos começando por '2449' -> +2449XXXXXXXX.
 * - Valida formato estrito E.164: ^\+[1-9]\d{7,14}$
 */
export function normalizePhoneNumber(
  raw: string,
  defaultCountryCode: string = '+244'
): PhoneNormalizationResult {
  const input = (raw || '').trim();
  if (!input) {
    return { valid: false, error: 'Informe o número de telefone.' };
  }

  // Remove caracteres de formatação mantendo '+' e dígitos
  let cleaned = input.replace(/[\s\-().]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  if (cleaned.startsWith('+')) {
    const digitsAfterPlus = cleaned.slice(1).replace(/\D/g, '');
    const e164 = `+${digitsAfterPlus}`;
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      return {
        valid: false,
        error: 'Número internacional inválido. Use o formato +indicativo e número (ex: +244923456789).',
      };
    }
    return { valid: true, e164 };
  }

  const digits = cleaned.replace(/\D/g, '');
  if (!digits) {
    return { valid: false, error: 'Informe um número de telefone válido.' };
  }

  // Angola nacional: 9 dígitos começando por 9 (ex: 923456789 -> +244923456789)
  if (defaultCountryCode === '+244') {
    if (digits.length === 9 && digits.startsWith('9')) {
      return { valid: true, e164: `+244${digits}` };
    }
    if (digits.length === 12 && digits.startsWith('2449')) {
      return { valid: true, e164: `+${digits}` };
    }
  }

  // Caso possua código do país sem '+' (ex: 351912345678 ou 5511999998888), exige '+' explícito para evitar ambiguidade
  return {
    valid: false,
    error: 'Inclua o indicativo do país com + (ex: +244..., +351..., +55...) ou 9 dígitos locais (+244).',
  };
}

/**
 * Formata um E.164 de forma mascarada para exibição local discreta (ex: +244 ••• 789).
 */
export function maskPhoneNumber(e164: string): string {
  const clean = (e164 || '').trim();
  if (clean.length <= 7) return clean;
  const prefixLen = clean.startsWith('+244') ? 4 : Math.min(4, clean.length - 4);
  return `${clean.slice(0, prefixLen)} ••• ${clean.slice(-3)}`;
}

/**
 * Fallback puro TS para SHA-256 (apenas se crypto.subtle não estiver disponível em contexto HTTP não-localhost).
 */
function sha256FallbackHex(bytes: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H)
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Calcula o hash SHA-256 determinístico (64 hex chars) para descoberta exata sem expor o telefone bruto.
 */
export async function hashPhoneNumber(e164: string): Promise<string> {
  const input = `talk2tm:phone:v1:${e164.trim()}`;
  const bytes = new TextEncoder().encode(input);
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return sha256FallbackHex(bytes);
}

/**
 * Converte um phoneHash SHA-256 em e-mail interno opaco para o Firebase Auth.
 * Garante unicidade global do telefone no Auth sem exigir e-mail real do utilizador.
 */
export function phoneHashToInternalEmail(phoneHash: string): string {
  const clean = phoneHash.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 32);
  return `u_${clean}@talk2tm.internal`;
}
