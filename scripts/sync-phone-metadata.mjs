/**
 * Talk2TM — Extrator leve de metadados telefónicos a partir do Google libphonenumber (PhoneNumberMetadata.xml).
 *
 * Gera src/utils/phone-metadata.ts sem necessidade de instalar a biblioteca libphonenumber completa em runtime.
 * Uso: node scripts/sync-phone-metadata.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const METADATA_URL =
  'https://raw.githubusercontent.com/google/libphonenumber/master/resources/PhoneNumberMetadata.xml';

const OUTPUT_PATH = path.resolve(process.cwd(), 'src/utils/phone-metadata.ts');

// Nomes explícitos em português para territórios especiais ou variantes regionais caso algum ambiente falhe
const PT_NAME_OVERRIDES = {
  AC: 'Ilha de Ascensão',
  TA: 'Tristão da Cunha',
  XK: 'Kosovo',
  BQ: 'Países Baixos Caribenhos',
  SX: 'São Martinho (Países Baixos)',
  MF: 'São Martinho (França)',
  BL: 'São Bartolomeu',
  PS: 'Palestina',
  MK: 'Macedónia do Norte',
  CZ: 'Chéquia',
  TR: 'Turquia',
  SZ: 'Essuatíni',
};

function getAttr(attrStr, key) {
  const m = attrStr.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function parsePossibleLengths(str) {
  const out = new Set();
  for (const part of str.split(',')) {
    const p = part.trim();
    const range = p.match(/^\[(\d+)-(\d+)\]$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let i = start; i <= end; i++) out.add(i);
    } else if (/^\d+$/.test(p)) {
      out.add(Number(p));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function cleanPattern(raw) {
  return raw ? raw.replace(/\s+/g, '') : '';
}

function extractLeadingDigitsFromSections(body) {
  // Para territórios que partilham indicativo mas sem leadingDigits na tag <territory> (ex: GG/JE/YT)
  return undefined;
}

async function main() {
  console.log(`Baixando metadados oficiais de ${METADATA_URL}...`);
  const res = await fetch(METADATA_URL);
  if (!res.ok) {
    throw new Error(`Falha ao baixar PhoneNumberMetadata.xml: HTTP ${res.status}`);
  }
  const xml = await res.text();

  const revMatch = xml.match(/<!--\s*[^]*?-->/);
  const dn = new Intl.DisplayNames(['pt'], { type: 'region' });

  const territories = [...xml.matchAll(/<territory\b([^>]*)>([\s\S]*?)<\/territory>/g)];
  const rows = [];

  for (const [, attrs, body] of territories) {
    const iso = getAttr(attrs, 'id');
    const cc = getAttr(attrs, 'countryCode');
    if (!iso || !cc || iso === '001') continue;

    let name = PT_NAME_OVERRIDES[iso];
    if (!name) {
      try {
        name = dn.of(iso) || iso;
      } catch {
        name = iso;
      }
    }

    const main = getAttr(attrs, 'mainCountryForCode') === 'true' ? 1 : 0;
    const np = getAttr(attrs, 'nationalPrefix') || '';
    const npParse = cleanPattern(getAttr(attrs, 'nationalPrefixForParsing'));
    const npTrans = getAttr(attrs, 'nationalPrefixTransformRule') || '';
    const lead = cleanPattern(getAttr(attrs, 'leadingDigits')) || extractLeadingDigitsFromSections(body) || '';

    const genMatch = body.match(/<generalDesc>[\s\S]*?<nationalNumberPattern>([\s\S]*?)<\/nationalNumberPattern>/);
    const pat = genMatch ? cleanPattern(genMatch[1]) : '';

    const lenSet = new Set();
    const sections = ['fixedLine', 'mobile', 'personalNumber', 'voip', 'uan', 'tollFree', 'sharedCost', 'pager'];
    for (const tag of sections) {
      const tagMatch = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      if (tagMatch) {
        for (const lm of tagMatch[1].matchAll(/<possibleLengths[^>]*national="([^"]+)"/g)) {
          for (const len of parsePossibleLengths(lm[1])) {
            lenSet.add(len);
          }
        }
      }
    }
    if (lenSet.size === 0) {
      for (const lm of body.matchAll(/<possibleLengths[^>]*national="([^"]+)"/g)) {
        for (const len of parsePossibleLengths(lm[1])) {
          lenSet.add(len);
        }
      }
    }

    const lens = [...lenSet].sort((a, b) => a - b);
    if (!pat || lens.length === 0) {
      console.warn(`Aviso: território ${iso} (+${cc}) sem padrão ou comprimentos completos.`);
    }

    // Tupla compacta: [iso, cc, name, main, np, npParse, npTrans, lead, lens, pat]
    rows.push([iso, cc, name, main, np, npParse, npTrans, lead, lens, pat]);
  }

  // Ordenar por nome em português (mantendo código determinístico)
  rows.sort((a, b) => a[2].localeCompare(b[2], 'pt'));

  const headerComment = revMatch ? revMatch[0].split('\n')[0] : 'Google libphonenumber PhoneNumberMetadata.xml';

  const output = `/**
 * Talk2TM — Metadados Telefónicos Mundiais (245 países e territórios)
 * Extraído diretamente de Google libphonenumber (PhoneNumberMetadata.xml).
 * Gerado por: node scripts/sync-phone-metadata.mjs
 * Fonte: ${headerComment.replace(/\*\//g, '')}
 *
 * Estrutura compacta de tupla para peso mínimo no bundle sem dependência completa do runtime libphonenumber:
 * [iso, cc, name, main, np, npParse, npTrans, lead, lens, pat]
 */

export type CompactTerritoryTuple = readonly [
  iso: string,
  cc: string,
  name: string,
  main: 0 | 1,
  np: string,
  npParse: string,
  npTrans: string,
  lead: string,
  lens: readonly number[],
  pat: string
];

export const RAW_PHONE_TERRITORIES: readonly CompactTerritoryTuple[] = ${JSON.stringify(rows)};
`;

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
  console.log(`Gerado ${OUTPUT_PATH} com ${rows.length} países/territórios (${Buffer.byteLength(output, 'utf8')} bytes).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
