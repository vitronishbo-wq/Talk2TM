/**
 * Talk2TM — Tipos e interfaces estritas do produto
 * Modelo: Chat textual ultraleve para exatamente 2 pessoas por sala
 */

export type ConnectionState = 'conectando' | 'online' | 'offline' | 'sincronizando';

export type MessageStatus = 'pending' | 'synced' | 'failed' | 'read';

export interface Room {
  roomId: string;
  participantA: string;
  participantAName: string;
  participantB?: string | null;
  participantBName?: string | null;
  lastReadA?: string | null;
  lastReadB?: string | null;
  lastRead?: Record<string, string>;
  createdAt: string;
  lastActivity: string;
}

export interface Message {
  messageId: string;
  room: string;
  sender: string;
  senderId: string;
  text: string;
  clientId: string;
  createdAt: string;
  status?: MessageStatus;
  conversationId?: string;
  senderTalk2tmId?: string;
  deletedFor?: string[];
}

export interface UserSession {
  userId: string;
  displayName: string;
  username?: string;
  roomId: string;
  talk2tmId?: string;
  conversationId?: string;
  phoneMasked?: string;
  email?: string;
  emailVerified?: boolean;
}

export interface ChatConfig {
  ROOM_MAX_LENGTH: number;
  NAME_MAX_LENGTH: number;
  MESSAGE_MAX_LENGTH: number;
  HISTORY_LIMIT: number;
  MAX_PARTICIPANTS: number;
}

/**
 * ====================================================================
 * EXPANSION ARCHITECTURE V1: AS ENTIDADES ENXUTAS DO TALK2TM
 * Cadeia Obrigatória: Auth UID -> Identidade -> Conversation -> Messages
 * ====================================================================
 */

/**
 * 1. users/{uid} — Metadados privados da conta associada ao Firebase Auth
 */
export interface UserAccount {
  uid: string;
  talk2tmId: string;
  username?: string;
  createdAt: string;
  phoneHash?: string;
  phoneMasked?: string;
  accountStatus?: 'active' | 'deleting';
  deletionRequestedAt?: string;
}

/**
 * 2. userProfiles/{talk2tmId} — Índice público ultraleve para descoberta 1:1
 */
export interface UserProfile {
  talk2tmId: string;
  uid: string;
  displayName: string;
  username?: string;
  active: boolean;
  createdAt: string;
  plan?: string;
}

export type AdminStatusFilter = 'all' | 'active' | 'inactive';
export type AdminOverlayTab = 'users' | 'reports' | 'photos' | 'metrics';
export type AdminReportFilter = 'pending' | 'resolved' | 'dismissed' | 'all';
export type AdminPhotoFilter = 'pending' | 'reported' | 'rejected' | 'approved';

export interface AdminUserRow {
  uid: string;
  talk2tmId: string;
  displayName: string;
  phoneMasked: string;
  phoneHash?: string;
  createdAt: string;
  plan: string;
  active: boolean;
}

/**
 * 2b. phoneLookup/{phoneHash} — Índice exato por hash SHA-256 do telefone (nunca expõe número bruto)
 */
export interface PhoneDirectoryEntry {
  phoneHash: string;
  uid: string;
  talk2tmId: string;
  displayName: string;
  active: boolean;
  createdAt: string;
}

/**
 * 2c. usernames/{usernameLower} — Índice único de utilizador (ex: truman01)
 */
export interface UsernameDirectoryEntry {
  usernameLower: string;
  username: string;
  uid: string;
  talk2tmId: string;
  createdAt: string;
}

/**
 * 3. conversations/{conversationId} — Vínculo estrito bilateral (exatamente 2 participantes)
 */
export interface Conversation {
  conversationId: string;
  participantA: string; // UID do participante A
  participantB: string; // UID do participante B
  talk2tmIdA: string;
  talk2tmIdB: string;
  displayNameA: string;
  displayNameB: string;
  createdAt: string;
  updatedAt: string;
  lastReadA?: string | null;
  lastReadB?: string | null;
}

