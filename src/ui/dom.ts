import {
  ConnectionState,
  Conversation,
  ConversationInvite,
  DatingDiscoveryFilters,
  DatingDiscoveryResult,
  DatingEvaluationDecision,
  DatingLikeResult,
  DatingMatch,
  DatingProfile,
  DatingProfileInput,
  Message,
  ReferralMetricsSummary,
  ReportReason,
  ReportSourceType,
  Room,
  UserSession,
} from '../types';
import { getDatingMatchPartner, getUnseenDatingMatches } from '../dating';
import {
  buildWhatsAppReferralShareUrl,
  computeConversionRatePercent,
  getPendingReferralCode,
} from '../referral';
import { VALID_REPORT_REASONS } from '../safety';
import {
  AppSettings,
  normalizeAppearanceMode,
  normalizeNotificationSettings,
  normalizeSettingsLanguage,
} from '../config';
import {
  getWebNotificationPermission,
  requestWebNotificationPermission,
} from '../notifications';
import { formatDateSeparatorLabel, formatFullDateTime, formatTime, getLocalDateKey } from '../utils/sanitize';
import { MobileCalculator, isAdminRouteSequence } from './calculator';
import { Talk2TMLockScreen } from './lockscreen';
import { createMonogramAvatar, DatingPanel } from './dating-panel';
import { getPartnerLastRead } from '../firebase/firestore';
import { PWAPromptBar } from './pwa-prompt';
import { getCountryDisplayName, PhoneCountry, PhoneNormalizationResult } from '../utils/phone';
import { createPhoneInputField, PhoneInputField } from './phone-input';
import { LOCALE_REGISTRY, SUPPORTED_LOCALES, t } from '../i18n';
import {
  getAllLocalIdentities,
  validateAccountEmail,
  validateLocalPin,
  validateUsername,
} from '../identity';

export interface UIEvents {
  onUnlockByPin: (pin: string) => void;
  onCheckCustomPin?: (displayValue: string, inputSequence: string) => Promise<boolean>;
  onOpenAdminRoute?: () => void;
  onLockToCalculator: () => void;
  onSendMessage: (text: string) => void;
  onLoadOlder: () => void;
  onUpdateSettings: (settings: AppSettings) => void;
  onDeleteMessagesLocally?: (messageIds: string[]) => void;
  onCreateIdentity?: (params: {
    username: string;
    phone: string;
    email: string;
    pin: string;
  }) => Promise<{
    talk2tmId: string;
    e164Phone: string;
    email: string;
    emailVerified: boolean;
  }>;
  onCheckEmailActivation?: () => Promise<{ verified: boolean }>;
  onResendActivationEmail?: () => Promise<{ alreadyVerified: boolean; email: string }>;
  onCancelPendingActivation?: () => Promise<void>;
  onSendPasswordResetEmail?: (email: string) => Promise<{ email: string }>;
  onCompleteInAppPasswordReset?: (params: {
    oobCode: string;
    newPin: string;
  }) => Promise<void>;
  onChangeLocalPin?: (currentPin: string, newPin: string) => Promise<void>;
  onSendInvite?: (targetPhone: string) => Promise<string | void>;
  onAcceptInvite?: (invite: ConversationInvite) => Promise<void>;
  onDeclineInvite?: (inviteId: string) => Promise<void>;
  onCancelInvite?: (inviteId: string) => Promise<void>;
  onOpenConversation?: (conversationId: string) => Promise<void>;
  onShowConnectHub?: () => void;
  onLoadDatingWorkspace?: () => Promise<{
    profile: DatingProfile | null;
    filters: DatingDiscoveryFilters;
    discovery: DatingDiscoveryResult | null;
    matches?: DatingMatch[];
  }>;
  onSaveDatingProfile?: (input: DatingProfileInput) => Promise<{
    profile: DatingProfile;
    discovery: DatingDiscoveryResult | null;
  }>;
  onSetDatingVisibility?: (opts: { discoverable?: boolean; paused?: boolean }) => Promise<DatingProfile>;
  onDiscoverDating?: (
    filters: DatingDiscoveryFilters,
    cursorUpdatedAt?: string
  ) => Promise<DatingDiscoveryResult>;
  onEvaluateDatingProfile?: (targetUid: string, decision: DatingEvaluationDecision) => Promise<void>;
  onLikeDatingCandidate?: (candidate: DatingProfile) => Promise<DatingLikeResult>;
  onOpenDatingMatchChat?: (match: DatingMatch) => Promise<void>;
  onUnmatchDating?: (matchId: string) => Promise<void>;
  onMarkDatingMatchSeen?: (match: DatingMatch) => Promise<void>;
  onReportTarget?: (params: {
    targetUid: string;
    targetTalk2tmId?: string;
    targetDisplayName?: string;
    sourceType: ReportSourceType;
    channelId?: string;
    itemRefId?: string;
    reason: ReportReason;
    details?: string;
    evidenceSnapshot: string;
  }) => Promise<void>;
  onBlockUser?: (targetUid: string, targetName: string) => Promise<void>;
  onDeleteOwnAccount?: (currentPin: string) => Promise<void>;
  onUploadDatingPhoto?: (blob: Blob) => Promise<DatingProfile>;
  onRemoveDatingPhoto?: () => Promise<DatingProfile>;
  onTrackReferralShare?: (referralCode: string) => Promise<number>;
}

export class ChatUI {
  private container: HTMLElement;
  private events: UIEvents;
  private settings: AppSettings;

  // Telas de bloqueio (Padrão Talk2TM e Discreto Calculadora)
  private lockScreen!: Talk2TMLockScreen;
  private calculator!: MobileCalculator;
  private pwaPromptBar!: PWAPromptBar;
  private lastConnectionState: ConnectionState = 'conectando';

  // Elementos Estruturais
  private appWrapper!: HTMLElement;
  private headerEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private roomInfoEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private settingsBtnEl!: HTMLButtonElement;
  private lockBtnEl!: HTMLButtonElement;

  // Tela Única de PIN (Acesso manual pelo DEG)
  private passViewEl!: HTMLElement;
  private passSubtitleEl!: HTMLElement;
  private singlePassInput!: HTMLInputElement;
  private passPinToggleBtnEl!: HTMLButtonElement;
  private passErrorEl!: HTMLElement;
  private passEnterBtnEl!: HTMLButtonElement;
  private passCreateBtnEl!: HTMLButtonElement;
  private passRecoverBtnEl!: HTMLButtonElement;
  private backToLockBtnEl!: HTMLButtonElement;

  // Página pública leve de convite (?ref=CODE)
  private landingViewEl!: HTMLElement;
  private landingKickerEl!: HTMLElement;
  private landingTitleEl!: HTMLElement;
  private landingSubtitleEl!: HTMLElement;
  private landingBullet1El!: HTMLElement;
  private landingBullet2El!: HTMLElement;
  private landingBullet3El!: HTMLElement;
  private landingCtaBtnEl!: HTMLButtonElement;
  private landingSecondaryBtnEl!: HTMLButtonElement;
  private activeReferralInvite: { code: string; referrerDisplayName?: string } | null = null;

  // Tela de Cadastro Único (User + Tel +244 + E-mail + PIN local >= 6 dígitos) + Ativação por Link
  private onboardingViewEl!: HTMLElement;
  private onboardingRefBannerEl!: HTMLElement;
  private onboardingTitleEl!: HTMLElement;
  private onboardingSubtitleEl!: HTMLElement;
  private onboardingFormEl!: HTMLFormElement;
  private onboardingNameInput!: HTMLInputElement;
  private onboardingUsernameHintEl!: HTMLElement;
  private onboardingPhoneField!: PhoneInputField;
  private onboardingPhonePreviewEl!: HTMLElement;
  private onboardingEmailInput!: HTMLInputElement;
  private onboardingEmailHintEl!: HTMLElement;
  private onboardingPinInput!: HTMLInputElement;
  private onboardingPinToggleBtn1El!: HTMLButtonElement;
  private onboardingPinConfirmInput!: HTMLInputElement;
  private onboardingPinToggleBtn2El!: HTMLButtonElement;
  private onboardingErrorEl!: HTMLElement;
  private onboardingSubmitBtn!: HTMLButtonElement;
  private onboardingBackBtnEl!: HTMLButtonElement;
  private pendingActivationBoxEl!: HTMLElement;
  private pendingActivationTitleEl!: HTMLElement;
  private pendingActivationDescEl!: HTMLElement;
  private pendingActivationFeedbackEl!: HTMLElement;
  private pendingActivationCheckBtn!: HTMLButtonElement;
  private pendingActivationResendBtn!: HTMLButtonElement;
  private pendingActivationBackBtn!: HTMLButtonElement;
  private pendingActivationEmail: string = '';

  // Tela de Recuperação por E-mail + Conclusão OOB (Novo PIN + Repetir PIN)
  private recoveryViewEl!: HTMLElement;
  private recoveryTitleEl!: HTMLElement;
  private recoverySubtitleEl!: HTMLElement;
  private recoveryMainFormEl!: HTMLFormElement;
  private recoveryEmailInput!: HTMLInputElement;
  private recoveryEmailHintEl!: HTMLElement;
  private recoveryFeedbackEl!: HTMLElement;
  private recoverySubmitBtn!: HTMLButtonElement;
  private recoveryBackBtnEl!: HTMLButtonElement;
  private recoveryOobBoxEl!: HTMLElement;
  private recoveryOobTitleEl!: HTMLElement;
  private recoveryOobEmailLabelEl!: HTMLElement;
  private recoveryOobPinInput!: HTMLInputElement;
  private recoveryOobPinToggleBtn1El!: HTMLButtonElement;
  private recoveryOobPinConfirmInput!: HTMLInputElement;
  private recoveryOobPinToggleBtn2El!: HTMLButtonElement;
  private recoveryOobErrorEl!: HTMLElement;
  private recoveryOobSubmitBtn!: HTMLButtonElement;
  private recoveryOobCancelBtnEl!: HTMLButtonElement;
  private activeOobCode: string | null = null;
  private activeOobEmail: string | null = null;

  // Hub de Conexões Bilaterais & Descoberta
  private connectionsBtnEl!: HTMLButtonElement;
  private connectViewEl!: HTMLElement;
  private hubNavEl!: HTMLElement;
  private navDiscoverBtnEl!: HTMLButtonElement;
  private navDiscoverLabelEl!: HTMLElement;
  private navMatchesBtnEl!: HTMLButtonElement;
  private navMatchesLabelEl!: HTMLElement;
  private navMatchesBadgeEl!: HTMLElement;
  private navChatsBtnEl!: HTMLButtonElement;
  private navChatsLabelEl!: HTMLElement;
  private navAccountBtnEl!: HTMLButtonElement;
  private navAccountLabelEl!: HTMLElement;
  private hubContentEl!: HTMLElement;
  private conversasSectionEl!: HTMLElement;
  private accountSectionEl!: HTMLElement;
  private selfAvatarSlotEl!: HTMLElement;
  private accountEditDatingBtnEl!: HTMLButtonElement;
  private datingPanel!: DatingPanel;
  private activeHubDest: 'discover' | 'matches' | 'connections' | 'account' = 'discover';
  private lastDatingUid: string | null = null;
  private unseenDatingMatchCount = 0;
  private connectSelfTitleEl!: HTMLElement;
  private connectSelfNameEl!: HTMLElement;
  private connectSelfPhoneEl!: HTMLElement;
  private connectChangePinBtnEl!: HTMLButtonElement;
  private connectPinPanelEl!: HTMLElement;
  private connectCurPinInput!: HTMLInputElement;
  private connectNextPinInput!: HTMLInputElement;
  private connectNextPinConfInput!: HTMLInputElement;
  private connectSavePinBtnEl!: HTMLButtonElement;
  private connectDeleteBtnEl!: HTMLButtonElement;
  private connectDeletePanelEl!: HTMLElement;
  private connectDeleteWarningEl!: HTMLElement;
  private connectDeletePinInput!: HTMLInputElement;
  private connectDeleteCheckbox!: HTMLInputElement;
  private connectDeleteCheckLabelEl!: HTMLElement;
  private connectDeleteSubmitBtnEl!: HTMLButtonElement;
  private isDeleteConfirmPending = false;
  private deleteConfirmTimerId: ReturnType<typeof setTimeout> | null = null;
  private connectRefTitleEl!: HTMLElement;
  private connectRefDescEl!: HTMLElement;
  private connectRefUrlEl!: HTMLElement;
  private connectRefStatsEl!: HTMLElement;
  private connectRefWhatsappLinkEl!: HTMLAnchorElement;
  private connectRefCopyBtnEl!: HTMLButtonElement;
  private lastReferralSummary: ReferralMetricsSummary | null = null;
  private connectInviteTitleEl!: HTMLElement;
  private connectTargetField!: PhoneInputField;
  private connectTargetPreviewEl!: HTMLElement;
  private connectInviteBtn!: HTMLButtonElement;
  private connectFeedbackEl!: HTMLElement;
  private connectIncomingTitleEl!: HTMLElement;
  private incomingInvitesListEl!: HTMLElement;
  private connectOutgoingTitleEl!: HTMLElement;
  private outgoingInvitesListEl!: HTMLElement;
  private connectConvTitleEl!: HTMLElement;
  private conversationsListEl!: HTMLElement;
  private outgoingTargetNameCache: Map<string, string> = new Map();
  private lastHubData: {
    incoming: ConversationInvite[];
    outgoing: ConversationInvite[];
    conversations: Conversation[];
  } | null = null;

  // Tela de Chat
  private chatViewEl!: HTMLElement;
  private chatBlockBtnEl!: HTMLButtonElement;
  private isChatBlockConfirmPending = false;
  private chatBlockConfirmTimerId: ReturnType<typeof setTimeout> | null = null;
  private currentChatPartnerUid: string | null = null;
  private currentChatPartnerName = '';
  private isChatBlocked = false;
  private msgListEl!: HTMLElement;
  private msgInputEl!: HTMLInputElement;
  private sendBtnEl!: HTMLButtonElement;
  private charCountEl!: HTMLElement;
  private loadOlderBtn!: HTMLButtonElement;
  private sendFormEl!: HTMLFormElement;

  // Modo de Seleção e Exclusão Local Minimalista (1 a 1 + Selecionar Tudo + Apagar)
  private isSelectionMode: boolean = false;
  private selectedMessageIds: Set<string> = new Set();
  private selectionBarEl!: HTMLElement;
  private selectAllBtnEl!: HTMLButtonElement;
  private cancelSelectionBtnEl!: HTMLButtonElement;
  private deleteBtnEl!: HTMLButtonElement;
  private selectModeBtn!: HTMLButtonElement;
  private isConfirmPending: boolean = false;
  private confirmTimerId: ReturnType<typeof setTimeout> | null = null;

  // Modal de Definições Mínimas
  private settingsModalEl!: HTMLElement;
  private settingsModalTitleEl!: HTMLElement;
  private settingsSessionLabelEl!: HTMLElement;
  private settingsInactivityLabelEl!: HTMLElement;
  private settingsAppearanceLabelEl!: HTMLElement;
  private settingsLanguageLabelEl!: HTMLElement;
  private settingsSaveBtnEl!: HTMLButtonElement;
  private settingsCancelBtnEl!: HTMLButtonElement;
  private sessionSelectEl!: HTMLSelectElement;
  private inactivitySelectEl!: HTMLSelectElement;
  private appearanceSelectEl!: HTMLSelectElement;
  private languageSelectEl!: HTMLSelectElement;
  private settingsPushLabelEl!: HTMLElement;
  private pushEnabledCheckboxEl!: HTMLInputElement;
  private settingsPushEnableTextEl!: HTMLElement;
  private pushMatchCheckboxEl!: HTMLInputElement;
  private settingsPushMatchTextEl!: HTMLElement;
  private pushMessageCheckboxEl!: HTMLInputElement;
  private settingsPushMessageTextEl!: HTMLElement;
  private settingsPushHintEl!: HTMLElement;
  private settingsPushStatusEl!: HTMLElement;
  private settingsPushPermissionBtnEl!: HTMLButtonElement;
  private inactivityNoticeEl!: HTMLElement;

  // Modal inline de Denúncia (Reports)
  private reportModalEl!: HTMLElement;
  private reportModalTitleEl!: HTMLElement;
  private reportTargetLabelEl!: HTMLElement;
  private reportReasonLabelEl!: HTMLElement;
  private reportReasonSelectEl!: HTMLSelectElement;
  private reportDetailsInputEl!: HTMLTextAreaElement;
  private reportErrorEl!: HTMLElement;
  private reportSubmitBtnEl!: HTMLButtonElement;
  private reportCancelBtnEl!: HTMLButtonElement;
  private activeReportContext: {
    targetUid: string;
    targetTalk2tmId?: string;
    targetDisplayName?: string;
    sourceType: ReportSourceType;
    channelId?: string;
    itemRefId?: string;
    evidenceSnapshot: string;
  } | null = null;

  // Folha de Partilha / Recomendar a um amigo & Confirmação de Bloqueio
  private shareSheetModalEl!: HTMLElement;
  private shareSheetTitleEl!: HTMLElement;
  private shareSheetDescEl!: HTMLElement;
  private shareSheetWhatsappEl!: HTMLAnchorElement;
  private shareSheetCopyBtnEl!: HTMLButtonElement;
  private shareSheetDismissBtnEl!: HTMLButtonElement;

  private blockedDoneModalEl!: HTMLElement;
  private blockedDoneTitleEl!: HTMLElement;
  private blockedDoneDescEl!: HTMLElement;
  private blockedDoneOkBtnEl!: HTMLButtonElement;
  private lastBlockedName = '';

  private renderedMessageIds: Set<string> = new Set();
  private renderedMessages: Map<string, { msg: Message; isSelf: boolean }> = new Map();
  private currentRoom: Room | null = null;
  private currentSession: UserSession | null = null;

  constructor(container: HTMLElement, settings: AppSettings, events: UIEvents) {
    this.container = container;
    this.settings = settings;
    this.events = events;
    this.buildBaseDOM();
    this.setupAntiMediaGuards();
  }

  private buildBaseDOM(): void {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    this.appWrapper = document.createElement('div');
    this.appWrapper.id = 'talk2tm-app';
    this.appWrapper.className = 'talk2tm-shell';

    // Notificação Fina de Instalação PWA
    this.pwaPromptBar = new PWAPromptBar(this.appWrapper);

    // 1. Tela de entrada direta Talk2TM (Padrão) + Calculadora Camuflada (Modo discreto opcional)
    this.lockScreen = new Talk2TMLockScreen(this.appWrapper, {
      onUnlock: (_user, pin) => {
        this.events.onUnlockByPin(pin);
      },
      onCheckCustomPin: this.events.onCheckCustomPin,
      onOpenOnboarding: () => {
        this.showOnboardingView();
      },
      onOpenRecovery: () => {
        this.showRecoveryView();
      },
      onOpenAdminRoute: () => {
        this.events.onOpenAdminRoute?.();
      },
    });

    this.calculator = new MobileCalculator(this.appWrapper, {
      onUnlock: (_user, pin) => {
        this.events.onUnlockByPin(pin);
      },
      onCheckCustomPin: this.events.onCheckCustomPin,
      onOpenManualEntry: () => {
        this.showPassEntryView();
      },
      onOpenAdminRoute: () => {
        this.events.onOpenAdminRoute?.();
      },
    });

    // 2. Cabeçalho Minimalista
    this.headerEl = document.createElement('header');
    this.headerEl.id = 'chat-header';
    this.headerEl.className = 'ttm-header';
    this.headerEl.style.display = 'none';

    const brandEl = document.createElement('div');
    brandEl.className = 'ttm-brand';
    const brandTitle = document.createElement('strong');
    brandTitle.textContent = 'Talk2TM';
    const brandDesc = document.createElement('span');
    brandDesc.textContent = '1:1';
    brandEl.appendChild(brandTitle);
    brandEl.appendChild(brandDesc);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'ttm-status';
    this.statusEl.setAttribute('data-state', 'conectando');
    const initialNetTitle = t('chat.networkTitle', { state: t('chat.netState.connecting') });
    this.statusEl.setAttribute('title', initialNetTitle);
    this.statusEl.setAttribute('aria-label', initialNetTitle);
    this.statusEl.innerHTML = this.getNetworkIconSvg();

    // Ações do cabeçalho sistematizadas
    const headerActions = document.createElement('div');
    headerActions.className = 'ttm-header-actions';

    this.connectionsBtnEl = document.createElement('button');
    this.connectionsBtnEl.type = 'button';
    this.connectionsBtnEl.className = 'ttm-btn ttm-btn-def';
    this.connectionsBtnEl.textContent = t('chat.connectionsBtn');
    this.connectionsBtnEl.title = t('chat.connectionsTitle');
    this.connectionsBtnEl.style.display = 'none';
    this.connectionsBtnEl.addEventListener('click', () => {
      this.events.onShowConnectHub?.();
    });

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'ttm-btn ttm-btn-def ttm-btn-icon';
    settingsBtn.innerHTML = this.getSettingsIconSvg();
    settingsBtn.title = t('chat.settingsTitle');
    settingsBtn.setAttribute('aria-label', t('chat.settingsBtn'));
    settingsBtn.addEventListener('click', () => {
      this.openSettingsModal();
    });
    this.settingsBtnEl = settingsBtn;

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'ttm-btn ttm-btn-lock';
    lockBtn.addEventListener('click', () => {
      this.events.onLockToCalculator();
    });
    this.lockBtnEl = lockBtn;
    this.syncLockButtonLabel();

    headerActions.appendChild(this.connectionsBtnEl);
    headerActions.appendChild(settingsBtn);
    headerActions.appendChild(lockBtn);

    const headerTopRow = document.createElement('div');
    headerTopRow.className = 'ttm-header-row';
    headerTopRow.appendChild(brandEl);
    headerTopRow.appendChild(this.statusEl);
    headerTopRow.appendChild(headerActions);

    this.roomInfoEl = document.createElement('div');
    this.roomInfoEl.className = 'ttm-room-info';
    this.roomInfoEl.textContent = '';

    this.headerEl.appendChild(headerTopRow);
    this.headerEl.appendChild(this.roomInfoEl);
    this.appWrapper.appendChild(this.headerEl);

    // 3. Área Principal
    this.mainEl = document.createElement('main');
    this.mainEl.className = 'ttm-main';

    this.buildPassEntryView();
    this.buildReferralLandingView();
    this.buildOnboardingView();
    this.buildRecoveryView();
    this.buildConnectView();
    this.buildChatView();
    this.buildSettingsModal();
    this.buildReportModal();
    this.buildShareSheetModal();
    this.buildBlockedDoneModal();

    this.mainEl.appendChild(this.passViewEl);
    this.mainEl.appendChild(this.landingViewEl);
    this.mainEl.appendChild(this.onboardingViewEl);
    this.mainEl.appendChild(this.recoveryViewEl);
    this.mainEl.appendChild(this.connectViewEl);
    this.mainEl.appendChild(this.chatViewEl);
    this.appWrapper.appendChild(this.mainEl);
    this.appWrapper.appendChild(this.settingsModalEl);
    this.appWrapper.appendChild(this.reportModalEl);
    this.appWrapper.appendChild(this.shareSheetModalEl);
    this.appWrapper.appendChild(this.blockedDoneModalEl);

    this.container.appendChild(this.appWrapper);

    // Inicia na tela configurada no dispositivo (Talk2TM padrão ou Calculadora)
    this.showLockView();
  }

