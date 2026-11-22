/**
 * Talk2TM — Normalização E.164 Mundial (Baseada nos Metadados Oficiais Google libphonenumber),
 * Pesquisa de Países/Territórios, Desambiguação de Indicativos Partilhados e Mascaramento (Zero Custos).
 *
 * - Suporta todos os 245 países e territórios reconhecidos no plano de numeração mundial (Google libphonenumber).
 * - Valida estrutura, prefixos nacionais/troncos (zeros) e comprimentos válidos por território
 *   (nota: valida estrutura e plano de numeração, não existência ativa na operadora).
 * - Resolve territórios que partilham indicativos (+1, +7, +39, +44, +47, +61, +212, +262, +290, +358, +590, +599).
 * - Preserva estritamente os valores E.164 e hashes SHA-256 existentes em phoneLookup.
 */

import { RAW_PHONE_TERRITORIES } from './phone-metadata';

export interface PhoneCountry {
  iso: string;
  cc: string;
  dialCode: string;
  flag: string;
  name: string;
  searchKey: string;
  main: boolean;
  nationalPrefix: string;
  nationalPrefixForParsing: string;
  nationalPrefixTransformRule: string;
  leadingDigits: string;
  lengths: readonly number[];
  minLen: number;
  maxLen: number;
  /** true quando o país usa um prefixo nacional explícito (ex.: '0', '1', '8', '06' ou regra nacional) */
  hasNationalPrefix: boolean;
  /** Compatibilidade de leitura: true quando o tronco nacional começa por '0' */
  trunkZero: boolean;
}

export interface PhoneNormalizationResult {
  valid: boolean;
  e164?: string;
  iso?: string;
  error?: string;
}

interface CompiledTerritory {
  country: PhoneCountry;
  lengthSet: Set<number>;
  patRegex: RegExp;
  leadRegex: RegExp | null;
  npRegex: RegExp | null;
}

export const DEFAULT_COUNTRY_ISO = 'AO';
export const DEFAULT_COUNTRY_DIAL_CODE = '+244';

export function isoToFlag(iso: string): string {
  const clean = (iso || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(clean)) return '🌐';
  return String.fromCodePoint(0x1f1e6 + clean.charCodeAt(0) - 65, 0x1f1e6 + clean.charCodeAt(1) - 65);
}

