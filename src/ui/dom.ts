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
import { DatingPanel } from './dating-panel';
import { getPartnerLastRead } from '../firebase/firestore';
import { PWAPromptBar } from './pwa-prompt';
import { getCountryDisplayName, PhoneCountry, PhoneNormalizationResult } from '../utils/phone';
import { createPhoneInputField, PhoneInputField } from './phone-input';
import { LOCALE_REGISTRY, SUPPORTED_LOCALES, t } from '../i18n';
import {
  generateRecoveryCode,
  getAllLocalIdentities,
  normalizeRecoveryCode,
  validateLocalPin,
  validateOptionalRecoveryEmail,
  validateRecoverySecret,
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
    displayName: string;
    phone: string;
    pin: string;
    recoveryCode?: string;
    recoveryEmail?: string;
  }) => Promise<{
    talk2tmId: string;
    recoveryCode: string;
    e164Phone: string;
  }>;
  onFinishOnboarding?: () => Promise<void>;
  onRecoverIdentity?: (params: {
    phone?: string;
    recoveryEmail?: string;
    recoveryCode: string;
    newPin: string;
  }) => Promise<void>;
  onSendPasswordResetEmail?: (email: string) => Promise<{ email: string }>;
  onCompleteInAppPasswordReset?: (params: {
    oobCode: string;
    recoveryCode: string;
    newPin: string;
  }) => Promise<void>;
  onRegenerateRecoveryCode?: (currentPin: string, customRecoveryCode?: string) => Promise<string>;
  onAssociateRecoveryEmail?: (
    currentPin: string,
    email: string
  ) => Promise<{ status: 'already_active' | 'verification_sent'; email: string }>;
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

  // Tela de Cadastro Ultraminimalista (4 campos + Chave Pessoal de Recuperação + E-mail Opcional)
  private onboardingViewEl!: HTMLElement;
  private onboardingRefBannerEl!: HTMLElement;
  private onboardingTitleEl!: HTMLElement;
  private onboardingSubtitleEl!: HTMLElement;
  private onboardingFormEl!: HTMLFormElement;
  private onboardingNameInput!: HTMLInputElement;
  private onboardingPhoneField!: PhoneInputField;
  private onboardingPhonePreviewEl!: HTMLElement;
  private onboardingPinInput!: HTMLInputElement;
  private onboardingPinToggleBtn1El!: HTMLButtonElement;
  private onboardingPinConfirmInput!: HTMLInputElement;
  private onboardingPinToggleBtn2El!: HTMLButtonElement;
  private onboardingErrorEl!: HTMLElement;
  private onboardingSubmitBtn!: HTMLButtonElement;
  private onboardingBackBtnEl!: HTMLButtonElement;
  private recoveryStepBoxEl!: HTMLElement;
  private onboardingStep2TitleEl!: HTMLElement;
  private onboardingStep2DescEl!: HTMLElement;
  private onboardingStep2FormEl!: HTMLFormElement;
  private onboardingPmUsernameInput!: HTMLInputElement;
  private onboardingSecretInput!: HTMLInputElement;
  private onboardingSecretToggleBtn1El!: HTMLButtonElement;
  private onboardingSecretConfirmInput!: HTMLInputElement;
  private onboardingSecretToggleBtn2El!: HTMLButtonElement;
  private onboardingSecretHintEl!: HTMLElement;
  private onboardingEmailInput!: HTMLInputElement;
  private onboardingEmailHintEl!: HTMLElement;
  private onboardingStep2ErrorEl!: HTMLElement;
  private onboardingStep2SubmitBtn!: HTMLButtonElement;
  private onboardingGenCodeBtnEl!: HTMLButtonElement;
  private onboardingBackStep1BtnEl!: HTMLButtonElement;
  private recoveryStepCodeEl!: HTMLElement;
  private onboardingCopyCodeBtn!: HTMLButtonElement;
  private pendingOnboardingDraft: { displayName: string; phone: string; e164Phone: string; pin: string } | null = null;

  // Tela de Entrada em Outro Aparelho / Recuperação (Zero Custos)
  private recoveryViewEl!: HTMLElement;
  private recoveryTitleEl!: HTMLElement;
  private recoverySubtitleEl!: HTMLElement;
  private recoveryMainFormEl!: HTMLFormElement;
  private recoveryPhoneField!: PhoneInputField;
  private recoveryPhonePreviewEl!: HTMLElement;
  private recoveryEmailInput!: HTMLInputElement;
  private recoveryEmailHintEl!: HTMLElement;
  private recoveryCodeInput!: HTMLInputElement;
  private recoveryKeyToggleBtnEl!: HTMLButtonElement;
  private recoveryKeyHintEl!: HTMLElement;
  private recoveryPinInput!: HTMLInputElement;
  private recoveryPinToggleBtn1El!: HTMLButtonElement;
  private recoveryPinConfirmInput!: HTMLInputElement;
  private recoveryPinToggleBtn2El!: HTMLButtonElement;
  private recoveryErrorEl!: HTMLElement;
  private recoverySubmitBtn!: HTMLButtonElement;
  private recoveryForgotEmailBtn!: HTMLButtonElement;
  private recoveryBackBtnEl!: HTMLButtonElement;
  private recoveryResetBoxEl!: HTMLElement;
  private recoveryResetTitleEl!: HTMLElement;
  private recoveryResetDescEl!: HTMLElement;
  private recoveryResetEmailInput!: HTMLInputElement;
  private recoveryResetFeedbackEl!: HTMLElement;
  private recoveryResetSubmitBtn!: HTMLButtonElement;
  private recoveryResetBackBtnEl!: HTMLButtonElement;
  private recoveryOobBoxEl!: HTMLElement;
  private recoveryOobTitleEl!: HTMLElement;
  private recoveryOobEmailLabelEl!: HTMLElement;
  private recoveryOobSecretInput!: HTMLInputElement;
  private recoveryOobSecretToggleBtn1El!: HTMLButtonElement;
  private recoveryOobSecretConfirmInput!: HTMLInputElement;
  private recoveryOobSecretToggleBtn2El!: HTMLButtonElement;
  private recoveryOobPinInput!: HTMLInputElement;
  private recoveryOobPinToggleBtn1El!: HTMLButtonElement;
  private recoveryOobPinConfirmInput!: HTMLInputElement;
  private recoveryOobPinToggleBtn2El!: HTMLButtonElement;
  private recoveryOobErrorEl!: HTMLElement;
  private recoveryOobSubmitBtn!: HTMLButtonElement;
  private recoveryOobCancelBtnEl!: HTMLButtonElement;
  private activeOobCode: string | null = null;
  private activeOobEmail: string | null = null;

  // Hub de Conexões Bilaterais (Descoberta por telefone exato, sem expor TM-XXXX-XXXX)
  private connectionsBtnEl!: HTMLButtonElement;
  private connectViewEl!: HTMLElement;
  private connectTabConnectionsBtnEl!: HTMLButtonElement;
  private connectTabDatingBtnEl!: HTMLButtonElement;
  private connectHubCardsWrapEl!: HTMLElement;
  private datingPanel!: DatingPanel;
  private activeConnectTab: 'connections' | 'dating' = 'connections';
  private lastDatingUid: string | null = null;
  private unseenDatingMatchCount = 0;
  private connectSelfTitleEl!: HTMLElement;
  private connectSelfNameEl!: HTMLElement;
  private connectSelfPhoneEl!: HTMLElement;
  private connectRotateCodeBtnEl!: HTMLButtonElement;
  private connectRecoveryEmailBtnEl!: HTMLButtonElement;
  private connectChangePinBtnEl!: HTMLButtonElement;
  private connectRecoveryPanelEl!: HTMLElement;
  private connectRotHintEl!: HTMLElement;
  private connectRotCustomInput!: HTMLInputElement;
  private connectRotPinInput!: HTMLInputElement;
  private connectRotSubmitBtnEl!: HTMLButtonElement;
  private connectRotGenBtnEl!: HTMLButtonElement;
  private connectRotCopyBtnEl!: HTMLButtonElement;
  private connectEmailPanelEl!: HTMLElement;
  private connectEmailStatusEl!: HTMLElement;
  private connectEmailInput!: HTMLInputElement;
  private connectEmailPinInput!: HTMLInputElement;
  private connectSaveEmailBtnEl!: HTMLButtonElement;
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

    this.mainEl.appendChild(this.passViewEl);
    this.mainEl.appendChild(this.landingViewEl);
    this.mainEl.appendChild(this.onboardingViewEl);
    this.mainEl.appendChild(this.recoveryViewEl);
    this.mainEl.appendChild(this.connectViewEl);
    this.mainEl.appendChild(this.chatViewEl);
    this.appWrapper.appendChild(this.mainEl);
    this.appWrapper.appendChild(this.settingsModalEl);
    this.appWrapper.appendChild(this.reportModalEl);

    this.container.appendChild(this.appWrapper);

    // Inicia na tela configurada no dispositivo (Talk2TM padrão ou Calculadora)
    this.showLockView();
  }

  private createPinInputWithToggle(
    id: string,
    placeholder: string,
    maxLength: number = 8,
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

  private createSecretInputWithToggle(
    id: string,
    placeholder: string,
    maxLength: number = 40,
    startVisible: boolean = true,
    autocomplete: AutoFill = 'off',
    name?: string
  ): { wrapper: HTMLElement; input: HTMLInputElement; toggleBtn: HTMLButtonElement } {
    const wrapper = document.createElement('div');
    wrapper.className = 'ttm-input-group';

    const input = document.createElement('input');
    input.type = startVisible ? 'text' : 'password';
    input.id = id;
    if (name) {
      input.name = name;
    }
    input.className = 'ttm-input ttm-input-left ttm-input-with-toggle';
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.autocomplete = autocomplete;
    input.autocapitalize = 'none';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'ttm-toggle-vis-btn';
    toggleBtn.textContent = startVisible ? t('common.hide') : t('common.show');
    toggleBtn.setAttribute('aria-label', t('pass.secretVisToggleAria'));
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
      16,
      'off'
    );
    this.singlePassInput = pinField.input;
    this.passPinToggleBtnEl = pinField.toggleBtn;
    this.singlePassInput.maxLength = 32;
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
    this.onboardingNameInput.maxLength = 30;
    this.onboardingNameInput.autocomplete = 'name';

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

    const pin1 = this.createPinInputWithToggle(
      'ttm-onboarding-pin',
      t('onboarding.pinPlaceholder'),
      8,
      'off'
    );
    this.onboardingPinInput = pin1.input;
    this.onboardingPinToggleBtn1El = pin1.toggleBtn;

    const pin2 = this.createPinInputWithToggle(
      'ttm-onboarding-pin-confirm',
      t('onboarding.pinConfirmPlaceholder'),
      8,
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
    this.onboardingSubmitBtn.textContent = t('onboarding.continueBtn');

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backBtn.textContent = t('common.back');
    backBtn.addEventListener('click', () => {
      this.returnToEntryScreen();
    });
    this.onboardingBackBtnEl = backBtn;

    this.onboardingFormEl.appendChild(this.onboardingNameInput);
    this.onboardingFormEl.appendChild(this.onboardingPhoneField.wrapper);
    this.onboardingFormEl.appendChild(this.onboardingPhonePreviewEl);
    this.onboardingFormEl.appendChild(pin1.wrapper);
    this.onboardingFormEl.appendChild(pin2.wrapper);
    this.onboardingFormEl.appendChild(this.onboardingErrorEl);
    this.onboardingFormEl.appendChild(this.onboardingSubmitBtn);
    this.onboardingFormEl.appendChild(backBtn);

    // Passo 2: Definir Chave Pessoal (compatível com Gestor de Senhas nativo) + E-mail de recuperação opcional
    this.recoveryStepBoxEl = document.createElement('div');
    this.recoveryStepBoxEl.className = 'ttm-recovery-confirm-box';
    this.recoveryStepBoxEl.style.display = 'none';

    const recTitle = document.createElement('div');
    recTitle.className = 'ttm-recovery-title';
    recTitle.textContent = t('onboarding.step2Title');
    this.onboardingStep2TitleEl = recTitle;

    const recDesc = document.createElement('p');
    recDesc.className = 'ttm-onboarding-tip';
    recDesc.textContent = t('onboarding.step2Desc');
    this.onboardingStep2DescEl = recDesc;

    this.onboardingStep2FormEl = document.createElement('form');
    this.onboardingStep2FormEl.className = 'ttm-form';

    // Campo username somente leitura para o Gestor de Senhas nativo (Google / Apple Keychain) guardar Telefone + Chave Pessoal
    this.onboardingPmUsernameInput = document.createElement('input');
    this.onboardingPmUsernameInput.type = 'text';
    this.onboardingPmUsernameInput.id = 'ttm-onboarding-username';
    this.onboardingPmUsernameInput.name = 'username';
    this.onboardingPmUsernameInput.autocomplete = 'username';
    this.onboardingPmUsernameInput.readOnly = true;
    this.onboardingPmUsernameInput.tabIndex = -1;
    this.onboardingPmUsernameInput.className = 'ttm-input ttm-input-left ttm-pm-username';
    this.onboardingPmUsernameInput.setAttribute('aria-label', t('onboarding.pmPhoneAria'));

    const sec1 = this.createSecretInputWithToggle(
      'ttm-onboarding-secret',
      t('onboarding.secretPlaceholder'),
      40,
      false,
      'new-password',
      'password'
    );
    this.onboardingSecretInput = sec1.input;
    this.onboardingSecretToggleBtn1El = sec1.toggleBtn;

    this.onboardingSecretHintEl = document.createElement('div');
    this.onboardingSecretHintEl.className = 'ttm-field-hint';
    this.onboardingSecretHintEl.textContent = '';
    this.onboardingSecretHintEl.style.display = 'none';

    const sec2 = this.createSecretInputWithToggle(
      'ttm-onboarding-secret-confirm',
      t('onboarding.secretConfirmPlaceholder'),
      40,
      false,
      'new-password'
    );
    this.onboardingSecretConfirmInput = sec2.input;
    this.onboardingSecretToggleBtn2El = sec2.toggleBtn;

    this.onboardingEmailInput = document.createElement('input');
    this.onboardingEmailInput.type = 'email';
    this.onboardingEmailInput.id = 'ttm-onboarding-email';
    this.onboardingEmailInput.name = 'recovery-email';
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
      const check = validateOptionalRecoveryEmail(raw);
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

    this.recoveryStepCodeEl = document.createElement('div');
    this.recoveryStepCodeEl.className = 'ttm-code-badge ttm-code-badge-compact';
    this.recoveryStepCodeEl.style.display = 'none';

    this.onboardingCopyCodeBtn = document.createElement('button');
    this.onboardingCopyCodeBtn.type = 'button';
    this.onboardingCopyCodeBtn.className = 'ttm-btn ttm-btn-secondary';
    this.onboardingCopyCodeBtn.textContent = t('onboarding.copyCodeBtn');
    this.onboardingCopyCodeBtn.style.display = 'none';
    this.onboardingCopyCodeBtn.addEventListener('click', async () => {
      const code = this.recoveryStepCodeEl.textContent || '';
      if (!code) return;
      await navigator.clipboard?.writeText(code).catch(() => {});
      this.onboardingSecretHintEl.textContent = t('onboarding.codeCopied');
      this.onboardingSecretHintEl.style.display = 'block';
      this.onboardingSecretHintEl.classList.add('is-valid');
      this.onboardingSecretHintEl.classList.remove('is-invalid');
    });

    this.onboardingSecretInput.addEventListener('input', () => {
      const raw = this.onboardingSecretInput.value;
      if (!raw.trim()) {
        this.onboardingSecretHintEl.textContent = '';
        this.onboardingSecretHintEl.style.display = 'none';
        this.onboardingSecretHintEl.classList.remove('is-valid', 'is-invalid');
        return;
      }
      const check = validateRecoverySecret(raw, this.pendingOnboardingDraft?.pin);
      this.onboardingSecretHintEl.style.display = 'block';
      if (check.valid) {
        this.onboardingSecretHintEl.textContent = t('onboarding.secretValid', {
          count: check.normalized.length,
        });
        this.onboardingSecretHintEl.classList.add('is-valid');
        this.onboardingSecretHintEl.classList.remove('is-invalid');
      } else {
        this.onboardingSecretHintEl.textContent = check.error || t('onboarding.secretInvalid');
        this.onboardingSecretHintEl.classList.add('is-invalid');
        this.onboardingSecretHintEl.classList.remove('is-valid');
      }
    });

    this.onboardingStep2ErrorEl = document.createElement('div');
    this.onboardingStep2ErrorEl.className = 'ttm-error';
    this.onboardingStep2ErrorEl.textContent = '';

    this.onboardingStep2SubmitBtn = document.createElement('button');
    this.onboardingStep2SubmitBtn.type = 'submit';
    this.onboardingStep2SubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.onboardingStep2SubmitBtn.textContent = t('onboarding.createEnterBtn');

    const genRandomBtn = document.createElement('button');
    genRandomBtn.type = 'button';
    genRandomBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-step2-sub';
    genRandomBtn.textContent = t('onboarding.genCodeBtn');
    genRandomBtn.addEventListener('click', () => {
      const generated = generateRecoveryCode();
      this.onboardingSecretInput.value = generated;
      this.onboardingSecretConfirmInput.value = generated;
      this.recoveryStepCodeEl.textContent = generated;
      this.recoveryStepCodeEl.style.display = 'block';
      this.onboardingCopyCodeBtn.style.display = 'inline-block';
      this.onboardingSecretHintEl.textContent = t('onboarding.genCodeApplied');
      this.onboardingSecretHintEl.style.display = 'block';
      this.onboardingSecretHintEl.classList.add('is-valid');
      this.onboardingSecretHintEl.classList.remove('is-invalid');
      this.onboardingStep2ErrorEl.textContent = '';
    });
    this.onboardingGenCodeBtnEl = genRandomBtn;

    const backStep1Btn = document.createElement('button');
    backStep1Btn.type = 'button';
    backStep1Btn.className = 'ttm-btn ttm-btn-secondary ttm-btn-step2-sub';
    backStep1Btn.textContent = t('onboarding.backStep1Btn');
    backStep1Btn.addEventListener('click', () => {
      this.recoveryStepBoxEl.style.display = 'none';
      this.onboardingFormEl.style.display = 'flex';
      this.onboardingSubtitleEl.style.display = '';
      this.onboardingStep2ErrorEl.textContent = '';
    });
    this.onboardingBackStep1BtnEl = backStep1Btn;

    const step2ActionsRow = document.createElement('div');
    step2ActionsRow.className = 'ttm-step2-actions';
    step2ActionsRow.appendChild(backStep1Btn);
    step2ActionsRow.appendChild(genRandomBtn);

    this.onboardingStep2FormEl.appendChild(this.onboardingPmUsernameInput);
    this.onboardingStep2FormEl.appendChild(sec1.wrapper);
    this.onboardingStep2FormEl.appendChild(this.onboardingSecretHintEl);
    this.onboardingStep2FormEl.appendChild(sec2.wrapper);
    this.onboardingStep2FormEl.appendChild(this.onboardingEmailInput);
    this.onboardingStep2FormEl.appendChild(this.onboardingEmailHintEl);
    this.onboardingStep2FormEl.appendChild(this.recoveryStepCodeEl);
    this.onboardingStep2FormEl.appendChild(this.onboardingCopyCodeBtn);
    this.onboardingStep2FormEl.appendChild(this.onboardingStep2ErrorEl);
    this.onboardingStep2FormEl.appendChild(this.onboardingStep2SubmitBtn);
    this.onboardingStep2FormEl.appendChild(step2ActionsRow);

    this.recoveryStepBoxEl.appendChild(recTitle);
    this.recoveryStepBoxEl.appendChild(recDesc);
    this.recoveryStepBoxEl.appendChild(this.onboardingStep2FormEl);

    this.onboardingFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.onboardingErrorEl.textContent = '';

      const displayName = this.onboardingNameInput.value.trim();
      const pin = this.onboardingPinInput.value.trim();
      const pinConfirm = this.onboardingPinConfirmInput.value.trim();

      if (!displayName) {
        this.onboardingErrorEl.textContent = t('onboarding.errNameRequired');
        return;
      }
      const phoneCheck = this.onboardingPhoneField.validate();
      if (!phoneCheck.valid || !phoneCheck.e164) {
        this.onboardingErrorEl.textContent = phoneCheck.error || t('onboarding.errPhoneInvalid');
        return;
      }
      if (!/^\d{4,8}$/.test(pin)) {
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

      this.pendingOnboardingDraft = {
        displayName,
        phone: phoneCheck.e164,
        e164Phone: phoneCheck.e164,
        pin,
      };
      this.onboardingPmUsernameInput.value = phoneCheck.e164;
      this.onboardingFormEl.style.display = 'none';
      this.onboardingSubtitleEl.style.display = 'none';
      this.recoveryStepBoxEl.style.display = 'flex';
      this.onboardingStep2ErrorEl.textContent = '';
      setTimeout(() => {
        this.onboardingSecretInput.focus();
      }, 80);
    });

    this.onboardingStep2FormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.onboardingStep2ErrorEl.textContent = '';

      const draft = this.pendingOnboardingDraft;
      if (!draft) {
        this.recoveryStepBoxEl.style.display = 'none';
        this.onboardingFormEl.style.display = 'flex';
        this.onboardingSubtitleEl.style.display = '';
        return;
      }

      const secret = this.onboardingSecretInput.value.trim();
      const secretConfirm = this.onboardingSecretConfirmInput.value.trim();
      const recoveryEmailRaw = this.onboardingEmailInput.value.trim();

      const check = validateRecoverySecret(secret, draft.pin);
      if (!check.valid) {
        this.onboardingStep2ErrorEl.textContent = check.error || t('onboarding.errSecretInvalid');
        return;
      }
      if (normalizeRecoveryCode(secret) !== normalizeRecoveryCode(secretConfirm)) {
        this.onboardingStep2ErrorEl.textContent = t('onboarding.errSecretMismatch');
        return;
      }
      const emailCheck = validateOptionalRecoveryEmail(recoveryEmailRaw);
      if (!emailCheck.valid) {
        this.onboardingStep2ErrorEl.textContent = emailCheck.error || t('onboarding.errEmailInvalid');
        return;
      }

      if (this.events.onCreateIdentity) {
        this.onboardingStep2SubmitBtn.disabled = true;
        this.onboardingStep2SubmitBtn.textContent = t('onboarding.creatingBtn');
        try {
          await this.events.onCreateIdentity({
            displayName: draft.displayName,
            phone: draft.phone,
            pin: draft.pin,
            recoveryCode: secret,
            recoveryEmail: emailCheck.email,
          });
          this.pendingOnboardingDraft = null;
          await this.events.onFinishOnboarding?.();
        } catch (err: any) {
          this.onboardingStep2ErrorEl.textContent = this.extractReadableError(err);
        } finally {
          this.onboardingStep2SubmitBtn.disabled = false;
          this.onboardingStep2SubmitBtn.textContent = t('onboarding.createEnterBtn');
        }
      }
    });

    cardEl.appendChild(titleEl);
    cardEl.appendChild(subtitleEl);
    cardEl.appendChild(this.onboardingRefBannerEl);
    cardEl.appendChild(this.onboardingFormEl);
    cardEl.appendChild(this.recoveryStepBoxEl);
    this.onboardingViewEl.appendChild(cardEl);
  }

  /**
   * Entrada em Outro Aparelho / Recuperação gratuita:
   * 1. Telefone (+ E-mail se associou) + Chave Pessoal + PIN (com Gestor de Senhas nativo)
   * 2. Link gratuito de redefinição por e-mail para quem associou e-mail opcional
   * 3. Conclusão in-app caso seja aberto diretamente via ?mode=resetPassword&oobCode=...
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

    this.recoveryPhonePreviewEl = document.createElement('div');
    this.recoveryPhonePreviewEl.className = 'ttm-field-hint';

    this.recoveryPhoneField = createPhoneInputField({
      id: 'ttm-recovery-phone',
      name: 'username',
      placeholder: t('recovery.phonePlaceholder'),
      autocomplete: 'username',
      onChange: (raw, res, country) => {
        this.updatePhonePreview(raw, res, country, this.recoveryPhonePreviewEl, 'recovery');
      },
    });
    this.updatePhonePreview(
      '',
      { valid: false },
      this.recoveryPhoneField.getCountry(),
      this.recoveryPhonePreviewEl,
      'recovery'
    );

    this.recoveryEmailInput = document.createElement('input');
    this.recoveryEmailInput.type = 'email';
    this.recoveryEmailInput.id = 'ttm-recovery-email';
    this.recoveryEmailInput.name = 'recovery-email';
    this.recoveryEmailInput.className = 'ttm-input ttm-input-left';
    this.recoveryEmailInput.placeholder = t('recovery.emailPlaceholder');
    this.recoveryEmailInput.maxLength = 120;
    this.recoveryEmailInput.autocomplete = 'email';
    this.recoveryEmailInput.inputMode = 'email';

    const recoveryEmailHint = document.createElement('div');
    recoveryEmailHint.className = 'ttm-field-hint';
    recoveryEmailHint.textContent = t('recovery.emailHint');
    this.recoveryEmailHintEl = recoveryEmailHint;

    const recKeyField = this.createSecretInputWithToggle(
      'ttm-recovery-code',
      t('recovery.keyPlaceholder'),
      40,
      false,
      'current-password',
      'password'
    );
    this.recoveryCodeInput = recKeyField.input;
    this.recoveryKeyToggleBtnEl = recKeyField.toggleBtn;

    const recKeyHintEl = document.createElement('div');
    recKeyHintEl.className = 'ttm-field-hint';
    recKeyHintEl.textContent = t('recovery.keyHint');
    this.recoveryKeyHintEl = recKeyHintEl;

    const newPin1 = this.createPinInputWithToggle(
      'ttm-recovery-pin',
      t('recovery.pinPlaceholder'),
      8,
      'off'
    );
    this.recoveryPinInput = newPin1.input;
    this.recoveryPinToggleBtn1El = newPin1.toggleBtn;

    const newPin2 = this.createPinInputWithToggle(
      'ttm-recovery-pin-confirm',
      t('recovery.pinConfirmPlaceholder'),
      8,
      'off'
    );
    this.recoveryPinConfirmInput = newPin2.input;
    this.recoveryPinToggleBtn2El = newPin2.toggleBtn;

    this.recoveryErrorEl = document.createElement('div');
    this.recoveryErrorEl.className = 'ttm-error';
    this.recoveryErrorEl.textContent = '';

    this.recoverySubmitBtn = document.createElement('button');
    this.recoverySubmitBtn.type = 'submit';
    this.recoverySubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoverySubmitBtn.textContent = t('recovery.submitBtn');

    this.recoveryForgotEmailBtn = document.createElement('button');
    this.recoveryForgotEmailBtn.type = 'button';
    this.recoveryForgotEmailBtn.className = 'ttm-btn ttm-btn-secondary';
    this.recoveryForgotEmailBtn.textContent = t('recovery.forgotKeyBtn');
    this.recoveryForgotEmailBtn.addEventListener('click', () => {
      this.recoveryMainFormEl.style.display = 'none';
      this.recoveryOobBoxEl.style.display = 'none';
      this.recoveryResetBoxEl.style.display = 'flex';
      this.recoveryResetEmailInput.value = this.recoveryEmailInput.value.trim();
      this.recoveryResetFeedbackEl.textContent = '';
      this.recoveryResetFeedbackEl.classList.remove('is-valid', 'is-invalid');
      setTimeout(() => {
        this.recoveryResetEmailInput.focus();
      }, 80);
    });

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backBtn.textContent = t('common.back');
    backBtn.addEventListener('click', () => {
      this.returnToEntryScreen();
    });
    this.recoveryBackBtnEl = backBtn;

    this.recoveryMainFormEl.appendChild(this.recoveryPhoneField.wrapper);
    this.recoveryMainFormEl.appendChild(this.recoveryPhonePreviewEl);
    this.recoveryMainFormEl.appendChild(this.recoveryEmailInput);
    this.recoveryMainFormEl.appendChild(recoveryEmailHint);
    this.recoveryMainFormEl.appendChild(recKeyField.wrapper);
    this.recoveryMainFormEl.appendChild(recKeyHintEl);
    this.recoveryMainFormEl.appendChild(newPin1.wrapper);
    this.recoveryMainFormEl.appendChild(newPin2.wrapper);
    this.recoveryMainFormEl.appendChild(this.recoveryErrorEl);
    this.recoveryMainFormEl.appendChild(this.recoverySubmitBtn);
    this.recoveryMainFormEl.appendChild(this.recoveryForgotEmailBtn);
    this.recoveryMainFormEl.appendChild(backBtn);

    this.recoveryMainFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.recoveryErrorEl.textContent = '';

      const rawPhone = this.recoveryPhoneField.getValue();
      const recoveryEmail = this.recoveryEmailInput.value.trim();
      const recoveryCode = this.recoveryCodeInput.value.trim();
      const newPin = this.recoveryPinInput.value.trim();
      const confirmPin = this.recoveryPinConfirmInput.value.trim();

      if (!rawPhone && !recoveryEmail) {
        this.recoveryErrorEl.textContent = t('recovery.errMissingPhoneOrEmail');
        return;
      }
      let normalizedPhone: string | undefined;
      if (rawPhone) {
        const phoneCheck = this.recoveryPhoneField.validate();
        if (!phoneCheck.valid || !phoneCheck.e164) {
          this.recoveryErrorEl.textContent = phoneCheck.error || t('onboarding.errPhoneInvalid');
          return;
        }
        normalizedPhone = phoneCheck.e164;
      }
      const emailCheck = validateOptionalRecoveryEmail(recoveryEmail);
      if (!emailCheck.valid) {
        this.recoveryErrorEl.textContent = emailCheck.error || t('onboarding.errEmailInvalid');
        return;
      }
      if (normalizeRecoveryCode(recoveryCode).length < 6 && recoveryCode.length < 6) {
        this.recoveryErrorEl.textContent = t('recovery.errSecretMissing');
        return;
      }
      if (!/^\d{4,8}$/.test(newPin)) {
        this.recoveryErrorEl.textContent = t('onboarding.errPinFormat');
        return;
      }
      if (newPin !== confirmPin) {
        this.recoveryErrorEl.textContent = t('onboarding.errPinMismatch');
        return;
      }

      if (this.events.onRecoverIdentity) {
        this.recoverySubmitBtn.disabled = true;
        this.recoverySubmitBtn.textContent = t('recovery.submittingBtn');
        try {
          await this.events.onRecoverIdentity({
            phone: normalizedPhone,
            recoveryEmail: emailCheck.email,
            recoveryCode,
            newPin,
          });
        } catch (err: any) {
          this.recoveryErrorEl.textContent = this.extractReadableError(err);
        } finally {
          this.recoverySubmitBtn.disabled = false;
          this.recoverySubmitBtn.textContent = t('recovery.submitBtn');
        }
      }
    });

    // Painel 2: Pedir link gratuito de redefinição por e-mail (Firebase Auth nativo)
    this.recoveryResetBoxEl = document.createElement('div');
    this.recoveryResetBoxEl.className = 'ttm-recovery-confirm-box';
    this.recoveryResetBoxEl.style.display = 'none';

    const resetBoxTitle = document.createElement('div');
    resetBoxTitle.className = 'ttm-recovery-title';
    resetBoxTitle.textContent = t('recovery.resetTitle');
    this.recoveryResetTitleEl = resetBoxTitle;

    const resetBoxDesc = document.createElement('p');
    resetBoxDesc.className = 'ttm-onboarding-tip';
    resetBoxDesc.textContent = t('recovery.resetDesc');
    this.recoveryResetDescEl = resetBoxDesc;

    const resetForm = document.createElement('form');
    resetForm.className = 'ttm-form';

    this.recoveryResetEmailInput = document.createElement('input');
    this.recoveryResetEmailInput.type = 'email';
    this.recoveryResetEmailInput.className = 'ttm-input ttm-input-left';
    this.recoveryResetEmailInput.placeholder = t('recovery.resetEmailPlaceholder');
    this.recoveryResetEmailInput.maxLength = 120;
    this.recoveryResetEmailInput.autocomplete = 'email';
    this.recoveryResetEmailInput.inputMode = 'email';

    this.recoveryResetFeedbackEl = document.createElement('div');
    this.recoveryResetFeedbackEl.className = 'ttm-field-hint';
    this.recoveryResetFeedbackEl.textContent = '';

    this.recoveryResetSubmitBtn = document.createElement('button');
    this.recoveryResetSubmitBtn.type = 'submit';
    this.recoveryResetSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoveryResetSubmitBtn.textContent = t('recovery.resetSendBtn');

    const resetBackBtn = document.createElement('button');
    resetBackBtn.type = 'button';
    resetBackBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    resetBackBtn.textContent = t('recovery.resetDoneBackBtn');
    resetBackBtn.addEventListener('click', () => {
      const typedEmail = this.recoveryResetEmailInput.value.trim();
      if (typedEmail) {
        this.recoveryEmailInput.value = typedEmail;
      }
      this.recoveryResetBoxEl.style.display = 'none';
      this.recoveryMainFormEl.style.display = 'flex';
    });
    this.recoveryResetBackBtnEl = resetBackBtn;

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.recoveryResetFeedbackEl.textContent = '';
      this.recoveryResetFeedbackEl.classList.remove('is-valid', 'is-invalid');

      const rawEmail = this.recoveryResetEmailInput.value.trim();
      const emailCheck = validateOptionalRecoveryEmail(rawEmail);
      if (!emailCheck.valid || !emailCheck.email) {
        this.recoveryResetFeedbackEl.textContent = emailCheck.error || t('recovery.resetValidEmail');
        this.recoveryResetFeedbackEl.classList.add('is-invalid');
        return;
      }

      if (!this.events.onSendPasswordResetEmail) return;
      this.recoveryResetSubmitBtn.disabled = true;
      this.recoveryResetSubmitBtn.textContent = t('recovery.resetSendingBtn');
      try {
        const res = await this.events.onSendPasswordResetEmail(emailCheck.email);
        this.recoveryEmailInput.value = res.email;
        this.recoveryResetFeedbackEl.textContent = t('recovery.resetSent', { email: res.email });
        this.recoveryResetFeedbackEl.classList.add('is-valid');
      } catch (err: any) {
        this.recoveryResetFeedbackEl.textContent = this.extractReadableError(err);
        this.recoveryResetFeedbackEl.classList.add('is-invalid');
      } finally {
        this.recoveryResetSubmitBtn.disabled = false;
        this.recoveryResetSubmitBtn.textContent = t('recovery.resetSendBtn');
      }
    });

    resetForm.appendChild(this.recoveryResetEmailInput);
    resetForm.appendChild(this.recoveryResetFeedbackEl);
    resetForm.appendChild(this.recoveryResetSubmitBtn);
    resetForm.appendChild(resetBackBtn);
    this.recoveryResetBoxEl.appendChild(resetBoxTitle);
    this.recoveryResetBoxEl.appendChild(resetBoxDesc);
    this.recoveryResetBoxEl.appendChild(resetForm);

    // Painel 3: Conclusão direta quando aberto via link ?mode=resetPassword&oobCode=...
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

    const oobSec1 = this.createSecretInputWithToggle(
      'ttm-oob-secret',
      t('recovery.oobSecretPlaceholder'),
      40,
      false,
      'new-password',
      'password'
    );
    this.recoveryOobSecretInput = oobSec1.input;
    this.recoveryOobSecretToggleBtn1El = oobSec1.toggleBtn;

    const oobSec2 = this.createSecretInputWithToggle(
      'ttm-oob-secret-confirm',
      t('recovery.oobSecretConfirmPlaceholder'),
      40,
      false,
      'new-password'
    );
    this.recoveryOobSecretConfirmInput = oobSec2.input;
    this.recoveryOobSecretToggleBtn2El = oobSec2.toggleBtn;

    const oobPin1 = this.createPinInputWithToggle(
      'ttm-oob-pin',
      t('recovery.pinPlaceholder'),
      8,
      'off'
    );
    this.recoveryOobPinInput = oobPin1.input;
    this.recoveryOobPinToggleBtn1El = oobPin1.toggleBtn;

    const oobPin2 = this.createPinInputWithToggle(
      'ttm-oob-pin-confirm',
      t('recovery.pinConfirmPlaceholder'),
      8,
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

      const secret = this.recoveryOobSecretInput.value.trim();
      const secretConfirm = this.recoveryOobSecretConfirmInput.value.trim();
      const newPin = this.recoveryOobPinInput.value.trim();
      const confirmPin = this.recoveryOobPinConfirmInput.value.trim();

      if (!/^\d{4,8}$/.test(newPin)) {
        this.recoveryOobErrorEl.textContent = t('onboarding.errPinFormat');
        return;
      }
      if (newPin !== confirmPin) {
        this.recoveryOobErrorEl.textContent = t('onboarding.errPinMismatch');
        return;
      }
      const secCheck = validateRecoverySecret(secret, newPin);
      if (!secCheck.valid) {
        this.recoveryOobErrorEl.textContent = secCheck.error || t('onboarding.errSecretInvalid');
        return;
      }
      if (normalizeRecoveryCode(secret) !== normalizeRecoveryCode(secretConfirm)) {
        this.recoveryOobErrorEl.textContent = t('onboarding.errSecretMismatch');
        return;
      }

      if (!this.events.onCompleteInAppPasswordReset) return;
      this.recoveryOobSubmitBtn.disabled = true;
      this.recoveryOobSubmitBtn.textContent = t('recovery.oobSavingBtn');
      try {
        await this.events.onCompleteInAppPasswordReset({
          oobCode: this.activeOobCode,
          recoveryCode: secret,
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

    oobForm.appendChild(oobSec1.wrapper);
    oobForm.appendChild(oobSec2.wrapper);
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
    cardEl.appendChild(this.recoveryResetBoxEl);
    cardEl.appendChild(this.recoveryOobBoxEl);
    this.recoveryViewEl.appendChild(cardEl);
  }

  /**
   * Hub de Conexões Bilaterais:
   * Descoberta exata pelo número de telefone declarado (sem expor código TM interno).
   */
  private buildConnectView(): void {
    this.connectViewEl = document.createElement('div');
    this.connectViewEl.id = 'ttm-connect-view';
    this.connectViewEl.className = 'ttm-connect-box';
    this.connectViewEl.style.display = 'none';

    const tabBar = document.createElement('div');
    tabBar.className = 'ttm-connect-tabs';

    this.connectTabConnectionsBtnEl = document.createElement('button');
    this.connectTabConnectionsBtnEl.type = 'button';
    this.connectTabConnectionsBtnEl.className = 'ttm-connect-tab is-active';
    this.connectTabConnectionsBtnEl.textContent = t('dating.tabConnections');
    this.connectTabConnectionsBtnEl.addEventListener('click', () => {
      this.setConnectHubTab('connections');
    });

    this.connectTabDatingBtnEl = document.createElement('button');
    this.connectTabDatingBtnEl.type = 'button';
    this.connectTabDatingBtnEl.className = 'ttm-connect-tab';
    this.connectTabDatingBtnEl.textContent = t('dating.tabDating');
    this.connectTabDatingBtnEl.addEventListener('click', () => {
      this.setConnectHubTab('dating');
    });

    tabBar.appendChild(this.connectTabConnectionsBtnEl);
    tabBar.appendChild(this.connectTabDatingBtnEl);
    this.connectViewEl.appendChild(tabBar);

    this.connectHubCardsWrapEl = document.createElement('div');
    this.connectHubCardsWrapEl.className = 'ttm-connect-cards-wrap';

    // Cartão 1: Minha Conta & Segurança Local
    const selfCard = document.createElement('div');
    selfCard.className = 'ttm-connect-card';

    const selfTitle = document.createElement('div');
    selfTitle.className = 'ttm-connect-section-title';
    selfTitle.textContent = t('connect.myAccount');
    this.connectSelfTitleEl = selfTitle;

    const selfRow = document.createElement('div');
    selfRow.className = 'ttm-connect-self-row';

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
    selfActions.className = 'ttm-connect-item-actions';

    const rotateCodeBtn = document.createElement('button');
    rotateCodeBtn.type = 'button';
    rotateCodeBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    rotateCodeBtn.textContent = t('connect.recoveryKeyBtn');
    rotateCodeBtn.title = t('connect.recoveryKeyTitle');
    this.connectRotateCodeBtnEl = rotateCodeBtn;

    const recoveryEmailBtn = document.createElement('button');
    recoveryEmailBtn.type = 'button';
    recoveryEmailBtn.className = 'ttm-btn-mini';
    recoveryEmailBtn.textContent = t('connect.recoveryEmailBtn');
    recoveryEmailBtn.title = t('connect.recoveryEmailTitle');
    this.connectRecoveryEmailBtnEl = recoveryEmailBtn;

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

    selfActions.appendChild(rotateCodeBtn);
    selfActions.appendChild(recoveryEmailBtn);
    selfActions.appendChild(changePinBtn);
    selfActions.appendChild(deleteAccountBtn);
    selfRow.appendChild(selfMeta);
    selfRow.appendChild(selfActions);

    // Painel inline: Definir Chave Pessoal de recuperação (ou gerar código automático)
    this.connectRecoveryPanelEl = document.createElement('div');
    this.connectRecoveryPanelEl.className = 'ttm-inline-security-panel';
    this.connectRecoveryPanelEl.style.display = 'none';

    const rotForm = document.createElement('form');
    rotForm.className = 'ttm-form';
    const rotCustomInput = document.createElement('input');
    rotCustomInput.type = 'text';
    rotCustomInput.maxLength = 40;
    rotCustomInput.placeholder = t('connect.rotPlaceholder');
    rotCustomInput.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectRotCustomInput = rotCustomInput;

    const rotPinInput = document.createElement('input');
    rotPinInput.type = 'password';
    rotPinInput.inputMode = 'numeric';
    rotPinInput.maxLength = 8;
    rotPinInput.autocomplete = 'off';
    rotPinInput.placeholder = t('connect.confirmCurrentPinPlaceholder');
    rotPinInput.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectRotPinInput = rotPinInput;

    const rotBtnRow = document.createElement('div');
    rotBtnRow.className = 'ttm-inline-form';
    const rotSubmitBtn = document.createElement('button');
    rotSubmitBtn.type = 'submit';
    rotSubmitBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    rotSubmitBtn.textContent = t('connect.saveKeyBtn');
    this.connectRotSubmitBtnEl = rotSubmitBtn;

    const rotGenBtn = document.createElement('button');
    rotGenBtn.type = 'button';
    rotGenBtn.className = 'ttm-btn-mini';
    rotGenBtn.textContent = t('connect.genAutoBtn');
    this.connectRotGenBtnEl = rotGenBtn;

    rotBtnRow.appendChild(rotSubmitBtn);
    rotBtnRow.appendChild(rotGenBtn);

    const rotResultEl = document.createElement('div');
    rotResultEl.className = 'ttm-code-badge ttm-code-badge-compact';
    rotResultEl.style.display = 'none';
    const rotHintEl = document.createElement('div');
    rotHintEl.className = 'ttm-field-hint';
    rotHintEl.textContent = t('connect.rotHint');
    this.connectRotHintEl = rotHintEl;

    const rotCopyBtn = document.createElement('button');
    rotCopyBtn.type = 'button';
    rotCopyBtn.className = 'ttm-btn-mini';
    rotCopyBtn.textContent = t('connect.copyKeyBtn');
    rotCopyBtn.style.display = 'none';
    rotCopyBtn.addEventListener('click', async () => {
      const code = rotResultEl.textContent || '';
      if (code) {
        await navigator.clipboard?.writeText(code).catch(() => {});
        this.showConnectFeedback(t('connect.keyCopied'));
      }
    });
    this.connectRotCopyBtnEl = rotCopyBtn;

    rotGenBtn.addEventListener('click', () => {
      rotCustomInput.value = generateRecoveryCode();
    });

    rotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = rotPinInput.value.trim();
      const customKey = rotCustomInput.value.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        this.showConnectFeedback(t('connect.enterCurrentPin'), true);
        return;
      }
      if (customKey) {
        const keyCheck = validateRecoverySecret(customKey, pin);
        if (!keyCheck.valid) {
          this.showConnectFeedback(keyCheck.error || t('onboarding.errSecretInvalid'), true);
          return;
        }
      }
      if (!this.events.onRegenerateRecoveryCode) return;
      rotSubmitBtn.disabled = true;
      try {
        const savedCode = await this.events.onRegenerateRecoveryCode(pin, customKey || undefined);
        rotPinInput.value = '';
        rotCustomInput.value = '';
        rotResultEl.textContent = savedCode;
        rotResultEl.style.display = 'block';
        rotCopyBtn.style.display = 'inline-block';
        rotHintEl.textContent = t('connect.keyUpdatedHint');
        this.showConnectFeedback(t('connect.keyUpdated'));
      } catch (err) {
        this.showConnectFeedback(this.extractReadableError(err), true);
      } finally {
        rotSubmitBtn.disabled = false;
      }
    });

    rotForm.appendChild(rotCustomInput);
    rotForm.appendChild(rotPinInput);
    rotForm.appendChild(rotBtnRow);
    this.connectRecoveryPanelEl.appendChild(rotHintEl);
    this.connectRecoveryPanelEl.appendChild(rotForm);
    this.connectRecoveryPanelEl.appendChild(rotResultEl);
    this.connectRecoveryPanelEl.appendChild(rotCopyBtn);

    // Painel inline: E-mail de recuperação opcional
    this.connectEmailPanelEl = document.createElement('div');
    this.connectEmailPanelEl.className = 'ttm-inline-security-panel';
    this.connectEmailPanelEl.style.display = 'none';

    this.connectEmailStatusEl = document.createElement('div');
    this.connectEmailStatusEl.className = 'ttm-field-hint';
    this.connectEmailStatusEl.textContent = t('onboarding.emailHint');

    const emailForm = document.createElement('form');
    emailForm.className = 'ttm-form';

    this.connectEmailInput = document.createElement('input');
    this.connectEmailInput.type = 'email';
    this.connectEmailInput.maxLength = 120;
    this.connectEmailInput.autocomplete = 'email';
    this.connectEmailInput.inputMode = 'email';
    this.connectEmailInput.placeholder = t('onboarding.emailPlaceholder');
    this.connectEmailInput.className = 'ttm-connect-input ttm-connect-input-phone';

    const emailPinInput = document.createElement('input');
    emailPinInput.type = 'password';
    emailPinInput.inputMode = 'numeric';
    emailPinInput.maxLength = 8;
    emailPinInput.autocomplete = 'off';
    emailPinInput.placeholder = t('connect.confirmCurrentPinPlaceholder');
    emailPinInput.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectEmailPinInput = emailPinInput;

    const saveEmailBtn = document.createElement('button');
    saveEmailBtn.type = 'submit';
    saveEmailBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    saveEmailBtn.textContent = t('connect.emailSaveBtn');
    this.connectSaveEmailBtnEl = saveEmailBtn;

    emailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawEmail = this.connectEmailInput.value.trim();
      const pin = emailPinInput.value.trim();
      const check = validateOptionalRecoveryEmail(rawEmail);
      if (!check.valid || !check.email) {
        this.showConnectFeedback(check.error || t('connect.emailValidRequired'), true);
        return;
      }
      if (!/^\d{4,8}$/.test(pin)) {
        this.showConnectFeedback(t('connect.enterCurrentPin'), true);
        return;
      }
      if (!this.events.onAssociateRecoveryEmail) return;
      saveEmailBtn.disabled = true;
      try {
        const res = await this.events.onAssociateRecoveryEmail(pin, check.email);
        emailPinInput.value = '';
        if (res.status === 'already_active') {
          this.connectEmailStatusEl.textContent = t('connect.emailActive', { email: res.email });
          this.showConnectFeedback(t('connect.emailAlreadyActive'));
        } else {
          this.connectEmailStatusEl.textContent = t('connect.emailConfirmSentHint', { email: res.email });
          this.showConnectFeedback(t('connect.emailConfirmSentNotice', { email: res.email }));
        }
      } catch (err) {
        this.showConnectFeedback(this.extractReadableError(err), true);
      } finally {
        saveEmailBtn.disabled = false;
      }
    });

    emailForm.appendChild(this.connectEmailInput);
    emailForm.appendChild(emailPinInput);
    emailForm.appendChild(saveEmailBtn);
    this.connectEmailPanelEl.appendChild(this.connectEmailStatusEl);
    this.connectEmailPanelEl.appendChild(emailForm);

    // Painel inline: Alterar PIN local
    this.connectPinPanelEl = document.createElement('div');
    this.connectPinPanelEl.className = 'ttm-inline-security-panel';
    this.connectPinPanelEl.style.display = 'none';

    const pinForm = document.createElement('form');
    pinForm.className = 'ttm-form';
    const curPinInp = document.createElement('input');
    curPinInp.type = 'password';
    curPinInp.inputMode = 'numeric';
    curPinInp.maxLength = 8;
    curPinInp.autocomplete = 'off';
    curPinInp.placeholder = t('connect.currentPinPlaceholder');
    curPinInp.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectCurPinInput = curPinInp;

    const nextPinInp = document.createElement('input');
    nextPinInp.type = 'password';
    nextPinInp.inputMode = 'numeric';
    nextPinInp.maxLength = 8;
    nextPinInp.autocomplete = 'off';
    nextPinInp.placeholder = t('connect.newPinPlaceholder');
    nextPinInp.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectNextPinInput = nextPinInp;

    const nextPinConfInp = document.createElement('input');
    nextPinConfInp.type = 'password';
    nextPinConfInp.inputMode = 'numeric';
    nextPinConfInp.maxLength = 8;
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
      if (!/^\d{4,8}$/.test(cur) || !/^\d{4,8}$/.test(next)) {
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
    deletePinInput.maxLength = 8;
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
      if (!/^\d{4,8}$/.test(pin)) {
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

    rotateCodeBtn.addEventListener('click', () => {
      const visible = this.connectRecoveryPanelEl.style.display === 'flex';
      this.connectRecoveryPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectEmailPanelEl.style.display = 'none';
      this.connectPinPanelEl.style.display = 'none';
      this.connectDeletePanelEl.style.display = 'none';
      this.resetDeleteAccountConfirmState();
      rotResultEl.style.display = 'none';
      rotCopyBtn.style.display = 'none';
    });

    recoveryEmailBtn.addEventListener('click', () => {
      const visible = this.connectEmailPanelEl.style.display === 'flex';
      this.connectEmailPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectRecoveryPanelEl.style.display = 'none';
      this.connectPinPanelEl.style.display = 'none';
      this.connectDeletePanelEl.style.display = 'none';
      this.resetDeleteAccountConfirmState();
    });

    changePinBtn.addEventListener('click', () => {
      const visible = this.connectPinPanelEl.style.display === 'flex';
      this.connectPinPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectRecoveryPanelEl.style.display = 'none';
      this.connectEmailPanelEl.style.display = 'none';
      this.connectDeletePanelEl.style.display = 'none';
      this.resetDeleteAccountConfirmState();
    });

    deleteAccountBtn.addEventListener('click', () => {
      const visible = this.connectDeletePanelEl.style.display === 'flex';
      this.connectDeletePanelEl.style.display = visible ? 'none' : 'flex';
      this.connectRecoveryPanelEl.style.display = 'none';
      this.connectEmailPanelEl.style.display = 'none';
      this.connectPinPanelEl.style.display = 'none';
      if (visible) {
        this.resetDeleteAccountConfirmState();
      }
    });

    selfCard.appendChild(selfTitle);
    selfCard.appendChild(selfRow);
    selfCard.appendChild(this.connectRecoveryPanelEl);
    selfCard.appendChild(this.connectEmailPanelEl);
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

    this.connectHubCardsWrapEl.appendChild(selfCard);
    this.connectHubCardsWrapEl.appendChild(refCard);
    this.connectHubCardsWrapEl.appendChild(inviteCard);
    this.connectHubCardsWrapEl.appendChild(incomingCard);
    this.connectHubCardsWrapEl.appendChild(outgoingCard);
    this.connectHubCardsWrapEl.appendChild(convCard);

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
      onBlockUser: this.events.onBlockUser,
    });
    this.datingPanel.rootEl.style.display = 'none';

    this.connectViewEl.appendChild(this.connectHubCardsWrapEl);
    this.connectViewEl.appendChild(this.datingPanel.rootEl);
  }

  private syncDatingTabLabel(): void {
    if (!this.connectTabDatingBtnEl) return;
    this.connectTabDatingBtnEl.textContent =
      this.unseenDatingMatchCount > 0
        ? t('dating.matchTabBadge', { count: this.unseenDatingMatchCount })
        : t('dating.tabDating');
    this.connectTabDatingBtnEl.classList.toggle('has-badge', this.unseenDatingMatchCount > 0);
  }

  public getActiveConnectTab(): 'connections' | 'dating' {
    return this.activeConnectTab;
  }

  public updateDatingMatches(matches: DatingMatch[], myUid: string): void {
    this.unseenDatingMatchCount = myUid ? getUnseenDatingMatches(matches, myUid).length : 0;
    this.syncDatingTabLabel();
    this.datingPanel?.updateMatches(matches);
  }

  private setConnectHubTab(tab: 'connections' | 'dating'): void {
    this.activeConnectTab = tab;
    const isDating = tab === 'dating';
    this.connectTabConnectionsBtnEl.classList.toggle('is-active', !isDating);
    this.connectTabDatingBtnEl.classList.toggle('is-active', isDating);
    this.connectHubCardsWrapEl.style.display = isDating ? 'none' : 'flex';
    this.datingPanel.rootEl.style.display = isDating ? 'flex' : 'none';
    if (isDating && this.currentSession?.talk2tmId) {
      void this.datingPanel.loadForSession(this.currentSession);
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
    this.activeConnectTab = 'connections';
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
    this.activeConnectTab = 'connections';
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
    this.recoveryStepBoxEl.style.display = 'none';
    this.pendingOnboardingDraft = null;
    this.onboardingNameInput.value = '';
    this.onboardingPhoneField.reset();
    this.onboardingPinInput.value = '';
    this.onboardingPinConfirmInput.value = '';
    this.onboardingPinInput.type = 'password';
    this.onboardingPinConfirmInput.type = 'password';
    this.onboardingPinToggleBtn1El.textContent = t('common.show');
    this.onboardingPinToggleBtn2El.textContent = t('common.show');
    this.onboardingErrorEl.textContent = '';
    this.onboardingSecretInput.value = '';
    this.onboardingSecretInput.type = 'password';
    this.onboardingSecretConfirmInput.value = '';
    this.onboardingSecretConfirmInput.type = 'password';
    this.onboardingSecretToggleBtn1El.textContent = t('common.show');
    this.onboardingSecretToggleBtn2El.textContent = t('common.show');
    this.onboardingPmUsernameInput.value = '';
    this.onboardingEmailInput.value = '';
    this.onboardingEmailHintEl.textContent = '';
    this.onboardingEmailHintEl.style.display = 'none';
    this.onboardingEmailHintEl.classList.remove('is-valid', 'is-invalid');
    this.onboardingSecretHintEl.textContent = '';
    this.onboardingSecretHintEl.style.display = 'none';
    this.onboardingSecretHintEl.classList.remove('is-valid', 'is-invalid');
    this.onboardingStep2ErrorEl.textContent = '';
    this.recoveryStepCodeEl.textContent = '';
    this.recoveryStepCodeEl.style.display = 'none';
    this.onboardingCopyCodeBtn.style.display = 'none';
    this.onboardingSubmitBtn.disabled = false;
    this.onboardingSubmitBtn.textContent = t('onboarding.continueBtn');
    this.onboardingStep2SubmitBtn.disabled = false;
    this.onboardingStep2SubmitBtn.textContent = t('onboarding.createEnterBtn');
    setTimeout(() => {
      this.onboardingNameInput.focus();
    }, 100);
  }

  public showRecoveryView(): void {
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
    this.recoveryResetBoxEl.style.display = 'none';
    this.recoveryOobBoxEl.style.display = 'none';
    this.activeOobCode = null;
    this.activeOobEmail = null;
    this.recoveryPhoneField.reset();
    this.recoveryEmailInput.value = '';
    this.recoveryCodeInput.value = '';
    this.recoveryCodeInput.type = 'password';
    this.recoveryKeyToggleBtnEl.textContent = t('common.show');
    this.recoveryPinInput.value = '';
    this.recoveryPinConfirmInput.value = '';
    this.recoveryPinInput.type = 'password';
    this.recoveryPinConfirmInput.type = 'password';
    this.recoveryPinToggleBtn1El.textContent = t('common.show');
    this.recoveryPinToggleBtn2El.textContent = t('common.show');
    this.recoveryErrorEl.textContent = '';
    this.recoverySubmitBtn.disabled = false;
    this.recoverySubmitBtn.textContent = t('recovery.submitBtn');
    setTimeout(() => {
      this.recoveryPhoneField.input.focus();
    }, 100);
  }

  public showInAppPasswordResetView(oobCode: string, email: string): void {
    this.showRecoveryView();
    this.activeOobCode = oobCode;
    this.activeOobEmail = email;
    this.recoveryMainFormEl.style.display = 'none';
    this.recoveryResetBoxEl.style.display = 'none';
    this.recoveryOobBoxEl.style.display = 'flex';
    this.recoveryOobEmailLabelEl.textContent = t('recovery.oobAccountDesc', { email });
    this.recoveryOobSecretInput.value = '';
    this.recoveryOobSecretInput.type = 'password';
    this.recoveryOobSecretToggleBtn1El.textContent = t('common.show');
    this.recoveryOobSecretConfirmInput.value = '';
    this.recoveryOobSecretConfirmInput.type = 'password';
    this.recoveryOobSecretToggleBtn2El.textContent = t('common.show');
    this.recoveryOobPinInput.value = '';
    this.recoveryOobPinConfirmInput.value = '';
    this.recoveryOobPinInput.type = 'password';
    this.recoveryOobPinConfirmInput.type = 'password';
    this.recoveryOobPinToggleBtn1El.textContent = t('common.show');
    this.recoveryOobPinToggleBtn2El.textContent = t('common.show');
    this.recoveryOobErrorEl.textContent = '';
    setTimeout(() => {
      this.recoveryOobSecretInput.focus();
    }, 100);
  }

  private applyConnectSessionMeta(session: UserSession): void {
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-flex' : 'none';
    this.connectSelfNameEl.textContent = session.displayName || t('connect.defaultName');
    this.connectSelfPhoneEl.textContent = session.phoneMasked
      ? t('connect.discoveryMasked', { phoneMasked: session.phoneMasked })
      : t('connect.discoveryActive');
    if (session.pendingRecoveryEmail) {
      this.connectEmailStatusEl.textContent = t('connect.emailPending', {
        email: session.pendingRecoveryEmail,
      });
    } else if (session.recoveryEmail) {
      this.connectEmailStatusEl.textContent = t('connect.emailLinkedStatus', {
        email: session.recoveryEmail,
      });
    } else {
      this.connectEmailStatusEl.textContent = t('onboarding.emailHint');
    }
    // No Hub de Conexões o cartão próprio já exibe o nome; evita duplicar no cabeçalho
    this.roomInfoEl.innerHTML = '';
  }

  public showConnectView(session: UserSession): void {
    const switchedAccount = this.lastDatingUid !== session.userId;
    if (switchedAccount) {
      this.datingPanel.reset();
      this.lastDatingUid = session.userId;
      this.activeConnectTab = 'connections';
      this.unseenDatingMatchCount = 0;
      this.syncDatingTabLabel();
    }
    this.currentSession = session;
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
    this.connectRecoveryPanelEl.style.display = 'none';
    this.connectEmailPanelEl.style.display = 'none';
    this.connectPinPanelEl.style.display = 'none';
    this.connectDeletePanelEl.style.display = 'none';
    this.connectDeletePinInput.value = '';
    this.connectDeleteCheckbox.checked = false;
    this.resetDeleteAccountConfirmState();
    this.connectEmailInput.value = session.recoveryEmail || session.pendingRecoveryEmail || '';
    this.connectFeedbackEl.textContent = '';
    this.connectFeedbackEl.classList.remove('is-error');
    this.applyConnectSessionMeta(session);
    this.setConnectHubTab(this.activeConnectTab);
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

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        const senderName = inv.fromDisplayName || t('connect.defaultContact');
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

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        nameEl.textContent = this.outgoingTargetNameCache.get(inv.inviteId) || t('connect.outgoingFallback');
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

        const item = document.createElement('div');
        item.className = 'ttm-connect-item';

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        nameEl.textContent = partnerName || t('connect.defaultContact');
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

    // Cadastro
    this.onboardingTitleEl.textContent = t('onboarding.title');
    this.onboardingSubtitleEl.textContent = t('onboarding.subtitle');
    this.onboardingNameInput.placeholder = t('onboarding.namePlaceholder');
    this.onboardingPhoneField.input.placeholder = t('onboarding.phonePlaceholder');
    this.onboardingPhoneField.refreshLocale();
    this.onboardingPinInput.placeholder = t('onboarding.pinPlaceholder');
    this.onboardingPinConfirmInput.placeholder = t('onboarding.pinConfirmPlaceholder');
    this.onboardingPinToggleBtn1El.textContent =
      this.onboardingPinInput.type === 'text' ? t('common.hide') : t('common.show');
    this.onboardingPinToggleBtn2El.textContent =
      this.onboardingPinConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.onboardingPinToggleBtn1El.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.onboardingPinToggleBtn2El.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.onboardingSubmitBtn.textContent = t('onboarding.continueBtn');
    this.onboardingBackBtnEl.textContent = t('common.back');
    this.onboardingStep2TitleEl.textContent = t('onboarding.step2Title');
    this.onboardingStep2DescEl.textContent = t('onboarding.step2Desc');
    this.onboardingPmUsernameInput.setAttribute('aria-label', t('onboarding.pmPhoneAria'));
    this.onboardingSecretInput.placeholder = t('onboarding.secretPlaceholder');
    this.onboardingSecretConfirmInput.placeholder = t('onboarding.secretConfirmPlaceholder');
    this.onboardingSecretToggleBtn1El.textContent =
      this.onboardingSecretInput.type === 'text' ? t('common.hide') : t('common.show');
    this.onboardingSecretToggleBtn2El.textContent =
      this.onboardingSecretConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.onboardingSecretToggleBtn1El.setAttribute('aria-label', t('pass.secretVisToggleAria'));
    this.onboardingSecretToggleBtn2El.setAttribute('aria-label', t('pass.secretVisToggleAria'));
    if (!this.onboardingSecretInput.value.trim()) {
      this.onboardingSecretHintEl.textContent = '';
      this.onboardingSecretHintEl.style.display = 'none';
    }
    this.onboardingEmailInput.placeholder = t('onboarding.emailPlaceholder');
    if (!this.onboardingEmailInput.value.trim()) {
      this.onboardingEmailHintEl.textContent = '';
      this.onboardingEmailHintEl.style.display = 'none';
    }
    this.onboardingCopyCodeBtn.textContent = t('onboarding.copyCodeBtn');
    this.onboardingStep2SubmitBtn.textContent = t('onboarding.createEnterBtn');
    this.onboardingGenCodeBtnEl.textContent = t('onboarding.genCodeBtn');
    this.onboardingBackStep1BtnEl.textContent = t('onboarding.backStep1Btn');

    // Recuperação
    this.recoveryTitleEl.textContent = t('recovery.title');
    this.recoverySubtitleEl.textContent = t('recovery.subtitle');
    this.recoveryPhoneField.input.placeholder = t('recovery.phonePlaceholder');
    this.recoveryPhoneField.refreshLocale();
    this.recoveryEmailInput.placeholder = t('recovery.emailPlaceholder');
    this.recoveryEmailHintEl.textContent = t('recovery.emailHint');
    this.recoveryCodeInput.placeholder = t('recovery.keyPlaceholder');
    this.recoveryKeyHintEl.textContent = t('recovery.keyHint');
    this.recoveryKeyToggleBtnEl.textContent =
      this.recoveryCodeInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryKeyToggleBtnEl.setAttribute('aria-label', t('pass.secretVisToggleAria'));
    this.recoveryPinInput.placeholder = t('recovery.pinPlaceholder');
    this.recoveryPinConfirmInput.placeholder = t('recovery.pinConfirmPlaceholder');
    this.recoveryPinToggleBtn1El.textContent =
      this.recoveryPinInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryPinToggleBtn2El.textContent =
      this.recoveryPinConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryPinToggleBtn1El.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.recoveryPinToggleBtn2El.setAttribute('aria-label', t('pass.pinVisToggleAria'));
    this.recoverySubmitBtn.textContent = t('recovery.submitBtn');
    this.recoveryForgotEmailBtn.textContent = t('recovery.forgotKeyBtn');
    this.recoveryBackBtnEl.textContent = t('common.back');
    this.recoveryResetTitleEl.textContent = t('recovery.resetTitle');
    this.recoveryResetDescEl.textContent = t('recovery.resetDesc');
    this.recoveryResetEmailInput.placeholder = t('recovery.resetEmailPlaceholder');
    this.recoveryResetSubmitBtn.textContent = t('recovery.resetSendBtn');
    this.recoveryResetBackBtnEl.textContent = t('recovery.resetDoneBackBtn');
    this.recoveryOobTitleEl.textContent = t('recovery.oobTitle');
    this.recoveryOobEmailLabelEl.textContent = this.activeOobEmail
      ? t('recovery.oobAccountDesc', { email: this.activeOobEmail })
      : t('recovery.oobDefaultDesc');
    this.recoveryOobSecretInput.placeholder = t('recovery.oobSecretPlaceholder');
    this.recoveryOobSecretConfirmInput.placeholder = t('recovery.oobSecretConfirmPlaceholder');
    this.recoveryOobPinInput.placeholder = t('recovery.pinPlaceholder');
    this.recoveryOobPinConfirmInput.placeholder = t('recovery.pinConfirmPlaceholder');
    this.recoveryOobSecretToggleBtn1El.textContent =
      this.recoveryOobSecretInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryOobSecretToggleBtn2El.textContent =
      this.recoveryOobSecretConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryOobPinToggleBtn1El.textContent =
      this.recoveryOobPinInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryOobPinToggleBtn2El.textContent =
      this.recoveryOobPinConfirmInput.type === 'text' ? t('common.hide') : t('common.show');
    this.recoveryOobSubmitBtn.textContent = t('recovery.oobSaveBtn');
    this.recoveryOobCancelBtnEl.textContent = t('common.cancel');

    // Hub Bilateral & Dating (+18)
    this.connectTabConnectionsBtnEl.textContent = t('dating.tabConnections');
    this.syncDatingTabLabel();
    this.datingPanel.refreshLocale();
    this.connectSelfTitleEl.textContent = t('connect.myAccount');
    this.connectRotateCodeBtnEl.textContent = t('connect.recoveryKeyBtn');
    this.connectRotateCodeBtnEl.title = t('connect.recoveryKeyTitle');
    this.connectRecoveryEmailBtnEl.textContent = t('connect.recoveryEmailBtn');
    this.connectRecoveryEmailBtnEl.title = t('connect.recoveryEmailTitle');
    this.connectChangePinBtnEl.textContent = t('connect.changePinBtn');
    this.connectRotCustomInput.placeholder = t('connect.rotPlaceholder');
    this.connectRotPinInput.placeholder = t('connect.confirmCurrentPinPlaceholder');
    this.connectRotSubmitBtnEl.textContent = t('connect.saveKeyBtn');
    this.connectRotGenBtnEl.textContent = t('connect.genAutoBtn');
    this.connectRotHintEl.textContent = t('connect.rotHint');
    this.connectRotCopyBtnEl.textContent = t('connect.copyKeyBtn');
    this.connectEmailInput.placeholder = t('onboarding.emailPlaceholder');
    this.connectEmailPinInput.placeholder = t('connect.confirmCurrentPinPlaceholder');
    this.connectSaveEmailBtnEl.textContent = t('connect.emailSaveBtn');
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
