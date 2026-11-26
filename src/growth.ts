/**
 * Talk2TM — Fase 5: Telemetria Semanal Minimalista (WAU) & Agregação de Indicadores de Crescimento
 *
 * - Regista apenas dia/carimbo de atividade e cidade declarada pelo utilizador no perfil Dating.
 * - Zero GPS contínuo, zero histórico de localização, zero exposição de PII no Dashboard Admin.
 * - Throttling cliente de 6 horas (~1 escrita/dia por utilizador ativo) para manter Custo Zero.
 */

import { doc, setDoc } from 'firebase/firestore';
import { getFirebaseAuth, getFirebaseDB, isAuthValidAndNonAnonymous } from './firebase/firestore';
import type {
  AdminCityDistributionRow,
  AdminGrowthMetricsSnapshot,
  DatingMatch,
  DatingProfile,
  GrowthTelemetryRecord,
  ReferralAttribution,
  ReferralLink,
  ReferralStats,
  UserProfile,
} from './types';

const PROTECTED_LEGACY_UIDS = new Set(['uid_truman_852456', 'uid_maezinha_135790']);
const ACTIVITY_PING_PREFIX = 'talk2tm_activity_ping_v1_';
const ACTIVITY_PING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function getActivityPingStorageKey(uid: string): string {
  return `${ACTIVITY_PING_PREFIX}${uid}`;
}

export function getLocalDateDayKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getWeekWindowStartIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - WEEK_MS).toISOString();
}

export async function recordUserWeeklyActivityIfNeeded(params: {
  uid: string;
  city?: string | null;
  cityKey?: string | null;
  countryCode?: string | null;
  forceCitySync?: boolean;
}): Promise<void> {
  const uid = (params.uid || '').trim();
  if (!uid || PROTECTED_LEGACY_UIDS.has(uid)) return;

  const nowMs = Date.now();
  const todayKey = getLocalDateDayKey(new Date(nowMs));
  const cleanCity = typeof params.city === 'string' && params.city.trim() ? params.city.trim().slice(0, 60) : null;
  const cleanCityKey =
    typeof params.cityKey === 'string' && params.cityKey.trim()
      ? params.cityKey.trim().slice(0, 60)
      : cleanCity
      ? cleanCity.toLowerCase().slice(0, 60)
      : null;
  const cleanCountry =
    typeof params.countryCode === 'string' && params.countryCode.trim()
      ? params.countryCode.trim().toUpperCase().slice(0, 4)
      : null;

  const pingKey = getActivityPingStorageKey(uid);
  try {
    if (!params.forceCitySync && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(pingKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { dayKey?: string; atMs?: number; cityKey?: string | null };
        if (
          parsed?.dayKey === todayKey &&
          typeof parsed.atMs === 'number' &&
          nowMs - parsed.atMs < ACTIVITY_PING_INTERVAL_MS
        ) {
          return;
        }
      }
    }
  } catch {
    // Segue com tentativa de sincronização
  }

  const db = getFirebaseDB();
  const auth = getFirebaseAuth();
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid || !isAuthValidAndNonAnonymous()) {
    return;
  }

  const nowIso = new Date(nowMs).toISOString();
  const record: GrowthTelemetryRecord = {
    uid,
    lastActiveAt: nowIso,
    lastActiveDay: todayKey,
    ...(cleanCity ? { city: cleanCity } : {}),
    ...(cleanCityKey ? { cityKey: cleanCityKey } : {}),
    ...(cleanCountry ? { countryCode: cleanCountry } : {}),
    updatedAt: nowIso,
  };

  try {
    await setDoc(doc(db, 'growthTelemetry', uid), record, { merge: true });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        pingKey,
        JSON.stringify({
          dayKey: todayKey,
          atMs: nowMs,
          cityKey: cleanCityKey,
        })
      );
    }
  } catch (err) {
    console.debug('Talk2TM [Telemetry]: Não foi possível registar sinal semanal agora:', err);
  }
}