/**
 * 4. conversationInvites/{inviteId} — Convites bilaterais para conversas
 */
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface ConversationInvite {
  inviteId: string;
  fromUid: string;
  fromDisplayName: string;
  fromTalk2tmId: string;
  toTalk2tmId: string;
  toUid?: string | null;
  conversationId: string;
  status: InviteStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 5. conversations/{conversationId}/messages/{messageId} — Mensagens puramente textuais
 */
export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  senderId: string; // UID obrigatório
  senderTalk2tmId: string;
  text: string;
  clientId: string;
  createdAt: string;
  status?: MessageStatus;
}

/**
 * ====================================================================
 * DATING FASE 1: PERFIL ADULTO (+18) & DESCOBERTA FINITA (SEM FEED INFINITO)
 * ====================================================================
 */

export type DatingGender = 'woman' | 'man' | 'non_binary';

export type DatingSeeking = 'women' | 'men' | 'all';

export type DatingIntent = 'serious' | 'meet_people' | 'chat';

export type DatingEvaluationDecision = 'seen' | 'pass' | 'like' | 'blocked';

export type DatingPhotoStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface DatingProfile {
  uid: string;
  talk2tmId: string;
  displayName: string;
  age: number;
  gender: DatingGender;
  seeking: DatingSeeking;
  countryCode: string;
  city: string;
  cityKey: string;
  bio: string;
  intent: DatingIntent;
  adultConfirmed: boolean;
  termsAcceptedAt: string;
  termsVersion: string;
  discoverable: boolean;
  paused: boolean;
  suspended: boolean;
  photoUrl?: string | null;
  photoPath?: string | null;
  photoStatus?: DatingPhotoStatus;
  photoUpdatedAt?: string | null;
  photoModerationNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPhotoQueueItem {
  uid: string;
  talk2tmId: string;
  displayName: string;
  age: number;
  city: string;
  countryCode: string;
  photoUrl: string | null;
  photoPath: string | null;
  photoStatus: DatingPhotoStatus;
  photoUpdatedAt: string;
  photoModerationNote?: string | null;
  suspended: boolean;
  reportReason?: string;
  reportEvidence?: string;
}

export interface DatingProfileInput {
  displayName: string;
  age: number;
  gender: DatingGender;
  seeking: DatingSeeking;
  countryCode: string;
  city: string;
  bio: string;
  intent: DatingIntent;
  adultConfirmed: boolean;
  termsAccepted: boolean;
  discoverable?: boolean;
  paused?: boolean;
}

export interface DatingDiscoveryFilters {
  minAge: number;
  maxAge: number;
  seeking: DatingSeeking;
  countryCode: string; // '' para qualquer país ou ISO2 (ex: 'AO')
  city: string;
}

export interface DatingEvaluationRecord {
  targetUid: string;
  decision: DatingEvaluationDecision;
  createdAt: string;
  dayKey: string;
}

export interface DatingDiscoveryResult {
  candidates: DatingProfile[];
  usedToday: number;
  remainingToday: number;
  dailyLimit: number;
  exhaustedReason?: 'daily_limit' | 'no_matches';
  nextCursorUpdatedAt?: string;
}

/**
 * ====================================================================
 * DATING FASE 2: INTERESSE SECRETO (LIKE), MATCH RECÍPROCO & DESFAZER MATCH
 * ====================================================================
 */

export type DatingMatchStatus = 'matched' | 'unmatched';

export interface DatingLike {
  likeId: string;
  fromUid: string;
  toUid: string;
  fromTalk2tmId: string;
  fromDisplayName: string;
  createdAt: string;
}

export interface DatingMatch {
  matchId: string;
  conversationId: string;
  participantA: string;
  participantB: string;
  talk2tmIdA: string;
  talk2tmIdB: string;
  displayNameA: string;
  displayNameB: string;
  matchedByUid: string;
  status: DatingMatchStatus;
  seenByA: boolean;
  seenByB: boolean;
  createdAt: string;
  updatedAt: string;
  chatStarted?: boolean;
  chatStartedAt?: string;
  unmatchedByUid?: string;
  unmatchedAt?: string;
}

export interface DatingLikeResult {
  matched: boolean;
  like: DatingLike;
  match?: DatingMatch;
  conversation?: Conversation;
}

/**
 * ====================================================================
 * FASE 3: SEGURANÇA, BLOQUEIOS, DENÚNCIAS (REPORTS) E ANTI-SPAM
 * ====================================================================
 */

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'fake_profile'
  | 'underage'
  | 'scam'
  | 'other';

export type ReportSourceType =
  | 'dating_profile'
  | 'dating_match'
  | 'chat_message'
  | 'connection';

export type ReportStatus = 'pending' | 'resolved' | 'dismissed';

export interface UserBlock {
  blockId: string; // `${blockerUid}_${blockedUid}`
  blockerUid: string;
  blockedUid: string;
  blockerTalk2tmId?: string;
  reason?: string;
  createdAt: string;
}

export interface ModerationReport {
  reportId: string;
  reporterUid: string;
  reporterTalk2tmId: string;
  targetUid: string;
  targetTalk2tmId?: string;
  targetDisplayName?: string;
  sourceType: ReportSourceType;
  channelId?: string;
  itemRefId?: string;
  reason: ReportReason;
  details?: string;
  evidenceSnapshot: string;
  status: ReportStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedByUid?: string;
  resolutionAction?: 'none' | 'account_suspended' | 'dismissed';
  resolutionNote?: string;
}

export interface UserRateLimitState {
  uid: string;
  dayKey: string;
  likeDayKey: string;
  likeCountToday: number;
  reportDayKey: string;
  reportCountToday: number;
  inviteDayKey: string;
  inviteCountToday: number;
  lastReportAtMs?: number;
  lastInviteAtMs?: number;
  updatedAt: string;
}

/**
 * ====================================================================
 * FASE 4: VIRALIZAÇÃO, LINKS DE CONVITE & ATRIBUIÇÃO DE REGISTOS
 * ====================================================================
 */

export interface ReferralLink {
  code: string;
  referrerUid: string;
  referrerDisplayName: string;
  active: boolean;
  createdAt: string;
}

export interface ReferralStats {
  uid: string;
  referralCode: string;
  invitesSharedCount: number;
  updatedAt: string;
}

export interface ReferralAttribution {
  newUid: string;
  newTalk2tmId: string;
  referralCode: string;
  referrerUid: string;
  createdAt: string;
}

export interface ReferralMetricsSummary {
  referralCode: string;
  inviteUrl: string;
  whatsappUrl: string;
  invitesSharedCount: number;
  convertedCount: number;
}

/**
 * ====================================================================
 * FASE 5: NOTIFICAÇÕES WEB PUSH DISCRETAS & INDICADORES DE CRESCIMENTO
 * ====================================================================
 */

export type DiscreetNotificationKind = 'message' | 'match';

export interface GrowthTelemetryRecord {
  uid: string;
  lastActiveAt: string;
  lastActiveDay: string;
  city?: string | null;
  cityKey?: string | null;
  countryCode?: string | null;
  updatedAt: string;
}

export interface AdminCityDistributionRow {
  city: string;
  cityKey: string;
  countryCode: string;
  activeCount: number;
  sharePercent: number;
}

export interface AdminGrowthMetricsSnapshot {
  generatedAt: string;
  totalActiveUsers: number;
  totalDatingProfiles: number;
  weeklyActiveUsers: number;
  weeklyRetentionPercent: number;
  referralConvertedUsers: number;
  referralConversionSharePercent: number;
  totalReferralShares: number;
  totalActiveReferralLinks: number;
  referralLinkConversionRatePercent: number;
  totalMatchesCreated: number;
  activeMatchedCount: number;
  avgMatchesPerUser: number;
  matchesWithChatStarted: number;
  postMatchConversationRatePercent: number;
  cityDistribution: AdminCityDistributionRow[];
}

