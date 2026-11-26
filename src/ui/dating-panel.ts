import {
  DATING_BIO_MAX_LENGTH,
  DATING_CITY_MAX_LENGTH,
  DATING_DAILY_DISCOVERY_LIMIT,
  DATING_MAX_AGE,
  DATING_MIN_AGE,
  filterActiveDatingMatches,
  getDatingMatchPartner,
  shouldDisplayCandidatePhoto,
  validateDatingFilters,
  validateDatingProfileInput,
} from '../dating';
import { compressImageToDatingWebP } from '../media/photo';
import { t } from '../i18n';
import {
  DatingDiscoveryFilters,
  DatingDiscoveryResult,
  DatingEvaluationDecision,
  DatingGender,
  DatingIntent,
  DatingLikeResult,
  DatingMatch,
  DatingProfile,
  DatingProfileInput,
  DatingSeeking,
  UserSession,
} from '../types';
import { detectSuggestedCountry, getCountryByIso, getCountryDisplayName, PHONE_COUNTRIES } from '../utils/phone';

export interface DatingPanelCallbacks {
  onLoadWorkspace?: () => Promise<{
    profile: DatingProfile | null;
    filters: DatingDiscoveryFilters;
    discovery: DatingDiscoveryResult | null;
    matches?: DatingMatch[];
  }>;
  onSaveProfile?: (input: DatingProfileInput) => Promise<{
    profile: DatingProfile;
    discovery: DatingDiscoveryResult | null;
  }>;
  onSetVisibility?: (opts: { discoverable?: boolean; paused?: boolean }) => Promise<DatingProfile>;
  onDiscover?: (
    filters: DatingDiscoveryFilters,
    cursorUpdatedAt?: string
  ) => Promise<DatingDiscoveryResult>;
  onEvaluate?: (targetUid: string, decision: DatingEvaluationDecision) => Promise<void>;
  onLike?: (candidate: DatingProfile) => Promise<DatingLikeResult>;
  onOpenMatchChat?: (match: DatingMatch) => Promise<void>;
  onUnmatch?: (matchId: string) => Promise<void>;
  onMarkMatchSeen?: (match: DatingMatch) => Promise<void>;
  onReportCandidate?: (candidate: DatingProfile) => void;
  onReportMatch?: (match: DatingMatch) => void;
  onBlockUser?: (targetUid: string, targetName: string) => Promise<void>;
  onUploadPhoto?: (blob: Blob) => Promise<DatingProfile>;
  onRemovePhoto?: () => Promise<DatingProfile>;
}

export class DatingPanel {
  public readonly rootEl: HTMLElement;
  private callbacks: DatingPanelCallbacks;

  private activeUid: string | null = null;
  private currentProfile: DatingProfile | null = null;
  private currentFilters: DatingDiscoveryFilters = validateDatingFilters({});
  private queue: DatingProfile[] = [];
  private usedToday = 0;
  private remainingToday = DATING_DAILY_DISCOVERY_LIMIT;
  private nextCursor?: string;
  private isLoading = false;
  private isEditingProfile = false;
  private showFilters = false;
  private lastError = '';
  private matches: DatingMatch[] = [];
  private celebratingMatch: DatingMatch | null = null;
  private pendingUnmatchId: string | null = null;
  private pendingUnmatchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBlockCandidateUid: string | null = null;
  private pendingBlockMatchId: string | null = null;
  private pendingBlockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoCelebratedMatchIds: Set<string> = new Set();
  private pendingPhotoBlob: Blob | null = null;
  private pendingPhotoPreviewUrl: string | null = null;
  private pendingPhotoBytes: number | null = null;
  private isPhotoProcessing = false;

  // Discovery elements
  private discoveryWrapEl!: HTMLElement;
  private quotaEl!: HTMLElement;
  private filtersToggleBtn!: HTMLButtonElement;
  private profileBtn!: HTMLButtonElement;
  private statusBannerEl!: HTMLElement;
  private statusBannerTextEl!: HTMLElement;
  private reactivateBtn!: HTMLButtonElement;

  private matchBannerCardEl!: HTMLElement;
  private matchBannerTitleEl!: HTMLElement;
  private matchBannerDescEl!: HTMLElement;
  private matchOpenChatBtn!: HTMLButtonElement;
  private matchContinueBtn!: HTMLButtonElement;

  private filtersCardEl!: HTMLElement;
  private filterMinAgeLabelEl!: HTMLElement;
  private filterMinAgeInput!: HTMLInputElement;
  private filterMaxAgeLabelEl!: HTMLElement;
  private filterMaxAgeInput!: HTMLInputElement;
  private filterSeekingLabelEl!: HTMLElement;
  private filterSeekingSelect!: HTMLSelectElement;
  private filterCountryLabelEl!: HTMLElement;
  private filterCountrySelect!: HTMLSelectElement;
  private filterCityInput!: HTMLInputElement;
  private filterApplyBtn!: HTMLButtonElement;

  private stageCardEl!: HTMLElement;
  private candidatePhotoEl!: HTMLImageElement;
  private candidateNameAgeEl!: HTMLElement;
  private candidateLocationEl!: HTMLElement;
  private candidateIntentEl!: HTMLElement;
  private candidateBioEl!: HTMLElement;
  private passBtn!: HTMLButtonElement;
  private likeBtn!: HTMLButtonElement;
  private candidateSafetyRowEl!: HTMLElement;
  private candidateReportBtn!: HTMLButtonElement;
  private candidateBlockBtn!: HTMLButtonElement;
  private phase1NoteEl!: HTMLElement;

  private emptyCardEl!: HTMLElement;
  private emptyTitleEl!: HTMLElement;
  private emptyDescEl!: HTMLElement;
  private refreshBtn!: HTMLButtonElement;
  private discoveryFeedbackEl!: HTMLElement;

  private matchesCardEl!: HTMLElement;
  private matchesTitleEl!: HTMLElement;
  private matchesListEl!: HTMLElement;

  // Profile / Setup elements
  private profileWrapEl!: HTMLElement;
  private profileTitleEl!: HTMLElement;
  private profileHintEl!: HTMLElement;
  private profileFormEl!: HTMLFormElement;
  private nameLabelEl!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private ageLabelEl!: HTMLElement;
  private ageInput!: HTMLInputElement;
  private genderLabelEl!: HTMLElement;
  private genderSelect!: HTMLSelectElement;
  private seekingLabelEl!: HTMLElement;
  private seekingSelect!: HTMLSelectElement;
  private countryLabelEl!: HTMLElement;
  private countrySelect!: HTMLSelectElement;
  private cityLabelEl!: HTMLElement;
  private cityInput!: HTMLInputElement;
  private intentLabelEl!: HTMLElement;
  private intentSelect!: HTMLSelectElement;
  private bioLabelEl!: HTMLElement;
  private bioCounterEl!: HTMLElement;
  private bioTextarea!: HTMLTextAreaElement;
  private photoLabelEl!: HTMLElement;
  private photoPreviewImgEl!: HTMLImageElement;
  private photoPlaceholderEl!: HTMLElement;
  private photoFileInput!: HTMLInputElement;
  private photoChooseBtn!: HTMLButtonElement;
  private photoRemoveBtn!: HTMLButtonElement;
  private photoStatusEl!: HTMLElement;
  private photoHintEl!: HTMLElement;
  private visibilityGroupEl!: HTMLElement;
  private discoverableCheckbox!: HTMLInputElement;
  private discoverableLabelEl!: HTMLElement;
  private pausedCheckbox!: HTMLInputElement;
  private pausedLabelEl!: HTMLElement;
  private adultCheckbox!: HTMLInputElement;
  private adultLabelEl!: HTMLElement;
  private termsCheckbox!: HTMLInputElement;
  private termsLabelEl!: HTMLElement;
  private termsToggleBtn!: HTMLButtonElement;
  private termsSummaryEl!: HTMLElement;
  private profileFeedbackEl!: HTMLElement;
  private saveProfileBtn!: HTMLButtonElement;
  private cancelEditBtn!: HTMLButtonElement;

  constructor(callbacks: DatingPanelCallbacks) {
    this.callbacks = callbacks;
    this.rootEl = document.createElement('div');
    this.rootEl.className = 'ttm-dating-root';
    this.buildDom();
  }