  private createPinInputWithToggle(
    id: string,
    placeholder: string,
    maxLength: number = 128,
    autocomplete: AutoFill = 'off'
  ): { wrapper: HTMLElement; input: HTMLInputElement; toggleBtn: HTMLButtonElement } {
    const wrapper = document.createElement('div');
    wrapper.className = 'ttm-input-group';

    const input = document.createElement('input');
    input.type = 'password';
    input.id = id;
    input.className = 'ttm-input ttm-input-with-toggle';
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.inputMode = 'numeric';
    input.setAttribute('pattern', '[0-9]*');
    input.autocomplete = autocomplete;

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'ttm-toggle-vis-btn';
    toggleBtn.textContent = t('common.show');
    toggleBtn.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    toggleBtn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggleBtn.textContent = showing ? t('common.show') : t('common.hide');
    });

    wrapper.appendChild(input);
    wrapper.appendChild(toggleBtn);
    return { wrapper, input, toggleBtn };
  }

  private updatePhonePreview(
    raw: string,
    res: PhoneNormalizationResult,
    country: PhoneCountry,
    previewEl: HTMLElement,
    mode: 'onboarding' | 'recovery' | 'connect' = 'onboarding'
  ): void {
    const trimmed = raw.trim();
    const countryName = getCountryDisplayName(country);
    if (!trimmed) {
      if (mode === 'recovery') {
        previewEl.textContent = t('phone.previewRecovery', {
          flag: country.flag,
          country: countryName,
          dialCode: country.dialCode,
        });
      } else if (mode === 'connect') {
        previewEl.textContent = t('phone.previewConnect', {
          flag: country.flag,
          country: countryName,
          dialCode: country.dialCode,
        });
      } else {
        previewEl.textContent = t('phone.previewOnboarding', {
          flag: country.flag,
          country: countryName,
          dialCode: country.dialCode,
        });
      }
      previewEl.classList.remove('is-valid', 'is-invalid');
      return;
    }
    if (res.valid && res.e164) {
      previewEl.textContent =
        mode === 'connect'
          ? t('phone.previewValidConnect', { e164: res.e164 })
          : t('phone.previewValidStandard', { e164: res.e164 });
      previewEl.classList.add('is-valid');
      previewEl.classList.remove('is-invalid');
    } else {
      previewEl.textContent = res.error || t('phone.invalidFormat');
      previewEl.classList.add('is-invalid');
      previewEl.classList.remove('is-valid');
    }
  }

  /**
   * Caixa Única de Digitação de PIN (Acesso pelo botão discreto DEG)
   */
  private buildPassEntryView(): void {
    this.passViewEl = document.createElement('div');
    this.passViewEl.id = 'ttm-pass-view';
    this.passViewEl.className = 'ttm-pass-box';
    this.passViewEl.style.display = 'none';

    const titleEl = document.createElement('h1');
    titleEl.className = 'ttm-title';
    titleEl.textContent = 'Talk2TM';

    this.passSubtitleEl = document.createElement('p');
    this.passSubtitleEl.className = 'ttm-subtitle';
    this.passSubtitleEl.textContent = t('pass.subtitleWithVault');

    const formEl = document.createElement('form');
    formEl.className = 'ttm-form';

    const pinField = this.createPinInputWithToggle(
      'ttm-single-pass',
      t('pass.pinPlaceholder'),
      128,
      'off'
    );
    this.singlePassInput = pinField.input;
    this.passPinToggleBtnEl = pinField.toggleBtn;
    this.singlePassInput.maxLength = 128;
    this.singlePassInput.inputMode = 'text';
    this.singlePassInput.removeAttribute('pattern');
    this.singlePassInput.addEventListener('input', () => {
      if (isAdminRouteSequence(this.singlePassInput.value)) {
        this.singlePassInput.value = '';
        this.passErrorEl.textContent = '';
        this.events.onOpenAdminRoute?.();
      }
    });

    this.passErrorEl = document.createElement('div');
    this.passErrorEl.className = 'ttm-error';
    this.passErrorEl.textContent = '';

    const enterBtn = document.createElement('button');
    enterBtn.type = 'submit';
    enterBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    enterBtn.textContent = t('pass.signInBtn');
    this.passEnterBtnEl = enterBtn;

    const createAccountBtn = document.createElement('button');
    createAccountBtn.type = 'button';
    createAccountBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    createAccountBtn.textContent = t('pass.createBtn');
    createAccountBtn.addEventListener('click', () => {
      this.showOnboardingView();
    });
    this.passCreateBtnEl = createAccountBtn;

    const recoverAccountBtn = document.createElement('button');
    recoverAccountBtn.type = 'button';
    recoverAccountBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    recoverAccountBtn.textContent = t('pass.recoverBtn');
    recoverAccountBtn.addEventListener('click', () => {
      this.showRecoveryView();
    });
    this.passRecoverBtnEl = recoverAccountBtn;

    const backToCalcBtn = document.createElement('button');
    backToCalcBtn.type = 'button';
    backToCalcBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backToCalcBtn.textContent = t('common.back');
    backToCalcBtn.addEventListener('click', () => {
      this.events.onLockToCalculator();
    });
    this.backToLockBtnEl = backToCalcBtn;

    formEl.appendChild(pinField.wrapper);
    formEl.appendChild(this.passErrorEl);
    formEl.appendChild(enterBtn);
    formEl.appendChild(createAccountBtn);
    formEl.appendChild(recoverAccountBtn);
    formEl.appendChild(backToCalcBtn);

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this.passErrorEl.textContent = '';
      const pin = this.singlePassInput.value.trim();

      if (!pin) {
        this.passErrorEl.textContent = t('lock.enterPinPrompt');
        return;
      }

      if (isAdminRouteSequence(pin)) {
        this.singlePassInput.value = '';
        this.events.onOpenAdminRoute?.();
        return;
      }

      this.events.onUnlockByPin(pin);
    });

    this.passViewEl.appendChild(titleEl);
    this.passViewEl.appendChild(this.passSubtitleEl);
    this.passViewEl.appendChild(formEl);
  }

  /**
   * Cadastro Ultraminimalista (4 campos):
   * 1. Nome / Utilizador
   * 2. Número de telefone (declarado, com normalização +244 / internacional)
   * 3. PIN numérico de 4 a 8 dígitos
   * 4. Confirmar PIN
   * + Passo 2: Definição de Chave Pessoal fácil de lembrar (regras claras, zero custos, sem SMS/e-mail).
   */
  private buildReferralLandingView(): void {
    this.landingViewEl = document.createElement('section');
    this.landingViewEl.id = 'ttm-landing-view';
    this.landingViewEl.className = 'ttm-landing-box';
    this.landingViewEl.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'ttm-landing-card';

    const emblem = document.createElement('div');
    emblem.className = 'ttm-landing-emblem';
    emblem.innerHTML = `<svg width="42" height="42" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="56" height="56" rx="16" stroke="currentColor" stroke-width="2.5"/>
      <path d="M18 22h28v18a4 4 0 0 1-4 4H28l-8 6v-6h-2a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4Z" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M26 30h12M26 35h8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;

    this.landingKickerEl = document.createElement('div');
    this.landingKickerEl.className = 'ttm-landing-kicker';

    this.landingTitleEl = document.createElement('h1');
    this.landingTitleEl.className = 'ttm-landing-title';

    this.landingSubtitleEl = document.createElement('p');
    this.landingSubtitleEl.className = 'ttm-landing-subtitle';

    const pointsList = document.createElement('ul');
    pointsList.className = 'ttm-landing-points';
    this.landingBullet1El = document.createElement('li');
    this.landingBullet2El = document.createElement('li');
    this.landingBullet3El = document.createElement('li');
    pointsList.appendChild(this.landingBullet1El);
    pointsList.appendChild(this.landingBullet2El);
    pointsList.appendChild(this.landingBullet3El);

    this.landingCtaBtnEl = document.createElement('button');
    this.landingCtaBtnEl.type = 'button';
    this.landingCtaBtnEl.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.landingCtaBtnEl.addEventListener('click', () => {
      this.showOnboardingView();
    });

    this.landingSecondaryBtnEl = document.createElement('button');
    this.landingSecondaryBtnEl.type = 'button';
    this.landingSecondaryBtnEl.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    this.landingSecondaryBtnEl.addEventListener('click', () => {
      this.showLockView();
    });

    card.appendChild(emblem);
    card.appendChild(this.landingKickerEl);
    card.appendChild(this.landingTitleEl);
    card.appendChild(this.landingSubtitleEl);
    card.appendChild(pointsList);
    card.appendChild(this.landingCtaBtnEl);
    card.appendChild(this.landingSecondaryBtnEl);
    this.landingViewEl.appendChild(card);
    this.updateReferralLandingLocale();
  }

  private buildOnboardingView(): void {
    this.onboardingViewEl = document.createElement('div');
    this.onboardingViewEl.id = 'ttm-onboarding-view';
    this.onboardingViewEl.className = 'ttm-onboarding-box';
    this.onboardingViewEl.style.display = 'none';

    const cardEl = document.createElement('div');
    cardEl.className = 'ttm-onboarding-card';

    const titleEl = document.createElement('h1');
    titleEl.className = 'ttm-title';
    titleEl.textContent = t('onboarding.title');
    this.onboardingTitleEl = titleEl;

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'ttm-subtitle';
    subtitleEl.textContent = t('onboarding.subtitle');
    this.onboardingSubtitleEl = subtitleEl;

    this.onboardingRefBannerEl = document.createElement('div');
    this.onboardingRefBannerEl.className = 'ttm-onboarding-ref-banner';
    this.onboardingRefBannerEl.style.display = 'none';

    this.onboardingFormEl = document.createElement('form');
    this.onboardingFormEl.className = 'ttm-form';

    this.onboardingNameInput = document.createElement('input');
    this.onboardingNameInput.type = 'text';
    this.onboardingNameInput.id = 'ttm-onboarding-name';
    this.onboardingNameInput.className = 'ttm-input ttm-input-left';
    this.onboardingNameInput.placeholder = t('onboarding.namePlaceholder');
    this.onboardingNameInput.maxLength = 24;
    this.onboardingNameInput.autocomplete = 'username';
    this.onboardingNameInput.autocapitalize = 'none';

    this.onboardingUsernameHintEl = document.createElement('div');
    this.onboardingUsernameHintEl.className = 'ttm-field-hint';
    this.onboardingUsernameHintEl.textContent = '';
    this.onboardingUsernameHintEl.style.display = 'none';

    this.onboardingNameInput.addEventListener('input', () => {
      const raw = this.onboardingNameInput.value;
      if (!raw.trim()) {
        this.onboardingUsernameHintEl.textContent = '';
        this.onboardingUsernameHintEl.style.display = 'none';
        this.onboardingUsernameHintEl.classList.remove('is-valid', 'is-invalid');
        return;
      }
      const check = validateUsername(raw);
      if (check.valid) {
        this.onboardingUsernameHintEl.textContent = `@${check.username}`;
        this.onboardingUsernameHintEl.style.display = 'block';
        this.onboardingUsernameHintEl.classList.add('is-valid');
        this.onboardingUsernameHintEl.classList.remove('is-invalid');
      } else {
        this.onboardingUsernameHintEl.textContent = check.error || t('err.usernameFormat');
        this.onboardingUsernameHintEl.style.display = 'block';
        this.onboardingUsernameHintEl.classList.add('is-invalid');
        this.onboardingUsernameHintEl.classList.remove('is-valid');
      }
    });

    this.onboardingPhonePreviewEl = document.createElement('div');
    this.onboardingPhonePreviewEl.className = 'ttm-field-hint';

    this.onboardingPhoneField = createPhoneInputField({
      id: 'ttm-onboarding-phone',
      placeholder: t('onboarding.phonePlaceholder'),
      autocomplete: 'tel',
      onChange: (raw, res, country) => {
        this.updatePhonePreview(raw, res, country, this.onboardingPhonePreviewEl, 'onboarding');
      },
    });
    this.updatePhonePreview(
      '',
      { valid: false },
      this.onboardingPhoneField.getCountry(),
      this.onboardingPhonePreviewEl,
      'onboarding'
    );

    this.onboardingEmailInput = document.createElement('input');
    this.onboardingEmailInput.type = 'email';
    this.onboardingEmailInput.id = 'ttm-onboarding-email';
    this.onboardingEmailInput.name = 'email';
    this.onboardingEmailInput.className = 'ttm-input ttm-input-left';
    this.onboardingEmailInput.placeholder = t('onboarding.emailPlaceholder');
    this.onboardingEmailInput.maxLength = 120;
    this.onboardingEmailInput.autocomplete = 'email';
    this.onboardingEmailInput.inputMode = 'email';

    this.onboardingEmailHintEl = document.createElement('div');
    this.onboardingEmailHintEl.className = 'ttm-field-hint';
    this.onboardingEmailHintEl.textContent = '';
    this.onboardingEmailHintEl.style.display = 'none';

    this.onboardingEmailInput.addEventListener('input', () => {
      const raw = this.onboardingEmailInput.value.trim();
      if (!raw) {
        this.onboardingEmailHintEl.textContent = '';
        this.onboardingEmailHintEl.style.display = 'none';
        this.onboardingEmailHintEl.classList.remove('is-valid', 'is-invalid');
        return;
      }
      const check = validateAccountEmail(raw);
      if (check.valid && check.email) {
        this.onboardingEmailHintEl.textContent = '';
        this.onboardingEmailHintEl.style.display = 'none';
        this.onboardingEmailHintEl.classList.add('is-valid');
        this.onboardingEmailHintEl.classList.remove('is-invalid');
      } else {
        this.onboardingEmailHintEl.textContent = check.error || t('onboarding.emailInvalid');
        this.onboardingEmailHintEl.style.display = 'block';
        this.onboardingEmailHintEl.classList.add('is-invalid');
        this.onboardingEmailHintEl.classList.remove('is-valid');
      }
    });

    const pin1 = this.createPinInputWithToggle(
      'ttm-onboarding-pin',
      t('onboarding.pinPlaceholder'),
      128,
      'off'
    );
    this.onboardingPinInput = pin1.input;
    this.onboardingPinToggleBtn1El = pin1.toggleBtn;

    const pin2 = this.createPinInputWithToggle(
      'ttm-onboarding-pin-confirm',
      t('onboarding.pinConfirmPlaceholder'),
      128,
      'off'
    );
    this.onboardingPinConfirmInput = pin2.input;
    this.onboardingPinToggleBtn2El = pin2.toggleBtn;

    this.onboardingErrorEl = document.createElement('div');
    this.onboardingErrorEl.className = 'ttm-error';
    this.onboardingErrorEl.textContent = '';

    this.onboardingSubmitBtn = document.createElement('button');
    this.onboardingSubmitBtn.type = 'submit';
    this.onboardingSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.onboardingSubmitBtn.textContent = t('onboarding.createEnterBtn');

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backBtn.textContent = t('common.back');
    backBtn.addEventListener('click', () => {
      this.returnToEntryScreen();
    });
    this.onboardingBackBtnEl = backBtn;

    this.onboardingFormEl.appendChild(this.onboardingNameInput);
    this.onboardingFormEl.appendChild(this.onboardingUsernameHintEl);
    this.onboardingFormEl.appendChild(this.onboardingPhoneField.wrapper);
    this.onboardingFormEl.appendChild(this.onboardingPhonePreviewEl);
    this.onboardingFormEl.appendChild(this.onboardingEmailInput);
    this.onboardingFormEl.appendChild(this.onboardingEmailHintEl);
    this.onboardingFormEl.appendChild(pin1.wrapper);
    this.onboardingFormEl.appendChild(pin2.wrapper);
    this.onboardingFormEl.appendChild(this.onboardingErrorEl);
    this.onboardingFormEl.appendChild(this.onboardingSubmitBtn);
    this.onboardingFormEl.appendChild(backBtn);

    // Painel de Ativação Pendente por E-mail (bloqueia entrada até clicar no link de ativação)
    this.pendingActivationBoxEl = document.createElement('div');
    this.pendingActivationBoxEl.className = 'ttm-recovery-confirm-box';
    this.pendingActivationBoxEl.style.display = 'none';

    this.pendingActivationTitleEl = document.createElement('div');
    this.pendingActivationTitleEl.className = 'ttm-recovery-title';
    this.pendingActivationTitleEl.textContent = t('activation.title');

    this.pendingActivationDescEl = document.createElement('p');
    this.pendingActivationDescEl.className = 'ttm-onboarding-tip';
    this.pendingActivationDescEl.textContent = '';

    this.pendingActivationFeedbackEl = document.createElement('div');
    this.pendingActivationFeedbackEl.className = 'ttm-field-hint';
    this.pendingActivationFeedbackEl.textContent = '';

    this.pendingActivationCheckBtn = document.createElement('button');
    this.pendingActivationCheckBtn.type = 'button';
    this.pendingActivationCheckBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.pendingActivationCheckBtn.textContent = t('activation.checkBtn');
    this.pendingActivationCheckBtn.addEventListener('click', async () => {
      if (!this.events.onCheckEmailActivation) return;
      this.pendingActivationFeedbackEl.textContent = '';
      this.pendingActivationFeedbackEl.classList.remove('is-valid', 'is-invalid');
      this.pendingActivationCheckBtn.disabled = true;
      this.pendingActivationCheckBtn.textContent = t('activation.checkingBtn');
      try {
        const res = await this.events.onCheckEmailActivation();
        if (!res.verified) {
          this.pendingActivationFeedbackEl.textContent = t('activation.notYetConfirmed');
          this.pendingActivationFeedbackEl.classList.add('is-invalid');
        }
      } catch (err: any) {
        this.pendingActivationFeedbackEl.textContent = this.extractReadableError(err);
        this.pendingActivationFeedbackEl.classList.add('is-invalid');
      } finally {
        this.pendingActivationCheckBtn.disabled = false;
        this.pendingActivationCheckBtn.textContent = t('activation.checkBtn');
      }
    });

    this.pendingActivationResendBtn = document.createElement('button');
    this.pendingActivationResendBtn.type = 'button';
    this.pendingActivationResendBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    this.pendingActivationResendBtn.textContent = t('activation.resendBtn');
    this.pendingActivationResendBtn.addEventListener('click', async () => {
      if (!this.events.onResendActivationEmail) return;
      this.pendingActivationFeedbackEl.textContent = '';
      this.pendingActivationFeedbackEl.classList.remove('is-valid', 'is-invalid');
      this.pendingActivationResendBtn.disabled = true;
      this.pendingActivationResendBtn.textContent = t('activation.resendingBtn');
      try {
        const res = await this.events.onResendActivationEmail();
        if (!res.alreadyVerified) {
          this.pendingActivationFeedbackEl.textContent = t('activation.resentNotice', {
            email: res.email || this.pendingActivationEmail,
          });
          this.pendingActivationFeedbackEl.classList.add('is-valid');
        }
      } catch (err: any) {
        this.pendingActivationFeedbackEl.textContent = this.extractReadableError(err);
        this.pendingActivationFeedbackEl.classList.add('is-invalid');
      } finally {
        this.pendingActivationResendBtn.disabled = false;
        this.pendingActivationResendBtn.textContent = t('activation.resendBtn');
      }
    });

    this.pendingActivationBackBtn = document.createElement('button');
    this.pendingActivationBackBtn.type = 'button';
    this.pendingActivationBackBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    this.pendingActivationBackBtn.textContent = t('common.back');
    this.pendingActivationBackBtn.addEventListener('click', () => {
      void this.events.onCancelPendingActivation?.();
    });

    this.pendingActivationBoxEl.appendChild(this.pendingActivationTitleEl);
    this.pendingActivationBoxEl.appendChild(this.pendingActivationDescEl);
    this.pendingActivationBoxEl.appendChild(this.pendingActivationFeedbackEl);
    this.pendingActivationBoxEl.appendChild(this.pendingActivationCheckBtn);
    this.pendingActivationBoxEl.appendChild(this.pendingActivationResendBtn);
    this.pendingActivationBoxEl.appendChild(this.pendingActivationBackBtn);

    this.onboardingFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.onboardingErrorEl.textContent = '';

      const userCheck = validateUsername(this.onboardingNameInput.value);
      if (!userCheck.valid) {
        this.onboardingErrorEl.textContent = userCheck.error || t('onboarding.errNameRequired');
        return;
      }

      const phoneCheck = this.onboardingPhoneField.validate();
      if (!phoneCheck.valid || !phoneCheck.e164) {
        this.onboardingErrorEl.textContent = phoneCheck.error || t('onboarding.errPhoneInvalid');
        return;
      }

      const emailCheck = validateAccountEmail(this.onboardingEmailInput.value);
      if (!emailCheck.valid || !emailCheck.email) {
        this.onboardingErrorEl.textContent = emailCheck.error || t('onboarding.errEmailInvalid');
        return;
      }

      const pin = this.onboardingPinInput.value.trim();
      const pinConfirm = this.onboardingPinConfirmInput.value.trim();

      if (!/^\d{6,}$/.test(pin)) {
        this.onboardingErrorEl.textContent = t('onboarding.errPinFormat');
        return;
      }
      if (pin !== pinConfirm) {
        this.onboardingErrorEl.textContent = t('onboarding.errPinMismatch');
        return;
      }
      const pinValid = await validateLocalPin(pin, true);
      if (!pinValid.valid) {
        this.onboardingErrorEl.textContent = pinValid.error || t('onboarding.errPinInvalid');
        return;
      }

      if (!this.events.onCreateIdentity) return;
      this.onboardingSubmitBtn.disabled = true;
      this.onboardingSubmitBtn.textContent = t('onboarding.creatingBtn');
      try {
        const res = await this.events.onCreateIdentity({
          username: userCheck.username,
          phone: phoneCheck.e164,
          email: emailCheck.email,
          pin,
        });
        if (res.emailVerified) {
          await this.events.onCheckEmailActivation?.();
        } else {
          this.showPendingActivationView(res.email, userCheck.username);
        }
      } catch (err: any) {
        this.onboardingErrorEl.textContent = this.extractReadableError(err);
      } finally {
        this.onboardingSubmitBtn.disabled = false;
        this.onboardingSubmitBtn.textContent = t('onboarding.createEnterBtn');
      }
    });

    cardEl.appendChild(titleEl);
    cardEl.appendChild(subtitleEl);
    cardEl.appendChild(this.onboardingRefBannerEl);
    cardEl.appendChild(this.onboardingFormEl);
    cardEl.appendChild(this.pendingActivationBoxEl);
    this.onboardingViewEl.appendChild(cardEl);
  }

  /**
   * Recuperação de Acesso (exclusivamente via link de e-mail):
   * 1. Formulário principal com um único campo: E-mail associado à conta
   * 2. Conclusão in-app ao abrir ?mode=resetPassword&oobCode=... com apenas Novo PIN + Repetir PIN
   */
  private buildRecoveryView(): void {
    this.recoveryViewEl = document.createElement('div');
    this.recoveryViewEl.id = 'ttm-recovery-view';
    this.recoveryViewEl.className = 'ttm-onboarding-box';
    this.recoveryViewEl.style.display = 'none';

    const cardEl = document.createElement('div');
    cardEl.className = 'ttm-onboarding-card';

    const titleEl = document.createElement('h1');
    titleEl.className = 'ttm-title';
    titleEl.textContent = t('recovery.title');
    this.recoveryTitleEl = titleEl;

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'ttm-subtitle';
    subtitleEl.textContent = t('recovery.subtitle');
    this.recoverySubtitleEl = subtitleEl;

    this.recoveryMainFormEl = document.createElement('form');
    this.recoveryMainFormEl.className = 'ttm-form';

    this.recoveryEmailInput = document.createElement('input');
    this.recoveryEmailInput.type = 'email';
    this.recoveryEmailInput.id = 'ttm-recovery-email';
    this.recoveryEmailInput.name = 'email';
    this.recoveryEmailInput.className = 'ttm-input ttm-input-left';
    this.recoveryEmailInput.placeholder = t('recovery.emailPlaceholder');
    this.recoveryEmailInput.maxLength = 120;
    this.recoveryEmailInput.autocomplete = 'email';
    this.recoveryEmailInput.inputMode = 'email';

    const recoveryEmailHint = document.createElement('div');
    recoveryEmailHint.className = 'ttm-field-hint';
    recoveryEmailHint.textContent = t('recovery.emailHint');
    this.recoveryEmailHintEl = recoveryEmailHint;

    this.recoveryFeedbackEl = document.createElement('div');
    this.recoveryFeedbackEl.className = 'ttm-field-hint';
    this.recoveryFeedbackEl.textContent = '';

    this.recoverySubmitBtn = document.createElement('button');
    this.recoverySubmitBtn.type = 'submit';
    this.recoverySubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoverySubmitBtn.textContent = t('recovery.resetSendBtn');

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backBtn.textContent = t('common.back');
    backBtn.addEventListener('click', () => {
      this.returnToEntryScreen();
    });
    this.recoveryBackBtnEl = backBtn;

    this.recoveryMainFormEl.appendChild(this.recoveryEmailInput);
    this.recoveryMainFormEl.appendChild(recoveryEmailHint);
    this.recoveryMainFormEl.appendChild(this.recoveryFeedbackEl);
    this.recoveryMainFormEl.appendChild(this.recoverySubmitBtn);
    this.recoveryMainFormEl.appendChild(backBtn);

    this.recoveryMainFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.recoveryFeedbackEl.textContent = '';
      this.recoveryFeedbackEl.classList.remove('is-valid', 'is-invalid');

      const rawEmail = this.recoveryEmailInput.value.trim();
      const emailCheck = validateAccountEmail(rawEmail);
      if (!emailCheck.valid || !emailCheck.email) {
        this.recoveryFeedbackEl.textContent = emailCheck.error || t('recovery.resetValidEmail');
        this.recoveryFeedbackEl.classList.add('is-invalid');
        return;
      }

      if (!this.events.onSendPasswordResetEmail) return;
      this.recoverySubmitBtn.disabled = true;
      this.recoverySubmitBtn.textContent = t('recovery.resetSendingBtn');
      try {
        const res = await this.events.onSendPasswordResetEmail(emailCheck.email);
        this.recoveryFeedbackEl.textContent = t('recovery.resetSent', { email: res.email });
        this.recoveryFeedbackEl.classList.add('is-valid');
      } catch (err: any) {
        this.recoveryFeedbackEl.textContent = this.extractReadableError(err);
        this.recoveryFeedbackEl.classList.add('is-invalid');
      } finally {
        this.recoverySubmitBtn.disabled = false;
        this.recoverySubmitBtn.textContent = t('recovery.resetSendBtn');
      }
    });

    // Painel 2: Conclusão direta quando aberto via link ?mode=resetPassword&oobCode=...
    // Exibe exclusivamente "Novo PIN" e "Repetir PIN"
    this.recoveryOobBoxEl = document.createElement('div');
    this.recoveryOobBoxEl.className = 'ttm-recovery-confirm-box';
    this.recoveryOobBoxEl.style.display = 'none';

    const oobTitle = document.createElement('div');
    oobTitle.className = 'ttm-recovery-title';
    oobTitle.textContent = t('recovery.oobTitle');
    this.recoveryOobTitleEl = oobTitle;

    this.recoveryOobEmailLabelEl = document.createElement('p');
    this.recoveryOobEmailLabelEl.className = 'ttm-onboarding-tip';
    this.recoveryOobEmailLabelEl.textContent = t('recovery.oobDefaultDesc');

    const oobForm = document.createElement('form');
    oobForm.className = 'ttm-form';

    const oobPin1 = this.createPinInputWithToggle(
      'ttm-oob-pin',
      t('recovery.pinPlaceholder'),
      128,
      'off'
    );
    this.recoveryOobPinInput = oobPin1.input;
    this.recoveryOobPinToggleBtn1El = oobPin1.toggleBtn;

    const oobPin2 = this.createPinInputWithToggle(
      'ttm-oob-pin-confirm',
      t('recovery.pinConfirmPlaceholder'),
      128,
      'off'
    );
    this.recoveryOobPinConfirmInput = oobPin2.input;
    this.recoveryOobPinToggleBtn2El = oobPin2.toggleBtn;

    this.recoveryOobErrorEl = document.createElement('div');
    this.recoveryOobErrorEl.className = 'ttm-error';
    this.recoveryOobErrorEl.textContent = '';

    this.recoveryOobSubmitBtn = document.createElement('button');
    this.recoveryOobSubmitBtn.type = 'submit';
    this.recoveryOobSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoveryOobSubmitBtn.textContent = t('recovery.oobSaveBtn');

    const oobCancelBtn = document.createElement('button');
    oobCancelBtn.type = 'button';
    oobCancelBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    oobCancelBtn.textContent = t('common.cancel');
    oobCancelBtn.addEventListener('click', () => {
      this.activeOobCode = null;
      this.activeOobEmail = null;
      this.returnToEntryScreen();
    });
    this.recoveryOobCancelBtnEl = oobCancelBtn;

    oobForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.recoveryOobErrorEl.textContent = '';
      if (!this.activeOobCode) return;

      const newPin = this.recoveryOobPinInput.value.trim();
      const confirmPin = this.recoveryOobPinConfirmInput.value.trim();

      if (!/^\d{6,}$/.test(newPin)) {
        this.recoveryOobErrorEl.textContent = t('onboarding.errPinFormat');
        return;
      }
      if (newPin !== confirmPin) {
        this.recoveryOobErrorEl.textContent = t('onboarding.errPinMismatch');
        return;
      }
      const pinCheck = await validateLocalPin(newPin, false);
      if (!pinCheck.valid) {
        this.recoveryOobErrorEl.textContent = pinCheck.error || t('onboarding.errPinInvalid');
        return;
      }

      if (!this.events.onCompleteInAppPasswordReset) return;
      this.recoveryOobSubmitBtn.disabled = true;
      this.recoveryOobSubmitBtn.textContent = t('recovery.oobSavingBtn');
      try {
        await this.events.onCompleteInAppPasswordReset({
          oobCode: this.activeOobCode,
          newPin,
        });
        this.activeOobCode = null;
        this.activeOobEmail = null;
      } catch (err: any) {
        this.recoveryOobErrorEl.textContent = this.extractReadableError(err);
      } finally {
        this.recoveryOobSubmitBtn.disabled = false;
        this.recoveryOobSubmitBtn.textContent = t('recovery.oobSaveBtn');
      }
    });

    oobForm.appendChild(oobPin1.wrapper);
    oobForm.appendChild(oobPin2.wrapper);
    oobForm.appendChild(this.recoveryOobErrorEl);
    oobForm.appendChild(this.recoveryOobSubmitBtn);
    oobForm.appendChild(oobCancelBtn);
    this.recoveryOobBoxEl.appendChild(oobTitle);
    this.recoveryOobBoxEl.appendChild(this.recoveryOobEmailLabelEl);
    this.recoveryOobBoxEl.appendChild(oobForm);

    cardEl.appendChild(titleEl);
    cardEl.appendChild(subtitleEl);
    cardEl.appendChild(this.recoveryMainFormEl);
    cardEl.appendChild(this.recoveryOobBoxEl);
    this.recoveryViewEl.appendChild(cardEl);
  }

  /**
   * Hub de Conexões Bilaterais:
   * Descoberta exata pelo número de telefone declarado (sem expor código TM interno).
   */
  private createHubNavButton(
    svgPathMarkup: string,
    labelText: string,
    onClick: () => void,
    withBadge: boolean = false
  ): {
    btn: HTMLButtonElement;
    labelEl: HTMLElement;
    badgeEl?: HTMLElement;
  } {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttm-hub-nav-item';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'ttm-nav-icon';
    iconWrap.innerHTML = svgPathMarkup;

    const labelEl = document.createElement('span');
    labelEl.className = 'ttm-nav-label';
    labelEl.textContent = labelText;

    btn.appendChild(iconWrap);
    btn.appendChild(labelEl);

    let badgeEl: HTMLElement | undefined;
    if (withBadge) {
      badgeEl = document.createElement('span');
      badgeEl.className = 'ttm-nav-badge';
      badgeEl.style.display = 'none';
      btn.appendChild(badgeEl);
    }

    btn.addEventListener('click', onClick);
    return { btn, labelEl, badgeEl };
  }

  private buildConnectView(): void {
    this.connectViewEl = document.createElement('div');
    this.connectViewEl.id = 'ttm-connect-view';
    this.connectViewEl.className = 'ttm-connect-box';
    this.connectViewEl.style.display = 'none';

    this.hubNavEl = document.createElement('nav');
    this.hubNavEl.className = 'ttm-hub-nav';
    this.hubNavEl.setAttribute('aria-label', 'Talk2TM');

    const navDiscover = this.createHubNavButton(
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
      t('nav.discover'),
      () => this.setHubDestination('discover')
    );
    this.navDiscoverBtnEl = navDiscover.btn;
    this.navDiscoverLabelEl = navDiscover.labelEl;
    this.navDiscoverBtnEl.classList.add('is-active');

    const navMatches = this.createHubNavButton(
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
      t('nav.matches'),
      () => this.setHubDestination('matches'),
      true
    );
    this.navMatchesBtnEl = navMatches.btn;
    this.navMatchesLabelEl = navMatches.labelEl;
    this.navMatchesBadgeEl = navMatches.badgeEl!;

    const navChats = this.createHubNavButton(
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      t('nav.chats'),
      () => this.setHubDestination('connections')
    );
    this.navChatsBtnEl = navChats.btn;
    this.navChatsLabelEl = navChats.labelEl;

    const navAccount = this.createHubNavButton(
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      t('nav.account'),
      () => this.setHubDestination('account')
    );
    this.navAccountBtnEl = navAccount.btn;
    this.navAccountLabelEl = navAccount.labelEl;

    this.hubNavEl.appendChild(this.navDiscoverBtnEl);
    this.hubNavEl.appendChild(this.navMatchesBtnEl);
    this.hubNavEl.appendChild(this.navChatsBtnEl);
    this.hubNavEl.appendChild(this.navAccountBtnEl);

    this.hubContentEl = document.createElement('div');
    this.hubContentEl.className = 'ttm-hub-content';

    this.conversasSectionEl = document.createElement('div');
    this.conversasSectionEl.className = 'ttm-connect-cards-wrap';
    this.conversasSectionEl.style.display = 'none';

    this.accountSectionEl = document.createElement('div');
    this.accountSectionEl.className = 'ttm-connect-cards-wrap';
    this.accountSectionEl.style.display = 'none';

    // Cartão 1: Minha Conta & Segurança Local
    const selfCard = document.createElement('div');
    selfCard.className = 'ttm-connect-card';

    const selfTitle = document.createElement('div');
    selfTitle.className = 'ttm-connect-section-title';
    selfTitle.textContent = t('connect.myAccount');
    this.connectSelfTitleEl = selfTitle;

    const selfRow = document.createElement('div');
    selfRow.className = 'ttm-connect-self-row';

    this.selfAvatarSlotEl = document.createElement('div');
    this.selfAvatarSlotEl.className = 'ttm-self-avatar-slot';

    const selfMeta = document.createElement('div');
    selfMeta.className = 'ttm-connect-item-meta';

    this.connectSelfNameEl = document.createElement('div');
    this.connectSelfNameEl.className = 'ttm-connect-self-name';
    this.connectSelfNameEl.textContent = '';

    this.connectSelfPhoneEl = document.createElement('div');
    this.connectSelfPhoneEl.className = 'ttm-connect-item-sub';
    this.connectSelfPhoneEl.textContent = '';

    selfMeta.appendChild(this.connectSelfNameEl);
    selfMeta.appendChild(this.connectSelfPhoneEl);

    const selfActions = document.createElement('div');
    selfActions.className = 'ttm-connect-item-actions ttm-self-actions-wrap';

    const editDatingBtn = document.createElement('button');
    editDatingBtn.type = 'button';
    editDatingBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    editDatingBtn.textContent = t('dating.profileBtn');
    editDatingBtn.addEventListener('click', () => {
      this.setHubDestination('discover');
      this.datingPanel.openProfileEditor();
    });
    this.accountEditDatingBtnEl = editDatingBtn;

    const changePinBtn = document.createElement('button');
    changePinBtn.type = 'button';
    changePinBtn.className = 'ttm-btn-mini';
    changePinBtn.textContent = t('connect.changePinBtn');
    this.connectChangePinBtnEl = changePinBtn;

    const deleteAccountBtn = document.createElement('button');
    deleteAccountBtn.type = 'button';
    deleteAccountBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
    deleteAccountBtn.textContent = t('safety.deleteAccountBtn');
    deleteAccountBtn.title = t('safety.deleteAccountTitle');
    this.connectDeleteBtnEl = deleteAccountBtn;

    selfActions.appendChild(editDatingBtn);
    selfActions.appendChild(changePinBtn);
    selfActions.appendChild(deleteAccountBtn);
    selfRow.appendChild(this.selfAvatarSlotEl);
    selfRow.appendChild(selfMeta);
    selfRow.appendChild(selfActions);

    // Painel inline: Alterar PIN local
    this.connectPinPanelEl = document.createElement('div');
    this.connectPinPanelEl.className = 'ttm-inline-security-panel';
    this.connectPinPanelEl.style.display = 'none';

    const pinForm = document.createElement('form');
    pinForm.className = 'ttm-form';
    const curPinInp = document.createElement('input');
    curPinInp.type = 'password';
    curPinInp.inputMode = 'numeric';
    curPinInp.maxLength = 128;
    curPinInp.autocomplete = 'off';
    curPinInp.placeholder = t('connect.currentPinPlaceholder');
    curPinInp.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectCurPinInput = curPinInp;

    const nextPinInp = document.createElement('input');
    nextPinInp.type = 'password';
    nextPinInp.inputMode = 'numeric';
    nextPinInp.maxLength = 128;
    nextPinInp.autocomplete = 'off';
    nextPinInp.placeholder = t('connect.newPinPlaceholder');
    nextPinInp.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectNextPinInput = nextPinInp;

    const nextPinConfInp = document.createElement('input');
    nextPinConfInp.type = 'password';
    nextPinConfInp.inputMode = 'numeric';
    nextPinConfInp.maxLength = 128;
    nextPinConfInp.autocomplete = 'off';
    nextPinConfInp.placeholder = t('connect.confirmNewPinPlaceholder');
    nextPinConfInp.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectNextPinConfInput = nextPinConfInp;

    const savePinBtn = document.createElement('button');
    savePinBtn.type = 'submit';
    savePinBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    savePinBtn.textContent = t('connect.savePinBtn');
    this.connectSavePinBtnEl = savePinBtn;

    pinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cur = curPinInp.value.trim();
      const next = nextPinInp.value.trim();
      const conf = nextPinConfInp.value.trim();
      if (!/^\d{6,}$/.test(cur) || !/^\d{6,}$/.test(next)) {
        this.showConnectFeedback(t('onboarding.errPinFormat'), true);
        return;
      }
      if (next !== conf) {
        this.showConnectFeedback(t('connect.errPinMismatch'), true);
        return;
      }
      if (!this.events.onChangeLocalPin) return;
      savePinBtn.disabled = true;
      try {
        await this.events.onChangeLocalPin(cur, next);
        curPinInp.value = '';
        nextPinInp.value = '';
        nextPinConfInp.value = '';
        this.connectPinPanelEl.style.display = 'none';
        this.showConnectFeedback(t('connect.pinChanged'));
      } catch (err) {
        this.showConnectFeedback(this.extractReadableError(err), true);
      } finally {
        savePinBtn.disabled = false;
      }
    });

    pinForm.appendChild(curPinInp);
    pinForm.appendChild(nextPinInp);
    pinForm.appendChild(nextPinConfInp);
    pinForm.appendChild(savePinBtn);
    this.connectPinPanelEl.appendChild(pinForm);

    // Painel inline: Eliminação Real da Conta (Hard Delete)
    this.connectDeletePanelEl = document.createElement('div');
    this.connectDeletePanelEl.className = 'ttm-inline-security-panel ttm-danger-panel';
    this.connectDeletePanelEl.style.display = 'none';

    const deleteWarnEl = document.createElement('div');
    deleteWarnEl.className = 'ttm-field-hint ttm-danger-hint';
    deleteWarnEl.textContent = t('safety.deleteAccountWarning');
    this.connectDeleteWarningEl = deleteWarnEl;

    const deleteForm = document.createElement('form');
    deleteForm.className = 'ttm-form';

    const deletePinInput = document.createElement('input');
    deletePinInput.type = 'password';
    deletePinInput.inputMode = 'numeric';
    deletePinInput.maxLength = 128;
    deletePinInput.autocomplete = 'off';
    deletePinInput.placeholder = t('safety.deleteAccountPinPlaceholder');
    deletePinInput.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectDeletePinInput = deletePinInput;

    const deleteCheckRow = document.createElement('label');
    deleteCheckRow.className = 'ttm-dating-check-row';
    const deleteCheck = document.createElement('input');
    deleteCheck.type = 'checkbox';
    this.connectDeleteCheckbox = deleteCheck;
    const deleteCheckLabel = document.createElement('span');
    deleteCheckLabel.textContent = t('safety.deleteAccountCheckLabel');
    this.connectDeleteCheckLabelEl = deleteCheckLabel;
    deleteCheckRow.appendChild(deleteCheck);
    deleteCheckRow.appendChild(deleteCheckLabel);

    const deleteSubmitBtn = document.createElement('button');
    deleteSubmitBtn.type = 'submit';
    deleteSubmitBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
    deleteSubmitBtn.textContent = t('safety.deleteAccountSubmitBtn');
    this.connectDeleteSubmitBtnEl = deleteSubmitBtn;

    deleteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = deletePinInput.value.trim();
      if (!/^\d{6,}$/.test(pin)) {
        this.showConnectFeedback(t('connect.enterCurrentPin'), true);
        return;
      }
      if (!deleteCheck.checked) {
        this.showConnectFeedback(t('safety.deleteAccountCheckRequired'), true);
        return;
      }
      if (!this.isDeleteConfirmPending) {
        this.isDeleteConfirmPending = true;
        deleteSubmitBtn.classList.add('is-confirming');
        deleteSubmitBtn.textContent = t('safety.deleteAccountConfirmBtn');
        if (this.deleteConfirmTimerId) clearTimeout(this.deleteConfirmTimerId);
        this.deleteConfirmTimerId = setTimeout(() => {
          this.resetDeleteAccountConfirmState();
        }, 4000);
        return;
      }
      if (this.deleteConfirmTimerId) {
        clearTimeout(this.deleteConfirmTimerId);
        this.deleteConfirmTimerId = null;
      }
      this.isDeleteConfirmPending = false;
      deleteSubmitBtn.classList.remove('is-confirming');
      if (!this.events.onDeleteOwnAccount) return;
      deleteSubmitBtn.disabled = true;
      deleteSubmitBtn.textContent = t('safety.deleteAccountSubmittingBtn');
      try {
        await this.events.onDeleteOwnAccount(pin);
        deletePinInput.value = '';
        deleteCheck.checked = false;
      } catch (err) {
        this.showConnectFeedback(this.extractReadableError(err), true);
      } finally {
        deleteSubmitBtn.disabled = false;
        deleteSubmitBtn.textContent = t('safety.deleteAccountSubmitBtn');
      }
    });

    deleteForm.appendChild(deletePinInput);
    deleteForm.appendChild(deleteCheckRow);
    deleteForm.appendChild(deleteSubmitBtn);
    this.connectDeletePanelEl.appendChild(deleteWarnEl);
    this.connectDeletePanelEl.appendChild(deleteForm);

    changePinBtn.addEventListener('click', () => {
      const visible = this.connectPinPanelEl.style.display === 'flex';
      this.connectPinPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectDeletePanelEl.style.display = 'none';
      this.resetDeleteAccountConfirmState();
    });

    deleteAccountBtn.addEventListener('click', () => {
      const visible = this.connectDeletePanelEl.style.display === 'flex';
      this.connectDeletePanelEl.style.display = visible ? 'none' : 'flex';
      this.connectPinPanelEl.style.display = 'none';
      if (visible) {
        this.resetDeleteAccountConfirmState();
      }
    });

    selfCard.appendChild(selfTitle);
    selfCard.appendChild(selfRow);
    selfCard.appendChild(this.connectPinPanelEl);
    selfCard.appendChild(this.connectDeletePanelEl);

    // Cartão 2: Procurar contacto por telefone exato e convidar
    const inviteCard = document.createElement('div');
    inviteCard.className = 'ttm-connect-card';

    const inviteTitle = document.createElement('div');
    inviteTitle.className = 'ttm-connect-section-title';
    inviteTitle.textContent = t('connect.inviteTitle');
    this.connectInviteTitleEl = inviteTitle;

    const inviteForm = document.createElement('form');
    inviteForm.className = 'ttm-connect-form';

    this.connectTargetPreviewEl = document.createElement('div');
    this.connectTargetPreviewEl.className = 'ttm-field-hint';

    this.connectTargetField = createPhoneInputField({
      variant: 'compact',
      placeholder: t('connect.inviteTargetPlaceholder'),
      autocomplete: 'tel',
      onChange: (raw, res, country) => {
        this.updatePhonePreview(raw, res, country, this.connectTargetPreviewEl, 'connect');
      },
    });
    this.updatePhonePreview(
      '',
      { valid: false },
      this.connectTargetField.getCountry(),
      this.connectTargetPreviewEl,
      'connect'
    );

    this.connectInviteBtn = document.createElement('button');
    this.connectInviteBtn.type = 'submit';
    this.connectInviteBtn.className = 'ttm-btn ttm-btn-primary';
    this.connectInviteBtn.textContent = t('connect.inviteBtn');

    this.connectFeedbackEl = document.createElement('div');
    this.connectFeedbackEl.className = 'ttm-connect-feedback';

    inviteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawPhone = this.connectTargetField.getValue();
      if (!rawPhone) {
        this.showConnectFeedback(t('connect.inviteEnterPhone'), true);
        return;
      }
      const phoneCheck = this.connectTargetField.validate();
      if (!phoneCheck.valid || !phoneCheck.e164) {
        this.showConnectFeedback(phoneCheck.error || t('onboarding.errPhoneInvalid'), true);
        return;
      }
      if (!this.events.onSendInvite) return;
      this.connectInviteBtn.disabled = true;
      this.connectInviteBtn.textContent = t('connect.invitingBtn');
      this.showConnectFeedback('');
      try {
        await this.events.onSendInvite(phoneCheck.e164);
        this.connectTargetField.reset();
      } catch (err: any) {
        this.showConnectFeedback(this.extractReadableError(err), true);
      } finally {
        this.connectInviteBtn.disabled = false;
        this.connectInviteBtn.textContent = t('connect.inviteBtn');
      }
    });

    inviteForm.appendChild(this.connectTargetField.wrapper);
    inviteForm.appendChild(this.connectInviteBtn);
    inviteCard.appendChild(inviteTitle);
    inviteCard.appendChild(inviteForm);
    inviteCard.appendChild(this.connectTargetPreviewEl);
    inviteCard.appendChild(this.connectFeedbackEl);

    // Cartão 3: Convites Recebidos
    const incomingCard = document.createElement('div');
    incomingCard.className = 'ttm-connect-card';
    const incomingTitle = document.createElement('div');
    incomingTitle.className = 'ttm-connect-section-title';
    incomingTitle.textContent = t('connect.incomingTitle');
    this.connectIncomingTitleEl = incomingTitle;
    this.incomingInvitesListEl = document.createElement('div');
    this.incomingInvitesListEl.className = 'ttm-connect-list';
    incomingCard.appendChild(incomingTitle);
    incomingCard.appendChild(this.incomingInvitesListEl);

    // Cartão 4: Convites Enviados
    const outgoingCard = document.createElement('div');
    outgoingCard.className = 'ttm-connect-card';
    const outgoingTitle = document.createElement('div');
    outgoingTitle.className = 'ttm-connect-section-title';
    outgoingTitle.textContent = t('connect.outgoingTitle');
    this.connectOutgoingTitleEl = outgoingTitle;
    this.outgoingInvitesListEl = document.createElement('div');
    this.outgoingInvitesListEl.className = 'ttm-connect-list';
    outgoingCard.appendChild(outgoingTitle);
    outgoingCard.appendChild(this.outgoingInvitesListEl);

    // Cartão 5: Conversas Bilaterais Ativas
    const convCard = document.createElement('div');
    convCard.className = 'ttm-connect-card';
    const convTitle = document.createElement('div');
    convTitle.className = 'ttm-connect-section-title';
    convTitle.textContent = t('connect.conversationsTitle');
    this.connectConvTitleEl = convTitle;
    this.conversationsListEl = document.createElement('div');
    this.conversationsListEl.className = 'ttm-connect-list';
    convCard.appendChild(convTitle);
    convCard.appendChild(this.conversationsListEl);

    // Cartão 1.5: Partilha de Convite Individual & WhatsApp
    const refCard = document.createElement('div');
    refCard.className = 'ttm-connect-card ttm-referral-card';

    this.connectRefTitleEl = document.createElement('div');
    this.connectRefTitleEl.className = 'ttm-connect-section-title';
    this.connectRefTitleEl.textContent = t('referral.cardTitle');

    this.connectRefDescEl = document.createElement('div');
    this.connectRefDescEl.className = 'ttm-field-hint';
    this.connectRefDescEl.textContent = t('referral.cardDesc');

    this.connectRefUrlEl = document.createElement('div');
    this.connectRefUrlEl.className = 'ttm-referral-url';
    this.connectRefUrlEl.textContent = '—';

    this.connectRefStatsEl = document.createElement('div');
    this.connectRefStatsEl.className = 'ttm-referral-stats';
    this.connectRefStatsEl.textContent = t('referral.statsLine', {
      shared: 0,
      converted: 0,
      rate: 0,
    });

    const refActionsRow = document.createElement('div');
    refActionsRow.className = 'ttm-referral-actions';

    this.connectRefWhatsappLinkEl = document.createElement('a');
    this.connectRefWhatsappLinkEl.className = 'ttm-btn ttm-btn-whatsapp';
    this.connectRefWhatsappLinkEl.target = '_blank';
    this.connectRefWhatsappLinkEl.rel = 'noopener noreferrer';
    this.connectRefWhatsappLinkEl.href = 'https://wa.me/';
    this.connectRefWhatsappLinkEl.textContent = t('referral.whatsappBtn');
    this.connectRefWhatsappLinkEl.addEventListener('click', () => {
      const code = this.lastReferralSummary?.referralCode;
      if (code && this.events.onTrackReferralShare) {
        void this.events.onTrackReferralShare(code).then((nextShared) => {
          if (this.lastReferralSummary) {
            this.updateReferralMetrics({
              ...this.lastReferralSummary,
              invitesSharedCount: nextShared,
            });
          }
        }).catch(() => {});
      }
    });

    this.connectRefCopyBtnEl = document.createElement('button');
    this.connectRefCopyBtnEl.type = 'button';
    this.connectRefCopyBtnEl.className = 'ttm-btn ttm-btn-secondary';
    this.connectRefCopyBtnEl.textContent = t('referral.copyLinkBtn');
    this.connectRefCopyBtnEl.addEventListener('click', async () => {
      const url = this.lastReferralSummary?.inviteUrl;
      if (!url) return;
      await navigator.clipboard?.writeText(url).catch(() => {});
      this.showConnectFeedback(t('referral.linkCopied'));
      const code = this.lastReferralSummary?.referralCode;
      if (code && this.events.onTrackReferralShare) {
        void this.events.onTrackReferralShare(code).then((nextShared) => {
          if (this.lastReferralSummary) {
            this.updateReferralMetrics({
              ...this.lastReferralSummary,
              invitesSharedCount: nextShared,
            });
          }
        }).catch(() => {});
      }
    });

    refActionsRow.appendChild(this.connectRefWhatsappLinkEl);
    refActionsRow.appendChild(this.connectRefCopyBtnEl);

    refCard.appendChild(this.connectRefTitleEl);
    refCard.appendChild(this.connectRefDescEl);
    refCard.appendChild(this.connectRefUrlEl);
    refCard.appendChild(this.connectRefStatsEl);
    refCard.appendChild(refActionsRow);

    this.accountSectionEl.appendChild(selfCard);
    this.accountSectionEl.appendChild(refCard);
    this.conversasSectionEl.appendChild(inviteCard);
    this.conversasSectionEl.appendChild(incomingCard);
    this.conversasSectionEl.appendChild(outgoingCard);
    this.conversasSectionEl.appendChild(convCard);

    this.datingPanel = new DatingPanel({
      onLoadWorkspace: this.events.onLoadDatingWorkspace,
      onSaveProfile: this.events.onSaveDatingProfile,
      onSetVisibility: this.events.onSetDatingVisibility,
      onDiscover: this.events.onDiscoverDating,
      onEvaluate: this.events.onEvaluateDatingProfile,
      onLike: this.events.onLikeDatingCandidate,
      onOpenMatchChat: this.events.onOpenDatingMatchChat,
      onUnmatch: this.events.onUnmatchDating,
      onMarkMatchSeen: this.events.onMarkDatingMatchSeen,
      onUploadPhoto: this.events.onUploadDatingPhoto,
      onRemovePhoto: this.events.onRemoveDatingPhoto,
      onShareInvite: () => {
        void this.handleDatingShareInvite();
      },
      onReportCandidate: (candidate) => {
        this.openReportModal({
          targetUid: candidate.uid,
          targetTalk2tmId: candidate.talk2tmId,
          targetDisplayName: candidate.displayName,
          sourceType: 'dating_profile',
          itemRefId: candidate.uid,
          evidenceSnapshot: `${candidate.displayName} (${candidate.age}, ${candidate.city}): ${candidate.bio}`,
        });
      },
      onReportMatch: (match) => {
        const myUid = this.currentSession?.userId || '';
        const partner = getDatingMatchPartner(match, myUid);
        this.openReportModal({
          targetUid: partner.uid,
          targetTalk2tmId: partner.talk2tmId,
          targetDisplayName: partner.displayName,
          sourceType: 'dating_match',
          channelId: match.conversationId,
          itemRefId: match.matchId,
          evidenceSnapshot: `Match ${match.matchId} (${partner.displayName || partner.uid})`,
        });
      },
      onBlockUser: async (targetUid, targetName) => {
        if (!this.events.onBlockUser) return;
        await this.events.onBlockUser(targetUid, targetName);
        this.openBlockedDoneModal(targetName);
      },
    });
    this.datingPanel.rootEl.style.display = 'flex';

    this.hubContentEl.appendChild(this.datingPanel.rootEl);
    this.hubContentEl.appendChild(this.conversasSectionEl);
    this.hubContentEl.appendChild(this.accountSectionEl);

    this.connectViewEl.appendChild(this.hubNavEl);
    this.connectViewEl.appendChild(this.hubContentEl);
  }

  private trackShareAction(): void {
    const code = this.lastReferralSummary?.referralCode;
    if (code && this.events.onTrackReferralShare) {
      void this.events.onTrackReferralShare(code).then((nextShared) => {
        if (this.lastReferralSummary) {
          this.updateReferralMetrics({
            ...this.lastReferralSummary,
            invitesSharedCount: nextShared,
          });
        }
      }).catch(() => {});
    }
  }

  private async handleDatingShareInvite(): Promise<void> {
    const url = this.lastReferralSummary?.inviteUrl;
    if (!url) {
      this.setHubDestination('account');
      return;
    }
    this.shareSheetWhatsappEl.href = buildWhatsAppReferralShareUrl(
      t('referral.whatsappShareText', { url })
    );
    this.shareSheetModalEl.style.display = 'flex';
  }

  private syncDatingTabLabel(): void {
    if (!this.navMatchesBadgeEl || !this.navMatchesBtnEl) return;
    if (this.unseenDatingMatchCount > 0) {
      this.navMatchesBadgeEl.textContent = String(this.unseenDatingMatchCount);
      this.navMatchesBadgeEl.style.display = 'inline-flex';
    } else {
      this.navMatchesBadgeEl.textContent = '';
      this.navMatchesBadgeEl.style.display = 'none';
    }
    this.navMatchesBtnEl.classList.toggle('has-badge', this.unseenDatingMatchCount > 0);
  }

  public getActiveConnectTab(): 'connections' | 'dating' {
    return this.activeHubDest === 'discover' || this.activeHubDest === 'matches'
      ? 'dating'
      : 'connections';
  }

  public updateDatingMatches(matches: DatingMatch[], myUid: string): void {
    this.unseenDatingMatchCount = myUid ? getUnseenDatingMatches(matches, myUid).length : 0;
    this.syncDatingTabLabel();
    this.datingPanel?.updateMatches(matches);
  }

  private setHubDestination(dest: 'discover' | 'matches' | 'connections' | 'account'): void {
    this.activeHubDest = dest;
    const isDatingDest = dest === 'discover' || dest === 'matches';

    this.navDiscoverBtnEl.classList.toggle('is-active', dest === 'discover');
    this.navMatchesBtnEl.classList.toggle('is-active', dest === 'matches');
    this.navChatsBtnEl.classList.toggle('is-active', dest === 'connections');
    this.navAccountBtnEl.classList.toggle('is-active', dest === 'account');

    this.datingPanel.rootEl.style.display = isDatingDest ? 'flex' : 'none';
    this.conversasSectionEl.style.display = dest === 'connections' ? 'flex' : 'none';
    this.accountSectionEl.style.display = dest === 'account' ? 'flex' : 'none';

    if (this.hubContentEl) {
      this.hubContentEl.scrollTop = 0;
    }

    if (isDatingDest) {
      this.datingPanel.setSubView(dest === 'matches' ? 'matches' : 'discover');
      if (this.currentSession?.talk2tmId) {
        void this.datingPanel.loadForSession(this.currentSession);
      }
    }
  }

  private extractReadableError(err: unknown): string {
    let msg = err instanceof Error ? err.message : String(err || t('app.unexpectedError'));
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed.error === 'string') {
        msg = parsed.error;
      }
    } catch {
      // mantém texto original
    }
    if (msg.includes('Missing or insufficient permissions')) {
      return t('app.permissionDenied');
    }
    return msg;
  }

  /**
   * Tela de Chat Linear Móvel
   */
  private buildChatView(): void {
    this.chatViewEl = document.createElement('div');
    this.chatViewEl.id = 'ttm-chat';
    this.chatViewEl.className = 'ttm-chat-box';
    this.chatViewEl.style.display = 'none';

    // Faixa utilitária compacta do chat
    const topBar = document.createElement('div');
    topBar.className = 'ttm-topbar';

    const topBarActions = document.createElement('div');
    topBarActions.className = 'ttm-topbar-actions';

    this.loadOlderBtn = document.createElement('button');
    this.loadOlderBtn.type = 'button';
    this.loadOlderBtn.className = 'ttm-topbar-link';
    this.loadOlderBtn.textContent = t('chat.loadOlder');
    this.loadOlderBtn.style.display = 'none';
    this.loadOlderBtn.addEventListener('click', () => {
      this.events.onLoadOlder();
    });

    this.selectModeBtn = document.createElement('button');
    this.selectModeBtn.type = 'button';
    this.selectModeBtn.className = 'ttm-topbar-link ttm-btn-sel-top';
    this.selectModeBtn.textContent = t('chat.selectAll');
    this.selectModeBtn.title = t('chat.selectAllTitle');
    this.selectModeBtn.addEventListener('click', () => {
      if (this.renderedMessageIds.size === 0) {
        this.showTemporaryNotice(t('chat.noMessages'));
        return;
      }
      if (this.isSelectionMode) {
        this.exitSelectionMode();
      } else {
        this.selectAllMessages();
      }
    });

    this.chatBlockBtnEl = document.createElement('button');
    this.chatBlockBtnEl.type = 'button';
    this.chatBlockBtnEl.className = 'ttm-topbar-link ttm-topbar-danger';
    this.chatBlockBtnEl.textContent = t('safety.blockUserBtn');
    this.chatBlockBtnEl.title = t('safety.blockUserTitle');
    this.chatBlockBtnEl.style.display = 'none';
    this.chatBlockBtnEl.addEventListener('click', () => {
      void this.handleChatBlockClick();
    });

    topBarActions.appendChild(this.loadOlderBtn);
    topBarActions.appendChild(this.selectModeBtn);
    topBarActions.appendChild(this.chatBlockBtnEl);

    this.inactivityNoticeEl = document.createElement('span');
    this.inactivityNoticeEl.className = 'ttm-lock-badge';
    this.updateInactivityBadge();

    topBar.appendChild(topBarActions);
    topBar.appendChild(this.inactivityNoticeEl);
    this.chatViewEl.appendChild(topBar);

    // Mensagens
    this.msgListEl = document.createElement('div');
    this.msgListEl.id = 'ttm-msg-list';
    this.msgListEl.className = 'ttm-msg-list';
    this.chatViewEl.appendChild(this.msgListEl);

    // Cancelamento ultra-minimalista: clicar fora das mensagens encerra o modo de seleção
    this.msgListEl.addEventListener('click', (e) => {
      if (!this.isSelectionMode) return;
      // Se clicou na área vazia da lista (não numa linha de mensagem)
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('.ttm-msg-row')) {
        this.exitSelectionMode();
      }
    });

    // Tecla ESC para cancelar seleção
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isSelectionMode) {
        this.exitSelectionMode();
      }
    });

    // Formulário de envio
    this.sendFormEl = document.createElement('form');
    this.sendFormEl.className = 'ttm-send-form';

    this.msgInputEl = document.createElement('input');
    this.msgInputEl.type = 'text';
    this.msgInputEl.id = 'ttm-input-msg';
    this.msgInputEl.className = 'ttm-input ttm-input-msg';
    this.msgInputEl.maxLength = 2000;
    this.msgInputEl.placeholder = t('chat.msgPlaceholder');
    this.msgInputEl.autocomplete = 'off';
    this.msgInputEl.autocapitalize = 'sentences';

    this.charCountEl = document.createElement('span');
    this.charCountEl.className = 'ttm-char-count';
    this.charCountEl.textContent = '0/2000';

    this.msgInputEl.addEventListener('input', () => {
      this.charCountEl.textContent = `${this.msgInputEl.value.length}/2000`;
    });

    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-send';
    sendBtn.textContent = t('chat.sendBtn');
    this.sendBtnEl = sendBtn;

    const inputRow = document.createElement('div');
    inputRow.className = 'ttm-input-row';
    inputRow.appendChild(this.msgInputEl);
    inputRow.appendChild(sendBtn);

    this.sendFormEl.appendChild(inputRow);
    this.sendFormEl.appendChild(this.charCountEl);

    this.sendFormEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.msgInputEl.value;
      if (!text.trim()) return;
      this.events.onSendMessage(text);
      this.msgInputEl.value = '';
      this.charCountEl.textContent = '0/2000';
      this.msgInputEl.focus();
    });

    // Barra de Seleção e Exclusão (Selecionar Tudo + Cancelar + Apagar)
    this.selectionBarEl = document.createElement('div');
    this.selectionBarEl.className = 'ttm-selection-bar';
    this.selectionBarEl.style.display = 'none';

    const selectionLeft = document.createElement('div');
    selectionLeft.className = 'ttm-selection-left';

    this.selectAllBtnEl = document.createElement('button');
    this.selectAllBtnEl.type = 'button';
    this.selectAllBtnEl.className = 'ttm-btn ttm-btn-sel-all';
    this.selectAllBtnEl.textContent = t('chat.selectAll');
    this.selectAllBtnEl.title = t('chat.toggleSelectAllTitle');
    this.selectAllBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSelectAll();
    });

    this.cancelSelectionBtnEl = document.createElement('button');
    this.cancelSelectionBtnEl.type = 'button';
    this.cancelSelectionBtnEl.className = 'ttm-btn ttm-btn-sel-cancel';
    this.cancelSelectionBtnEl.textContent = t('common.cancel');
    this.cancelSelectionBtnEl.title = t('chat.cancelSelectionTitle');
    this.cancelSelectionBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exitSelectionMode();
    });

    selectionLeft.appendChild(this.selectAllBtnEl);
    selectionLeft.appendChild(this.cancelSelectionBtnEl);

    this.deleteBtnEl = document.createElement('button');
    this.deleteBtnEl.type = 'button';
    this.deleteBtnEl.className = 'ttm-btn ttm-btn-compact-del';
    this.deleteBtnEl.textContent = t('chat.delete');
    this.deleteBtnEl.title = t('chat.deleteTitle');
    this.deleteBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleDeleteBtnClick();
    });

    this.selectionBarEl.appendChild(selectionLeft);
    this.selectionBarEl.appendChild(this.deleteBtnEl);

    this.chatViewEl.appendChild(this.sendFormEl);
    this.chatViewEl.appendChild(this.selectionBarEl);
  }

  /**
   * Modal de Definições Mínimas
   * Permite configurar:
   * 1. Tempo de sessão (após o qual desconecta automaticamente)
   * 2. Bloqueio se ficar 5 segundos sem teclar (ou outro intervalo)
   */
  private buildSettingsModal(): void {
    this.settingsModalEl = document.createElement('div');
    this.settingsModalEl.id = 'ttm-settings-modal';
    this.settingsModalEl.className = 'ttm-modal-backdrop';
    this.settingsModalEl.style.display = 'none';

    const modalBox = document.createElement('div');
    modalBox.className = 'ttm-modal-box';

    const modalTitle = document.createElement('h2');
    modalTitle.className = 'ttm-modal-title';
    modalTitle.textContent = t('settings.title');
    this.settingsModalTitleEl = modalTitle;

    // Configuração 1: Tempo de Sessão
    const sessionGroup = document.createElement('div');
    sessionGroup.className = 'ttm-setting-group';

    const sessionLabel = document.createElement('label');
    sessionLabel.className = 'ttm-setting-label';
    sessionLabel.textContent = t('settings.sessionLabel');
    this.settingsSessionLabelEl = sessionLabel;

    this.sessionSelectEl = document.createElement('select');
    this.sessionSelectEl.className = 'ttm-select';

    sessionGroup.appendChild(sessionLabel);
    sessionGroup.appendChild(this.sessionSelectEl);

    // Configuração 2: Bloqueio por Inatividade (5 minutos sem teclar padrão)
    const inactivityGroup = document.createElement('div');
    inactivityGroup.className = 'ttm-setting-group';

    const inactivityLabel = document.createElement('label');
    inactivityLabel.className = 'ttm-setting-label';
    inactivityLabel.textContent = t('settings.inactivityLabel');
    this.settingsInactivityLabelEl = inactivityLabel;

    this.inactivitySelectEl = document.createElement('select');
    this.inactivitySelectEl.className = 'ttm-select';

    inactivityGroup.appendChild(inactivityLabel);
    inactivityGroup.appendChild(this.inactivitySelectEl);

    // Configuração 3: Aparência local no dispositivo (Talk2TM Padrão vs Calculadora Discreta)
    const appearanceGroup = document.createElement('div');
    appearanceGroup.className = 'ttm-setting-group';

    const appearanceLabel = document.createElement('label');
    appearanceLabel.className = 'ttm-setting-label';
    appearanceLabel.textContent = t('settings.appearanceLabel');
    this.settingsAppearanceLabelEl = appearanceLabel;

    this.appearanceSelectEl = document.createElement('select');
    this.appearanceSelectEl.className = 'ttm-select';

    appearanceGroup.appendChild(appearanceLabel);
    appearanceGroup.appendChild(this.appearanceSelectEl);

    // Configuração 4: Idioma local neste dispositivo (Automático / pt / en / fr / es)
    const languageGroup = document.createElement('div');
    languageGroup.className = 'ttm-setting-group';

    const languageLabel = document.createElement('label');
    languageLabel.className = 'ttm-setting-label';
    languageLabel.textContent = t('settings.languageLabel');
    this.settingsLanguageLabelEl = languageLabel;

    this.languageSelectEl = document.createElement('select');
    this.languageSelectEl.className = 'ttm-select';

    languageGroup.appendChild(languageLabel);
    languageGroup.appendChild(this.languageSelectEl);

    // Configuração 5: Notificações Web Push Discretas (sem dados sensíveis no ecrã bloqueado)
    const pushGroup = document.createElement('div');
    pushGroup.className = 'ttm-setting-group';

    const pushLabel = document.createElement('label');
    pushLabel.className = 'ttm-setting-label';
    pushLabel.textContent = t('settings.pushLabel');
    this.settingsPushLabelEl = pushLabel;

    const pushMasterRow = document.createElement('label');
    pushMasterRow.className = 'ttm-setting-check-row';
    this.pushEnabledCheckboxEl = document.createElement('input');
    this.pushEnabledCheckboxEl.type = 'checkbox';
    this.settingsPushEnableTextEl = document.createElement('span');
    this.settingsPushEnableTextEl.textContent = t('settings.pushMasterToggle');
    pushMasterRow.appendChild(this.pushEnabledCheckboxEl);
    pushMasterRow.appendChild(this.settingsPushEnableTextEl);

    const pushSubRow = document.createElement('div');
    pushSubRow.className = 'ttm-setting-subchecks';

    const pushMatchLabel = document.createElement('label');
    pushMatchLabel.className = 'ttm-setting-check-row';
    this.pushMatchCheckboxEl = document.createElement('input');
    this.pushMatchCheckboxEl.type = 'checkbox';
    this.settingsPushMatchTextEl = document.createElement('span');
    this.settingsPushMatchTextEl.textContent = t('settings.pushMatchToggle');
    pushMatchLabel.appendChild(this.pushMatchCheckboxEl);
    pushMatchLabel.appendChild(this.settingsPushMatchTextEl);

    const pushMsgLabel = document.createElement('label');
    pushMsgLabel.className = 'ttm-setting-check-row';
    this.pushMessageCheckboxEl = document.createElement('input');
    this.pushMessageCheckboxEl.type = 'checkbox';
    this.settingsPushMessageTextEl = document.createElement('span');
    this.settingsPushMessageTextEl.textContent = t('settings.pushMessageToggle');
    pushMsgLabel.appendChild(this.pushMessageCheckboxEl);
    pushMsgLabel.appendChild(this.settingsPushMessageTextEl);

    pushSubRow.appendChild(pushMatchLabel);
    pushSubRow.appendChild(pushMsgLabel);

    const permRow = document.createElement('div');
    permRow.className = 'ttm-notif-permission-row';

    this.settingsPushStatusEl = document.createElement('span');
    this.settingsPushStatusEl.className = 'ttm-field-hint';

    this.settingsPushPermissionBtnEl = document.createElement('button');
    this.settingsPushPermissionBtnEl.type = 'button';
    this.settingsPushPermissionBtnEl.className = 'ttm-btn-mini ttm-btn-mini-primary';
    this.settingsPushPermissionBtnEl.textContent = t('settings.pushAllowBtn');
    this.settingsPushPermissionBtnEl.addEventListener('click', () => {
      void this.handleRequestPushPermissionClick();
    });

    permRow.appendChild(this.settingsPushStatusEl);
    permRow.appendChild(this.settingsPushPermissionBtnEl);

    this.settingsPushHintEl = document.createElement('div');
    this.settingsPushHintEl.className = 'ttm-field-hint';
    this.settingsPushHintEl.textContent = t('settings.pushHint');

    this.pushEnabledCheckboxEl.addEventListener('change', () => {
      if (this.pushEnabledCheckboxEl.checked && getWebNotificationPermission() === 'default') {
        void this.handleRequestPushPermissionClick();
      } else {
        this.syncNotificationControlsUI();
      }
    });

    pushGroup.appendChild(pushLabel);
    pushGroup.appendChild(pushMasterRow);
    pushGroup.appendChild(pushSubRow);
    pushGroup.appendChild(permRow);
    pushGroup.appendChild(this.settingsPushHintEl);

    this.populateSettingsSelects();

    // Botões de Ação do Modal
    const modalActions = document.createElement('div');
    modalActions.className = 'ttm-modal-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ttm-btn ttm-btn-primary';
    saveBtn.textContent = t('settings.saveBtn');
    saveBtn.addEventListener('click', () => {
      this.settings = {
        sessionTimeoutMinutes: Number(this.sessionSelectEl.value),
        inactivityLockSeconds: Number(this.inactivitySelectEl.value),
        appearance: normalizeAppearanceMode(this.appearanceSelectEl.value),
        language: normalizeSettingsLanguage(this.languageSelectEl.value),
        pushEnabled: this.pushEnabledCheckboxEl.checked,
        pushMatchEnabled: this.pushMatchCheckboxEl.checked,
        pushMessageEnabled: this.pushMessageCheckboxEl.checked,
        version: 2,
      };
      this.events.onUpdateSettings(this.settings);
      this.syncLockButtonLabel();
      this.updateInactivityBadge();
      this.closeSettingsModal();
    });
    this.settingsSaveBtnEl = saveBtn;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ttm-btn ttm-btn-secondary';
    cancelBtn.textContent = t('common.close');
    cancelBtn.addEventListener('click', () => {
      this.closeSettingsModal();
    });
    this.settingsCancelBtnEl = cancelBtn;

    modalActions.appendChild(saveBtn);
    modalActions.appendChild(cancelBtn);

    modalBox.appendChild(modalTitle);
    modalBox.appendChild(sessionGroup);
    modalBox.appendChild(inactivityGroup);
    modalBox.appendChild(appearanceGroup);
    modalBox.appendChild(languageGroup);
    modalBox.appendChild(pushGroup);
    modalBox.appendChild(modalActions);
    this.settingsModalEl.appendChild(modalBox);
  }

  private async handleRequestPushPermissionClick(): Promise<void> {
    this.settingsPushPermissionBtnEl.disabled = true;
    const perm = await requestWebNotificationPermission();
    if (perm === 'granted') {
      this.pushEnabledCheckboxEl.checked = true;
      this.showTemporaryNotice(t('settings.pushPermissionGrantedNotice'));
    } else if (perm === 'denied') {
      this.pushEnabledCheckboxEl.checked = false;
      this.showTemporaryNotice(t('settings.pushPermissionDeniedNotice'));
    }
    this.syncNotificationControlsUI();
  }

  private syncNotificationControlsUI(): void {
    const perm = getWebNotificationPermission();
    const masterOn = this.pushEnabledCheckboxEl.checked;
    this.pushMatchCheckboxEl.disabled = !masterOn;
    this.pushMessageCheckboxEl.disabled = !masterOn;

    if (perm === 'unsupported') {
      this.settingsPushStatusEl.textContent = t('settings.pushStatusUnsupported');
      this.settingsPushPermissionBtnEl.style.display = 'none';
      this.pushEnabledCheckboxEl.disabled = true;
      return;
    }

    this.pushEnabledCheckboxEl.disabled = false;
    if (perm === 'granted') {
      this.settingsPushStatusEl.textContent = t('settings.pushStatusGranted');
      this.settingsPushPermissionBtnEl.style.display = 'none';
    } else if (perm === 'denied') {
      this.settingsPushStatusEl.textContent = t('settings.pushStatusDenied');
      this.settingsPushPermissionBtnEl.style.display = 'none';
    } else {
      this.settingsPushStatusEl.textContent = t('settings.pushStatusDefault');
      this.settingsPushPermissionBtnEl.style.display = 'inline-flex';
      this.settingsPushPermissionBtnEl.disabled = false;
      this.settingsPushPermissionBtnEl.textContent = t('settings.pushAllowBtn');
    }
  }

  private populateSettingsSelects(): void {
    const sessionOptions = [
      { val: 1, label: t('settings.opt.min1') },
      { val: 5, label: t('settings.opt.min5Default') },
      { val: 15, label: t('settings.opt.min15') },
      { val: 30, label: t('settings.opt.min30') },
      { val: 60, label: t('settings.opt.min60') },
      { val: 0, label: t('settings.opt.disabled') },
    ];
    this.sessionSelectEl.innerHTML = '';
    sessionOptions.forEach((opt) => {
      const option = document.createElement('option');
      option.value = String(opt.val);
      option.textContent = opt.label;
      if (opt.val === this.settings.sessionTimeoutMinutes) {
        option.selected = true;
      }
      this.sessionSelectEl.appendChild(option);
    });

    const inactivityOptions = [
      { val: 5, label: t('settings.opt.sec5') },
      { val: 10, label: t('settings.opt.sec10') },
      { val: 15, label: t('settings.opt.sec15') },
      { val: 30, label: t('settings.opt.sec30') },
      { val: 60, label: t('settings.opt.min1') },
      { val: 120, label: t('settings.opt.min2') },
      { val: 300, label: t('settings.opt.min5Default') },
      { val: 600, label: t('settings.opt.min10') },
      { val: 900, label: t('settings.opt.min15') },
      { val: 0, label: t('settings.opt.disabled') },
    ];
    this.inactivitySelectEl.innerHTML = '';
    inactivityOptions.forEach((opt) => {
      const option = document.createElement('option');
      option.value = String(opt.val);
      option.textContent = opt.label;
      if (opt.val === this.settings.inactivityLockSeconds) {
        option.selected = true;
      }
      this.inactivitySelectEl.appendChild(option);
    });

    const appearanceOptions: Array<{ val: 'talk2tm' | 'calculator'; label: string }> = [
      { val: 'talk2tm', label: t('settings.appearanceTalk2tm') },
      { val: 'calculator', label: t('settings.appearanceCalc') },
    ];
    const currentAppearance = normalizeAppearanceMode(this.settings.appearance);
    this.appearanceSelectEl.innerHTML = '';
    appearanceOptions.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.val;
      option.textContent = opt.label;
      if (opt.val === currentAppearance) {
        option.selected = true;
      }
      this.appearanceSelectEl.appendChild(option);
    });

    const currentLang = normalizeSettingsLanguage(this.settings.language);
    const languageOptions: Array<{ val: string; label: string }> = [
      { val: 'auto', label: t('settings.languageAuto') },
      ...SUPPORTED_LOCALES.map((code) => ({
        val: code,
        label: LOCALE_REGISTRY[code].nativeLabel,
      })),
    ];
    this.languageSelectEl.innerHTML = '';
    languageOptions.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.val;
      option.textContent = opt.label;
      if (opt.val === currentLang) {
        option.selected = true;
      }
      this.languageSelectEl.appendChild(option);
    });
  }

  public openSettingsModal(): void {
    this.sessionSelectEl.value = String(this.settings.sessionTimeoutMinutes);
    this.inactivitySelectEl.value = String(this.settings.inactivityLockSeconds);
    this.appearanceSelectEl.value = normalizeAppearanceMode(this.settings.appearance);
    this.languageSelectEl.value = normalizeSettingsLanguage(this.settings.language);
    const notif = normalizeNotificationSettings(this.settings);
    this.pushEnabledCheckboxEl.checked = notif.pushEnabled;
    this.pushMatchCheckboxEl.checked = notif.pushMatchEnabled;
    this.pushMessageCheckboxEl.checked = notif.pushMessageEnabled;
    this.syncNotificationControlsUI();
    this.settingsModalEl.style.display = 'flex';
  }

  public closeSettingsModal(): void {
    this.settingsModalEl.style.display = 'none';
  }

  private buildReportModal(): void {
    this.reportModalEl = document.createElement('div');
    this.reportModalEl.id = 'ttm-report-modal';
    this.reportModalEl.className = 'ttm-modal-backdrop';
    this.reportModalEl.style.display = 'none';

    const box = document.createElement('form');
    box.className = 'ttm-modal-box';

    this.reportModalTitleEl = document.createElement('h2');
    this.reportModalTitleEl.className = 'ttm-modal-title';
    this.reportModalTitleEl.textContent = t('safety.reportModalTitle');

    this.reportTargetLabelEl = document.createElement('div');
    this.reportTargetLabelEl.className = 'ttm-field-hint';

    const reasonGroup = document.createElement('div');
    reasonGroup.className = 'ttm-setting-group';
    this.reportReasonLabelEl = document.createElement('label');
    this.reportReasonLabelEl.className = 'ttm-setting-label';
    this.reportReasonLabelEl.textContent = t('safety.reportReasonLabel');
    this.reportReasonSelectEl = document.createElement('select');
    this.reportReasonSelectEl.className = 'ttm-select';
    this.populateReportReasonSelect();
    reasonGroup.appendChild(this.reportReasonLabelEl);
    reasonGroup.appendChild(this.reportReasonSelectEl);

    this.reportDetailsInputEl = document.createElement('textarea');
    this.reportDetailsInputEl.rows = 3;
    this.reportDetailsInputEl.maxLength = 300;
    this.reportDetailsInputEl.className = 'ttm-dating-textarea';
    this.reportDetailsInputEl.placeholder = t('safety.reportDetailsPlaceholder');

    this.reportErrorEl = document.createElement('div');
    this.reportErrorEl.className = 'ttm-connect-feedback is-error';

    const actions = document.createElement('div');
    actions.className = 'ttm-modal-actions';

    this.reportSubmitBtnEl = document.createElement('button');
    this.reportSubmitBtnEl.type = 'submit';
    this.reportSubmitBtnEl.className = 'ttm-btn ttm-btn-primary';
    this.reportSubmitBtnEl.textContent = t('safety.reportSubmitBtn');

    this.reportCancelBtnEl = document.createElement('button');
    this.reportCancelBtnEl.type = 'button';
    this.reportCancelBtnEl.className = 'ttm-btn ttm-btn-secondary';
    this.reportCancelBtnEl.textContent = t('common.cancel');
    this.reportCancelBtnEl.addEventListener('click', () => {
      this.closeReportModal();
    });

    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ctx = this.activeReportContext;
      if (!ctx || !this.events.onReportTarget) return;
      this.reportErrorEl.textContent = '';
      this.reportSubmitBtnEl.disabled = true;
      this.reportSubmitBtnEl.textContent = t('safety.reportSubmittingBtn');
      try {
        await this.events.onReportTarget({
          ...ctx,
          reason: this.reportReasonSelectEl.value as ReportReason,
          details: this.reportDetailsInputEl.value,
        });
        this.closeReportModal();
        this.showTemporaryNotice(t('safety.reportSentNotice'));
      } catch (err) {
        this.reportErrorEl.textContent = this.extractReadableError(err);
      } finally {
        this.reportSubmitBtnEl.disabled = false;
        this.reportSubmitBtnEl.textContent = t('safety.reportSubmitBtn');
      }
    });

    actions.appendChild(this.reportSubmitBtnEl);
    actions.appendChild(this.reportCancelBtnEl);

    box.appendChild(this.reportModalTitleEl);
    box.appendChild(this.reportTargetLabelEl);
    box.appendChild(reasonGroup);
    box.appendChild(this.reportDetailsInputEl);
    box.appendChild(this.reportErrorEl);
    box.appendChild(actions);
    this.reportModalEl.appendChild(box);
  }

  private buildShareSheetModal(): void {
    this.shareSheetModalEl = document.createElement('div');
    this.shareSheetModalEl.id = 'ttm-share-sheet-modal';
    this.shareSheetModalEl.className = 'ttm-modal-backdrop';
    this.shareSheetModalEl.style.display = 'none';
    this.shareSheetModalEl.addEventListener('click', (e) => {
      if (e.target === this.shareSheetModalEl) {
        this.shareSheetModalEl.style.display = 'none';
      }
    });

    const box = document.createElement('div');
    box.className = 'ttm-modal-box ttm-commercial-sheet';

    const emblem = document.createElement('div');
    emblem.className = 'ttm-sheet-emblem';
    emblem.innerHTML =
      '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

    this.shareSheetTitleEl = document.createElement('div');
    this.shareSheetTitleEl.className = 'ttm-sheet-title';
    this.shareSheetTitleEl.textContent = t('referral.sheetTitle');

    this.shareSheetDescEl = document.createElement('div');
    this.shareSheetDescEl.className = 'ttm-sheet-desc';
    this.shareSheetDescEl.textContent = t('referral.sheetDesc');

    const actions = document.createElement('div');
    actions.className = 'ttm-sheet-actions';

    this.shareSheetWhatsappEl = document.createElement('a');
    this.shareSheetWhatsappEl.className = 'ttm-btn ttm-btn-whatsapp';
    this.shareSheetWhatsappEl.target = '_blank';
    this.shareSheetWhatsappEl.rel = 'noopener noreferrer';
    this.shareSheetWhatsappEl.href = 'https://wa.me/';
    this.shareSheetWhatsappEl.textContent = t('referral.whatsappBtn');
    this.shareSheetWhatsappEl.addEventListener('click', () => {
      this.trackShareAction();
      this.shareSheetModalEl.style.display = 'none';
    });

    this.shareSheetCopyBtnEl = document.createElement('button');
    this.shareSheetCopyBtnEl.type = 'button';
    this.shareSheetCopyBtnEl.className = 'ttm-btn ttm-btn-secondary';
    this.shareSheetCopyBtnEl.textContent = t('referral.copyLinkBtn');
    this.shareSheetCopyBtnEl.addEventListener('click', async () => {
      const url = this.lastReferralSummary?.inviteUrl;
      if (!url) return;
      await navigator.clipboard?.writeText(url).catch(() => {});
      this.trackShareAction();
      this.shareSheetModalEl.style.display = 'none';
      this.showTemporaryNotice(t('referral.linkCopied'));
    });

    this.shareSheetDismissBtnEl = document.createElement('button');
    this.shareSheetDismissBtnEl.type = 'button';
    this.shareSheetDismissBtnEl.className = 'ttm-link-btn ttm-sheet-dismiss';
    this.shareSheetDismissBtnEl.textContent = t('referral.notNowBtn');
    this.shareSheetDismissBtnEl.addEventListener('click', () => {
      this.shareSheetModalEl.style.display = 'none';
    });

    actions.appendChild(this.shareSheetWhatsappEl);
    actions.appendChild(this.shareSheetCopyBtnEl);
    actions.appendChild(this.shareSheetDismissBtnEl);

    box.appendChild(emblem);
    box.appendChild(this.shareSheetTitleEl);
    box.appendChild(this.shareSheetDescEl);
    box.appendChild(actions);
    this.shareSheetModalEl.appendChild(box);
  }

  private buildBlockedDoneModal(): void {
    this.blockedDoneModalEl = document.createElement('div');
    this.blockedDoneModalEl.id = 'ttm-blocked-done-modal';
    this.blockedDoneModalEl.className = 'ttm-modal-backdrop';
    this.blockedDoneModalEl.style.display = 'none';
    this.blockedDoneModalEl.addEventListener('click', (e) => {
      if (e.target === this.blockedDoneModalEl) {
        this.blockedDoneModalEl.style.display = 'none';
      }
    });

    const box = document.createElement('div');
    box.className = 'ttm-modal-box ttm-commercial-sheet';

    const emblem = document.createElement('div');
    emblem.className = 'ttm-sheet-emblem is-safe';
    emblem.innerHTML =
      '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';

    this.blockedDoneTitleEl = document.createElement('div');
    this.blockedDoneTitleEl.className = 'ttm-sheet-title';
    this.blockedDoneTitleEl.textContent = t('safety.blockedModalTitle');

    this.blockedDoneDescEl = document.createElement('div');
    this.blockedDoneDescEl.className = 'ttm-sheet-desc';

    this.blockedDoneOkBtnEl = document.createElement('button');
    this.blockedDoneOkBtnEl.type = 'button';
    this.blockedDoneOkBtnEl.className = 'ttm-btn ttm-btn-primary';
    this.blockedDoneOkBtnEl.textContent = t('safety.blockedModalOkBtn');
    this.blockedDoneOkBtnEl.addEventListener('click', () => {
      this.blockedDoneModalEl.style.display = 'none';
    });

    box.appendChild(emblem);
    box.appendChild(this.blockedDoneTitleEl);
    box.appendChild(this.blockedDoneDescEl);
    box.appendChild(this.blockedDoneOkBtnEl);
    this.blockedDoneModalEl.appendChild(box);
  }

  public openBlockedDoneModal(targetName?: string): void {
    const cleanName = (targetName || '').trim() || t('connect.defaultContact');
    this.lastBlockedName = cleanName;
    this.blockedDoneTitleEl.textContent = t('safety.blockedModalTitle');
    this.blockedDoneDescEl.textContent = t('safety.blockedModalDesc', { name: cleanName });
    this.blockedDoneOkBtnEl.textContent = t('safety.blockedModalOkBtn');
    this.blockedDoneModalEl.style.display = 'flex';
  }

  private populateReportReasonSelect(): void {
    if (!this.reportReasonSelectEl) return;
    const prev = this.reportReasonSelectEl.value || 'harassment';
    this.reportReasonSelectEl.innerHTML = '';
    for (const reason of VALID_REPORT_REASONS) {
      const opt = document.createElement('option');
      opt.value = reason;
      opt.textContent = t(`safety.reportReason.${reason}`);
      this.reportReasonSelectEl.appendChild(opt);
    }
    this.reportReasonSelectEl.value = prev;
  }

  public openReportModal(context: {
    targetUid: string;
    targetTalk2tmId?: string;
    targetDisplayName?: string;
    sourceType: ReportSourceType;
    channelId?: string;
    itemRefId?: string;
    evidenceSnapshot: string;
  }): void {
    this.activeReportContext = context;
    this.populateReportReasonSelect();
    this.reportTargetLabelEl.textContent = t('safety.reportTargetPrefix', {
      target: context.targetDisplayName || t('connect.defaultContact'),
    });
    this.reportDetailsInputEl.value = '';
    this.reportErrorEl.textContent = '';
    this.reportSubmitBtnEl.disabled = false;
    this.reportSubmitBtnEl.textContent = t('safety.reportSubmitBtn');
    this.reportModalEl.style.display = 'flex';
  }

  public closeReportModal(): void {
    this.activeReportContext = null;
    if (this.reportModalEl) {
      this.reportModalEl.style.display = 'none';
    }
  }

  private resetDeleteAccountConfirmState(): void {
    if (this.deleteConfirmTimerId) {
      clearTimeout(this.deleteConfirmTimerId);
      this.deleteConfirmTimerId = null;
    }
    this.isDeleteConfirmPending = false;
    if (this.connectDeleteSubmitBtnEl) {
      this.connectDeleteSubmitBtnEl.classList.remove('is-confirming');
      this.connectDeleteSubmitBtnEl.textContent = t('safety.deleteAccountSubmitBtn');
    }
  }

  private resetChatBlockConfirmState(): void {
    if (this.chatBlockConfirmTimerId) {
      clearTimeout(this.chatBlockConfirmTimerId);
      this.chatBlockConfirmTimerId = null;
    }
    this.isChatBlockConfirmPending = false;
    if (this.chatBlockBtnEl) {
      this.chatBlockBtnEl.classList.remove('is-confirming');
      this.chatBlockBtnEl.textContent = t('safety.blockUserBtn');
    }
  }

  private async handleChatBlockClick(): Promise<void> {
    if (!this.currentChatPartnerUid || !this.events.onBlockUser) return;
    if (!this.isChatBlockConfirmPending) {
      this.isChatBlockConfirmPending = true;
      this.chatBlockBtnEl.classList.add('is-confirming');
      this.chatBlockBtnEl.textContent = t('safety.blockUserConfirmBtn');
      if (this.chatBlockConfirmTimerId) clearTimeout(this.chatBlockConfirmTimerId);
      this.chatBlockConfirmTimerId = setTimeout(() => {
        this.resetChatBlockConfirmState();
      }, 4000);
      return;
    }

    const targetUid = this.currentChatPartnerUid;
    const targetName = this.currentChatPartnerName;
    this.resetChatBlockConfirmState();
    this.chatBlockBtnEl.disabled = true;
    try {
      await this.events.onBlockUser(targetUid, targetName);
      this.openBlockedDoneModal(targetName);
    } catch (err) {
      this.showTemporaryNotice(this.extractReadableError(err));
    } finally {
      this.chatBlockBtnEl.disabled = false;
    }
  }

  public setChatBlockedState(blocked: boolean): void {
    this.isChatBlocked = blocked;
    if (this.msgInputEl) {
      this.msgInputEl.disabled = blocked;
      this.msgInputEl.placeholder = blocked
        ? t('safety.blockedChatPlaceholder')
        : t('chat.msgPlaceholder');
    }
    if (this.sendBtnEl) {
      this.sendBtnEl.disabled = blocked;
    }
  }

  private updateInactivityBadge(): void {
    if (this.settings.inactivityLockSeconds > 0) {
      const label = this.settings.inactivityLockSeconds >= 60
        ? `${Math.round(this.settings.inactivityLockSeconds / 60)}m`
        : `${this.settings.inactivityLockSeconds}s`;
      this.inactivityNoticeEl.textContent = t('chat.autoLockBadge', { label });
      this.inactivityNoticeEl.title = t('chat.autoLockTitle', { label });
      this.inactivityNoticeEl.style.display = 'inline-flex';
    } else {
      this.inactivityNoticeEl.textContent = '';
      this.inactivityNoticeEl.removeAttribute('title');
      this.inactivityNoticeEl.style.display = 'none';
    }
  }

  private setupAntiMediaGuards(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.showTemporaryNotice(t('chat.antiMediaDrop'));
    });

    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' || items[i].type.startsWith('image/')) {
          e.preventDefault();
          this.showTemporaryNotice(t('chat.antiMediaPaste'));
          return;
        }
      }
    });
  }

  public cacheOutgoingInviteTargetName(inviteId: string, displayName: string): void {
    if (inviteId && displayName) {
      this.outgoingTargetNameCache.set(inviteId, displayName);
    }
  }

  public getAppWrapper(): HTMLElement {
    return this.appWrapper;
  }

  private syncLockButtonLabel(): void {
    if (!this.lockBtnEl) return;
    if (normalizeAppearanceMode(this.settings.appearance) === 'calculator') {
      this.lockBtnEl.textContent = t('chat.lockCalcBtn');
      this.lockBtnEl.title = t('chat.lockCalcTitle');
    } else {
      this.lockBtnEl.textContent = t('chat.lockDefaultBtn');
      this.lockBtnEl.title = t('chat.lockDefaultTitle');
    }
  }

  private returnToEntryScreen(): void {
    if (normalizeAppearanceMode(this.settings.appearance) === 'calculator') {
      this.showPassEntryView();
    } else {
      this.showLockView();
    }
  }

  private updateReferralLandingLocale(): void {
    if (!this.landingViewEl) return;
    const inviterName = this.activeReferralInvite?.referrerDisplayName?.trim();
    this.landingKickerEl.textContent = inviterName
      ? t('landing.kickerNamed', { name: inviterName })
      : t('landing.kickerGeneric');
    this.landingTitleEl.textContent = t('landing.title');
    this.landingSubtitleEl.textContent = t('landing.subtitle');
    this.landingBullet1El.textContent = t('landing.point1');
    this.landingBullet2El.textContent = t('landing.point2');
    this.landingBullet3El.textContent = t('landing.point3');
    this.landingCtaBtnEl.textContent = t('landing.acceptCta');
    this.landingSecondaryBtnEl.textContent = t('landing.alreadyMemberBtn');
  }

  public showReferralLandingView(invite: { code: string; referrerDisplayName?: string }): void {
    this.activeReferralInvite = invite;
    this.hideAllPrimaryViews();
    this.updateReferralLandingLocale();
    this.landingViewEl.style.display = 'flex';
  }

  private syncOnboardingReferralBanner(): void {
    if (!this.onboardingRefBannerEl) return;
    const code = getPendingReferralCode();
    if (code) {
      this.onboardingRefBannerEl.textContent = t('referral.onboardingApplied', { code });
      this.onboardingRefBannerEl.style.display = 'block';
    } else {
      this.onboardingRefBannerEl.textContent = '';
      this.onboardingRefBannerEl.style.display = 'none';
    }
  }

  public updateReferralMetrics(summary: ReferralMetricsSummary): void {
    this.lastReferralSummary = summary;
    if (!this.connectRefUrlEl) return;
    this.connectRefUrlEl.textContent = summary.inviteUrl;
    const shareText = t('referral.whatsappShareText', { url: summary.inviteUrl });
    this.connectRefWhatsappLinkEl.href = buildWhatsAppReferralShareUrl(shareText);
    const rate = computeConversionRatePercent(summary.invitesSharedCount, summary.convertedCount);
    this.connectRefStatsEl.textContent = t('referral.statsLine', {
      shared: summary.invitesSharedCount,
      converted: summary.convertedCount,
      rate,
    });
  }

  public hideAllPrimaryViews(): void {
    this.appWrapper.classList.remove('is-hub-active');
    this.exitSelectionMode();
    this.closeSettingsModal();
    this.closeReportModal();
    this.resetChatBlockConfirmState();
    this.resetDeleteAccountConfirmState();
    this.lockScreen.hide();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.datingPanel?.reset();
    this.lastDatingUid = null;
    this.activeHubDest = 'discover';
    this.unseenDatingMatchCount = 0;
    this.syncDatingTabLabel();
  }

  public showLockView(): void {
    this.hideAllPrimaryViews();
    if (normalizeAppearanceMode(this.settings.appearance) === 'calculator') {
      this.calculator.show();
    } else {
      this.lockScreen.show();
    }
  }

  public showCalculatorView(): void {
    this.showLockView();
  }

  public showPassEntryView(): void {
    this.appWrapper.classList.remove('is-hub-active');
    this.closeSettingsModal();
    this.closeReportModal();
    this.lockScreen.hide();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.passViewEl.style.display = 'flex';
    this.datingPanel?.reset();
    this.lastDatingUid = null;
    this.activeHubDest = 'discover';
    this.unseenDatingMatchCount = 0;
    this.syncDatingTabLabel();
    if (this.backToLockBtnEl) {
      this.backToLockBtnEl.textContent =
        normalizeAppearanceMode(this.settings.appearance) === 'calculator'
          ? t('pass.backToCalc')
          : t('pass.backToLock');
    }
    const hasSavedVault = getAllLocalIdentities().length > 0;
    this.passSubtitleEl.textContent = hasSavedVault
      ? t('pass.subtitleWithVault')
      : t('pass.subtitleNoVault');
    this.singlePassInput.value = '';
    this.singlePassInput.type = 'password';
    this.passPinToggleBtnEl.textContent = t('common.show');
    this.passErrorEl.textContent = '';
    setTimeout(() => {
      this.singlePassInput.focus();
    }, 100);
  }

  public showOnboardingView(): void {
    this.appWrapper.classList.remove('is-hub-active');
    this.closeSettingsModal();
    this.closeReportModal();
    this.lockScreen.hide();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'flex';
    this.onboardingFormEl.style.display = 'flex';
    this.onboardingSubtitleEl.style.display = '';
    this.syncOnboardingReferralBanner();
    this.pendingActivationBoxEl.style.display = 'none';
    this.pendingActivationEmail = '';
    this.onboardingNameInput.value = '';
    this.onboardingUsernameHintEl.textContent = '';
    this.onboardingUsernameHintEl.style.display = 'none';
    this.onboardingUsernameHintEl.classList.remove('is-valid', 'is-invalid');
    this.onboardingPhoneField.reset();
    this.onboardingEmailInput.value = '';
    this.onboardingEmailHintEl.textContent = '';
    this.onboardingEmailHintEl.style.display = 'none';
    this.onboardingEmailHintEl.classList.remove('is-valid', 'is-invalid');
    this.onboardingPinInput.value = '';
    this.onboardingPinConfirmInput.value = '';
    this.onboardingPinInput.type = 'password';
    this.onboardingPinConfirmInput.type = 'password';
    this.onboardingPinToggleBtn1El.textContent = t('common.show');
    this.onboardingPinToggleBtn2El.textContent = t('common.show');
    this.onboardingErrorEl.textContent = '';
    this.onboardingSubmitBtn.disabled = false;
    this.onboardingSubmitBtn.textContent = t('onboarding.createEnterBtn');
    setTimeout(() => {
      this.onboardingNameInput.focus();
    }, 100);
  }

  public showPendingActivationView(email: string, _username?: string): void {
    this.appWrapper.classList.remove('is-hub-active');
    this.closeSettingsModal();
    this.closeReportModal();
    this.lockScreen.hide();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'flex';
    this.onboardingRefBannerEl.style.display = 'none';
    this.onboardingFormEl.style.display = 'none';
    this.onboardingSubtitleEl.style.display = 'none';
    this.pendingActivationEmail = email;
    this.pendingActivationBoxEl.style.display = 'flex';
    this.pendingActivationTitleEl.textContent = t('activation.title');
    this.pendingActivationDescEl.textContent = t('activation.desc', { email });
    this.pendingActivationFeedbackEl.textContent = '';
    this.pendingActivationFeedbackEl.classList.remove('is-valid', 'is-invalid');
    this.pendingActivationCheckBtn.disabled = false;
    this.pendingActivationCheckBtn.textContent = t('activation.checkBtn');
    this.pendingActivationResendBtn.disabled = false;
    this.pendingActivationResendBtn.textContent = t('activation.resendBtn');
  }

  public showRecoveryView(): void {
    this.appWrapper.classList.remove('is-hub-active');
    this.closeSettingsModal();
    this.closeReportModal();
    this.lockScreen.hide();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'flex';
    this.recoveryMainFormEl.style.display = 'flex';
    this.recoveryOobBoxEl.style.display = 'none';
    this.activeOobCode = null;
    this.activeOobEmail = null;
    this.recoveryEmailInput.value = '';
    this.recoveryFeedbackEl.textContent = '';
    this.recoveryFeedbackEl.classList.remove('is-valid', 'is-invalid');
    this.recoverySubmitBtn.disabled = false;
    this.recoverySubmitBtn.textContent = t('recovery.resetSendBtn');
    setTimeout(() => {
      this.recoveryEmailInput.focus();
    }, 100);
  }

  public showInAppPasswordResetView(oobCode: string, email: string): void {
    this.showRecoveryView();
    this.activeOobCode = oobCode;
    this.activeOobEmail = email;
    this.recoveryMainFormEl.style.display = 'none';
    this.recoveryOobBoxEl.style.display = 'flex';
    this.recoveryOobEmailLabelEl.textContent = t('recovery.oobAccountDesc', { email });
    this.recoveryOobPinInput.value = '';
    this.recoveryOobPinConfirmInput.value = '';
    this.recoveryOobPinInput.type = 'password';
    this.recoveryOobPinConfirmInput.type = 'password';
    this.recoveryOobPinToggleBtn1El.textContent = t('common.show');
    this.recoveryOobPinToggleBtn2El.textContent = t('common.show');
    this.recoveryOobErrorEl.textContent = '';
    setTimeout(() => {
      this.recoveryOobPinInput.focus();
    }, 100);
  }

  private applyConnectSessionMeta(session: UserSession): void {
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-flex' : 'none';
    const selfName = session.displayName || t('connect.defaultName');
    this.connectSelfNameEl.textContent = selfName;
    if (this.selfAvatarSlotEl) {
      this.selfAvatarSlotEl.innerHTML = '';
      this.selfAvatarSlotEl.appendChild(createMonogramAvatar(selfName, session.userId, 'md'));
    }
    const metaParts: string[] = [];
    if (session.username) {
      metaParts.push(`@${session.username}`);
    }
    if (session.phoneMasked) {
      metaParts.push(t('connect.discoveryMasked', { phoneMasked: session.phoneMasked }));
    } else {
      metaParts.push(t('connect.discoveryActive'));
    }
    if (session.email) {
      metaParts.push(session.email);
    }
    this.connectSelfPhoneEl.textContent = metaParts.join(' · ');
    this.roomInfoEl.innerHTML = '';
  }

  public showConnectView(session: UserSession): void {
    const switchedAccount = this.lastDatingUid !== session.userId;
    if (switchedAccount) {
      this.datingPanel.reset();
      this.lastDatingUid = session.userId;
      this.activeHubDest = 'discover';
      this.unseenDatingMatchCount = 0;
      this.syncDatingTabLabel();
    }
    this.currentSession = session;
    this.appWrapper.classList.add('is-hub-active');
    this.exitSelectionMode();
    this.closeSettingsModal();
    this.closeReportModal();
    this.resetChatBlockConfirmState();
    this.setChatBlockedState(false);
    this.lockScreen.hide();
    this.calculator.hide();
    this.passViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.headerEl.style.display = 'flex';
    this.connectViewEl.style.display = 'flex';
    this.connectPinPanelEl.style.display = 'none';
    this.connectDeletePanelEl.style.display = 'none';
    this.connectDeletePinInput.value = '';
    this.connectDeleteCheckbox.checked = false;
    this.resetDeleteAccountConfirmState();
    this.connectFeedbackEl.textContent = '';
    this.connectFeedbackEl.classList.remove('is-error');
    this.applyConnectSessionMeta(session);
    this.setHubDestination(this.activeHubDest);
  }

  public isConnectViewActive(): boolean {
    return this.connectViewEl ? this.connectViewEl.style.display === 'flex' : false;
  }

  public showConnectFeedback(text: string, isError: boolean = false): void {
    if (!this.connectFeedbackEl) return;
    this.connectFeedbackEl.textContent = text;
    if (isError) {
      this.connectFeedbackEl.classList.add('is-error');
    } else {
      this.connectFeedbackEl.classList.remove('is-error');
    }
  }

  public updateConnectHubData(data: {
    incoming: ConversationInvite[];
    outgoing: ConversationInvite[];
    conversations: Conversation[];
  }): void {
    this.lastHubData = data;
    if (!this.incomingInvitesListEl || !this.outgoingInvitesListEl || !this.conversationsListEl) return;

    // 1. Convites recebidos — formato minimalista obrigatório: «[Nome] quer conversar contigo»
    this.incomingInvitesListEl.innerHTML = '';
    if (data.incoming.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-connect-empty';
      empty.textContent = t('connect.incomingEmpty');
      this.incomingInvitesListEl.appendChild(empty);
    } else {
      data.incoming.forEach((inv) => {
        const item = document.createElement('div');
        item.className = 'ttm-connect-item';

        const senderName = inv.fromDisplayName || t('connect.defaultContact');
        item.appendChild(createMonogramAvatar(senderName, inv.fromUid || senderName, 'md'));

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        nameEl.textContent = t('connect.wantsToChat', { name: senderName });
        meta.appendChild(nameEl);

        const actions = document.createElement('div');
        actions.className = 'ttm-connect-item-actions';

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
        acceptBtn.textContent = t('connect.acceptBtn');
        acceptBtn.addEventListener('click', async () => {
          acceptBtn.disabled = true;
          try {
            await this.events.onAcceptInvite?.(inv);
          } catch (err) {
            this.showConnectFeedback(this.extractReadableError(err), true);
            acceptBtn.disabled = false;
          }
        });

        const declineBtn = document.createElement('button');
        declineBtn.type = 'button';
        declineBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
        declineBtn.textContent = t('connect.declineBtn');
        declineBtn.addEventListener('click', async () => {
          declineBtn.disabled = true;
          try {
            await this.events.onDeclineInvite?.(inv.inviteId);
          } catch (err) {
            this.showConnectFeedback(this.extractReadableError(err), true);
            declineBtn.disabled = false;
          }
        });

        actions.appendChild(acceptBtn);
        actions.appendChild(declineBtn);
        item.appendChild(meta);
        item.appendChild(actions);
        this.incomingInvitesListEl.appendChild(item);
      });
    }

    // 2. Convites enviados (sem expor TM-XXXX-XXXX)
    this.outgoingInvitesListEl.innerHTML = '';
    const pendingOutgoing = data.outgoing.filter((i) => i.status === 'pending');
    if (pendingOutgoing.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-connect-empty';
      empty.textContent = t('connect.outgoingEmpty');
      this.outgoingInvitesListEl.appendChild(empty);
    } else {
      pendingOutgoing.forEach((inv) => {
        const item = document.createElement('div');
        item.className = 'ttm-connect-item';

        const targetLabel = this.outgoingTargetNameCache.get(inv.inviteId) || t('connect.outgoingFallback');
        item.appendChild(createMonogramAvatar(targetLabel, inv.inviteId, 'md'));

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        nameEl.textContent = targetLabel;
        const subEl = document.createElement('div');
        subEl.className = 'ttm-connect-item-sub';
        subEl.textContent = t('connect.awaitingAcceptance');
        meta.appendChild(nameEl);
        meta.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'ttm-connect-item-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
        cancelBtn.textContent = t('common.cancel');
        cancelBtn.addEventListener('click', async () => {
          cancelBtn.disabled = true;
          try {
            await this.events.onCancelInvite?.(inv.inviteId);
          } catch (err) {
            this.showConnectFeedback(this.extractReadableError(err), true);
            cancelBtn.disabled = false;
          }
        });

        actions.appendChild(cancelBtn);
        item.appendChild(meta);
        item.appendChild(actions);
        this.outgoingInvitesListEl.appendChild(item);
      });
    }

    // 3. Conversas Bilaterais Ativas (apenas nomes, sem expor TM-XXXX-XXXX)
    this.conversationsListEl.innerHTML = '';
    if (data.conversations.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-connect-empty';
      empty.textContent = t('connect.conversationsEmpty');
      this.conversationsListEl.appendChild(empty);
    } else {
      const myUid = this.currentSession?.userId;
      data.conversations.forEach((conv) => {
        const isA = conv.participantA === myUid;
        const partnerName = isA ? conv.displayNameB : conv.displayNameA;
        const partnerUid = isA ? conv.participantB : conv.participantA;
        const safePartnerName = partnerName || t('connect.defaultContact');

        const item = document.createElement('div');
        item.className = 'ttm-connect-item';
        item.appendChild(createMonogramAvatar(safePartnerName, partnerUid || safePartnerName, 'md'));

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        nameEl.textContent = safePartnerName;
        const subEl = document.createElement('div');
        subEl.className = 'ttm-connect-item-sub';
        subEl.textContent = t('connect.privateChatSub');
        meta.appendChild(nameEl);
        meta.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'ttm-connect-item-actions';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
        openBtn.textContent = t('connect.openBtn');
        openBtn.addEventListener('click', async () => {
          openBtn.disabled = true;
          try {
            await this.events.onOpenConversation?.(conv.conversationId);
          } catch (err) {
            this.showConnectFeedback(this.extractReadableError(err), true);
            openBtn.disabled = false;
          }
        });

        actions.appendChild(openBtn);
        item.appendChild(meta);
        item.appendChild(actions);
        this.conversationsListEl.appendChild(item);
      });
    }
  }

  public isChatActive(): boolean {
    return this.chatViewEl ? this.chatViewEl.style.display === 'flex' : false;
  }

  public setCalculatorUnreadDot(active: boolean): void {
    this.calculator.setUnreadDot(active);
    this.lockScreen.setUnreadDot(active);
  }

  public hasCalculatorUnreadDot(): boolean {
    return this.calculator.hasUnreadDot() || this.lockScreen.hasUnreadDot();
  }

  public clearMessages(): void {
    this.renderedMessageIds.clear();
    this.renderedMessages.clear();
    this.selectedMessageIds.clear();
    if (this.msgListEl) {
      this.msgListEl.innerHTML = '';
    }
  }

  public showChatView(session: UserSession, room?: Room): void {
    this.appWrapper.classList.remove('is-hub-active');
    this.currentSession = session;
    this.closeSettingsModal();
    this.closeReportModal();
    this.resetChatBlockConfirmState();
    this.setChatBlockedState(false);
    this.currentChatPartnerUid = null;
    this.currentChatPartnerName = '';
    this.chatBlockBtnEl.style.display = 'none';
    this.lockScreen.hide();
    this.calculator.hide();
    this.passViewEl.style.display = 'none';
    if (this.landingViewEl) this.landingViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.headerEl.style.display = 'flex';
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-flex' : 'none';
    this.chatViewEl.style.display = 'flex';
    this.clearMessages();
    if (room) {
      this.currentRoom = room;
      this.updateRoomInfo(room, session);
      this.updateReadReceipts(room, session);
    } else if (session.talk2tmId) {
      this.renderRoomInfoStrip(
        t('chat.bilateralLabel'),
        t('chat.selfTag', { name: session.displayName }),
        'waiting'
      );
    }
    setTimeout(() => {
      if (!this.isChatBlocked) {
        this.msgInputEl.focus();
      }
    }, 100);
  }

  public updateConnectionState(state: ConnectionState): void {
    this.lastConnectionState = state;
    const stateKey =
      state === 'online'
        ? 'chat.netState.online'
        : state === 'offline'
          ? 'chat.netState.offline'
          : state === 'sincronizando'
            ? 'chat.netState.syncing'
            : 'chat.netState.connecting';
    const netLabel = t('chat.networkTitle', { state: t(stateKey) });
    this.statusEl.setAttribute('data-state', state);
    this.statusEl.setAttribute('title', netLabel);
    this.statusEl.setAttribute('aria-label', netLabel);
    if (state === 'online') {
      this.statusEl.classList.add('is-online');
      this.statusEl.classList.remove('is-offline');
    } else if (state === 'offline') {
      this.statusEl.classList.add('is-offline');
      this.statusEl.classList.remove('is-online');
    } else {
      this.statusEl.classList.remove('is-online', 'is-offline');
    }
  }

  private getNetworkIconSvg(): string {
    return `<svg class="ttm-net-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="2" y="16" width="3.5" height="5" rx="0.8"/><rect x="7.5" y="12" width="3.5" height="9" rx="0.8"/><rect x="13" y="7" width="3.5" height="14" rx="0.8"/><rect x="18.5" y="2" width="3.5" height="19" rx="0.8"/></svg>`;
  }

  private getSettingsIconSvg(): string {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  }

  private renderRoomInfoStrip(
    primaryText: string,
    secondaryText?: string,
    presenceState: 'connected' | 'waiting' | 'selection' | null = null
  ): void {
    this.roomInfoEl.innerHTML = '';
    if (!primaryText && !secondaryText) return;

    const primaryWrap = document.createElement('span');
    primaryWrap.className = 'ttm-room-primary';
    if (presenceState === 'connected' || presenceState === 'waiting') {
      const dot = document.createElement('span');
      dot.className = `ttm-room-dot ${presenceState === 'connected' ? 'is-connected' : 'is-waiting'}`;
      dot.setAttribute('aria-hidden', 'true');
      primaryWrap.appendChild(dot);
    }
    const primaryLabel = document.createElement('span');
    primaryLabel.className = presenceState === 'selection' ? 'ttm-room-selection-label' : 'ttm-room-partner';
    primaryLabel.textContent = primaryText;
    primaryWrap.appendChild(primaryLabel);
    this.roomInfoEl.appendChild(primaryWrap);

    if (secondaryText) {
      const secondaryEl = document.createElement('span');
      secondaryEl.className = 'ttm-room-self';
      secondaryEl.textContent = secondaryText;
      this.roomInfoEl.appendChild(secondaryEl);
    }
  }

  public updateRoomInfo(room: Room, session: UserSession): void {
    this.currentRoom = room;
    this.currentSession = session;
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-flex' : 'none';

    let partnerName = '';
    let partnerUid: string | null = null;
    if (session.conversationId) {
      if (room.participantA === session.userId) {
        partnerName = room.participantBName || '';
        partnerUid = room.participantB || null;
      } else if (room.participantB === session.userId) {
        partnerName = room.participantAName || '';
        partnerUid = room.participantA || null;
      } else {
        partnerName = room.participantAName === session.displayName
          ? (room.participantBName || '')
          : (room.participantAName || '');
      }
    } else {
      const isTruman = session.displayName === 'Truman';
      partnerName = isTruman ? 'Mãezinha' : 'Truman';
    }

    this.currentChatPartnerUid = partnerUid;
    this.currentChatPartnerName = partnerName;
    if (this.chatBlockBtnEl) {
      this.chatBlockBtnEl.style.display =
        session.conversationId && partnerUid ? 'inline-block' : 'none';
    }

    const isConnected = Boolean(room.participantB && room.participantB !== '');
    const primaryText = isConnected
      ? (partnerName || t('chat.roomDefaultPartner'))
      : t('chat.roomWaiting');
    const secondaryText = t('chat.selfTag', { name: session.displayName });

    if (!this.isSelectionMode) {
      this.renderRoomInfoStrip(primaryText, secondaryText, isConnected ? 'connected' : 'waiting');
    }
  }

  public setHasOlderMessages(hasOlder: boolean): void {
    this.loadOlderBtn.style.display = hasOlder ? 'inline-block' : 'none';
  }

  public getPartnerLastReadTime(): string | null {
    if (!this.currentRoom || !this.currentSession) return null;
    return getPartnerLastRead(this.currentRoom, this.currentSession.displayName, this.currentSession.userId);
  }

  public computeMessageStatus(msg: Message, isSelf: boolean): { text: string; dataStatus: string; title: string } {
    if (!isSelf) {
      return { text: '', dataStatus: 'incoming', title: '' };
    }
    if (msg.status === 'pending') {
      return { text: '·', dataStatus: 'pending', title: t('chat.msgStatusPending') };
    }

    const partnerReadTime = this.getPartnerLastReadTime();
    if (msg.status === 'read' || (partnerReadTime && partnerReadTime >= msg.createdAt)) {
      return { text: '✓✓', dataStatus: 'read', title: t('chat.msgStatusRead') };
    }

    return { text: '✓', dataStatus: 'synced', title: t('chat.msgStatusSent') };
  }

  public updateReadReceipts(room: Room, session: UserSession): void {
    this.currentRoom = room;
    this.currentSession = session;
    const partnerReadTime = getPartnerLastRead(room, session.displayName, session.userId);
    if (!partnerReadTime) return;

    for (const [messageId, item] of this.renderedMessages.entries()) {
      const isOwn =
        item.isSelf ||
        item.msg.sender === session.displayName ||
        item.msg.senderId === session.userId ||
        (Boolean(session.talk2tmId) && item.msg.senderTalk2tmId === session.talk2tmId);
      if (isOwn && item.msg.status !== 'pending') {
        item.isSelf = true;
        const isRead = partnerReadTime >= item.msg.createdAt;
        if (isRead) {
          item.msg.status = 'read';
          const row = document.getElementById(`ttm-msg-${messageId}`);
          if (row) {
            row.classList.add('ttm-msg-self');
            let statusSpan = row.querySelector('.msg-status') as HTMLElement | null;
            if (!statusSpan) {
              statusSpan = document.createElement('span');
              statusSpan.className = 'msg-status';
              const delBtn = row.querySelector('.ttm-msg-del');
              if (delBtn) {
                row.insertBefore(statusSpan, delBtn);
              } else {
                row.appendChild(statusSpan);
              }
            }
            statusSpan.textContent = '✓✓';
            statusSpan.setAttribute('data-status', 'read');
            statusSpan.setAttribute('title', t('chat.msgStatusRead'));
          }
        }
      }
    }
  }

  public appendOrUpdateMessage(msg: Message, isSelf: boolean): void {
    this.renderedMessages.set(msg.messageId, { msg, isSelf });
    const statusInfo = this.computeMessageStatus(msg, isSelf);

    const existingRow = document.getElementById(`ttm-msg-${msg.messageId}`);
    if (existingRow || this.renderedMessageIds.has(msg.messageId)) {
      if (existingRow) {
        existingRow.setAttribute('data-created-at', msg.createdAt);
        if (isSelf) {
          existingRow.classList.add('ttm-msg-self');
          let statusSpan = existingRow.querySelector('.msg-status') as HTMLElement | null;
          if (!statusSpan) {
            statusSpan = document.createElement('span');
            statusSpan.className = 'msg-status';
            const delBtn = existingRow.querySelector('.ttm-msg-del');
            if (delBtn) {
              existingRow.insertBefore(statusSpan, delBtn);
            } else {
              existingRow.appendChild(statusSpan);
            }
          }
          statusSpan.textContent = statusInfo.text;
          statusSpan.setAttribute('data-status', statusInfo.dataStatus);
          if (statusInfo.title) statusSpan.setAttribute('title', statusInfo.title);
        }
      }
      return;
    }

    const rowEl = document.createElement('div');
    rowEl.id = `ttm-msg-${msg.messageId}`;
    rowEl.className = 'ttm-msg-row';
    rowEl.setAttribute('data-created-at', msg.createdAt);
    rowEl.setAttribute('data-date-key', getLocalDateKey(msg.createdAt));
    if (isSelf) {
      rowEl.classList.add('ttm-msg-self');
    }
    if (msg.sender === 'Truman') {
      rowEl.classList.add('ttm-msg-truman');
    } else if (msg.sender === 'Mãezinha') {
      rowEl.classList.add('ttm-msg-maezinha');
    }

    if (this.isSelectionMode && this.selectedMessageIds.has(msg.messageId)) {
      rowEl.classList.add('ttm-msg-selected');
    }

    const checkSpan = document.createElement('span');
    checkSpan.className = 'msg-check';
    checkSpan.textContent = '✓ ';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = `[${formatTime(msg.createdAt)}] `;
    const fullDt = formatFullDateTime(msg.createdAt);
    if (fullDt) timeSpan.title = fullDt;

    const senderSpan = document.createElement('span');
    senderSpan.className = 'msg-sender';
    senderSpan.textContent = `${msg.sender}: `;

    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.textContent = msg.text;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'msg-status';
    statusSpan.textContent = statusInfo.text;
    statusSpan.setAttribute('data-status', statusInfo.dataStatus);
    if (statusInfo.title) statusSpan.setAttribute('title', statusInfo.title);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ttm-msg-del';
    deleteBtn.textContent = '×';
    deleteBtn.title = t('chat.deleteSingleTitle');
    deleteBtn.setAttribute('aria-label', t('chat.deleteSingleAria'));
    deleteBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      this.deleteSingleMessage(msg.messageId);
    });

    const reportBtn = this.createMessageReportButton(msg, isSelf);

    rowEl.appendChild(checkSpan);
    rowEl.appendChild(timeSpan);
    rowEl.appendChild(senderSpan);
    rowEl.appendChild(textSpan);
    if (isSelf) {
      rowEl.appendChild(statusSpan);
    }
    if (reportBtn) {
      rowEl.appendChild(reportBtn);
    }
    rowEl.appendChild(deleteBtn);

    this.attachMessageSelectionHandlers(rowEl, msg.messageId);

    // Inserção cronológica estável (ignora separadores de data durante a varredura)
    let insertBeforeNode: ChildNode | null = null;
    const children = this.msgListEl.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i] as HTMLElement;
      const childCreatedAt = child.getAttribute('data-created-at');
      if (!childCreatedAt) continue;
      if (childCreatedAt > msg.createdAt) {
        insertBeforeNode = child;
      } else {
        break;
      }
    }

    if (insertBeforeNode) {
      this.msgListEl.insertBefore(rowEl, insertBeforeNode);
      this.syncDateSeparators();
    } else {
      this.msgListEl.appendChild(rowEl);
      this.syncDateSeparators();
      this.scrollToBottom();
    }
    this.renderedMessageIds.add(msg.messageId);
  }

  public prependMessages(messages: Message[], currentUserId: string, currentUserName?: string): void {
    if (messages.length === 0) return;

    const previousHeight = this.msgListEl.scrollHeight;
    const fragment = document.createDocumentFragment();

    messages.forEach((msg) => {
      if (this.renderedMessageIds.has(msg.messageId)) return;

      const isSelf =
        msg.senderId === currentUserId ||
        (Boolean(currentUserName) && msg.sender === currentUserName);
      this.renderedMessages.set(msg.messageId, { msg, isSelf });
      const statusInfo = this.computeMessageStatus(msg, isSelf);

      const rowEl = document.createElement('div');
      rowEl.id = `ttm-msg-${msg.messageId}`;
      rowEl.className = 'ttm-msg-row';
      rowEl.setAttribute('data-created-at', msg.createdAt);
      rowEl.setAttribute('data-date-key', getLocalDateKey(msg.createdAt));
      if (isSelf) {
        rowEl.classList.add('ttm-msg-self');
      }
      if (msg.sender === 'Truman') {
        rowEl.classList.add('ttm-msg-truman');
      } else if (msg.sender === 'Mãezinha') {
        rowEl.classList.add('ttm-msg-maezinha');
      }

      if (this.isSelectionMode && this.selectedMessageIds.has(msg.messageId)) {
        rowEl.classList.add('ttm-msg-selected');
      }

      const checkSpan = document.createElement('span');
      checkSpan.className = 'msg-check';
      checkSpan.textContent = '✓ ';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'msg-time';
      timeSpan.textContent = `[${formatTime(msg.createdAt)}] `;
      const fullDt = formatFullDateTime(msg.createdAt);
      if (fullDt) timeSpan.title = fullDt;

      const senderSpan = document.createElement('span');
      senderSpan.className = 'msg-sender';
      senderSpan.textContent = `${msg.sender}: `;

      const textSpan = document.createElement('span');
      textSpan.className = 'msg-text';
      textSpan.textContent = msg.text;

      const statusSpan = document.createElement('span');
      statusSpan.className = 'msg-status';
      statusSpan.textContent = statusInfo.text;
      statusSpan.setAttribute('data-status', statusInfo.dataStatus);
      if (statusInfo.title) statusSpan.setAttribute('title', statusInfo.title);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'ttm-msg-del';
      deleteBtn.textContent = '×';
      deleteBtn.title = t('chat.deleteSingleTitle');
      deleteBtn.setAttribute('aria-label', t('chat.deleteSingleAria'));
      deleteBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        this.deleteSingleMessage(msg.messageId);
      });

      const reportBtn = this.createMessageReportButton(msg, isSelf);

      rowEl.appendChild(checkSpan);
      rowEl.appendChild(timeSpan);
      rowEl.appendChild(senderSpan);
      rowEl.appendChild(textSpan);
      if (isSelf) {
        rowEl.appendChild(statusSpan);
      }
      if (reportBtn) {
        rowEl.appendChild(reportBtn);
      }
      rowEl.appendChild(deleteBtn);

      this.attachMessageSelectionHandlers(rowEl, msg.messageId);

      fragment.appendChild(rowEl);
      this.renderedMessageIds.add(msg.messageId);
    });

    this.msgListEl.insertBefore(fragment, this.msgListEl.firstChild);
    this.syncDateSeparators();
    this.msgListEl.scrollTop = this.msgListEl.scrollHeight - previousHeight;
  }

  private createMessageReportButton(msg: Message, isSelf: boolean): HTMLButtonElement | null {
    const channelId = msg.conversationId || this.currentSession?.conversationId;
    if (isSelf || !channelId || !this.currentSession?.talk2tmId || !msg.senderId) {
      return null;
    }
    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'ttm-msg-report';
    reportBtn.textContent = '⚑';
    reportBtn.title = t('safety.reportMsgTitle');
    reportBtn.setAttribute('aria-label', t('safety.reportMsgAria'));
    reportBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      this.openReportModal({
        targetUid: msg.senderId!,
        targetTalk2tmId: msg.senderTalk2tmId,
        targetDisplayName: msg.sender,
        sourceType: 'chat_message',
        channelId,
        itemRefId: msg.messageId,
        evidenceSnapshot: `${msg.sender}: ${msg.text}`,
      });
    });
    return reportBtn;
  }

  /**
   * Garante um único separador de data acima da primeira mensagem visível de cada dia.
   * Mantém a lista limpa sem repetir a data em todas as mensagens e remove separadores órfãos.
   */
  private syncDateSeparators(): void {
    if (!this.msgListEl) return;

    const existingSeparators = Array.from(this.msgListEl.querySelectorAll('.ttm-date-separator')) as HTMLElement[];
    const rows = Array.from(this.msgListEl.querySelectorAll('.ttm-msg-row')) as HTMLElement[];

    if (rows.length === 0) {
      existingSeparators.forEach((sep) => sep.remove());
      return;
    }

    const neededBeforeRow = new Map<HTMLElement, { dateKey: string; label: string }>();
    let prevDateKey = '';
    const referenceNow = new Date();

    for (const row of rows) {
      const createdAt = row.getAttribute('data-created-at') || '';
      const dateKey = row.getAttribute('data-date-key') || getLocalDateKey(createdAt);
      if (dateKey && dateKey !== prevDateKey) {
        const label = formatDateSeparatorLabel(createdAt, referenceNow);
        if (label) {
          neededBeforeRow.set(row, { dateKey, label });
        }
        prevDateKey = dateKey;
      }
    }

    for (const sep of existingSeparators) {
      const next = sep.nextElementSibling as HTMLElement | null;
      const needed = next ? neededBeforeRow.get(next) : undefined;
      if (!needed || sep.getAttribute('data-date-key') !== needed.dateKey) {
        sep.remove();
      } else {
        const span = sep.querySelector('span');
        if (span && span.textContent !== needed.label) {
          span.textContent = needed.label;
        }
        neededBeforeRow.delete(next!);
      }
    }

    for (const [row, info] of neededBeforeRow.entries()) {
      const sepEl = document.createElement('div');
      sepEl.className = 'ttm-date-separator';
      sepEl.setAttribute('data-date-key', info.dateKey);
      const labelSpan = document.createElement('span');
      labelSpan.textContent = info.label;
      sepEl.appendChild(labelSpan);
      this.msgListEl.insertBefore(sepEl, row);
    }
  }

  /**
   * Vincula detecção de long-press (~500ms) e alternância de seleção
   */
  private attachMessageSelectionHandlers(rowEl: HTMLElement, messageId: string): void {
    let touchStartTime = 0;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let touchStartX = 0;
    let touchStartY = 0;

    const cancelTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    // Mobile touch
    let wasLongPressTriggered = false;

    rowEl.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.touches.length > 1) {
          cancelTimer();
          return;
        }
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        touchStartTime = Date.now();
        wasLongPressTriggered = false;

        cancelTimer();
        if (!this.isSelectionMode) {
          longPressTimer = setTimeout(() => {
            wasLongPressTriggered = true;
            this.enterSelectionMode(messageId);
            try {
              if (typeof navigator !== 'undefined' && navigator.vibrate) {
                navigator.vibrate(40);
              }
            } catch {
              // Silencioso se vibração não permitida
            }
          }, 500);
        }
      },
      { passive: true }
    );

    rowEl.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (!longPressTimer) return;
        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - touchStartX);
        const dy = Math.abs(touch.clientY - touchStartY);
        if (dx > 10 || dy > 10) {
          // Deslocamento de scroll: cancela long-press para não atrapalhar a rolagem
          cancelTimer();
        }
      },
      { passive: true }
    );

    rowEl.addEventListener('touchend', () => {
      cancelTimer();
      if (wasLongPressTriggered) {
        // Já entrou no modo seleção com esta mensagem selecionada, não faz toggle no touchend
        wasLongPressTriggered = false;
        return;
      }
      if (this.isSelectionMode) {
        // No modo de seleção, tocar na mensagem faz toggle
        this.toggleMessageSelection(messageId);
      }
    });

    rowEl.addEventListener('touchcancel', () => {
      cancelTimer();
      wasLongPressTriggered = false;
    });

    // Desktop mouse
    let mouseStartX = 0;
    let mouseStartY = 0;
    let wasMouseLongPressTriggered = false;

    rowEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      cancelTimer();
      mouseStartX = e.clientX;
      mouseStartY = e.clientY;
      wasMouseLongPressTriggered = false;
      if (!this.isSelectionMode) {
        longPressTimer = setTimeout(() => {
          wasMouseLongPressTriggered = true;
          this.enterSelectionMode(messageId);
        }, 500);
      }
    });

    rowEl.addEventListener('mousemove', (e: MouseEvent) => {
      if (!longPressTimer) return;
      const dx = Math.abs(e.clientX - mouseStartX);
      const dy = Math.abs(e.clientY - mouseStartY);
      if (dx > 8 || dy > 8) {
        cancelTimer();
      }
    });

    rowEl.addEventListener('mouseup', () => {
      cancelTimer();
    });

    rowEl.addEventListener('click', (e: MouseEvent) => {
      if (wasMouseLongPressTriggered) {
        wasMouseLongPressTriggered = false;
        e.preventDefault();
        return;
      }
      if (this.isSelectionMode) {
        e.preventDefault();
        this.toggleMessageSelection(messageId);
      }
    });

    // Evita menu contextual nativo durante toque longo
    rowEl.addEventListener('contextmenu', (e: MouseEvent) => {
      if (this.isSelectionMode || Date.now() - touchStartTime < 800) {
        e.preventDefault();
      }
    });
  }

  public enterSelectionMode(initialMessageId: string): void {
    this.isSelectionMode = true;
    this.selectedMessageIds.clear();
    this.selectedMessageIds.add(initialMessageId);

    this.msgListEl.classList.add('ttm-selecting-mode');

    // Marca linha inicial
    const row = document.getElementById(`ttm-msg-${initialMessageId}`);
    if (row) {
      row.classList.add('ttm-msg-selected');
    }

    this.sendFormEl.style.display = 'none';
    this.selectionBarEl.style.display = 'flex';
    this.resetDeleteButtonState();
    this.updateSelectionUI();
  }

  /**
   * Seleciona todas as mensagens renderizadas na tela para exclusão
   */
  public selectAllMessages(): void {
    if (this.renderedMessageIds.size === 0) return;

    this.isSelectionMode = true;
    this.selectedMessageIds.clear();
    this.renderedMessageIds.forEach((id) => this.selectedMessageIds.add(id));

    this.msgListEl.classList.add('ttm-selecting-mode');

    // Destaca todas as linhas renderizadas
    this.renderedMessageIds.forEach((id) => {
      const row = document.getElementById(`ttm-msg-${id}`);
      if (row) {
        row.classList.add('ttm-msg-selected');
      }
    });

    this.sendFormEl.style.display = 'none';
    this.selectionBarEl.style.display = 'flex';
    this.resetDeleteButtonState();
    this.updateSelectionUI();
  }

  /**
   * Alterna entre selecionar todas e desmarcar tudo
   */
  public toggleSelectAll(): void {
    const total = this.renderedMessageIds.size;
    const isAllSelected = total > 0 && this.selectedMessageIds.size === total;
    if (isAllSelected) {
      this.exitSelectionMode();
    } else {
      this.selectAllMessages();
    }
  }

  public toggleMessageSelection(messageId: string): void {
    if (this.selectedMessageIds.has(messageId)) {
      this.selectedMessageIds.delete(messageId);
    } else {
      this.selectedMessageIds.add(messageId);
    }

    const row = document.getElementById(`ttm-msg-${messageId}`);
    if (row) {
      if (this.selectedMessageIds.has(messageId)) {
        row.classList.add('ttm-msg-selected');
      } else {
        row.classList.remove('ttm-msg-selected');
      }
    }

    // Se o usuário desmarcou tudo, sai automaticamente do modo de seleção
    if (this.selectedMessageIds.size === 0) {
      this.exitSelectionMode();
      return;
    }

    this.resetDeleteButtonState();
    this.updateSelectionUI();
  }

  private updateSelectionUI(): void {
    const count = this.selectedMessageIds.size;
    const total = this.renderedMessageIds.size;
    const isAll = total > 0 && count === total;
    const text = isAll
      ? t('chat.allSelected', { count })
      : count === 1
        ? t('chat.oneSelected')
        : t('chat.manySelected', { count });
    this.renderRoomInfoStrip(
      text,
      this.currentSession ? t('chat.selfTag', { name: this.currentSession.displayName }) : undefined,
      'selection'
    );

    if (this.selectAllBtnEl) {
      this.selectAllBtnEl.textContent = isAll ? t('chat.deselectAll') : t('chat.selectAll');
    }

    if (this.selectModeBtn) {
      this.selectModeBtn.textContent = this.isSelectionMode
        ? t('chat.exitSelection')
        : t('chat.selectAll');
    }

    if (!this.isConfirmPending) {
      this.deleteBtnEl.textContent =
        count > 1 ? t('chat.deleteCount', { count }) : t('chat.delete');
    }
  }

  private resetDeleteButtonState(): void {
    if (this.confirmTimerId) {
      clearTimeout(this.confirmTimerId);
      this.confirmTimerId = null;
    }
    this.isConfirmPending = false;
    this.deleteBtnEl.classList.remove('ttm-btn-confirm-state');
    const count = this.selectedMessageIds.size;
    this.deleteBtnEl.textContent =
      count > 1 ? t('chat.deleteCount', { count }) : t('chat.delete');
  }

  private handleDeleteBtnClick(): void {
    const count = this.selectedMessageIds.size;
    if (count === 0) {
      this.exitSelectionMode();
      return;
    }

    if (!this.isConfirmPending) {
      // Primeiro clique: solicita confirmação discreta sem modal nem botões extras
      this.isConfirmPending = true;
      this.deleteBtnEl.classList.add('ttm-btn-confirm-state');
      this.deleteBtnEl.textContent =
        count > 1 ? t('chat.confirmCount', { count }) : t('chat.confirm');

      // Auto-reverte para 'Apagar' após 3.5 segundos de inatividade
      if (this.confirmTimerId) clearTimeout(this.confirmTimerId);
      this.confirmTimerId = setTimeout(() => {
        if (this.isSelectionMode && this.isConfirmPending) {
          this.resetDeleteButtonState();
        }
      }, 3500);
    } else {
      // Segundo clique: executa exclusão local imediata
      this.confirmDeleteSelected();
    }
  }

  private confirmDeleteSelected(): void {
    const ids = Array.from(this.selectedMessageIds);
    if (ids.length > 0) {
      if (this.events.onDeleteMessagesLocally) {
        this.events.onDeleteMessagesLocally(ids);
      }
      this.removeMessages(ids);
      const count = ids.length;
      this.showTemporaryNotice(
        count > 1 ? t('chat.deletedMany', { count }) : t('chat.deletedOne')
      );
    }
    this.exitSelectionMode();
  }

  public exitSelectionMode(): void {
    this.isSelectionMode = false;
    this.selectedMessageIds.clear();
    this.resetDeleteButtonState();

    this.msgListEl.classList.remove('ttm-selecting-mode');

    // Remove classes visuais
    const selectedRows = this.msgListEl.querySelectorAll('.ttm-msg-selected');
    selectedRows.forEach((el) => el.classList.remove('ttm-msg-selected'));

    this.selectionBarEl.style.display = 'none';
    this.sendFormEl.style.display = 'block';

    if (this.selectModeBtn) {
      this.selectModeBtn.textContent = t('chat.selectAll');
    }

    if (this.currentSession) {
      if (this.isConnectViewActive()) {
        this.roomInfoEl.innerHTML = '';
      } else if (this.currentRoom) {
        this.updateRoomInfo(this.currentRoom, this.currentSession);
      } else if (this.currentSession.talk2tmId) {
        this.renderRoomInfoStrip(
          t('chat.bilateralLabel'),
          t('chat.selfTag', { name: this.currentSession.displayName }),
          'waiting'
        );
      }
    }
  }

  /**
   * Atualiza toda a interface visível após alteração de idioma no dispositivo
   * sem descartar sessão, mensagens renderizadas ou entradas em curso.
   */
  public refreshLocale(): void {
    this.pwaPromptBar?.refreshLocale();
    this.lockScreen?.refreshLocale();
    this.calculator?.refreshLocale();

    // Cabeçalho
    this.connectionsBtnEl.textContent = t('chat.connectionsBtn');
    this.connectionsBtnEl.title = t('chat.connectionsTitle');
    this.settingsBtnEl.title = t('chat.settingsTitle');
    this.settingsBtnEl.setAttribute('aria-label', t('chat.settingsBtn'));
    this.syncLockButtonLabel();
    this.updateConnectionState(this.lastConnectionState);

    // Tela manual de PIN
    const hasSavedVault = getAllLocalIdentities().length > 0;
    this.passSubtitleEl.textContent = hasSavedVault
      ? t('pass.subtitleWithVault')
      : t('pass.subtitleNoVault');
    this.singlePassInput.placeholder = t('pass.pinPlaceholder');
    this.passPinToggleBtnEl.textContent =
      this.singlePassInput.type === 'text' ? t('common.hide') : t('common.show');
    this.passPinToggleBtnEl.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.passEnterBtnEl.textContent = t('pass.signInBtn');
    this.passCreateBtnEl.textContent = t('pass.createBtn');
    this.passRecoverBtnEl.textContent = t('pass.recoverBtn');
    this.backToLockBtnEl.textContent =
      normalizeAppearanceMode(this.settings.appearance) === 'calculator'
        ? t('pass.backToCalc')
        : t('pass.backToLock');

    // Cadastro e Ativação
    this.onboardingTitleEl.textContent = t('onboarding.title');
    this.onboardingSubtitleEl.textContent = t('onboarding.subtitle');
    this.onboardingNameInput.placeholder = t('onboarding.namePlaceholder');
    this.onboardingPhoneField.input.placeholder = t('onboarding.phonePlaceholder');
    this.onboardingPhoneField.refreshLocale();
    this.onboardingEmailInput.placeholder = t('onboarding.emailPlaceholder');
    if (!this.onboardingEmailInput.value.trim()) {
      this.onboardingEmailHintEl.textContent = '';
      this.onboardingEmailHintEl.style.display = 'none';
    }
    this.onboardingPinInput.placeholder = t('onboarding.pinPlaceholder');
    this.onboardingPinConfirmInput.placeholder = t('onboarding.pinConfirmPlaceholder');
    this.onboardingPinToggleBtn1El.textContent =
      this.onboardingPinInput.type === 'text' ? t('common.hide') : t('common.show');
    this.onboardingPinToggleBtn2El.textContent =
      this.onboardingPinConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.onboardingPinToggleBtn1El.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.onboardingPinToggleBtn2El.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.onboardingSubmitBtn.textContent = t('onboarding.createEnterBtn');
    this.onboardingBackBtnEl.textContent = t('common.back');
    this.pendingActivationTitleEl.textContent = t('activation.title');
    if (this.pendingActivationEmail) {
      this.pendingActivationDescEl.textContent = t('activation.desc', {
        email: this.pendingActivationEmail,
      });
    }
    this.pendingActivationCheckBtn.textContent = t('activation.checkBtn');
    this.pendingActivationResendBtn.textContent = t('activation.resendBtn');
    this.pendingActivationBackBtn.textContent = t('common.back');

    // Recuperação
    this.recoveryTitleEl.textContent = t('recovery.title');
    this.recoverySubtitleEl.textContent = t('recovery.subtitle');
    this.recoveryEmailInput.placeholder = t('recovery.emailPlaceholder');
    this.recoveryEmailHintEl.textContent = t('recovery.emailHint');
    this.recoverySubmitBtn.textContent = t('recovery.resetSendBtn');
    this.recoveryBackBtnEl.textContent = t('common.back');
    this.recoveryOobTitleEl.textContent = t('recovery.oobTitle');
    this.recoveryOobEmailLabelEl.textContent = this.activeOobEmail
      ? t('recovery.oobAccountDesc', { email: this.activeOobEmail })
      : t('recovery.oobDefaultDesc');
    this.recoveryOobPinInput.placeholder = t('recovery.pinPlaceholder');
    this.recoveryOobPinConfirmInput.placeholder = t('recovery.pinConfirmPlaceholder');
    this.recoveryOobPinToggleBtn1El.textContent =
      this.recoveryOobPinInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryOobPinToggleBtn2El.textContent =
      this.recoveryOobPinConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryOobSubmitBtn.textContent = t('recovery.oobSaveBtn');
    this.recoveryOobCancelBtnEl.textContent = t('common.cancel');

    // Hub Bilateral & Descoberta
    this.navDiscoverLabelEl.textContent = t('nav.discover');
    this.navMatchesLabelEl.textContent = t('nav.matches');
    this.navChatsLabelEl.textContent = t('nav.chats');
    this.navAccountLabelEl.textContent = t('nav.account');
    this.accountEditDatingBtnEl.textContent = t('dating.profileBtn');
    this.syncDatingTabLabel();
    this.datingPanel.refreshLocale();
    this.connectSelfTitleEl.textContent = t('connect.myAccount');
    this.connectChangePinBtnEl.textContent = t('connect.changePinBtn');
    this.connectCurPinInput.placeholder = t('connect.currentPinPlaceholder');
    this.connectNextPinInput.placeholder = t('connect.newPinPlaceholder');
    this.connectNextPinConfInput.placeholder = t('connect.confirmNewPinPlaceholder');
    this.connectSavePinBtnEl.textContent = t('connect.savePinBtn');
    this.connectDeleteBtnEl.textContent = t('safety.deleteAccountBtn');
    this.connectDeleteBtnEl.title = t('safety.deleteAccountTitle');
    this.connectDeleteWarningEl.textContent = t('safety.deleteAccountWarning');
    this.connectDeletePinInput.placeholder = t('safety.deleteAccountPinPlaceholder');
    this.connectDeleteCheckLabelEl.textContent = t('safety.deleteAccountCheckLabel');
    this.connectDeleteSubmitBtnEl.textContent = this.isDeleteConfirmPending
      ? t('safety.deleteAccountConfirmBtn')
      : t('safety.deleteAccountSubmitBtn');
    this.updateReferralLandingLocale();
    this.syncOnboardingReferralBanner();
    this.connectRefTitleEl.textContent = t('referral.cardTitle');
    this.connectRefDescEl.textContent = t('referral.cardDesc');
    this.connectRefWhatsappLinkEl.textContent = t('referral.whatsappBtn');
    this.connectRefCopyBtnEl.textContent = t('referral.copyLinkBtn');
    this.shareSheetTitleEl.textContent = t('referral.sheetTitle');
    this.shareSheetDescEl.textContent = t('referral.sheetDesc');
    this.shareSheetWhatsappEl.textContent = t('referral.whatsappBtn');
    this.shareSheetCopyBtnEl.textContent = t('referral.copyLinkBtn');
    this.shareSheetDismissBtnEl.textContent = t('referral.notNowBtn');
    this.blockedDoneTitleEl.textContent = t('safety.blockedModalTitle');
    this.blockedDoneOkBtnEl.textContent = t('safety.blockedModalOkBtn');
    if (this.lastBlockedName) {
      this.blockedDoneDescEl.textContent = t('safety.blockedModalDesc', { name: this.lastBlockedName });
    }
    if (this.lastReferralSummary) {
      this.updateReferralMetrics(this.lastReferralSummary);
    } else {
      this.connectRefStatsEl.textContent = t('referral.statsLine', {
        shared: 0,
        converted: 0,
        rate: 0,
      });
    }
    this.connectInviteTitleEl.textContent = t('connect.inviteTitle');
    this.connectTargetField.input.placeholder = t('connect.inviteTargetPlaceholder');
    this.connectTargetField.refreshLocale();
    this.connectInviteBtn.textContent = t('connect.inviteBtn');
    this.connectIncomingTitleEl.textContent = t('connect.incomingTitle');
    this.connectOutgoingTitleEl.textContent = t('connect.outgoingTitle');
    this.connectConvTitleEl.textContent = t('connect.conversationsTitle');

    if (this.currentSession) {
      if (this.isConnectViewActive()) {
        this.applyConnectSessionMeta(this.currentSession);
      } else if (this.currentRoom) {
        this.updateRoomInfo(this.currentRoom, this.currentSession);
      } else if (this.currentSession.talk2tmId) {
        this.renderRoomInfoStrip(
          t('chat.bilateralLabel'),
          t('chat.selfTag', { name: this.currentSession.displayName }),
          'waiting'
        );
      }
    }
    if (this.lastHubData) {
      this.updateConnectHubData(this.lastHubData);
    }

    // Chat + Mensagens renderizadas
    this.loadOlderBtn.textContent = t('chat.loadOlder');
    this.selectModeBtn.textContent = this.isSelectionMode
      ? t('chat.exitSelection')
      : t('chat.selectAll');
    this.selectModeBtn.title = t('chat.selectAllTitle');
    this.chatBlockBtnEl.textContent = this.isChatBlockConfirmPending
      ? t('safety.blockUserConfirmBtn')
      : t('safety.blockUserBtn');
    this.chatBlockBtnEl.title = t('safety.blockUserTitle');
    this.updateInactivityBadge();
    this.msgInputEl.placeholder = this.isChatBlocked
      ? t('safety.blockedChatPlaceholder')
      : t('chat.msgPlaceholder');
    this.sendBtnEl.textContent = t('chat.sendBtn');
    this.selectAllBtnEl.title = t('chat.toggleSelectAllTitle');
    this.cancelSelectionBtnEl.textContent = t('common.cancel');
    this.cancelSelectionBtnEl.title = t('chat.cancelSelectionTitle');
    this.deleteBtnEl.title = t('chat.deleteTitle');
    if (this.isSelectionMode) {
      this.updateSelectionUI();
    } else {
      this.selectAllBtnEl.textContent = t('chat.selectAll');
      this.deleteBtnEl.textContent = t('chat.delete');
    }

    for (const [messageId, item] of this.renderedMessages.entries()) {
      const row = document.getElementById(`ttm-msg-${messageId}`);
      if (!row) continue;
      const timeSpan = row.querySelector('.msg-time') as HTMLElement | null;
      if (timeSpan) {
        timeSpan.textContent = `[${formatTime(item.msg.createdAt)}] `;
        const fullDt = formatFullDateTime(item.msg.createdAt);
        if (fullDt) timeSpan.title = fullDt;
      }
      const statusSpan = row.querySelector('.msg-status') as HTMLElement | null;
      if (statusSpan && item.isSelf) {
        const st = this.computeMessageStatus(item.msg, item.isSelf);
        statusSpan.textContent = st.text;
        statusSpan.setAttribute('data-status', st.dataStatus);
        if (st.title) statusSpan.setAttribute('title', st.title);
      }
      const reportBtn = row.querySelector('.ttm-msg-report') as HTMLButtonElement | null;
      if (reportBtn) {
        reportBtn.title = t('safety.reportMsgTitle');
        reportBtn.setAttribute('aria-label', t('safety.reportMsgAria'));
      }
      const delBtn = row.querySelector('.ttm-msg-del') as HTMLButtonElement | null;
      if (delBtn) {
        delBtn.title = t('chat.deleteSingleTitle');
        delBtn.setAttribute('aria-label', t('chat.deleteSingleAria'));
      }
    }
    this.syncDateSeparators();

    // Modal de definições
    this.settingsModalTitleEl.textContent = t('settings.title');
    this.settingsSessionLabelEl.textContent = t('settings.sessionLabel');
    this.settingsInactivityLabelEl.textContent = t('settings.inactivityLabel');
    this.settingsAppearanceLabelEl.textContent = t('settings.appearanceLabel');
    this.settingsLanguageLabelEl.textContent = t('settings.languageLabel');
    this.settingsPushLabelEl.textContent = t('settings.pushLabel');
    this.settingsPushEnableTextEl.textContent = t('settings.pushMasterToggle');
    this.settingsPushMatchTextEl.textContent = t('settings.pushMatchToggle');
    this.settingsPushMessageTextEl.textContent = t('settings.pushMessageToggle');
    this.settingsPushHintEl.textContent = t('settings.pushHint');
    this.syncNotificationControlsUI();
    this.settingsSaveBtnEl.textContent = t('settings.saveBtn');
    this.settingsCancelBtnEl.textContent = t('common.close');
    this.populateSettingsSelects();

    // Modal de denúncia
    this.reportModalTitleEl.textContent = t('safety.reportModalTitle');
    this.reportReasonLabelEl.textContent = t('safety.reportReasonLabel');
    this.reportDetailsInputEl.placeholder = t('safety.reportDetailsPlaceholder');
    this.reportSubmitBtnEl.textContent = t('safety.reportSubmitBtn');
    this.reportCancelBtnEl.textContent = t('common.cancel');
    this.populateReportReasonSelect();
    if (this.activeReportContext) {
      this.reportTargetLabelEl.textContent = t('safety.reportTargetPrefix', {
        target: this.activeReportContext.targetDisplayName || t('connect.defaultContact'),
      });
    }
  }

  public deleteSingleMessage(messageId: string): void {
    if (this.events.onDeleteMessagesLocally) {
      this.events.onDeleteMessagesLocally([messageId]);
    }
    this.removeMessages([messageId]);
  }

  public removeMessages(messageIds: string[]): void {
    messageIds.forEach((id) => {
      this.renderedMessageIds.delete(id);
      this.renderedMessages.delete(id);
      const row = document.getElementById(`ttm-msg-${id}`);
      if (row) {
        row.style.opacity = '0';
        row.style.transform = 'scale(0.96)';
        row.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        setTimeout(() => {
          if (row.parentNode) {
            row.parentNode.removeChild(row);
          }
          this.syncDateSeparators();
        }, 200);
      }
    });
  }

  public getIsSelectionMode(): boolean {
    return this.isSelectionMode;
  }

  public getSelectedMessageIds(): string[] {
    return Array.from(this.selectedMessageIds);
  }

  public scrollToBottom(): void {
    this.msgListEl.scrollTop = this.msgListEl.scrollHeight;
  }

  public showPassError(msg: string): void {
    this.passErrorEl.textContent = msg;
    this.showTemporaryNotice(msg);
  }

  public showTemporaryNotice(text: string): void {
    const existing = document.getElementById('ttm-temp-notice');
    if (existing) existing.remove();

    const notice = document.createElement('div');
    notice.id = 'ttm-temp-notice';
    notice.className = 'ttm-notice';
    notice.textContent = text;
    this.container.appendChild(notice);

    setTimeout(() => {
      notice.remove();
    }, 3000);
  }
}