export function normalizeSearchText(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED_TERRITORIES: readonly CompiledTerritory[] = RAW_PHONE_TERRITORIES.map(
  ([iso, cc, name, main, np, npParse, npTrans, lead, lens, pat]) => {
    const dialCode = `+${cc}`;
    const flag = isoToFlag(iso);
    const minLen = lens.length > 0 ? lens[0] : 4;
    const maxLen = lens.length > 0 ? lens[lens.length - 1] : 15;
    const country: PhoneCountry = {
      iso,
      cc,
      dialCode,
      flag,
      name,
      searchKey: normalizeSearchText(`${name} ${iso} ${dialCode} ${cc}`),
      main: main === 1,
      nationalPrefix: np,
      nationalPrefixForParsing: npParse,
      nationalPrefixTransformRule: npTrans,
      leadingDigits: lead,
      lengths: lens,
      minLen,
      maxLen,
      hasNationalPrefix: Boolean(np || npParse),
      trunkZero: np === '0' || np.startsWith('0'),
    };
    return {
      country,
      lengthSet: new Set(lens),
      patRegex: new RegExp(`^(?:${pat})$`),
      leadRegex: lead ? new RegExp(`^(?:${lead})`) : null,
      npRegex: npParse
        ? new RegExp(`^(?:${npParse})`)
        : np
          ? new RegExp(`^${escapeRegexLiteral(np)}`)
          : null,
    };
  }
);

export const PHONE_COUNTRIES: readonly PhoneCountry[] = COMPILED_TERRITORIES.map((t) => t.country);

const COMPILED_BY_ISO = new Map<string, CompiledTerritory>(
  COMPILED_TERRITORIES.map((t) => [t.country.iso, t])
);

const COMPILED_BY_CC = new Map<string, CompiledTerritory[]>();
for (const t of COMPILED_TERRITORIES) {
  const arr = COMPILED_BY_CC.get(t.country.cc) ?? [];
  arr.push(t);
  COMPILED_BY_CC.set(t.country.cc, arr);
}

// Ordena cada grupo de indicativo partilhado: países com leadingDigits específicos primeiro, depois mainCountryForCode
for (const arr of COMPILED_BY_CC.values()) {
  arr.sort((a, b) => {
    if (a.leadRegex && !b.leadRegex) return -1;
    if (!a.leadRegex && b.leadRegex) return 1;
    if (a.country.main && !b.country.main) return -1;
    if (!a.country.main && b.country.main) return 1;
    return a.country.name.localeCompare(b.country.name, 'pt');
  });
}

// Todos os códigos de chamada ordenados do mais comprido para o mais curto (ex.: 1876 não existe como CC; no libphonenumber são 1..3 dígitos)
const CALLING_CODES_DESC: readonly string[] = [...COMPILED_BY_CC.keys()].sort(
  (a, b) => b.length - a.length
);

/**
 * Mapeamento de fuso horário IANA -> ISO do país/território (apenas sugestão inicial silenciosa).
 */
const TIMEZONE_TO_ISO: Record<string, string> = {
  'Africa/Luanda': 'AO',
  'Africa/Windhoek': 'NA',
  'Africa/Maputo': 'MZ',
  'Africa/Johannesburg': 'ZA',
  'Atlantic/Cape_Verde': 'CV',
  'Africa/Sao_Tome': 'ST',
  'Africa/Bissau': 'GW',
  'Asia/Dili': 'TL',
  'Africa/Kinshasa': 'CD',
  'Africa/Lubumbashi': 'CD',
  'Africa/Brazzaville': 'CG',
  'Africa/Lusaka': 'ZM',
  'Africa/Harare': 'ZW',
  'Africa/Gaborone': 'BW',
  'Africa/Maseru': 'LS',
  'Africa/Mbabane': 'SZ',
  'Africa/Blantyre': 'MW',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Dar_es_Salaam': 'TZ',
  'Africa/Kampala': 'UG',
  'Africa/Kigali': 'RW',
  'Africa/Bujumbura': 'BI',
  'Africa/Accra': 'GH',
  'Africa/Abidjan': 'CI',
  'Africa/Dakar': 'SN',
  'Africa/Douala': 'CM',
  'Africa/Libreville': 'GA',
  'Africa/Malabo': 'GQ',
  'Africa/Casablanca': 'MA',
  'Africa/El_Aaiun': 'EH',
  'Africa/Algiers': 'DZ',
  'Africa/Tunis': 'TN',
  'Africa/Tripoli': 'LY',
  'Africa/Cairo': 'EG',
  'Africa/Addis_Ababa': 'ET',
  'Africa/Khartoum': 'SD',
  'Africa/Juba': 'SS',
  'Africa/Mogadishu': 'SO',
  'Indian/Antananarivo': 'MG',
  'Indian/Mauritius': 'MU',
  'Indian/Reunion': 'RE',
  'Indian/Mayotte': 'YT',
  'Atlantic/St_Helena': 'SH',
  'Europe/Lisbon': 'PT',
  'Atlantic/Azores': 'PT',
  'Atlantic/Madeira': 'PT',
  'America/Sao_Paulo': 'BR',
  'America/Fortaleza': 'BR',
  'America/Recife': 'BR',
  'America/Manaus': 'BR',
  'America/Belem': 'BR',
  'America/Bahia': 'BR',
  'America/Cuiaba': 'BR',
  'America/Porto_Velho': 'BR',
  'America/Boa_Vista': 'BR',
  'America/Rio_Branco': 'BR',
  'America/Noronha': 'BR',
  'America/Maceio': 'BR',
  'America/Araguaina': 'BR',
  'America/Campo_Grande': 'BR',
  'America/Santarem': 'BR',
  'Europe/London': 'GB',
  'Europe/Guernsey': 'GG',
  'Europe/Jersey': 'JE',
  'Europe/Isle_of_Man': 'IM',
  'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES',
  'Atlantic/Canary': 'ES',
  'Europe/Berlin': 'DE',
  'Europe/Rome': 'IT',
  'Europe/Vatican': 'VA',
  'Europe/San_Marino': 'SM',
  'Europe/Zurich': 'CH',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Luxembourg': 'LU',
  'Europe/Dublin': 'IE',
  'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Arctic/Longyearbyen': 'SJ',
  'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI',
  'Europe/Mariehamn': 'AX',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU',
  'Europe/Bucharest': 'RO',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Kiev': 'UA',
  'Europe/Kyiv': 'UA',
  'Europe/Moscow': 'RU',
  'Asia/Almaty': 'KZ',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Phoenix': 'US',
  'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/St_Johns': 'CA',
  'America/Puerto_Rico': 'PR',
  'America/Santo_Domingo': 'DO',
  'America/Jamaica': 'JM',
  'America/Port_of_Spain': 'TT',
  'America/Barbados': 'BB',
  'America/Nassau': 'BS',
  'Atlantic/Bermuda': 'BM',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Mexico_City': 'MX',
  'America/Bogota': 'CO',
  'America/Santiago': 'CL',
  'America/Lima': 'PE',
  'America/Montevideo': 'UY',
  'America/Asuncion': 'PY',
  'America/La_Paz': 'BO',
  'America/Caracas': 'VE',
  'America/Guayaquil': 'EC',
  'America/Panama': 'PA',
  'America/Costa_Rica': 'CR',
  'America/Havana': 'CU',
  'America/Guadeloupe': 'GP',
  'America/Martinique': 'MQ',
  'America/Cayenne': 'GF',
  'America/Curacao': 'CW',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Macau': 'MO',
  'Asia/Taipei': 'TW',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Dubai': 'AE',
  'Asia/Riyadh': 'SA',
  'Asia/Qatar': 'QA',
  'Asia/Kuwait': 'KW',
  'Asia/Singapore': 'SG',
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Jakarta': 'ID',
  'Asia/Manila': 'PH',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Karachi': 'PK',
  'Asia/Dhaka': 'BD',
  'Asia/Jerusalem': 'IL',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Brisbane': 'AU',
  'Pacific/Auckland': 'NZ',
  'Pacific/Norfolk': 'NF',
};

export function getCountryByIso(iso?: string): PhoneCountry {
  if (iso) {
    const found = COMPILED_BY_ISO.get(iso.trim().toUpperCase());
    if (found) return found.country;
  }
  return COMPILED_BY_ISO.get(DEFAULT_COUNTRY_ISO)!.country;
}

export function findCountryByDialCode(dialCode?: string): PhoneCountry | undefined {
  const clean = (dialCode || '').trim().replace(/[^\d]/g, '');
  if (!clean) return undefined;
  const group = COMPILED_BY_CC.get(clean);
  if (!group || group.length === 0) return undefined;
  return group.find((t) => t.country.main)?.country ?? group[0].country;
}

export function getCountriesByDialCode(dialCode?: string): readonly PhoneCountry[] {
  const clean = (dialCode || '').trim().replace(/[^\d]/g, '');
  if (!clean) return [];
  return (COMPILED_BY_CC.get(clean) ?? []).map((t) => t.country);
}

/**
 * Pesquisa países/territórios por nome (sem acentos), ISO ou indicativo (+264, 264, +1, etc.).
 * Quando pesquisa por indicativo exato (ex.: +1 ou 1), coloca os resultados exatos primeiro
 * e ordena o país principal antes dos territórios partilhados.
 */
export function searchPhoneCountries(query: string): readonly PhoneCountry[] {
  const raw = (query || '').trim();
  if (!raw) return PHONE_COUNTRIES;

  const norm = normalizeSearchText(raw);
  const digitsOnly = raw.replace(/[^\d]/g, '');
  const isDialQuery = /^[+\d\s-]+$/.test(raw) && digitsOnly.length > 0;

  const matches = PHONE_COUNTRIES.filter((c) => {
    if (isDialQuery) {
      return c.cc.startsWith(digitsOnly) || c.dialCode.includes(digitsOnly);
    }
    return c.searchKey.includes(norm);
  });

  return [...matches].sort((a, b) => {
    if (isDialQuery) {
      const aExact = a.cc === digitsOnly;
      const bExact = b.cc === digitsOnly;
      if (aExact !== bExact) return aExact ? -1 : 1;
      if (a.cc !== b.cc) return a.cc.localeCompare(b.cc);
      if (a.main !== b.main) return a.main ? -1 : 1;
    } else {
      const aStarts = normalizeSearchText(a.name).startsWith(norm) || a.iso.toLowerCase() === norm;
      const bStarts = normalizeSearchText(b.name).startsWith(norm) || b.iso.toLowerCase() === norm;
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'pt');
  });
}

function matchesNational(digits: string, t: CompiledTerritory): boolean {
  return t.lengthSet.has(digits.length) && t.patRegex.test(digits);
}

function stripNationalPrefix(digits: string, t: CompiledTerritory): string | null {
  if (!t.npRegex) return null;
  const m = digits.match(t.npRegex);
  if (!m || !m[0]) return null;

  const trans = t.country.nationalPrefixTransformRule;
  if (trans) {
    const groupRefs = [...trans.matchAll(/\$(\d)/g)];
    const hasAllGroups = groupRefs.every((g) => m[Number(g[1])] !== undefined);
    if (hasAllGroups) {
      const replaced = trans.replace(/\$(\d)/g, (_, idx) => m[Number(idx)] ?? '');
      return replaced + digits.slice(m[0].length);
    }
  }
  return digits.slice(m[0].length);
}

function resolveTerritoryForInternational(
  cc: string,
  nationalDigits: string,
  preferredIso?: string
): CompiledTerritory | undefined {
  const group = COMPILED_BY_CC.get(cc);
  if (!group || group.length === 0) return undefined;
  if (group.length === 1) return group[0];

  // 1. Territórios com leadingDigits explícitos (ex: +1787 -> PR, +77 -> KZ, +3906698 -> VA, +35818 -> AX)
  const leadMatches = group.filter((t) => t.leadRegex && t.leadRegex.test(nationalDigits));
  if (leadMatches.length === 1) return leadMatches[0];
  if (leadMatches.length > 1 && preferredIso) {
    const pref = leadMatches.find((t) => t.country.iso === preferredIso.toUpperCase());
    if (pref) return pref;
  }
  if (leadMatches.length > 0) {
    return leadMatches.find((t) => t.country.main) ?? leadMatches[0];
  }

  // 2. Se o utilizador selecionou explicitamente um território partilhado (ex: Canadá +1, Guernsey +44)
  if (preferredIso) {
    const pref = group.find((t) => t.country.iso === preferredIso.toUpperCase());
    if (pref && (!nationalDigits || matchesNational(nationalDigits, pref))) {
      return pref;
    }
  }

  // 3. Caso exclusivo: apenas um território do grupo aceita este número nacional
  if (nationalDigits) {
    const validMatches = group.filter((t) => matchesNational(nationalDigits, t));
    if (validMatches.length === 1) return validMatches[0];
  }

  // 4. Território principal do indicativo (ex: US para +1, RU para +7, GB para +44)
  return group.find((t) => t.country.main) ?? group[0];
}

export function findCountryByE164(
  e164OrPrefixed: string,
  preferredIso?: string
): PhoneCountry | undefined {
  const cleaned = (e164OrPrefixed || '').trim().replace(/[\s\-().]/g, '');
  const withPlus = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
  if (!withPlus.startsWith('+')) return undefined;
  const digits = withPlus.slice(1).replace(/\D/g, '');
  if (!digits) return undefined;

  const cc = CALLING_CODES_DESC.find((code) => digits.startsWith(code));
  if (!cc) return undefined;
  const national = digits.slice(cc.length);
  return resolveTerritoryForInternational(cc, national, preferredIso)?.country;
}

function extractLocaleRegion(locale?: string): string | undefined {
  if (!locale) return undefined;
  const match = locale.match(/[-_]([A-Za-z]{2})\b/);
  return match ? match[1].toUpperCase() : undefined;
}

/**
 * Sugere o país provável sem pedir permissões nem usar GPS.
 * Ordem: fuso horário IANA -> região do idioma -> Angola (+244) como recurso padrão.
 * Funciona estritamente como sugestão inicial editável.
 */
export function detectSuggestedCountry(overrides?: {
  timeZone?: string;
  locale?: string;
  languages?: readonly string[];
}): PhoneCountry {
  try {
    const tz =
      overrides?.timeZone ??
      (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined);

    if (tz && TIMEZONE_TO_ISO[tz]) {
      return getCountryByIso(TIMEZONE_TO_ISO[tz]);
    }

    const candidates: string[] = [];
    if (overrides?.locale) candidates.push(overrides.locale);
    if (overrides?.languages) candidates.push(...overrides.languages);
    if (!overrides && typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
      if (navigator.language) candidates.push(navigator.language);
    }

    for (const loc of candidates) {
      const region = extractLocaleRegion(loc);
      if (region && COMPILED_BY_ISO.has(region)) {
        return COMPILED_BY_ISO.get(region)!.country;
      }
    }
  } catch {
    // Fallback silencioso para Angola
  }

  return getCountryByIso(DEFAULT_COUNTRY_ISO);
}

function resolveDefaultTerritory(defaultCountryOrIso: string): CompiledTerritory | undefined {
  const clean = (defaultCountryOrIso || '').trim();
  if (/^[A-Za-z]{2}$/.test(clean)) {
    return COMPILED_BY_ISO.get(clean.toUpperCase());
  }
  const ccDigits = clean.replace(/\D/g, '');
  if (!ccDigits) return undefined;
  const group = COMPILED_BY_CC.get(ccDigits);
  if (!group || group.length === 0) return undefined;
  return group.find((t) => t.country.main) ?? group[0];
}

/**
 * Normaliza um número de telefone para o formato internacional E.164 usando metadados mundiais do Google libphonenumber.
 * - Aceita +indicativo, prefixo internacional '00', ou número local no país/território selecionado.
 * - Aceita opcionalmente o segundo argumento como ISO de 2 letras (ex.: 'NA', 'CA', 'GG') ou indicativo (ex.: '+264').
 * - Aplica estritamente as regras de prefixo nacional / zeros de cada território (sem remover zeros indiscriminadamente).
 * - Para territórios que partilham indicativo (ex.: +1, +7, +44, +39), valida e resolve o território correto.
 */
export function normalizePhoneNumber(
  raw: string,
  defaultCountryOrIso: string = DEFAULT_COUNTRY_DIAL_CODE
): PhoneNormalizationResult {
  const input = (raw || '').trim();
  if (!input) {
    return { valid: false, error: 'Informe o número de telefone.' };
  }

  const defaultTerritory = resolveDefaultTerritory(defaultCountryOrIso);
  let cleaned = input.replace(/[\s\-().]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  // 1. Formato internacional explícito (+... ou 00...)
  if (cleaned.startsWith('+')) {
    const digitsAfterPlus = cleaned.slice(1).replace(/\D/g, '');
    if (!/^[1-9]\d{4,14}$/.test(digitsAfterPlus)) {
      return {
        valid: false,
        error: 'Número internacional inválido. Verifique o indicativo e os dígitos.',
      };
    }

    const cc = CALLING_CODES_DESC.find((code) => digitsAfterPlus.startsWith(code));
    if (!cc) {
      return {
        valid: false,
        error: 'Indicativo internacional não reconhecido.',
      };
    }

    const group = COMPILED_BY_CC.get(cc)!;
    const rawNational = digitsAfterPlus.slice(cc.length);
    const preferredIso = defaultTerritory?.country.cc === cc ? defaultTerritory.country.iso : undefined;
    const resolved = resolveTerritoryForInternational(cc, rawNational, preferredIso) ?? group[0];

    // Verifica primeiro se o número nacional já é estruturalmente válido em algum território do código
    const directMatch =
      (preferredIso &&
        (() => {
          const prefT = COMPILED_BY_ISO.get(preferredIso);
          return prefT && matchesNational(rawNational, prefT) ? prefT : undefined;
        })()) ||
      group.find((t) => matchesNational(rawNational, t));

    if (directMatch) {
      const resolvedExact =
        resolveTerritoryForInternational(cc, rawNational, directMatch.country.iso) ?? directMatch;
      return {
        valid: true,
        e164: `+${cc}${rawNational}`,
        iso: resolvedExact.country.iso,
      };
    }

    // Caso o utilizador tenha digitado +CC + prefixo nacional de tronco (ex.: +264 081..., +44 07400...)
    // Só remove se o território possuir regra explícita de prefixo nacional e o resultado for estruturalmente válido
    for (const candidateT of [resolved, ...group]) {
      const stripped = stripNationalPrefix(rawNational, candidateT);
      if (stripped && stripped.length + cc.length <= 15 && matchesNational(stripped, candidateT)) {
        const finalT =
          resolveTerritoryForInternational(cc, stripped, candidateT.country.iso) ?? candidateT;
        return {
          valid: true,
          e164: `+${cc}${stripped}`,
          iso: finalT.country.iso,
        };
      }
    }

    return {
      valid: false,
      error: `${resolved.country.name} (${resolved.country.dialCode}): número inválido para o plano de numeração.`,
    };
  }

  // 2. Número digitado sem '+' -> usa país/território selecionado
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) {
    return { valid: false, error: 'Informe um número de telefone válido.' };
  }

  if (!defaultTerritory) {
    return {
      valid: false,
      error: 'País não reconhecido. Selecione o país na lista.',
    };
  }

  const c = defaultTerritory.country;
  const group = COMPILED_BY_CC.get(c.cc) ?? [defaultTerritory];

  // 2a. Verifica se já é um número nacional válido completo sem remover nada (preserva 0 iniciais obrigatórios como IT/CG/CI ou DDD 55 no BR)
  if (matchesNational(digits, defaultTerritory)) {
    return {
      valid: true,
      e164: `+${c.cc}${digits}`,
      iso: c.iso,
    };
  }

  // 2b. Verifica regra explícita de prefixo nacional/tronco do país (ex.: Namíbia 0..., Brasil 0/015..., Rússia 8..., Argentina 0..15, Guernsey 6 dígitos)
  const stripped = stripNationalPrefix(digits, defaultTerritory);
  if (stripped && stripped.length + c.cc.length <= 15 && matchesNational(stripped, defaultTerritory)) {
    return {
      valid: true,
      e164: `+${c.cc}${stripped}`,
      iso: c.iso,
    };
  }

  // 2c. Se o utilizador já incluiu o indicativo do país selecionado sem '+' (ex.: 244923456789, 264812345678, 17872345678)
  if (digits.startsWith(c.cc) && digits.length > c.cc.length && digits.length <= 15) {
    const withoutCc = digits.slice(c.cc.length);
    if (matchesNational(withoutCc, defaultTerritory)) {
      return {
        valid: true,
        e164: `+${c.cc}${withoutCc}`,
        iso: c.iso,
      };
    }
    const strippedAfterCc = stripNationalPrefix(withoutCc, defaultTerritory);
    if (
      strippedAfterCc &&
      strippedAfterCc.length + c.cc.length <= 15 &&
      matchesNational(strippedAfterCc, defaultTerritory)
    ) {
      return {
        valid: true,
        e164: `+${c.cc}${strippedAfterCc}`,
        iso: c.iso,
      };
    }
    // Se partilhar indicativo (ex.: +1 US selecionados mas digitou 1787... de PR)
    const sharedMatch = group.find((t) => matchesNational(withoutCc, t));
    if (sharedMatch) {
      const resolvedShared =
        resolveTerritoryForInternational(c.cc, withoutCc, sharedMatch.country.iso) ?? sharedMatch;
      return {
        valid: true,
        e164: `+${c.cc}${withoutCc}`,
        iso: resolvedShared.country.iso,
      };
    }
  }

  const lenDesc =
    c.minLen === c.maxLen ? `${c.minLen} dígitos` : `${c.minLen} a ${c.maxLen} dígitos`;
  return {
    valid: false,
    error: `${c.name} (${c.dialCode}): número inválido (esperado ${lenDesc} ou +indicativo).`,
  };
}

/**
 * Formata um E.164 de forma mascarada para exibição local discreta (ex: +244 ••• 789, +264 ••• 678, +1 ••• 671).
 */
export function maskPhoneNumber(e164: string): string {
  const clean = (e164 || '').trim();
  if (clean.length <= 6) return clean;
  const matched = findCountryByE164(clean);
  const prefixLen = matched
    ? matched.dialCode.length
    : clean.startsWith('+244')
      ? 4
      : Math.min(4, clean.length - 4);
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