  private buildDom(): void {
    // 1. Discovery Workspace
    this.discoveryWrapEl = document.createElement('div');
    this.discoveryWrapEl.className = 'ttm-dating-section';
    this.discoveryWrapEl.style.display = 'none';

    const topBar = document.createElement('div');
    topBar.className = 'ttm-dating-topbar';

    this.quotaEl = document.createElement('span');
    this.quotaEl.className = 'ttm-dating-quota';

    const topActions = document.createElement('div');
    topActions.className = 'ttm-dating-top-actions';

    this.filtersToggleBtn = document.createElement('button');
    this.filtersToggleBtn.type = 'button';
    this.filtersToggleBtn.className = 'ttm-btn-mini';
    this.filtersToggleBtn.addEventListener('click', () => {
      this.showFilters = !this.showFilters;
      this.filtersCardEl.style.display = this.showFilters ? 'flex' : 'none';
    });

    this.profileBtn = document.createElement('button');
    this.profileBtn.type = 'button';
    this.profileBtn.className = 'ttm-btn-mini';
    this.profileBtn.addEventListener('click', () => {
      this.openProfileEditor();
    });

    topActions.appendChild(this.filtersToggleBtn);
    topActions.appendChild(this.profileBtn);
    topBar.appendChild(this.quotaEl);
    topBar.appendChild(topActions);

    this.statusBannerEl = document.createElement('div');
    this.statusBannerEl.className = 'ttm-dating-banner';
    this.statusBannerEl.style.display = 'none';
    this.statusBannerTextEl = document.createElement('div');
    this.statusBannerTextEl.className = 'ttm-dating-banner-text';
    this.reactivateBtn = document.createElement('button');
    this.reactivateBtn.type = 'button';
    this.reactivateBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    this.reactivateBtn.addEventListener('click', () => {
      void this.handleReactivate();
    });
    this.statusBannerEl.appendChild(this.statusBannerTextEl);
    this.statusBannerEl.appendChild(this.reactivateBtn);

    // Filters Card
    this.filtersCardEl = document.createElement('div');
    this.filtersCardEl.className = 'ttm-connect-card ttm-dating-filters';
    this.filtersCardEl.style.display = 'none';

    const ageRow = document.createElement('div');
    ageRow.className = 'ttm-dating-grid-2';

    const minAgeCol = document.createElement('div');
    minAgeCol.className = 'ttm-dating-field';
    this.filterMinAgeLabelEl = document.createElement('label');
    this.filterMinAgeLabelEl.className = 'ttm-setting-label';
    this.filterMinAgeInput = document.createElement('input');
    this.filterMinAgeInput.type = 'number';
    this.filterMinAgeInput.min = String(DATING_MIN_AGE);
    this.filterMinAgeInput.max = String(DATING_MAX_AGE);
    this.filterMinAgeInput.className = 'ttm-connect-input ttm-connect-input-phone';
    minAgeCol.appendChild(this.filterMinAgeLabelEl);
    minAgeCol.appendChild(this.filterMinAgeInput);

    const maxAgeCol = document.createElement('div');
    maxAgeCol.className = 'ttm-dating-field';
    this.filterMaxAgeLabelEl = document.createElement('label');
    this.filterMaxAgeLabelEl.className = 'ttm-setting-label';
    this.filterMaxAgeInput = document.createElement('input');
    this.filterMaxAgeInput.type = 'number';
    this.filterMaxAgeInput.min = String(DATING_MIN_AGE);
    this.filterMaxAgeInput.max = String(DATING_MAX_AGE);
    this.filterMaxAgeInput.className = 'ttm-connect-input ttm-connect-input-phone';
    maxAgeCol.appendChild(this.filterMaxAgeLabelEl);
    maxAgeCol.appendChild(this.filterMaxAgeInput);

    ageRow.appendChild(minAgeCol);
    ageRow.appendChild(maxAgeCol);

    const seekCountryRow = document.createElement('div');
    seekCountryRow.className = 'ttm-dating-grid-2';

    const seekCol = document.createElement('div');
    seekCol.className = 'ttm-dating-field';
    this.filterSeekingLabelEl = document.createElement('label');
    this.filterSeekingLabelEl.className = 'ttm-setting-label';
    this.filterSeekingSelect = document.createElement('select');
    this.filterSeekingSelect.className = 'ttm-select';
    seekCol.appendChild(this.filterSeekingLabelEl);
    seekCol.appendChild(this.filterSeekingSelect);

    const countryCol = document.createElement('div');
    countryCol.className = 'ttm-dating-field';
    this.filterCountryLabelEl = document.createElement('label');
    this.filterCountryLabelEl.className = 'ttm-setting-label';
    this.filterCountrySelect = document.createElement('select');
    this.filterCountrySelect.className = 'ttm-select';
    countryCol.appendChild(this.filterCountryLabelEl);
    countryCol.appendChild(this.filterCountrySelect);

    seekCountryRow.appendChild(seekCol);
    seekCountryRow.appendChild(countryCol);

    this.filterCityInput = document.createElement('input');
    this.filterCityInput.type = 'text';
    this.filterCityInput.maxLength = DATING_CITY_MAX_LENGTH;
    this.filterCityInput.className = 'ttm-connect-input ttm-connect-input-phone';

    this.filterApplyBtn = document.createElement('button');
    this.filterApplyBtn.type = 'button';
    this.filterApplyBtn.className = 'ttm-btn ttm-btn-primary';
    this.filterApplyBtn.addEventListener('click', () => {
      void this.handleApplyFilters();
    });

    this.filtersCardEl.appendChild(ageRow);
    this.filtersCardEl.appendChild(seekCountryRow);
    this.filtersCardEl.appendChild(this.filterCityInput);
    this.filtersCardEl.appendChild(this.filterApplyBtn);

    // Match Celebration Screen (#43)
    this.matchBannerCardEl = document.createElement('div');
    this.matchBannerCardEl.className = 'ttm-connect-card ttm-dating-match-banner';
    this.matchBannerCardEl.style.display = 'none';

    this.matchBannerTitleEl = document.createElement('div');
    this.matchBannerTitleEl.className = 'ttm-dating-match-title';

    this.matchBannerDescEl = document.createElement('div');
    this.matchBannerDescEl.className = 'ttm-dating-match-desc';

    const matchActions = document.createElement('div');
    matchActions.className = 'ttm-dating-match-actions';

    this.matchOpenChatBtn = document.createElement('button');
    this.matchOpenChatBtn.type = 'button';
    this.matchOpenChatBtn.className = 'ttm-btn ttm-btn-dating-like';
    this.matchOpenChatBtn.addEventListener('click', () => {
      void this.handleOpenCelebratedMatchChat();
    });

    this.matchContinueBtn = document.createElement('button');
    this.matchContinueBtn.type = 'button';
    this.matchContinueBtn.className = 'ttm-btn ttm-btn-secondary';
    this.matchContinueBtn.addEventListener('click', () => {
      this.dismissCelebrationBanner();
    });

    matchActions.appendChild(this.matchOpenChatBtn);
    matchActions.appendChild(this.matchContinueBtn);
    this.matchBannerCardEl.appendChild(this.matchBannerTitleEl);
    this.matchBannerCardEl.appendChild(this.matchBannerDescEl);
    this.matchBannerCardEl.appendChild(matchActions);

    // Single Candidate Card
    this.stageCardEl = document.createElement('div');
    this.stageCardEl.className = 'ttm-connect-card ttm-dating-card';
    this.stageCardEl.style.display = 'none';

    this.candidatePhotoEl = document.createElement('img');
    this.candidatePhotoEl.className = 'ttm-dating-card-photo';
    this.candidatePhotoEl.loading = 'lazy';
    this.candidatePhotoEl.referrerPolicy = 'no-referrer';
    this.candidatePhotoEl.style.display = 'none';

    const cardHead = document.createElement('div');
    cardHead.className = 'ttm-dating-card-head';
    this.candidateNameAgeEl = document.createElement('div');
    this.candidateNameAgeEl.className = 'ttm-dating-card-name';
    this.candidateIntentEl = document.createElement('span');
    this.candidateIntentEl.className = 'ttm-dating-intent-tag';
    cardHead.appendChild(this.candidateNameAgeEl);
    cardHead.appendChild(this.candidateIntentEl);

    this.candidateLocationEl = document.createElement('div');
    this.candidateLocationEl.className = 'ttm-dating-card-loc';

    this.candidateBioEl = document.createElement('p');
    this.candidateBioEl.className = 'ttm-dating-card-bio';

    const cardActions = document.createElement('div');
    cardActions.className = 'ttm-dating-card-actions';
    this.passBtn = document.createElement('button');
    this.passBtn.type = 'button';
    this.passBtn.className = 'ttm-btn ttm-btn-secondary';
    this.passBtn.addEventListener('click', () => {
      void this.handleEvaluateCurrent('pass');
    });

    this.likeBtn = document.createElement('button');
    this.likeBtn.type = 'button';
    this.likeBtn.className = 'ttm-btn ttm-btn-dating-like';
    this.likeBtn.addEventListener('click', () => {
      void this.handleLikeCurrent();
    });

    cardActions.appendChild(this.passBtn);
    cardActions.appendChild(this.likeBtn);

    this.candidateSafetyRowEl = document.createElement('div');
    this.candidateSafetyRowEl.className = 'ttm-dating-safety-row';

    this.candidateReportBtn = document.createElement('button');
    this.candidateReportBtn.type = 'button';
    this.candidateReportBtn.className = 'ttm-btn-mini';
    this.candidateReportBtn.addEventListener('click', () => {
      const candidate = this.queue[0];
      if (!candidate) return;
      this.callbacks.onReportCandidate?.(candidate);
    });

    this.candidateBlockBtn = document.createElement('button');
    this.candidateBlockBtn.type = 'button';
    this.candidateBlockBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
    this.candidateBlockBtn.addEventListener('click', () => {
      void this.handleBlockCurrentCandidate();
    });

    this.candidateSafetyRowEl.appendChild(this.candidateReportBtn);
    this.candidateSafetyRowEl.appendChild(this.candidateBlockBtn);

    this.phase1NoteEl = document.createElement('div');
    this.phase1NoteEl.className = 'ttm-field-hint ttm-dating-phase-note';

    this.stageCardEl.appendChild(this.candidatePhotoEl);
    this.stageCardEl.appendChild(cardHead);
    this.stageCardEl.appendChild(this.candidateLocationEl);
    this.stageCardEl.appendChild(this.candidateBioEl);
    this.stageCardEl.appendChild(cardActions);
    this.stageCardEl.appendChild(this.candidateSafetyRowEl);
    this.stageCardEl.appendChild(this.phase1NoteEl);

    // Empty / Limit / Loading Card
    this.emptyCardEl = document.createElement('div');
    this.emptyCardEl.className = 'ttm-connect-card ttm-dating-empty';
    this.emptyTitleEl = document.createElement('div');
    this.emptyTitleEl.className = 'ttm-dating-card-name';
    this.emptyDescEl = document.createElement('div');
    this.emptyDescEl.className = 'ttm-connect-empty';
    this.refreshBtn = document.createElement('button');
    this.refreshBtn.type = 'button';
    this.refreshBtn.className = 'ttm-btn ttm-btn-secondary';
    this.refreshBtn.addEventListener('click', () => {
      void this.handleApplyFilters();
    });
    this.emptyCardEl.appendChild(this.emptyTitleEl);
    this.emptyCardEl.appendChild(this.emptyDescEl);
    this.emptyCardEl.appendChild(this.refreshBtn);

    this.discoveryFeedbackEl = document.createElement('div');
    this.discoveryFeedbackEl.className = 'ttm-connect-feedback';

    // Active Dating Connections List (#44)
    this.matchesCardEl = document.createElement('div');
    this.matchesCardEl.className = 'ttm-connect-card ttm-dating-matches-card';
    this.matchesTitleEl = document.createElement('div');
    this.matchesTitleEl.className = 'ttm-connect-section-title';
    this.matchesListEl = document.createElement('div');
    this.matchesListEl.className = 'ttm-connect-list';
    this.matchesCardEl.appendChild(this.matchesTitleEl);
    this.matchesCardEl.appendChild(this.matchesListEl);

    this.discoveryWrapEl.appendChild(topBar);
    this.discoveryWrapEl.appendChild(this.statusBannerEl);
    this.discoveryWrapEl.appendChild(this.filtersCardEl);
    this.discoveryWrapEl.appendChild(this.matchBannerCardEl);
    this.discoveryWrapEl.appendChild(this.stageCardEl);
    this.discoveryWrapEl.appendChild(this.emptyCardEl);
    this.discoveryWrapEl.appendChild(this.discoveryFeedbackEl);
    this.discoveryWrapEl.appendChild(this.matchesCardEl);

    // 2. Profile Setup / Edit View
    this.profileWrapEl = document.createElement('div');
    this.profileWrapEl.className = 'ttm-connect-card ttm-dating-section';
    this.profileWrapEl.style.display = 'none';

    this.profileTitleEl = document.createElement('div');
    this.profileTitleEl.className = 'ttm-connect-section-title';

    this.profileHintEl = document.createElement('div');
    this.profileHintEl.className = 'ttm-field-hint ttm-dating-setup-hint';

    this.profileFormEl = document.createElement('form');
    this.profileFormEl.className = 'ttm-form';

    const nameRow = document.createElement('div');
    nameRow.className = 'ttm-dating-grid-name-age';

    const nameCol = document.createElement('div');
    nameCol.className = 'ttm-dating-field';
    this.nameLabelEl = document.createElement('label');
    this.nameLabelEl.className = 'ttm-setting-label';
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 30;
    this.nameInput.className = 'ttm-connect-input ttm-connect-input-phone';
    nameCol.appendChild(this.nameLabelEl);
    nameCol.appendChild(this.nameInput);

    const ageCol = document.createElement('div');
    ageCol.className = 'ttm-dating-field';
    this.ageLabelEl = document.createElement('label');
    this.ageLabelEl.className = 'ttm-setting-label';
    this.ageInput = document.createElement('input');
    this.ageInput.type = 'number';
    this.ageInput.min = String(DATING_MIN_AGE);
    this.ageInput.max = String(DATING_MAX_AGE);
    this.ageInput.inputMode = 'numeric';
    this.ageInput.className = 'ttm-connect-input ttm-connect-input-phone';
    ageCol.appendChild(this.ageLabelEl);
    ageCol.appendChild(this.ageInput);

    nameRow.appendChild(nameCol);
    nameRow.appendChild(ageCol);

    const genderRow = document.createElement('div');
    genderRow.className = 'ttm-dating-grid-2';

    const genderCol = document.createElement('div');
    genderCol.className = 'ttm-dating-field';
    this.genderLabelEl = document.createElement('label');
    this.genderLabelEl.className = 'ttm-setting-label';
    this.genderSelect = document.createElement('select');
    this.genderSelect.className = 'ttm-select';
    genderCol.appendChild(this.genderLabelEl);
    genderCol.appendChild(this.genderSelect);

    const seekingCol = document.createElement('div');
    seekingCol.className = 'ttm-dating-field';
    this.seekingLabelEl = document.createElement('label');
    this.seekingLabelEl.className = 'ttm-setting-label';
    this.seekingSelect = document.createElement('select');
    this.seekingSelect.className = 'ttm-select';
    seekingCol.appendChild(this.seekingLabelEl);
    seekingCol.appendChild(this.seekingSelect);

    genderRow.appendChild(genderCol);
    genderRow.appendChild(seekingCol);

    const locRow = document.createElement('div');
    locRow.className = 'ttm-dating-grid-2';

    const countryColForm = document.createElement('div');
    countryColForm.className = 'ttm-dating-field';
    this.countryLabelEl = document.createElement('label');
    this.countryLabelEl.className = 'ttm-setting-label';
    this.countrySelect = document.createElement('select');
    this.countrySelect.className = 'ttm-select';
    countryColForm.appendChild(this.countryLabelEl);
    countryColForm.appendChild(this.countrySelect);

    const cityColForm = document.createElement('div');
    cityColForm.className = 'ttm-dating-field';
    this.cityLabelEl = document.createElement('label');
    this.cityLabelEl.className = 'ttm-setting-label';
    this.cityInput = document.createElement('input');
    this.cityInput.type = 'text';
    this.cityInput.maxLength = DATING_CITY_MAX_LENGTH;
    this.cityInput.className = 'ttm-connect-input ttm-connect-input-phone';
    cityColForm.appendChild(this.cityLabelEl);
    cityColForm.appendChild(this.cityInput);

    locRow.appendChild(countryColForm);
    locRow.appendChild(cityColForm);

    const intentCol = document.createElement('div');
    intentCol.className = 'ttm-dating-field';
    this.intentLabelEl = document.createElement('label');
    this.intentLabelEl.className = 'ttm-setting-label';
    this.intentSelect = document.createElement('select');
    this.intentSelect.className = 'ttm-select';
    intentCol.appendChild(this.intentLabelEl);
    intentCol.appendChild(this.intentSelect);

    const bioCol = document.createElement('div');
    bioCol.className = 'ttm-dating-field';
    const bioHead = document.createElement('div');
    bioHead.className = 'ttm-dating-bio-head';
    this.bioLabelEl = document.createElement('label');
    this.bioLabelEl.className = 'ttm-setting-label';
    this.bioCounterEl = document.createElement('span');
    this.bioCounterEl.className = 'ttm-setting-label';
    bioHead.appendChild(this.bioLabelEl);
    bioHead.appendChild(this.bioCounterEl);

    this.bioTextarea = document.createElement('textarea');
    this.bioTextarea.rows = 3;
    this.bioTextarea.maxLength = DATING_BIO_MAX_LENGTH;
    this.bioTextarea.className = 'ttm-dating-textarea';
    this.bioTextarea.addEventListener('input', () => {
      this.updateBioCounter();
    });
    bioCol.appendChild(bioHead);
    bioCol.appendChild(this.bioTextarea);

    // Optional Single Photo Upload (WebP client-compressed <= 420px)
    const photoCol = document.createElement('div');
    photoCol.className = 'ttm-dating-field ttm-dating-photo-box';
    this.photoLabelEl = document.createElement('label');
    this.photoLabelEl.className = 'ttm-setting-label';

    const photoRow = document.createElement('div');
    photoRow.className = 'ttm-dating-photo-row';

    const photoPreviewFrame = document.createElement('div');
    photoPreviewFrame.className = 'ttm-dating-photo-preview';
    this.photoPreviewImgEl = document.createElement('img');
    this.photoPreviewImgEl.className = 'ttm-dating-photo-img';
    this.photoPreviewImgEl.referrerPolicy = 'no-referrer';
    this.photoPreviewImgEl.style.display = 'none';
    this.photoPlaceholderEl = document.createElement('span');
    this.photoPlaceholderEl.className = 'ttm-dating-photo-placeholder';
    photoPreviewFrame.appendChild(this.photoPreviewImgEl);
    photoPreviewFrame.appendChild(this.photoPlaceholderEl);

    const photoMetaCol = document.createElement('div');
    photoMetaCol.className = 'ttm-dating-photo-meta';

    this.photoStatusEl = document.createElement('div');
    this.photoStatusEl.className = 'ttm-dating-photo-status';

    this.photoHintEl = document.createElement('div');
    this.photoHintEl.className = 'ttm-field-hint';

    this.photoFileInput = document.createElement('input');
    this.photoFileInput.type = 'file';
    this.photoFileInput.accept = 'image/jpeg,image/png,image/webp';
    this.photoFileInput.style.display = 'none';
    this.photoFileInput.addEventListener('change', () => {
      const file = this.photoFileInput.files?.[0];
      this.photoFileInput.value = '';
      if (file) {
        void this.handleSelectPhotoFile(file);
      }
    });

    const photoActions = document.createElement('div');
    photoActions.className = 'ttm-dating-photo-actions';

    this.photoChooseBtn = document.createElement('button');
    this.photoChooseBtn.type = 'button';
    this.photoChooseBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    this.photoChooseBtn.addEventListener('click', () => {
      if (this.isPhotoProcessing) return;
      this.photoFileInput.click();
    });

    this.photoRemoveBtn = document.createElement('button');
    this.photoRemoveBtn.type = 'button';
    this.photoRemoveBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
    this.photoRemoveBtn.style.display = 'none';
    this.photoRemoveBtn.addEventListener('click', () => {
      void this.handleRemovePhotoClick();
    });

    photoActions.appendChild(this.photoChooseBtn);
    photoActions.appendChild(this.photoRemoveBtn);
    photoMetaCol.appendChild(this.photoStatusEl);
    photoMetaCol.appendChild(photoActions);
    photoMetaCol.appendChild(this.photoHintEl);

    photoRow.appendChild(photoPreviewFrame);
    photoRow.appendChild(photoMetaCol);
    photoCol.appendChild(this.photoLabelEl);
    photoCol.appendChild(photoRow);
    photoCol.appendChild(this.photoFileInput);

    this.visibilityGroupEl = document.createElement('div');
    this.visibilityGroupEl.className = 'ttm-dating-checks';
    const visRow1 = document.createElement('label');
    visRow1.className = 'ttm-dating-check-row';
    this.discoverableCheckbox = document.createElement('input');
    this.discoverableCheckbox.type = 'checkbox';
    this.discoverableCheckbox.checked = true;
    this.discoverableLabelEl = document.createElement('span');
    visRow1.appendChild(this.discoverableCheckbox);
    visRow1.appendChild(this.discoverableLabelEl);

    const visRow2 = document.createElement('label');
    visRow2.className = 'ttm-dating-check-row';
    this.pausedCheckbox = document.createElement('input');
    this.pausedCheckbox.type = 'checkbox';
    this.pausedCheckbox.checked = false;
    this.pausedLabelEl = document.createElement('span');
    visRow2.appendChild(this.pausedCheckbox);
    visRow2.appendChild(this.pausedLabelEl);

    this.visibilityGroupEl.appendChild(visRow1);
    this.visibilityGroupEl.appendChild(visRow2);

    const legalGroup = document.createElement('div');
    legalGroup.className = 'ttm-dating-checks';

    const adultRow = document.createElement('label');
    adultRow.className = 'ttm-dating-check-row';
    this.adultCheckbox = document.createElement('input');
    this.adultCheckbox.type = 'checkbox';
    this.adultLabelEl = document.createElement('span');
    adultRow.appendChild(this.adultCheckbox);
    adultRow.appendChild(this.adultLabelEl);

    const termsRow = document.createElement('label');
    termsRow.className = 'ttm-dating-check-row';
    this.termsCheckbox = document.createElement('input');
    this.termsCheckbox.type = 'checkbox';
    this.termsLabelEl = document.createElement('span');
    termsRow.appendChild(this.termsCheckbox);
    termsRow.appendChild(this.termsLabelEl);

    this.termsToggleBtn = document.createElement('button');
    this.termsToggleBtn.type = 'button';
    this.termsToggleBtn.className = 'ttm-link-btn';
    this.termsSummaryEl = document.createElement('div');
    this.termsSummaryEl.className = 'ttm-dating-terms-box';
    this.termsSummaryEl.style.display = 'none';
    this.termsToggleBtn.addEventListener('click', () => {
      const open = this.termsSummaryEl.style.display === 'block';
      this.termsSummaryEl.style.display = open ? 'none' : 'block';
    });

    legalGroup.appendChild(adultRow);
    legalGroup.appendChild(termsRow);
    legalGroup.appendChild(this.termsToggleBtn);
    legalGroup.appendChild(this.termsSummaryEl);

    this.profileFeedbackEl = document.createElement('div');
    this.profileFeedbackEl.className = 'ttm-connect-feedback';

    this.saveProfileBtn = document.createElement('button');
    this.saveProfileBtn.type = 'submit';
    this.saveProfileBtn.className = 'ttm-btn ttm-btn-primary';

    this.cancelEditBtn = document.createElement('button');
    this.cancelEditBtn.type = 'button';
    this.cancelEditBtn.className = 'ttm-btn ttm-btn-secondary';
    this.cancelEditBtn.style.display = 'none';
    this.cancelEditBtn.addEventListener('click', () => {
      this.isEditingProfile = false;
      this.render();
    });

    this.profileFormEl.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleSaveProfileSubmit();
    });

    this.profileFormEl.appendChild(nameRow);
    this.profileFormEl.appendChild(genderRow);
    this.profileFormEl.appendChild(locRow);
    this.profileFormEl.appendChild(intentCol);
    this.profileFormEl.appendChild(bioCol);
    this.profileFormEl.appendChild(photoCol);
    this.profileFormEl.appendChild(this.visibilityGroupEl);
    this.profileFormEl.appendChild(legalGroup);
    this.profileFormEl.appendChild(this.profileFeedbackEl);
    this.profileFormEl.appendChild(this.saveProfileBtn);
    this.profileFormEl.appendChild(this.cancelEditBtn);

    this.profileWrapEl.appendChild(this.profileTitleEl);
    this.profileWrapEl.appendChild(this.profileHintEl);
    this.profileWrapEl.appendChild(this.profileFormEl);

    this.rootEl.appendChild(this.discoveryWrapEl);
    this.rootEl.appendChild(this.profileWrapEl);

    this.refreshLocale();
  }

  private populateSelectOptions(): void {
    const prevGender = (this.genderSelect.value || 'woman') as DatingGender;
    const prevSeeking = (this.seekingSelect.value || 'all') as DatingSeeking;
    const prevFilterSeeking = (this.filterSeekingSelect.value || 'all') as DatingSeeking;
    const prevIntent = (this.intentSelect.value || 'meet_people') as DatingIntent;
    const prevCountry = this.countrySelect.value || detectSuggestedCountry().iso || 'AO';
    const prevFilterCountry = this.filterCountrySelect.value || '';

    this.genderSelect.innerHTML = '';
    const genderOpts: Array<[DatingGender, string]> = [
      ['woman', t('dating.genderWoman')],
      ['man', t('dating.genderMan')],
      ['non_binary', t('dating.genderNonBinary')],
    ];
    for (const [val, label] of genderOpts) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      this.genderSelect.appendChild(opt);
    }
    this.genderSelect.value = prevGender;

    const seekingOpts: Array<[DatingSeeking, string]> = [
      ['women', t('dating.seekingWomen')],
      ['men', t('dating.seekingMen')],
      ['all', t('dating.seekingAll')],
    ];
    this.seekingSelect.innerHTML = '';
    this.filterSeekingSelect.innerHTML = '';
    for (const [val, label] of seekingOpts) {
      const opt1 = document.createElement('option');
      opt1.value = val;
      opt1.textContent = label;
      this.seekingSelect.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = val;
      opt2.textContent = label;
      this.filterSeekingSelect.appendChild(opt2);
    }
    this.seekingSelect.value = prevSeeking;
    this.filterSeekingSelect.value = prevFilterSeeking;

    this.intentSelect.innerHTML = '';
    const intentOpts: Array<[DatingIntent, string]> = [
      ['serious', t('dating.intentSerious')],
      ['meet_people', t('dating.intentMeetPeople')],
      ['chat', t('dating.intentChat')],
    ];
    for (const [val, label] of intentOpts) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      this.intentSelect.appendChild(opt);
    }
    this.intentSelect.value = prevIntent;

    const sortedCountries = [...PHONE_COUNTRIES].sort((a, b) =>
      getCountryDisplayName(a).localeCompare(getCountryDisplayName(b))
    );

    this.countrySelect.innerHTML = '';
    this.filterCountrySelect.innerHTML = '';

    const allCountriesOpt = document.createElement('option');
    allCountriesOpt.value = '';
    allCountriesOpt.textContent = t('dating.filterAllCountries');
    this.filterCountrySelect.appendChild(allCountriesOpt);

    for (const c of sortedCountries) {
      const label = `${c.flag} ${getCountryDisplayName(c)}`;
      const optForm = document.createElement('option');
      optForm.value = c.iso;
      optForm.textContent = label;
      this.countrySelect.appendChild(optForm);

      const optFilter = document.createElement('option');
      optFilter.value = c.iso;
      optFilter.textContent = label;
      this.filterCountrySelect.appendChild(optFilter);
    }

    this.countrySelect.value = prevCountry;
    this.filterCountrySelect.value = prevFilterCountry;
  }

  public refreshLocale(): void {
    this.populateSelectOptions();

    this.filtersToggleBtn.textContent = t('dating.filtersBtn');
    this.profileBtn.textContent = t('dating.profileBtn');
    this.reactivateBtn.textContent = t('dating.reactivateBtn');

    this.filterMinAgeLabelEl.textContent = t('dating.filterAgeMin');
    this.filterMaxAgeLabelEl.textContent = t('dating.filterAgeMax');
    this.filterSeekingLabelEl.textContent = t('dating.filterSeeking');
    this.filterCountryLabelEl.textContent = t('dating.filterCountry');
    this.filterCityInput.placeholder = t('dating.filterCity');
    this.filterApplyBtn.textContent = t('dating.filterApplyBtn');

    this.matchBannerTitleEl.textContent = t('dating.matchBannerTitle');
    this.matchOpenChatBtn.textContent = t('dating.matchOpenChatBtn');
    this.matchContinueBtn.textContent = t('dating.matchContinueBtn');

    this.passBtn.textContent = t('dating.passBtn');
    this.likeBtn.textContent = t('dating.likeBtn');
    this.candidateReportBtn.textContent = t('dating.reportBtn');
    this.candidateBlockBtn.textContent = t('dating.blockBtn');
    this.phase1NoteEl.textContent = t('dating.phase1MatchNote');
    this.refreshBtn.textContent = t('dating.refreshBtn');

    this.profileHintEl.textContent = t('dating.setupHint');
    this.nameLabelEl.textContent = t('dating.nameLabel');
    this.nameInput.placeholder = t('dating.namePlaceholder');
    this.ageLabelEl.textContent = t('dating.ageLabel');
    this.genderLabelEl.textContent = t('dating.genderLabel');
    this.seekingLabelEl.textContent = t('dating.seekingLabel');
    this.countryLabelEl.textContent = t('dating.countryLabel');
    this.cityLabelEl.textContent = t('dating.cityLabel');
    this.cityInput.placeholder = t('dating.cityPlaceholder');
    this.intentLabelEl.textContent = t('dating.intentLabel');
    this.bioLabelEl.textContent = t('dating.bioLabel', { max: DATING_BIO_MAX_LENGTH });
    this.bioTextarea.placeholder = t('dating.bioPlaceholder');
    this.photoLabelEl.textContent = t('dating.photoLabel');
    this.photoPlaceholderEl.textContent = t('dating.photoPlaceholder');
    this.photoHintEl.textContent = t('dating.photoHint');
    this.photoRemoveBtn.textContent = t('dating.photoRemoveBtn');
    this.discoverableLabelEl.textContent = t('dating.discoverableLabel');
    this.pausedLabelEl.textContent = t('dating.pausedLabel');
    this.adultLabelEl.textContent = t('dating.adultCheckLabel');
    this.termsLabelEl.textContent = t('dating.termsCheckLabel');
    this.termsToggleBtn.textContent = t('dating.termsToggleBtn');
    this.termsSummaryEl.textContent = t('dating.termsSummary');
    this.saveProfileBtn.textContent = t('dating.saveProfileBtn');
    this.cancelEditBtn.textContent = t('dating.cancelEditBtn');

    this.updateBioCounter();
    this.render();
  }

  private updateBioCounter(): void {
    const count = (this.bioTextarea.value || '').length;
    this.bioCounterEl.textContent = t('dating.bioCounter', {
      count,
      max: DATING_BIO_MAX_LENGTH,
    });
  }

  private mapPhotoError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err || '');
    if (msg === 'PHOTO_UNSUPPORTED_TYPE') return t('dating.photoErrType');
    if (msg === 'PHOTO_FILE_TOO_LARGE' || msg === 'PHOTO_COMPRESSION_EXCEEDED_LIMIT') {
      return t('dating.photoErrSize');
    }
    if (msg === 'WEBP_ENCODE_UNSUPPORTED' || msg === 'CANVAS_UNSUPPORTED' || msg === 'IMAGE_PROCESSING_UNSUPPORTED') {
      return t('dating.photoErrUnsupported');
    }
    return msg || t('app.unexpectedError');
  }

  private renderPhotoEditorState(): void {
    const previewUrl = this.pendingPhotoPreviewUrl || this.currentProfile?.photoUrl || '';
    if (previewUrl) {
      this.photoPreviewImgEl.src = previewUrl;
      this.photoPreviewImgEl.alt = this.nameInput.value || t('dating.photoLabel');
      this.photoPreviewImgEl.style.display = 'block';
      this.photoPlaceholderEl.style.display = 'none';
    } else {
      this.photoPreviewImgEl.style.display = 'none';
      this.photoPreviewImgEl.src = '';
      this.photoPlaceholderEl.style.display = 'flex';
    }

    const hasAnyPhoto = Boolean(this.pendingPhotoBlob || this.currentProfile?.photoUrl);
    this.photoChooseBtn.disabled = this.isPhotoProcessing;
    this.photoRemoveBtn.disabled = this.isPhotoProcessing;
    this.photoChooseBtn.textContent = this.isPhotoProcessing
      ? t('dating.photoProcessing')
      : hasAnyPhoto
      ? t('dating.photoReplaceBtn')
      : t('dating.photoChooseBtn');
    this.photoRemoveBtn.style.display = hasAnyPhoto && !this.isPhotoProcessing ? 'inline-flex' : 'none';

    if (this.pendingPhotoBlob && this.pendingPhotoBytes) {
      const kb = Math.max(1, Math.round(this.pendingPhotoBytes / 1024));
      this.photoStatusEl.textContent = t('dating.photoStagedReady', { kb });
      return;
    }

    const status = this.currentProfile?.photoStatus || 'none';
    if (status === 'approved' && this.currentProfile?.photoUrl) {
      this.photoStatusEl.textContent = t('dating.photoStatusApproved');
    } else if (status === 'pending' && this.currentProfile?.photoUrl) {
      this.photoStatusEl.textContent = t('dating.photoStatusPending');
    } else if (status === 'rejected') {
      this.photoStatusEl.textContent = this.currentProfile?.photoModerationNote
        ? t('dating.photoStatusRejectedNote', { note: this.currentProfile.photoModerationNote })
        : t('dating.photoStatusRejected');
    } else {
      this.photoStatusEl.textContent = t('dating.photoStatusNone');
    }
  }

  private async handleSelectPhotoFile(file: File): Promise<void> {
    this.isPhotoProcessing = true;
    this.profileFeedbackEl.textContent = '';
    this.profileFeedbackEl.classList.remove('is-error');
    this.renderPhotoEditorState();

    try {
      const compressed = await compressImageToDatingWebP(file);
      this.pendingPhotoBlob = compressed.blob;
      this.pendingPhotoPreviewUrl = compressed.previewDataUrl;
      this.pendingPhotoBytes = compressed.byteSize;
      this.renderPhotoEditorState();

      if (this.currentProfile && this.callbacks.onUploadPhoto) {
        const updated = await this.callbacks.onUploadPhoto(compressed.blob);
        this.currentProfile = updated;
        this.pendingPhotoBlob = null;
        this.pendingPhotoPreviewUrl = null;
        this.pendingPhotoBytes = null;
        const kb = Math.max(1, Math.round(compressed.byteSize / 1024));
        this.profileFeedbackEl.textContent = t('dating.photoUploadedPending', { kb });
        this.profileFeedbackEl.classList.remove('is-error');
      }
    } catch (err) {
      this.pendingPhotoBlob = null;
      this.pendingPhotoPreviewUrl = null;
      this.pendingPhotoBytes = null;
      this.profileFeedbackEl.textContent = this.mapPhotoError(err);
      this.profileFeedbackEl.classList.add('is-error');
    } finally {
      this.isPhotoProcessing = false;
      this.renderPhotoEditorState();
    }
  }

  private async handleRemovePhotoClick(): Promise<void> {
    if (this.isPhotoProcessing) return;
    if (this.pendingPhotoBlob && !this.currentProfile) {
      this.pendingPhotoBlob = null;
      this.pendingPhotoPreviewUrl = null;
      this.pendingPhotoBytes = null;
      this.renderPhotoEditorState();
      return;
    }

    if (!this.currentProfile || !this.callbacks.onRemovePhoto) {
      this.pendingPhotoBlob = null;
      this.pendingPhotoPreviewUrl = null;
      this.pendingPhotoBytes = null;
      this.renderPhotoEditorState();
      return;
    }

    this.isPhotoProcessing = true;
    this.profileFeedbackEl.textContent = '';
    this.profileFeedbackEl.classList.remove('is-error');
    this.renderPhotoEditorState();

    try {
      this.currentProfile = await this.callbacks.onRemovePhoto();
      this.pendingPhotoBlob = null;
      this.pendingPhotoPreviewUrl = null;
      this.pendingPhotoBytes = null;
      this.profileFeedbackEl.textContent = t('dating.photoRemoved');
    } catch (err) {
      this.profileFeedbackEl.textContent = this.mapPhotoError(err);
      this.profileFeedbackEl.classList.add('is-error');
    } finally {
      this.isPhotoProcessing = false;
      this.renderPhotoEditorState();
    }
  }

  public reset(): void {
    this.activeUid = null;
    this.currentProfile = null;
    this.queue = [];
    this.usedToday = 0;
    this.remainingToday = DATING_DAILY_DISCOVERY_LIMIT;
    this.nextCursor = undefined;
    this.isLoading = false;
    this.isEditingProfile = false;
    this.showFilters = false;
    this.lastError = '';
    this.matches = [];
    this.celebratingMatch = null;
    this.pendingUnmatchId = null;
    if (this.pendingUnmatchTimer) {
      clearTimeout(this.pendingUnmatchTimer);
      this.pendingUnmatchTimer = null;
    }
    this.pendingBlockCandidateUid = null;
    this.pendingBlockMatchId = null;
    if (this.pendingBlockTimer) {
      clearTimeout(this.pendingBlockTimer);
      this.pendingBlockTimer = null;
    }
    this.autoCelebratedMatchIds.clear();
    this.pendingPhotoBlob = null;
    this.pendingPhotoPreviewUrl = null;
    this.pendingPhotoBytes = null;
    this.isPhotoProcessing = false;
    this.filtersCardEl.style.display = 'none';
    this.discoveryFeedbackEl.textContent = '';
    this.profileFeedbackEl.textContent = '';
    this.render();
  }

  public updateMatches(matches: DatingMatch[]): void {
    this.matches = matches;
    if (this.celebratingMatch) {
      const updated = matches.find((m) => m.matchId === this.celebratingMatch?.matchId);
      if (updated && updated.status === 'matched') {
        this.celebratingMatch = updated;
      } else if (updated && updated.status === 'unmatched') {
        this.celebratingMatch = null;
      }
    }

    if (
      !this.celebratingMatch &&
      !this.isEditingProfile &&
      this.currentProfile &&
      this.activeUid &&
      this.rootEl.style.display !== 'none'
    ) {
      const active = filterActiveDatingMatches(matches, this.activeUid);
      const unseen = active.find((m) => {
        const isSeen = m.participantA === this.activeUid ? m.seenByA : m.seenByB;
        return !isSeen && !this.autoCelebratedMatchIds.has(m.matchId);
      });
      if (unseen) {
        this.celebratingMatch = unseen;
        this.autoCelebratedMatchIds.add(unseen.matchId);
      }
    }

    this.render();
  }

  public async loadForSession(session: UserSession): Promise<void> {
    if (!session.talk2tmId) return;
    if (this.activeUid !== session.userId) {
      this.reset();
      this.activeUid = session.userId;
      this.nameInput.value = session.displayName || '';
    }

    if (!this.callbacks.onLoadWorkspace) return;
    this.isLoading = true;
    this.lastError = '';
    this.render();

    try {
      const workspace = await this.callbacks.onLoadWorkspace();
      this.currentProfile = workspace.profile;
      this.currentFilters = workspace.filters;
      this.syncFiltersToInputs();
      if (workspace.matches) {
        this.matches = workspace.matches;
      }
      if (workspace.discovery) {
        this.applyDiscoveryResult(workspace.discovery);
      } else {
        this.queue = [];
      }
      if (!this.currentProfile) {
        this.isEditingProfile = true;
        this.populateProfileFormFromSession(session);
      } else {
        this.isEditingProfile = false;
        this.populateProfileFormFromExisting(this.currentProfile);
      }
      if (!this.celebratingMatch && !this.isEditingProfile && this.activeUid) {
        const active = filterActiveDatingMatches(this.matches, this.activeUid);
        const unseen = active.find((m) => {
          const isSeen = m.participantA === this.activeUid ? m.seenByA : m.seenByB;
          return !isSeen && !this.autoCelebratedMatchIds.has(m.matchId);
        });
        if (unseen) {
          this.celebratingMatch = unseen;
          this.autoCelebratedMatchIds.add(unseen.matchId);
        }
      }
    } catch (err: any) {
      this.lastError = err?.message || t('app.unexpectedError');
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  private populateProfileFormFromSession(session: UserSession): void {
    this.nameInput.value = session.displayName || '';
    this.ageInput.value = '';
    this.genderSelect.value = 'woman';
    this.seekingSelect.value = 'all';
    this.countrySelect.value = detectSuggestedCountry().iso || 'AO';
    this.cityInput.value = '';
    this.intentSelect.value = 'meet_people';
    this.bioTextarea.value = '';
    this.discoverableCheckbox.checked = true;
    this.pausedCheckbox.checked = false;
    this.adultCheckbox.checked = false;
    this.termsCheckbox.checked = false;
    this.updateBioCounter();
  }

  private populateProfileFormFromExisting(profile: DatingProfile): void {
    this.nameInput.value = profile.displayName;
    this.ageInput.value = String(profile.age);
    this.genderSelect.value = profile.gender;
    this.seekingSelect.value = profile.seeking;
    this.countrySelect.value = profile.countryCode;
    this.cityInput.value = profile.city;
    this.intentSelect.value = profile.intent;
    this.bioTextarea.value = profile.bio;
    this.discoverableCheckbox.checked = profile.discoverable;
    this.pausedCheckbox.checked = profile.paused;
    this.adultCheckbox.checked = profile.adultConfirmed;
    this.termsCheckbox.checked = Boolean(profile.termsAcceptedAt);
    this.updateBioCounter();
  }

  private syncFiltersToInputs(): void {
    this.filterMinAgeInput.value = String(this.currentFilters.minAge);
    this.filterMaxAgeInput.value = String(this.currentFilters.maxAge);
    this.filterSeekingSelect.value = this.currentFilters.seeking;
    this.filterCountrySelect.value = this.currentFilters.countryCode;
    this.filterCityInput.value = this.currentFilters.city;
  }

  private applyDiscoveryResult(result: DatingDiscoveryResult): void {
    this.queue = [...result.candidates];
    this.usedToday = result.usedToday;
    this.remainingToday = result.remainingToday;
    this.nextCursor = result.nextCursorUpdatedAt;
  }

  private openProfileEditor(): void {
    this.isEditingProfile = true;
    this.profileFeedbackEl.textContent = '';
    this.profileFeedbackEl.classList.remove('is-error');
    if (this.currentProfile) {
      this.populateProfileFormFromExisting(this.currentProfile);
    }
    this.render();
  }

  private async handleSaveProfileSubmit(): Promise<void> {
    this.profileFeedbackEl.textContent = '';
    this.profileFeedbackEl.classList.remove('is-error');

    const input: DatingProfileInput = {
      displayName: this.nameInput.value,
      age: Number(this.ageInput.value),
      gender: this.genderSelect.value as DatingGender,
      seeking: this.seekingSelect.value as DatingSeeking,
      countryCode: this.countrySelect.value,
      city: this.cityInput.value,
      bio: this.bioTextarea.value,
      intent: this.intentSelect.value as DatingIntent,
      adultConfirmed: this.adultCheckbox.checked,
      termsAccepted: this.termsCheckbox.checked,
      discoverable: this.discoverableCheckbox.checked,
      paused: this.pausedCheckbox.checked,
    };

    const check = validateDatingProfileInput(input);
    if (!check.valid) {
      this.profileFeedbackEl.textContent = check.error || t('dating.errProfileInvalid');
      this.profileFeedbackEl.classList.add('is-error');
      return;
    }

    if (!this.callbacks.onSaveProfile) return;
    this.saveProfileBtn.disabled = true;
    this.saveProfileBtn.textContent = t('dating.savingBtn');
    try {
      const res = await this.callbacks.onSaveProfile(input);
      this.currentProfile = res.profile;
      if (this.pendingPhotoBlob && this.callbacks.onUploadPhoto) {
        try {
          this.currentProfile = await this.callbacks.onUploadPhoto(this.pendingPhotoBlob);
          this.pendingPhotoBlob = null;
          this.pendingPhotoPreviewUrl = null;
          this.pendingPhotoBytes = null;
        } catch (photoErr) {
          this.discoveryFeedbackEl.textContent = this.mapPhotoError(photoErr);
          this.discoveryFeedbackEl.classList.add('is-error');
        }
      }
      if (res.discovery) {
        this.applyDiscoveryResult(res.discovery);
      } else {
        this.queue = [];
      }
      this.isEditingProfile = false;
      if (!this.discoveryFeedbackEl.classList.contains('is-error')) {
        this.discoveryFeedbackEl.textContent = t('dating.profileSaved');
      }
      this.render();
    } catch (err: any) {
      this.profileFeedbackEl.textContent = err?.message || t('app.unexpectedError');
      this.profileFeedbackEl.classList.add('is-error');
    } finally {
      this.saveProfileBtn.disabled = false;
      this.saveProfileBtn.textContent = t('dating.saveProfileBtn');
    }
  }

  private async handleReactivate(): Promise<void> {
    if (!this.callbacks.onSetVisibility) return;
    this.reactivateBtn.disabled = true;
    try {
      this.currentProfile = await this.callbacks.onSetVisibility({
        discoverable: true,
        paused: false,
      });
      await this.handleApplyFilters();
    } catch (err: any) {
      this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
      this.discoveryFeedbackEl.classList.add('is-error');
    } finally {
      this.reactivateBtn.disabled = false;
      this.render();
    }
  }

  private async handleApplyFilters(cursorUpdatedAt?: string): Promise<void> {
    if (!this.callbacks.onDiscover) return;
    this.currentFilters = validateDatingFilters({
      minAge: Number(this.filterMinAgeInput.value),
      maxAge: Number(this.filterMaxAgeInput.value),
      seeking: this.filterSeekingSelect.value as DatingSeeking,
      countryCode: this.filterCountrySelect.value,
      city: this.filterCityInput.value,
    });
    this.syncFiltersToInputs();
    this.isLoading = true;
    this.lastError = '';
    this.discoveryFeedbackEl.textContent = '';
    this.render();

    try {
      const res = await this.callbacks.onDiscover(this.currentFilters, cursorUpdatedAt);
      this.applyDiscoveryResult(res);
    } catch (err: any) {
      this.lastError = err?.message || t('app.unexpectedError');
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  private dismissCelebrationBanner(): void {
    const match = this.celebratingMatch;
    this.celebratingMatch = null;
    if (match && this.callbacks.onMarkMatchSeen) {
      void this.callbacks.onMarkMatchSeen(match).catch(() => {});
    }
    this.render();
  }

  private async handleOpenCelebratedMatchChat(): Promise<void> {
    const match = this.celebratingMatch;
    if (!match || !this.callbacks.onOpenMatchChat) return;
    this.matchOpenChatBtn.disabled = true;
    this.matchContinueBtn.disabled = true;
    try {
      this.celebratingMatch = null;
      await this.callbacks.onOpenMatchChat(match);
    } catch (err: any) {
      this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
      this.discoveryFeedbackEl.classList.add('is-error');
    } finally {
      this.matchOpenChatBtn.disabled = false;
      this.matchContinueBtn.disabled = false;
    }
  }

  private async handleLikeCurrent(): Promise<void> {
    const candidate = this.queue[0];
    if (!candidate || !this.callbacks.onLike) return;

    this.passBtn.disabled = true;
    this.likeBtn.disabled = true;
    this.discoveryFeedbackEl.textContent = '';
    this.discoveryFeedbackEl.classList.remove('is-error');

    try {
      const res = await this.callbacks.onLike(candidate);
      this.queue.shift();
      this.usedToday = Math.min(DATING_DAILY_DISCOVERY_LIMIT, this.usedToday + 1);
      this.remainingToday = Math.max(0, DATING_DAILY_DISCOVERY_LIMIT - this.usedToday);

      if (res.matched && res.match) {
        this.celebratingMatch = res.match;
        this.autoCelebratedMatchIds.add(res.match.matchId);
        if (!this.matches.some((m) => m.matchId === res.match!.matchId)) {
          this.matches = [res.match, ...this.matches];
        }
      } else {
        this.discoveryFeedbackEl.textContent = t('dating.likeSentNotice');
        this.discoveryFeedbackEl.classList.remove('is-error');
      }

      if (this.queue.length === 0 && this.remainingToday > 0 && this.nextCursor) {
        await this.handleApplyFilters(this.nextCursor);
        return;
      }
      this.render();
    } catch (err: any) {
      this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
      this.discoveryFeedbackEl.classList.add('is-error');
    } finally {
      this.passBtn.disabled = false;
      this.likeBtn.disabled = false;
    }
  }

  private async handleEvaluateCurrent(decision: DatingEvaluationDecision): Promise<void> {
    const candidate = this.queue[0];
    if (!candidate || !this.callbacks.onEvaluate) return;

    this.passBtn.disabled = true;
    this.likeBtn.disabled = true;
    try {
      await this.callbacks.onEvaluate(candidate.uid, decision);
      this.queue.shift();
      this.usedToday = Math.min(DATING_DAILY_DISCOVERY_LIMIT, this.usedToday + 1);
      this.remainingToday = Math.max(0, DATING_DAILY_DISCOVERY_LIMIT - this.usedToday);

      if (this.queue.length === 0 && this.remainingToday > 0 && this.nextCursor) {
        await this.handleApplyFilters(this.nextCursor);
        return;
      }
      this.render();
    } catch (err: any) {
      this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
      this.discoveryFeedbackEl.classList.add('is-error');
    } finally {
      this.passBtn.disabled = false;
      this.likeBtn.disabled = false;
    }
  }

  private async handleBlockCurrentCandidate(): Promise<void> {
    const candidate = this.queue[0];
    if (!candidate || !this.callbacks.onBlockUser) return;

    if (this.pendingBlockCandidateUid !== candidate.uid) {
      this.pendingBlockCandidateUid = candidate.uid;
      this.pendingBlockMatchId = null;
      if (this.pendingBlockTimer) clearTimeout(this.pendingBlockTimer);
      this.pendingBlockTimer = setTimeout(() => {
        if (this.pendingBlockCandidateUid === candidate.uid) {
          this.pendingBlockCandidateUid = null;
          this.render();
        }
      }, 4000);
      this.render();
      return;
    }

    if (this.pendingBlockTimer) {
      clearTimeout(this.pendingBlockTimer);
      this.pendingBlockTimer = null;
    }
    this.pendingBlockCandidateUid = null;
    this.candidateBlockBtn.disabled = true;
    this.passBtn.disabled = true;
    this.likeBtn.disabled = true;
    try {
      await this.callbacks.onBlockUser(candidate.uid, candidate.displayName);
      this.queue = this.queue.filter((c) => c.uid !== candidate.uid);
      this.discoveryFeedbackEl.textContent = t('dating.blockedDoneNotice');
      this.discoveryFeedbackEl.classList.remove('is-error');
      if (this.queue.length === 0 && this.remainingToday > 0 && this.nextCursor) {
        await this.handleApplyFilters(this.nextCursor);
        return;
      }
      this.render();
    } catch (err: any) {
      this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
      this.discoveryFeedbackEl.classList.add('is-error');
    } finally {
      this.candidateBlockBtn.disabled = false;
      this.passBtn.disabled = false;
      this.likeBtn.disabled = false;
    }
  }

  private formatIntentLabel(intent: DatingIntent): string {
    if (intent === 'serious') return t('dating.intentSerious');
    if (intent === 'chat') return t('dating.intentChat');
    return t('dating.intentMeetPeople');
  }

  private renderMatchesList(): void {
    const myUid = this.activeUid || '';
    const activeMatches = filterActiveDatingMatches(this.matches, myUid);
    this.matchesTitleEl.textContent = t('dating.matchesSectionTitle', {
      count: activeMatches.length,
    });
    this.matchesListEl.innerHTML = '';

    if (activeMatches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-connect-empty';
      empty.textContent = t('dating.matchesEmpty');
      this.matchesListEl.appendChild(empty);
      return;
    }

    activeMatches.forEach((match) => {
      const partner = getDatingMatchPartner(match, myUid);
      const isSeen = match.participantA === myUid ? match.seenByA : match.seenByB;

      const item = document.createElement('div');
      item.className = 'ttm-connect-item';

      const meta = document.createElement('div');
      meta.className = 'ttm-connect-item-meta';

      const nameRow = document.createElement('div');
      nameRow.className = 'ttm-dating-match-name-row';

      const nameEl = document.createElement('div');
      nameEl.className = 'ttm-connect-item-name';
      nameEl.textContent = partner.displayName || t('connect.defaultContact');
      nameRow.appendChild(nameEl);

      if (!isSeen) {
        const newBadge = document.createElement('span');
        newBadge.className = 'ttm-dating-new-badge';
        newBadge.textContent = t('dating.matchNewBadge');
        nameRow.appendChild(newBadge);
      }

      const subEl = document.createElement('div');
      subEl.className = 'ttm-connect-item-sub';
      subEl.textContent = t('dating.matchSubLabel');

      meta.appendChild(nameRow);
      meta.appendChild(subEl);

      const actions = document.createElement('div');
      actions.className = 'ttm-connect-item-actions';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
      openBtn.textContent = t('dating.matchOpenBtn');
      openBtn.addEventListener('click', async () => {
        if (!this.callbacks.onOpenMatchChat) return;
        openBtn.disabled = true;
        try {
          await this.callbacks.onOpenMatchChat(match);
        } catch (err: any) {
          this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
          this.discoveryFeedbackEl.classList.add('is-error');
          openBtn.disabled = false;
        }
      });

      const isConfirming = this.pendingUnmatchId === match.matchId;
      const unmatchBtn = document.createElement('button');
      unmatchBtn.type = 'button';
      unmatchBtn.className = isConfirming
        ? 'ttm-btn-mini ttm-btn-mini-danger is-confirming'
        : 'ttm-btn-mini ttm-btn-mini-danger';
      unmatchBtn.textContent = isConfirming
        ? t('dating.unmatchConfirmBtn')
        : t('dating.unmatchBtn');
      unmatchBtn.addEventListener('click', async () => {
        if (this.pendingUnmatchId !== match.matchId) {
          this.pendingUnmatchId = match.matchId;
          if (this.pendingUnmatchTimer) clearTimeout(this.pendingUnmatchTimer);
          this.pendingUnmatchTimer = setTimeout(() => {
            if (this.pendingUnmatchId === match.matchId) {
              this.pendingUnmatchId = null;
              this.renderMatchesList();
            }
          }, 4000);
          this.renderMatchesList();
          return;
        }

        if (this.pendingUnmatchTimer) {
          clearTimeout(this.pendingUnmatchTimer);
          this.pendingUnmatchTimer = null;
        }
        this.pendingUnmatchId = null;
        if (!this.callbacks.onUnmatch) return;
        unmatchBtn.disabled = true;
        openBtn.disabled = true;
        try {
          await this.callbacks.onUnmatch(match.matchId);
          this.discoveryFeedbackEl.textContent = t('dating.unmatchDoneNotice');
          this.discoveryFeedbackEl.classList.remove('is-error');
        } catch (err: any) {
          this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
          this.discoveryFeedbackEl.classList.add('is-error');
          unmatchBtn.disabled = false;
          openBtn.disabled = false;
        }
      });

      const reportBtn = document.createElement('button');
      reportBtn.type = 'button';
      reportBtn.className = 'ttm-btn-mini';
      reportBtn.textContent = t('dating.reportBtn');
      reportBtn.addEventListener('click', () => {
        this.callbacks.onReportMatch?.(match);
      });

      const isBlockConfirming = this.pendingBlockMatchId === match.matchId;
      const blockBtn = document.createElement('button');
      blockBtn.type = 'button';
      blockBtn.className = isBlockConfirming
        ? 'ttm-btn-mini ttm-btn-mini-danger is-confirming'
        : 'ttm-btn-mini ttm-btn-mini-danger';
      blockBtn.textContent = isBlockConfirming
        ? t('dating.blockConfirmBtn')
        : t('dating.blockBtn');
      blockBtn.addEventListener('click', async () => {
        if (this.pendingBlockMatchId !== match.matchId) {
          this.pendingBlockMatchId = match.matchId;
          this.pendingBlockCandidateUid = null;
          if (this.pendingBlockTimer) clearTimeout(this.pendingBlockTimer);
          this.pendingBlockTimer = setTimeout(() => {
            if (this.pendingBlockMatchId === match.matchId) {
              this.pendingBlockMatchId = null;
              this.renderMatchesList();
            }
          }, 4000);
          this.renderMatchesList();
          return;
        }
        if (this.pendingBlockTimer) {
          clearTimeout(this.pendingBlockTimer);
          this.pendingBlockTimer = null;
        }
        this.pendingBlockMatchId = null;
        if (!this.callbacks.onBlockUser) return;
        blockBtn.disabled = true;
        openBtn.disabled = true;
        unmatchBtn.disabled = true;
        try {
          await this.callbacks.onBlockUser(partner.uid, partner.displayName || '');
          this.discoveryFeedbackEl.textContent = t('dating.blockedDoneNotice');
          this.discoveryFeedbackEl.classList.remove('is-error');
        } catch (err: any) {
          this.discoveryFeedbackEl.textContent = err?.message || t('app.unexpectedError');
          this.discoveryFeedbackEl.classList.add('is-error');
          blockBtn.disabled = false;
          openBtn.disabled = false;
          unmatchBtn.disabled = false;
        }
      });

      actions.appendChild(openBtn);
      actions.appendChild(reportBtn);
      actions.appendChild(blockBtn);
      actions.appendChild(unmatchBtn);
      item.appendChild(meta);
      item.appendChild(actions);
      this.matchesListEl.appendChild(item);
    });
  }

  public render(): void {
    const showProfileForm = this.isEditingProfile || !this.currentProfile;
    this.profileWrapEl.style.display = showProfileForm ? 'flex' : 'none';
    this.discoveryWrapEl.style.display = showProfileForm ? 'none' : 'flex';

    if (showProfileForm) {
      this.profileTitleEl.textContent = this.currentProfile
        ? t('dating.editTitle')
        : t('dating.setupTitle');
      this.visibilityGroupEl.style.display = this.currentProfile ? 'flex' : 'none';
      this.cancelEditBtn.style.display = this.currentProfile ? 'inline-flex' : 'none';
      this.renderPhotoEditorState();
      return;
    }

    this.quotaEl.textContent = t('dating.quotaStatus', {
      used: this.usedToday,
      limit: DATING_DAILY_DISCOVERY_LIMIT,
      remaining: this.remainingToday,
    });

    this.renderMatchesList();

    const p = this.currentProfile!;
    if (p.suspended) {
      this.statusBannerEl.style.display = 'flex';
      this.statusBannerTextEl.textContent = t('dating.suspendedBanner');
      this.reactivateBtn.style.display = 'none';
    } else if (!p.discoverable || p.paused) {
      this.statusBannerEl.style.display = 'flex';
      this.statusBannerTextEl.textContent = t('dating.hiddenBanner');
      this.reactivateBtn.style.display = 'inline-flex';
    } else {
      this.statusBannerEl.style.display = 'none';
    }

    if (this.celebratingMatch && this.activeUid) {
      const partner = getDatingMatchPartner(this.celebratingMatch, this.activeUid);
      this.matchBannerDescEl.textContent = t('dating.matchBannerDesc', {
        name: partner.displayName || t('connect.defaultContact'),
      });
      this.matchBannerCardEl.style.display = 'flex';
      this.stageCardEl.style.display = 'none';
      this.emptyCardEl.style.display = 'none';
      return;
    }
    this.matchBannerCardEl.style.display = 'none';

    if (this.isLoading) {
      this.stageCardEl.style.display = 'none';
      this.emptyCardEl.style.display = 'flex';
      this.emptyTitleEl.textContent = '';
      this.emptyDescEl.textContent = t('dating.loading');
      this.refreshBtn.style.display = 'none';
      return;
    }

    if (this.lastError) {
      this.stageCardEl.style.display = 'none';
      this.emptyCardEl.style.display = 'flex';
      this.emptyTitleEl.textContent = '';
      this.emptyDescEl.textContent = this.lastError;
      this.refreshBtn.style.display = 'inline-flex';
      return;
    }

    const activeCandidate = this.queue[0];
    if (this.remainingToday <= 0) {
      this.stageCardEl.style.display = 'none';
      this.emptyCardEl.style.display = 'flex';
      this.emptyTitleEl.textContent = t('dating.emptyLimitTitle', {
        used: this.usedToday,
        limit: DATING_DAILY_DISCOVERY_LIMIT,
      });
      this.emptyDescEl.textContent = t('dating.emptyLimitDesc');
      this.refreshBtn.style.display = 'none';
      return;
    }

    if (activeCandidate && p.discoverable && !p.paused && !p.suspended) {
      this.emptyCardEl.style.display = 'none';
      this.stageCardEl.style.display = 'flex';
      if (shouldDisplayCandidatePhoto(activeCandidate)) {
        this.candidatePhotoEl.src = activeCandidate.photoUrl || '';
        this.candidatePhotoEl.alt = activeCandidate.displayName;
        this.candidatePhotoEl.style.display = 'block';
      } else {
        this.candidatePhotoEl.style.display = 'none';
        this.candidatePhotoEl.src = '';
      }
      const country = getCountryByIso(activeCandidate.countryCode);
      const countryLabel = getCountryDisplayName(country);
      this.candidateNameAgeEl.textContent = `${activeCandidate.displayName}, ${activeCandidate.age}`;
      this.candidateLocationEl.textContent = `${country.flag} ${activeCandidate.city}, ${countryLabel}`;
      this.candidateIntentEl.textContent = this.formatIntentLabel(activeCandidate.intent);
      this.candidateBioEl.textContent = activeCandidate.bio;
      const isCandidateBlockConfirming = this.pendingBlockCandidateUid === activeCandidate.uid;
      this.candidateReportBtn.textContent = t('dating.reportBtn');
      this.candidateBlockBtn.textContent = isCandidateBlockConfirming
        ? t('dating.blockConfirmBtn')
        : t('dating.blockBtn');
      this.candidateBlockBtn.classList.toggle('is-confirming', isCandidateBlockConfirming);
      return;
    }

    this.stageCardEl.style.display = 'none';
    this.emptyCardEl.style.display = 'flex';
    this.emptyTitleEl.textContent = t('dating.emptyNoMatchesTitle');
    this.emptyDescEl.textContent = t('dating.emptyNoMatchesDesc');
    this.refreshBtn.style.display = p.discoverable && !p.paused && !p.suspended ? 'inline-flex' : 'none';
  }
}