export function roundPercent(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0 || !numerator || numerator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function computeGrowthMetricsSummary(input: {
  userProfiles: UserProfile[];
  referralLinks: ReferralLink[];
  referralStats: ReferralStats[];
  referralAttributions: ReferralAttribution[];
  datingProfiles: DatingProfile[];
  datingMatches: DatingMatch[];
  growthTelemetry: GrowthTelemetryRecord[];
  nowMs?: number;
}): AdminGrowthMetricsSnapshot {
  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
  const weekStartIso = getWeekWindowStartIso(nowMs);

  const nonLegacyUsers = input.userProfiles.filter(
    (u) => u && u.uid && !PROTECTED_LEGACY_UIDS.has(u.uid)
  );
  const activeUserUids = new Set<string>();
  for (const u of nonLegacyUsers) {
    if (u.active !== false) {
      activeUserUids.add(u.uid);
    }
  }
  const totalActiveUsers = activeUserUids.size;

  const nonLegacyDating = input.datingProfiles.filter(
    (d) => d && d.uid && !PROTECTED_LEGACY_UIDS.has(d.uid)
  );
  const activeDatingProfiles = nonLegacyDating.filter((d) => d.suspended !== true);
  const totalDatingProfiles = activeDatingProfiles.length;

  // 1. Aquisição (Convites & Conversões)
  const validAttributions = input.referralAttributions.filter(
    (a) => a && a.newUid && !PROTECTED_LEGACY_UIDS.has(a.newUid)
  );
  const referralConvertedUsers = validAttributions.length;
  const referralConversionSharePercent = roundPercent(referralConvertedUsers, totalActiveUsers);

  const totalReferralShares = input.referralStats.reduce((sum, s) => {
    if (!s || PROTECTED_LEGACY_UIDS.has(s.uid)) return sum;
    const count = typeof s.invitesSharedCount === 'number' && s.invitesSharedCount > 0 ? s.invitesSharedCount : 0;
    return sum + count;
  }, 0);

  const totalActiveReferralLinks = input.referralLinks.filter(
    (l) => l && l.active !== false && !PROTECTED_LEGACY_UIDS.has(l.referrerUid)
  ).length;

  // Taxa de conversão: se partilhas >= conversões, calcula direto; se houver cliques não rastreados, limita visualmente a 100%
  const rawConvRate =
    totalReferralShares > 0 ? Math.min(100, (referralConvertedUsers / totalReferralShares) * 100) : 0;
  const referralLinkConversionRatePercent = Number(rawConvRate.toFixed(1));

  // 2. Engajamento (Matches & Conversas Iniciadas após Match)
  const validMatches = input.datingMatches.filter(
    (m) =>
      m &&
      m.matchId &&
      !PROTECTED_LEGACY_UIDS.has(m.participantA) &&
      !PROTECTED_LEGACY_UIDS.has(m.participantB)
  );
  const totalMatchesCreated = validMatches.length;
  const activeMatchedCount = validMatches.filter((m) => m.status === 'matched').length;
  const matchesWithChatStarted = validMatches.filter((m) => m.chatStarted === true).length;

  const matchUserDenominator = totalDatingProfiles > 0 ? totalDatingProfiles : totalActiveUsers;
  const avgMatchesPerUser =
    matchUserDenominator > 0
      ? Number(((activeMatchedCount * 2) / matchUserDenominator).toFixed(2))
      : 0;
  const postMatchConversationRatePercent = roundPercent(matchesWithChatStarted, totalMatchesCreated);

  // 3. Retenção Semanal (WAU)
  const weeklyActiveUids = new Set<string>();
  for (const tRec of input.growthTelemetry) {
    if (!tRec || !tRec.uid || PROTECTED_LEGACY_UIDS.has(tRec.uid)) continue;
    if (totalActiveUsers > 0 && !activeUserUids.has(tRec.uid)) continue;
    if (tRec.lastActiveAt && tRec.lastActiveAt >= weekStartIso) {
      weeklyActiveUids.add(tRec.uid);
    }
  }
  for (const d of activeDatingProfiles) {
    if (totalActiveUsers > 0 && !activeUserUids.has(d.uid)) continue;
    if (d.updatedAt && d.updatedAt >= weekStartIso) {
      weeklyActiveUids.add(d.uid);
    }
  }
  const weeklyActiveUsers = weeklyActiveUids.size;
  const weeklyRetentionPercent = roundPercent(weeklyActiveUsers, totalActiveUsers);

  // 4. Distribuição de ativos por cidade (sem PII, apenas cidade + código do país)
  const userLocationByUid = new Map<string, { city: string; cityKey: string; countryCode: string }>();
  for (const d of activeDatingProfiles) {
    if (totalActiveUsers > 0 && !activeUserUids.has(d.uid)) continue;
    if (d.paused) continue;
    const city = (d.city || '').trim();
    const cityKey = (d.cityKey || city.toLowerCase()).trim();
    const countryCode = (d.countryCode || '').trim().toUpperCase();
    if (city && cityKey) {
      userLocationByUid.set(d.uid, { city, cityKey, countryCode });
    }
  }
  for (const tRec of input.growthTelemetry) {
    if (!tRec || !tRec.uid || PROTECTED_LEGACY_UIDS.has(tRec.uid)) continue;
    if (totalActiveUsers > 0 && !activeUserUids.has(tRec.uid)) continue;
    if (userLocationByUid.has(tRec.uid)) continue;
    const city = (tRec.city || '').trim();
    const cityKey = (tRec.cityKey || city.toLowerCase()).trim();
    const countryCode = (tRec.countryCode || '').trim().toUpperCase();
    if (city && cityKey) {
      userLocationByUid.set(tRec.uid, { city, cityKey, countryCode });
    }
  }

  const cityBuckets = new Map<string, { city: string; cityKey: string; countryCode: string; count: number }>();
  for (const loc of userLocationByUid.values()) {
    const bucketKey = `${loc.countryCode || '--'}|${loc.cityKey}`;
    const existing = cityBuckets.get(bucketKey);
    if (existing) {
      existing.count += 1;
    } else {
      cityBuckets.set(bucketKey, {
        city: loc.city,
        cityKey: loc.cityKey,
        countryCode: loc.countryCode || '--',
        count: 1,
      });
    }
  }

  const totalCityLocated = userLocationByUid.size;
  const cityDistribution: AdminCityDistributionRow[] = Array.from(cityBuckets.values())
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city))
    .slice(0, 12)
    .map((bucket) => ({
      city: bucket.city,
      cityKey: bucket.cityKey,
      countryCode: bucket.countryCode,
      activeCount: bucket.count,
      sharePercent: roundPercent(bucket.count, totalCityLocated || totalActiveUsers),
    }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    totalActiveUsers,
    totalDatingProfiles,
    weeklyActiveUsers,
    weeklyRetentionPercent,
    referralConvertedUsers,
    referralConversionSharePercent,
    totalReferralShares,
    totalActiveReferralLinks,
    referralLinkConversionRatePercent,
    totalMatchesCreated,
    activeMatchedCount,
    avgMatchesPerUser,
    matchesWithChatStarted,
    postMatchConversationRatePercent,
    cityDistribution,
  };
}
