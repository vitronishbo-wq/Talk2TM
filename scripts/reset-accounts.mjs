#!/usr/bin/env node
/**
 * Talk2TM — Reset Seletivo de Contas (Nuvem)
 *
 * Apaga contas de teste antigas do Firebase Auth mantendo INTACTOS:
 *   - truman@talk2tm.internal (Truman)
 *   - maezinha@talk2tm.internal (Mãezinha)
 *
 * Sem dependências externas (usa crypto nativo do Node 22 + fetch REST API).
 * Por segurança, roda em modo simulação (dry-run) a menos que seja passado --confirm-reset.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const DEFAULT_PROJECT_ID = 'gen-lang-client-0618196986';
const PRESERVED_EMAILS = new Set([
  'truman@talk2tm.internal',
  'maezinha@talk2tm.internal',
]);

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inlineJson && inlineJson.trim()) {
    return JSON.parse(inlineJson);
  }
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  }
  throw new Error(
    'Defina FIREBASE_SERVICE_ACCOUNT (JSON) ou GOOGLE_APPLICATION_CREDENTIALS (caminho para o JSON da Service Account).'
  );
}

async function fetchGoogleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/identitytoolkit',
      iat: now,
      exp: now + 3600,
    })
  );

  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Falha ao obter token OAuth2 da Service Account (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function listAllAuthUsers(projectId, accessToken) {
  const users = [];
  let nextPageToken = '';

  do {
    const url = new URL(
      `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:batchGet`
    );
    url.searchParams.set('maxResults', '500');
    if (nextPageToken) {
      url.searchParams.set('nextPageToken', nextPageToken);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Falha ao listar utilizadores no Firebase Auth (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (Array.isArray(data.users)) {
      users.push(...data.users);
    }
    nextPageToken = data.nextPageToken || '';
  } while (nextPageToken);

  return users;
}

async function batchDeleteAuthUsers(projectId, accessToken, uids) {
  const CHUNK_SIZE = 1000;
  let deletedTotal = 0;

  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:batchDelete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ localIds: chunk, force: true }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Falha ao apagar utilizadores no Firebase Auth (${res.status}): ${errText}`);
    }
    const result = await res.json();
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      console.warn('Avisos em accounts:batchDelete:', JSON.stringify(result.errors));
    }
    deletedTotal += chunk.length - (result.errors?.length || 0);
  }

  return deletedTotal;
}

async function main() {
  const confirmReset = process.argv.includes('--confirm-reset');
  const sa = loadServiceAccount();
  const projectId = sa.project_id || process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;

  console.log(`Talk2TM Reset Seletivo — Projeto: ${projectId}`);
  console.log(`Modo: ${confirmReset ? 'EXECUÇÃO REAL (--confirm-reset)' : 'SIMULAÇÃO (dry-run)'}`);

  const accessToken = await fetchGoogleAccessToken(sa);
  const allUsers = await listAllAuthUsers(projectId, accessToken);

  const preserved = [];
  const toDelete = [];

  for (const user of allUsers) {
    const email = (user.email || '').trim().toLowerCase();
    if (PRESERVED_EMAILS.has(email)) {
      preserved.push({ uid: user.localId, email });
    } else {
      toDelete.push({ uid: user.localId, email: email || '(sem email / anónimo)' });
    }
  }

  console.log(`Utilizadores preservados (${preserved.length}):`);
  for (const u of preserved) {
    console.log(`  ✔ PRESERVADO: ${u.email} (${u.uid})`);
  }

  console.log(`Utilizadores marcados para remoção (${toDelete.length}):`);
  for (const u of toDelete) {
    console.log(`  - ${u.email} (${u.uid})`);
  }

  if (!confirmReset) {
    console.log('Simulação concluída. Passe --confirm-reset para apagar os utilizadores listados.');
    return;
  }

  if (toDelete.length === 0) {
    console.log('Nenhum utilizador extra encontrado para remover no Firebase Auth.');
    return;
  }

  const deletedCount = await batchDeleteAuthUsers(
    projectId,
    accessToken,
    toDelete.map((u) => u.uid)
  );
  console.log(`✔ Firebase Auth limpo: ${deletedCount} conta(s) removida(s); Truman e Mãezinha preservados.`);
}

main().catch((err) => {
  console.error('✖ Erro no reset seletivo:', err);
  process.exit(1);
});
