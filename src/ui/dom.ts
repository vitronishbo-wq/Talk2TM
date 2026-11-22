import { ConnectionState, Conversation, ConversationInvite, Message, Room, UserSession } from '../types';
import { AppSettings } from '../config';
import { formatDateSeparatorLabel, formatFullDateTime, formatTime, getLocalDateKey } from '../utils/sanitize';
import { MobileCalculator, isAdminRouteSequence } from './calculator';
import { getPartnerLastRead } from '../firebase/firestore';
import { PWAPromptBar } from './pwa-prompt';
import { normalizePhoneNumber } from '../utils/phone';
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
}

export class ChatUI {
  private container: HTMLElement;
  private events: UIEvents;
  private settings: AppSettings;

  // Calculadora
  private calculator!: MobileCalculator;

  // Elementos Estruturais
  private appWrapper!: HTMLElement;
  private headerEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private roomInfoEl!: HTMLElement;
  private mainEl!: HTMLElement;

  // Tela Única de PIN (Acesso manual pelo DEG)
  private passViewEl!: HTMLElement;
  private passSubtitleEl!: HTMLElement;
  private singlePassInput!: HTMLInputElement;
  private passErrorEl!: HTMLElement;

  // Tela de Cadastro Ultraminimalista (4 campos + Chave Pessoal de Recuperação + E-mail Opcional)
  private onboardingViewEl!: HTMLElement;
  private onboardingFormEl!: HTMLFormElement;
  private onboardingNameInput!: HTMLInputElement;
  private onboardingPhoneInput!: HTMLInputElement;
  private onboardingPhonePreviewEl!: HTMLElement;
  private onboardingPinInput!: HTMLInputElement;
  private onboardingPinConfirmInput!: HTMLInputElement;
  private onboardingErrorEl!: HTMLElement;
  private onboardingSubmitBtn!: HTMLButtonElement;
  private recoveryStepBoxEl!: HTMLElement;
  private onboardingStep2FormEl!: HTMLFormElement;
  private onboardingPmUsernameInput!: HTMLInputElement;
  private onboardingSecretInput!: HTMLInputElement;
  private onboardingSecretConfirmInput!: HTMLInputElement;
  private onboardingSecretHintEl!: HTMLElement;
  private onboardingEmailInput!: HTMLInputElement;
  private onboardingEmailHintEl!: HTMLElement;
  private onboardingStep2ErrorEl!: HTMLElement;
  private onboardingStep2SubmitBtn!: HTMLButtonElement;
  private recoveryStepCodeEl!: HTMLElement;
  private onboardingCopyCodeBtn!: HTMLButtonElement;
  private pendingOnboardingDraft: { displayName: string; phone: string; e164Phone: string; pin: string } | null = null;

  // Tela de Entrada em Outro Aparelho / Recuperação (Zero Custos)
  private recoveryViewEl!: HTMLElement;
  private recoveryMainFormEl!: HTMLFormElement;
  private recoveryPhoneInput!: HTMLInputElement;
  private recoveryPhonePreviewEl!: HTMLElement;
  private recoveryEmailInput!: HTMLInputElement;
  private recoveryCodeInput!: HTMLInputElement;
  private recoveryPinInput!: HTMLInputElement;
  private recoveryPinConfirmInput!: HTMLInputElement;
  private recoveryErrorEl!: HTMLElement;
  private recoverySubmitBtn!: HTMLButtonElement;
  private recoveryForgotEmailBtn!: HTMLButtonElement;
  private recoveryResetBoxEl!: HTMLElement;
  private recoveryResetEmailInput!: HTMLInputElement;
  private recoveryResetFeedbackEl!: HTMLElement;
  private recoveryResetSubmitBtn!: HTMLButtonElement;
  private recoveryOobBoxEl!: HTMLElement;
  private recoveryOobEmailLabelEl!: HTMLElement;
  private recoveryOobSecretInput!: HTMLInputElement;
  private recoveryOobSecretConfirmInput!: HTMLInputElement;
  private recoveryOobPinInput!: HTMLInputElement;
  private recoveryOobPinConfirmInput!: HTMLInputElement;
  private recoveryOobErrorEl!: HTMLElement;
  private recoveryOobSubmitBtn!: HTMLButtonElement;
  private activeOobCode: string | null = null;

  // Hub de Conexões Bilaterais (Descoberta por telefone exato, sem expor TM-XXXX-XXXX)
  private connectionsBtnEl!: HTMLButtonElement;
  private connectViewEl!: HTMLElement;
  private connectSelfNameEl!: HTMLElement;
  private connectSelfPhoneEl!: HTMLElement;
  private connectRecoveryPanelEl!: HTMLElement;
  private connectEmailPanelEl!: HTMLElement;
  private connectEmailStatusEl!: HTMLElement;
  private connectEmailInput!: HTMLInputElement;
  private connectPinPanelEl!: HTMLElement;
  private connectTargetInput!: HTMLInputElement;
  private connectTargetPreviewEl!: HTMLElement;
  private connectInviteBtn!: HTMLButtonElement;
  private connectFeedbackEl!: HTMLElement;
  private incomingInvitesListEl!: HTMLElement;
  private outgoingInvitesListEl!: HTMLElement;
  private conversationsListEl!: HTMLElement;
  private outgoingTargetNameCache: Map<string, string> = new Map();

  // Tela de Chat
  private chatViewEl!: HTMLElement;
  private msgListEl!: HTMLElement;
  private msgInputEl!: HTMLInputElement;
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
  private sessionSelectEl!: HTMLSelectElement;
  private inactivitySelectEl!: HTMLSelectElement;
  private inactivityNoticeEl!: HTMLElement;

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
    new PWAPromptBar(this.appWrapper);

    // 1. Calculadora Camuflada com teclado universal
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
    brandDesc.textContent = ' [2P]';
    brandEl.appendChild(brandTitle);
    brandEl.appendChild(brandDesc);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'ttm-status';
    this.statusEl.setAttribute('data-state', 'conectando');
    this.statusEl.setAttribute('title', 'Rede: conectando');
    this.statusEl.setAttribute('aria-label', 'Rede: conectando');
    this.statusEl.innerHTML = this.getNetworkIconSvg();

    // Ações do cabeçalho
    const headerActions = document.createElement('div');
    headerActions.className = 'ttm-header-actions';

    this.connectionsBtnEl = document.createElement('button');
    this.connectionsBtnEl.type = 'button';
    this.connectionsBtnEl.className = 'ttm-btn ttm-btn-def';
    this.connectionsBtnEl.textContent = '[⇄ conexões]';
    this.connectionsBtnEl.title = 'Gerir convites e conversas bilaterais';
    this.connectionsBtnEl.style.display = 'none';
    this.connectionsBtnEl.addEventListener('click', () => {
      this.events.onShowConnectHub?.();
    });

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'ttm-btn ttm-btn-def';
    settingsBtn.textContent = '[☼ def]';
    settingsBtn.title = 'Definições mínimas (tempo de sessão e inatividade)';
    settingsBtn.addEventListener('click', () => {
      this.openSettingsModal();
    });

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'ttm-btn ttm-btn-lock';
    lockBtn.textContent = '[⚑ calc]';
    lockBtn.title = 'Bloquear imediatamente e camuflar na calculadora';
    lockBtn.addEventListener('click', () => {
      this.events.onLockToCalculator();
    });

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
    this.buildOnboardingView();
    this.buildRecoveryView();
    this.buildConnectView();
    this.buildChatView();
    this.buildSettingsModal();

    this.mainEl.appendChild(this.passViewEl);
    this.mainEl.appendChild(this.onboardingViewEl);
    this.mainEl.appendChild(this.recoveryViewEl);
    this.mainEl.appendChild(this.connectViewEl);
    this.mainEl.appendChild(this.chatViewEl);
    this.appWrapper.appendChild(this.mainEl);
    this.appWrapper.appendChild(this.settingsModalEl);

    this.container.appendChild(this.appWrapper);

    // Inicia na calculadora por padrão
    this.showCalculatorView();
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
    toggleBtn.textContent = 'ver';
    toggleBtn.setAttribute('aria-label', 'Mostrar ou ocultar PIN');
    toggleBtn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggleBtn.textContent = showing ? 'ver' : 'ocultar';
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
    toggleBtn.textContent = startVisible ? 'ocultar' : 'ver';
    toggleBtn.setAttribute('aria-label', 'Mostrar ou ocultar chave');
    toggleBtn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggleBtn.textContent = showing ? 'ver' : 'ocultar';
    });

    wrapper.appendChild(input);
    wrapper.appendChild(toggleBtn);
    return { wrapper, input, toggleBtn };
  }

  private updatePhonePreview(raw: string, previewEl: HTMLElement): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      previewEl.textContent = 'Número declarado (não verificado por SMS). Angola: 9 dígitos ou +indicativo.';
      previewEl.classList.remove('is-valid', 'is-invalid');
      return;
    }
    const res = normalizePhoneNumber(trimmed);
    if (res.valid && res.e164) {
      previewEl.textContent = `Formato internacional: ${res.e164} (declarado)`;
      previewEl.classList.add('is-valid');
      previewEl.classList.remove('is-invalid');
    } else {
      previewEl.textContent = res.error || 'Formato inválido.';
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
    this.passSubtitleEl.textContent = 'Digite seu PIN numérico (4 a 8 dígitos) na calculadora ou abaixo:';

    const formEl = document.createElement('form');
    formEl.className = 'ttm-form';

    const pinField = this.createPinInputWithToggle(
      'ttm-single-pass',
      'PIN numérico (4 a 8 dígitos)',
      16,
      'off'
    );
    this.singlePassInput = pinField.input;
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
    enterBtn.textContent = '[entrar]';

    const createAccountBtn = document.createElement('button');
    createAccountBtn.type = 'button';
    createAccountBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    createAccountBtn.textContent = '[criar conta]';
    createAccountBtn.addEventListener('click', () => {
      this.showOnboardingView();
    });

    const recoverAccountBtn = document.createElement('button');
    recoverAccountBtn.type = 'button';
    recoverAccountBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    recoverAccountBtn.textContent = '[entrar noutro aparelho / recuperar]';
    recoverAccountBtn.addEventListener('click', () => {
      this.showRecoveryView();
    });

    const backToCalcBtn = document.createElement('button');
    backToCalcBtn.type = 'button';
    backToCalcBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backToCalcBtn.textContent = '[voltar para calculadora]';
    backToCalcBtn.addEventListener('click', () => {
      this.events.onLockToCalculator();
    });

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
        this.passErrorEl.textContent = 'Digite o PIN de acesso.';
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
  private buildOnboardingView(): void {
    this.onboardingViewEl = document.createElement('div');
    this.onboardingViewEl.id = 'ttm-onboarding-view';
    this.onboardingViewEl.className = 'ttm-onboarding-box';
    this.onboardingViewEl.style.display = 'none';

    const cardEl = document.createElement('div');
    cardEl.className = 'ttm-onboarding-card';

    const titleEl = document.createElement('h1');
    titleEl.className = 'ttm-title';
    titleEl.textContent = 'Criar Conta';

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'ttm-subtitle';
    subtitleEl.textContent = 'Cadastro simples, gratuito e sem e-mail ou SMS.';

    this.onboardingFormEl = document.createElement('form');
    this.onboardingFormEl.className = 'ttm-form';

    this.onboardingNameInput = document.createElement('input');
    this.onboardingNameInput.type = 'text';
    this.onboardingNameInput.id = 'ttm-onboarding-name';
    this.onboardingNameInput.className = 'ttm-input ttm-input-left';
    this.onboardingNameInput.placeholder = '1. Nome / Utilizador';
    this.onboardingNameInput.maxLength = 30;
    this.onboardingNameInput.autocomplete = 'name';

    this.onboardingPhoneInput = document.createElement('input');
    this.onboardingPhoneInput.type = 'tel';
    this.onboardingPhoneInput.id = 'ttm-onboarding-phone';
    this.onboardingPhoneInput.className = 'ttm-input ttm-input-left';
    this.onboardingPhoneInput.placeholder = '2. Telefone (+244 9XX... ou 9XXXXXXXX)';
    this.onboardingPhoneInput.inputMode = 'tel';
    this.onboardingPhoneInput.maxLength = 24;
    this.onboardingPhoneInput.autocomplete = 'tel';

    this.onboardingPhonePreviewEl = document.createElement('div');
    this.onboardingPhonePreviewEl.className = 'ttm-field-hint';
    this.onboardingPhonePreviewEl.textContent =
      'Número declarado (não verificado por SMS). Angola: 9 dígitos ou +indicativo.';

    this.onboardingPhoneInput.addEventListener('input', () => {
      this.updatePhonePreview(this.onboardingPhoneInput.value, this.onboardingPhonePreviewEl);
    });

    const pin1 = this.createPinInputWithToggle(
      'ttm-onboarding-pin',
      '3. PIN da calculadora (4 a 8 dígitos)',
      8,
      'off'
    );
    this.onboardingPinInput = pin1.input;

    const pin2 = this.createPinInputWithToggle(
      'ttm-onboarding-pin-confirm',
      '4. Confirmar PIN',
      8,
      'off'
    );
    this.onboardingPinConfirmInput = pin2.input;

    this.onboardingErrorEl = document.createElement('div');
    this.onboardingErrorEl.className = 'ttm-error';
    this.onboardingErrorEl.textContent = '';

    this.onboardingSubmitBtn = document.createElement('button');
    this.onboardingSubmitBtn.type = 'submit';
    this.onboardingSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.onboardingSubmitBtn.textContent = '[continuar]';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backBtn.textContent = '[voltar]';
    backBtn.addEventListener('click', () => {
      this.showPassEntryView();
    });

    this.onboardingFormEl.appendChild(this.onboardingNameInput);
    this.onboardingFormEl.appendChild(this.onboardingPhoneInput);
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
    recTitle.textContent = 'Passo 2: Chave Pessoal (Outro Aparelho)';

    const recDesc = document.createElement('p');
    recDesc.className = 'ttm-onboarding-tip';
    recDesc.textContent =
      'Para entrar noutro aparelho ou no modo anónimo, defina uma chave pessoal fácil que já tenha em mente (ex.: nomedamae1985). O navegador pode guardá-la por si.';

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
    this.onboardingPmUsernameInput.setAttribute('aria-label', 'Telefone da conta');

    const sec1 = this.createSecretInputWithToggle(
      'ttm-onboarding-secret',
      'Chave pessoal (mín. 6 letras/números)',
      40,
      false,
      'new-password',
      'password'
    );
    this.onboardingSecretInput = sec1.input;

    this.onboardingSecretHintEl = document.createElement('div');
    this.onboardingSecretHintEl.className = 'ttm-field-hint';
    this.onboardingSecretHintEl.textContent =
      'Regras: mínimo 6 caracteres, diferente do PIN da calculadora (maiúsculas e espaços são ignorados).';

    const sec2 = this.createSecretInputWithToggle(
      'ttm-onboarding-secret-confirm',
      'Confirmar chave pessoal',
      40,
      false,
      'new-password'
    );
    this.onboardingSecretConfirmInput = sec2.input;

    this.onboardingEmailInput = document.createElement('input');
    this.onboardingEmailInput.type = 'email';
    this.onboardingEmailInput.id = 'ttm-onboarding-email';
    this.onboardingEmailInput.name = 'recovery-email';
    this.onboardingEmailInput.className = 'ttm-input ttm-input-left';
    this.onboardingEmailInput.placeholder = 'E-mail de recuperação (opcional)';
    this.onboardingEmailInput.maxLength = 120;
    this.onboardingEmailInput.autocomplete = 'email';
    this.onboardingEmailInput.inputMode = 'email';

    this.onboardingEmailHintEl = document.createElement('div');
    this.onboardingEmailHintEl.className = 'ttm-field-hint';
    this.onboardingEmailHintEl.textContent =
      'Opcional — apenas para efeitos de recuperação de conta (guarde este e-mail).';

    this.onboardingEmailInput.addEventListener('input', () => {
      const raw = this.onboardingEmailInput.value.trim();
      if (!raw) {
        this.onboardingEmailHintEl.textContent =
          'Opcional — apenas para efeitos de recuperação de conta (guarde este e-mail).';
        this.onboardingEmailHintEl.classList.remove('is-valid', 'is-invalid');
        return;
      }
      const check = validateOptionalRecoveryEmail(raw);
      if (check.valid && check.email) {
        this.onboardingEmailHintEl.textContent =
          'Opcional — apenas para efeitos de recuperação de conta (guarde este e-mail).';
        this.onboardingEmailHintEl.classList.add('is-valid');
        this.onboardingEmailHintEl.classList.remove('is-invalid');
      } else {
        this.onboardingEmailHintEl.textContent = check.error || 'E-mail inválido.';
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
    this.onboardingCopyCodeBtn.textContent = '[copiar código gerado]';
    this.onboardingCopyCodeBtn.style.display = 'none';
    this.onboardingCopyCodeBtn.addEventListener('click', async () => {
      const code = this.recoveryStepCodeEl.textContent || '';
      if (!code) return;
      await navigator.clipboard?.writeText(code).catch(() => {});
      this.onboardingSecretHintEl.textContent = 'Código copiado! Guarde num local seguro fora deste aparelho.';
      this.onboardingSecretHintEl.classList.add('is-valid');
      this.onboardingSecretHintEl.classList.remove('is-invalid');
    });

    this.onboardingSecretInput.addEventListener('input', () => {
      const raw = this.onboardingSecretInput.value;
      if (!raw.trim()) {
        this.onboardingSecretHintEl.textContent =
          'Regras: mínimo 6 caracteres, diferente do PIN da calculadora (maiúsculas e espaços são ignorados).';
        this.onboardingSecretHintEl.classList.remove('is-valid', 'is-invalid');
        return;
      }
      const check = validateRecoverySecret(raw, this.pendingOnboardingDraft?.pin);
      if (check.valid) {
        this.onboardingSecretHintEl.textContent = `Chave válida (${check.normalized.length} caracteres). Fácil de replicar de memória.`;
        this.onboardingSecretHintEl.classList.add('is-valid');
        this.onboardingSecretHintEl.classList.remove('is-invalid');
      } else {
        this.onboardingSecretHintEl.textContent = check.error || 'Chave inválida.';
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
    this.onboardingStep2SubmitBtn.textContent = '[criar conta e entrar]';

    const genRandomBtn = document.createElement('button');
    genRandomBtn.type = 'button';
    genRandomBtn.className = 'ttm-btn ttm-btn-secondary';
    genRandomBtn.textContent = '[ou gerar código automático]';
    genRandomBtn.addEventListener('click', () => {
      const generated = generateRecoveryCode();
      this.onboardingSecretInput.value = generated;
      this.onboardingSecretConfirmInput.value = generated;
      this.recoveryStepCodeEl.textContent = generated;
      this.recoveryStepCodeEl.style.display = 'block';
      this.onboardingCopyCodeBtn.style.display = 'inline-block';
      this.onboardingSecretHintEl.textContent = 'Código automático preenchido. Copie ou anote se preferir usá-lo.';
      this.onboardingSecretHintEl.classList.add('is-valid');
      this.onboardingSecretHintEl.classList.remove('is-invalid');
      this.onboardingStep2ErrorEl.textContent = '';
    });

    const backStep1Btn = document.createElement('button');
    backStep1Btn.type = 'button';
    backStep1Btn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backStep1Btn.textContent = '[voltar aos dados]';
    backStep1Btn.addEventListener('click', () => {
      this.recoveryStepBoxEl.style.display = 'none';
      this.onboardingFormEl.style.display = 'flex';
      this.onboardingStep2ErrorEl.textContent = '';
    });

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
    this.onboardingStep2FormEl.appendChild(genRandomBtn);
    this.onboardingStep2FormEl.appendChild(backStep1Btn);

    this.recoveryStepBoxEl.appendChild(recTitle);
    this.recoveryStepBoxEl.appendChild(recDesc);
    this.recoveryStepBoxEl.appendChild(this.onboardingStep2FormEl);

    this.onboardingFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.onboardingErrorEl.textContent = '';

      const displayName = this.onboardingNameInput.value.trim();
      const phone = this.onboardingPhoneInput.value.trim();
      const pin = this.onboardingPinInput.value.trim();
      const pinConfirm = this.onboardingPinConfirmInput.value.trim();

      if (!displayName) {
        this.onboardingErrorEl.textContent = 'Informe seu nome ou utilizador.';
        return;
      }
      const phoneCheck = normalizePhoneNumber(phone);
      if (!phoneCheck.valid || !phoneCheck.e164) {
        this.onboardingErrorEl.textContent = phoneCheck.error || 'Número de telefone inválido.';
        return;
      }
      if (!/^\d{4,8}$/.test(pin)) {
        this.onboardingErrorEl.textContent = 'O PIN deve ter entre 4 e 8 dígitos numéricos.';
        return;
      }
      if (pin !== pinConfirm) {
        this.onboardingErrorEl.textContent = 'Os dois PINs não coincidem.';
        return;
      }
      const pinValid = await validateLocalPin(pin, true);
      if (!pinValid.valid) {
        this.onboardingErrorEl.textContent = pinValid.error || 'PIN inválido.';
        return;
      }

      this.pendingOnboardingDraft = { displayName, phone, e164Phone: phoneCheck.e164, pin };
      this.onboardingPmUsernameInput.value = phoneCheck.e164;
      this.onboardingFormEl.style.display = 'none';
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
        return;
      }

      const secret = this.onboardingSecretInput.value.trim();
      const secretConfirm = this.onboardingSecretConfirmInput.value.trim();
      const recoveryEmailRaw = this.onboardingEmailInput.value.trim();

      const check = validateRecoverySecret(secret, draft.pin);
      if (!check.valid) {
        this.onboardingStep2ErrorEl.textContent = check.error || 'Chave pessoal inválida.';
        return;
      }
      if (normalizeRecoveryCode(secret) !== normalizeRecoveryCode(secretConfirm)) {
        this.onboardingStep2ErrorEl.textContent = 'As duas chaves pessoais não coincidem.';
        return;
      }
      const emailCheck = validateOptionalRecoveryEmail(recoveryEmailRaw);
      if (!emailCheck.valid) {
        this.onboardingStep2ErrorEl.textContent = emailCheck.error || 'E-mail de recuperação inválido.';
        return;
      }

      if (this.events.onCreateIdentity) {
        this.onboardingStep2SubmitBtn.disabled = true;
        this.onboardingStep2SubmitBtn.textContent = '[criando conta...]';
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
          this.onboardingStep2SubmitBtn.textContent = '[criar conta e entrar]';
        }
      }
    });

    cardEl.appendChild(titleEl);
    cardEl.appendChild(subtitleEl);
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
    titleEl.textContent = 'Entrar / Recuperar Conta';

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'ttm-subtitle';
    subtitleEl.textContent =
      'Para entrar no modo anónimo ou noutro aparelho, informe seus dados e defina o PIN da calculadora neste aparelho.';

    this.recoveryMainFormEl = document.createElement('form');
    this.recoveryMainFormEl.className = 'ttm-form';

    this.recoveryPhoneInput = document.createElement('input');
    this.recoveryPhoneInput.type = 'tel';
    this.recoveryPhoneInput.id = 'ttm-recovery-phone';
    this.recoveryPhoneInput.name = 'username';
    this.recoveryPhoneInput.className = 'ttm-input ttm-input-left';
    this.recoveryPhoneInput.placeholder = '1. Telefone (+244 9XX... ou 9XXXXXXXX)';
    this.recoveryPhoneInput.inputMode = 'tel';
    this.recoveryPhoneInput.maxLength = 24;
    this.recoveryPhoneInput.autocomplete = 'username';

    this.recoveryPhonePreviewEl = document.createElement('div');
    this.recoveryPhonePreviewEl.className = 'ttm-field-hint';
    this.recoveryPhonePreviewEl.textContent = 'Use o mesmo número declarado no cadastro.';

    this.recoveryPhoneInput.addEventListener('input', () => {
      this.updatePhonePreview(this.recoveryPhoneInput.value, this.recoveryPhonePreviewEl);
    });

    this.recoveryEmailInput = document.createElement('input');
    this.recoveryEmailInput.type = 'email';
    this.recoveryEmailInput.id = 'ttm-recovery-email';
    this.recoveryEmailInput.name = 'recovery-email';
    this.recoveryEmailInput.className = 'ttm-input ttm-input-left';
    this.recoveryEmailInput.placeholder = '2. E-mail de recuperação (só se associou)';
    this.recoveryEmailInput.maxLength = 120;
    this.recoveryEmailInput.autocomplete = 'email';
    this.recoveryEmailInput.inputMode = 'email';

    const recoveryEmailHint = document.createElement('div');
    recoveryEmailHint.className = 'ttm-field-hint';
    recoveryEmailHint.textContent = 'Deixe vazio se não associou e-mail na sua conta.';

    const recKeyField = this.createSecretInputWithToggle(
      'ttm-recovery-code',
      '3. Chave pessoal (mín. 6 caracteres) ou código',
      40,
      false,
      'current-password',
      'password'
    );
    this.recoveryCodeInput = recKeyField.input;

    const recKeyHintEl = document.createElement('div');
    recKeyHintEl.className = 'ttm-field-hint';
    recKeyHintEl.textContent = 'A chave pessoal que definiu ao criar a conta (maiúsculas e espaços são ignorados).';

    const newPin1 = this.createPinInputWithToggle(
      'ttm-recovery-pin',
      '4. PIN da calculadora neste aparelho (4 a 8 dígitos)',
      8,
      'off'
    );
    this.recoveryPinInput = newPin1.input;

    const newPin2 = this.createPinInputWithToggle(
      'ttm-recovery-pin-confirm',
      '5. Confirmar PIN',
      8,
      'off'
    );
    this.recoveryPinConfirmInput = newPin2.input;

    this.recoveryErrorEl = document.createElement('div');
    this.recoveryErrorEl.className = 'ttm-error';
    this.recoveryErrorEl.textContent = '';

    this.recoverySubmitBtn = document.createElement('button');
    this.recoverySubmitBtn.type = 'submit';
    this.recoverySubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoverySubmitBtn.textContent = '[entrar na conta]';

    this.recoveryForgotEmailBtn = document.createElement('button');
    this.recoveryForgotEmailBtn.type = 'button';
    this.recoveryForgotEmailBtn.className = 'ttm-btn ttm-btn-secondary';
    this.recoveryForgotEmailBtn.textContent = '[esqueci a chave — recuperar por e-mail]';
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
    backBtn.textContent = '[voltar]';
    backBtn.addEventListener('click', () => {
      this.showPassEntryView();
    });

    this.recoveryMainFormEl.appendChild(this.recoveryPhoneInput);
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

      const phone = this.recoveryPhoneInput.value.trim();
      const recoveryEmail = this.recoveryEmailInput.value.trim();
      const recoveryCode = this.recoveryCodeInput.value.trim();
      const newPin = this.recoveryPinInput.value.trim();
      const confirmPin = this.recoveryPinConfirmInput.value.trim();

      if (!phone && !recoveryEmail) {
        this.recoveryErrorEl.textContent = 'Informe o número de telefone cadastrado (ou o e-mail de recuperação).';
        return;
      }
      if (phone) {
        const phoneCheck = normalizePhoneNumber(phone);
        if (!phoneCheck.valid) {
          this.recoveryErrorEl.textContent = phoneCheck.error || 'Número de telefone inválido.';
          return;
        }
      }
      const emailCheck = validateOptionalRecoveryEmail(recoveryEmail);
      if (!emailCheck.valid) {
        this.recoveryErrorEl.textContent = emailCheck.error || 'E-mail de recuperação inválido.';
        return;
      }
      if (normalizeRecoveryCode(recoveryCode).length < 6 && recoveryCode.length < 6) {
        this.recoveryErrorEl.textContent = 'Informe sua chave pessoal (mínimo 6 caracteres) ou senha redefinida.';
        return;
      }
      if (!/^\d{4,8}$/.test(newPin)) {
        this.recoveryErrorEl.textContent = 'O PIN deve ter entre 4 e 8 dígitos numéricos.';
        return;
      }
      if (newPin !== confirmPin) {
        this.recoveryErrorEl.textContent = 'Os dois PINs não coincidem.';
        return;
      }

      if (this.events.onRecoverIdentity) {
        this.recoverySubmitBtn.disabled = true;
        this.recoverySubmitBtn.textContent = '[entrando...]';
        try {
          await this.events.onRecoverIdentity({
            phone: phone || undefined,
            recoveryEmail: emailCheck.email,
            recoveryCode,
            newPin,
          });
        } catch (err: any) {
          this.recoveryErrorEl.textContent = this.extractReadableError(err);
        } finally {
          this.recoverySubmitBtn.disabled = false;
          this.recoverySubmitBtn.textContent = '[entrar na conta]';
        }
      }
    });

    // Painel 2: Pedir link gratuito de redefinição por e-mail (Firebase Auth nativo)
    this.recoveryResetBoxEl = document.createElement('div');
    this.recoveryResetBoxEl.className = 'ttm-recovery-confirm-box';
    this.recoveryResetBoxEl.style.display = 'none';

    const resetBoxTitle = document.createElement('div');
    resetBoxTitle.className = 'ttm-recovery-title';
    resetBoxTitle.textContent = 'Redefinir por E-mail';

    const resetBoxDesc = document.createElement('p');
    resetBoxDesc.className = 'ttm-onboarding-tip';
    resetBoxDesc.textContent =
      'Informe o e-mail que associou à sua conta para receber o link gratuito do Firebase. Ao abrir o link, digite a sua nova Chave Pessoal (mín. 6 caracteres) e depois volte aqui para entrar.';

    const resetForm = document.createElement('form');
    resetForm.className = 'ttm-form';

    this.recoveryResetEmailInput = document.createElement('input');
    this.recoveryResetEmailInput.type = 'email';
    this.recoveryResetEmailInput.className = 'ttm-input ttm-input-left';
    this.recoveryResetEmailInput.placeholder = 'Seu e-mail de recuperação';
    this.recoveryResetEmailInput.maxLength = 120;
    this.recoveryResetEmailInput.autocomplete = 'email';
    this.recoveryResetEmailInput.inputMode = 'email';

    this.recoveryResetFeedbackEl = document.createElement('div');
    this.recoveryResetFeedbackEl.className = 'ttm-field-hint';
    this.recoveryResetFeedbackEl.textContent = '';

    this.recoveryResetSubmitBtn = document.createElement('button');
    this.recoveryResetSubmitBtn.type = 'submit';
    this.recoveryResetSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoveryResetSubmitBtn.textContent = '[enviar link de redefinição]';

    const resetBackBtn = document.createElement('button');
    resetBackBtn.type = 'button';
    resetBackBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    resetBackBtn.textContent = '[já redefini no link — voltar e entrar]';
    resetBackBtn.addEventListener('click', () => {
      const typedEmail = this.recoveryResetEmailInput.value.trim();
      if (typedEmail) {
        this.recoveryEmailInput.value = typedEmail;
      }
      this.recoveryResetBoxEl.style.display = 'none';
      this.recoveryMainFormEl.style.display = 'flex';
    });

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.recoveryResetFeedbackEl.textContent = '';
      this.recoveryResetFeedbackEl.classList.remove('is-valid', 'is-invalid');

      const rawEmail = this.recoveryResetEmailInput.value.trim();
      const emailCheck = validateOptionalRecoveryEmail(rawEmail);
      if (!emailCheck.valid || !emailCheck.email) {
        this.recoveryResetFeedbackEl.textContent = emailCheck.error || 'Informe um e-mail válido.';
        this.recoveryResetFeedbackEl.classList.add('is-invalid');
        return;
      }

      if (!this.events.onSendPasswordResetEmail) return;
      this.recoveryResetSubmitBtn.disabled = true;
      this.recoveryResetSubmitBtn.textContent = '[enviando link...]';
      try {
        const res = await this.events.onSendPasswordResetEmail(emailCheck.email);
        this.recoveryEmailInput.value = res.email;
        this.recoveryResetFeedbackEl.textContent =
          `Se ${res.email} estiver associado a uma conta, enviámos o link de redefinição (confira a caixa de entrada e Spam). No link, defina sua nova Chave Pessoal e volte aqui para entrar.`;
        this.recoveryResetFeedbackEl.classList.add('is-valid');
      } catch (err: any) {
        this.recoveryResetFeedbackEl.textContent = this.extractReadableError(err);
        this.recoveryResetFeedbackEl.classList.add('is-invalid');
      } finally {
        this.recoveryResetSubmitBtn.disabled = false;
        this.recoveryResetSubmitBtn.textContent = '[enviar link de redefinição]';
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
    oobTitle.textContent = 'Definir Nova Chave Pessoal';

    this.recoveryOobEmailLabelEl = document.createElement('p');
    this.recoveryOobEmailLabelEl.className = 'ttm-onboarding-tip';
    this.recoveryOobEmailLabelEl.textContent = 'Defina a nova Chave Pessoal e o PIN da calculadora para este aparelho.';

    const oobForm = document.createElement('form');
    oobForm.className = 'ttm-form';

    const oobSec1 = this.createSecretInputWithToggle(
      'ttm-oob-secret',
      'Nova chave pessoal (mín. 6 caracteres)',
      40,
      false,
      'new-password',
      'password'
    );
    this.recoveryOobSecretInput = oobSec1.input;

    const oobSec2 = this.createSecretInputWithToggle(
      'ttm-oob-secret-confirm',
      'Confirmar nova chave pessoal',
      40,
      false,
      'new-password'
    );
    this.recoveryOobSecretConfirmInput = oobSec2.input;

    const oobPin1 = this.createPinInputWithToggle(
      'ttm-oob-pin',
      'PIN da calculadora neste aparelho (4 a 8 dígitos)',
      8,
      'off'
    );
    this.recoveryOobPinInput = oobPin1.input;

    const oobPin2 = this.createPinInputWithToggle(
      'ttm-oob-pin-confirm',
      'Confirmar PIN',
      8,
      'off'
    );
    this.recoveryOobPinConfirmInput = oobPin2.input;

    this.recoveryOobErrorEl = document.createElement('div');
    this.recoveryOobErrorEl.className = 'ttm-error';
    this.recoveryOobErrorEl.textContent = '';

    this.recoveryOobSubmitBtn = document.createElement('button');
    this.recoveryOobSubmitBtn.type = 'submit';
    this.recoveryOobSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    this.recoveryOobSubmitBtn.textContent = '[salvar nova chave e entrar]';

    const oobCancelBtn = document.createElement('button');
    oobCancelBtn.type = 'button';
    oobCancelBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    oobCancelBtn.textContent = '[cancelar]';
    oobCancelBtn.addEventListener('click', () => {
      this.activeOobCode = null;
      this.showPassEntryView();
    });

    oobForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.recoveryOobErrorEl.textContent = '';
      if (!this.activeOobCode) return;

      const secret = this.recoveryOobSecretInput.value.trim();
      const secretConfirm = this.recoveryOobSecretConfirmInput.value.trim();
      const newPin = this.recoveryOobPinInput.value.trim();
      const confirmPin = this.recoveryOobPinConfirmInput.value.trim();

      if (!/^\d{4,8}$/.test(newPin)) {
        this.recoveryOobErrorEl.textContent = 'O PIN deve ter entre 4 e 8 dígitos numéricos.';
        return;
      }
      if (newPin !== confirmPin) {
        this.recoveryOobErrorEl.textContent = 'Os dois PINs não coincidem.';
        return;
      }
      const secCheck = validateRecoverySecret(secret, newPin);
      if (!secCheck.valid) {
        this.recoveryOobErrorEl.textContent = secCheck.error || 'Nova chave pessoal inválida.';
        return;
      }
      if (normalizeRecoveryCode(secret) !== normalizeRecoveryCode(secretConfirm)) {
        this.recoveryOobErrorEl.textContent = 'As duas chaves pessoais não coincidem.';
        return;
      }

      if (!this.events.onCompleteInAppPasswordReset) return;
      this.recoveryOobSubmitBtn.disabled = true;
      this.recoveryOobSubmitBtn.textContent = '[salvando...]';
      try {
        await this.events.onCompleteInAppPasswordReset({
          oobCode: this.activeOobCode,
          recoveryCode: secret,
          newPin,
        });
        this.activeOobCode = null;
      } catch (err: any) {
        this.recoveryOobErrorEl.textContent = this.extractReadableError(err);
      } finally {
        this.recoveryOobSubmitBtn.disabled = false;
        this.recoveryOobSubmitBtn.textContent = '[salvar nova chave e entrar]';
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

    // Cartão 1: Minha Conta & Segurança Local
    const selfCard = document.createElement('div');
    selfCard.className = 'ttm-connect-card';

    const selfTitle = document.createElement('div');
    selfTitle.className = 'ttm-connect-section-title';
    selfTitle.textContent = 'Minha conta';

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
    rotateCodeBtn.textContent = '[chave de recuperação]';
    rotateCodeBtn.title = 'Definir chave pessoal fácil ou gerar novo código';

    const recoveryEmailBtn = document.createElement('button');
    recoveryEmailBtn.type = 'button';
    recoveryEmailBtn.className = 'ttm-btn-mini';
    recoveryEmailBtn.textContent = '[e-mail recuperação]';
    recoveryEmailBtn.title = 'Opcional: associar e-mail para recuperação gratuita';

    const changePinBtn = document.createElement('button');
    changePinBtn.type = 'button';
    changePinBtn.className = 'ttm-btn-mini';
    changePinBtn.textContent = '[alterar PIN]';

    selfActions.appendChild(rotateCodeBtn);
    selfActions.appendChild(recoveryEmailBtn);
    selfActions.appendChild(changePinBtn);
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
    rotCustomInput.placeholder = 'Chave pessoal (mín. 6 caracteres, opcional p/ gerar)';
    rotCustomInput.className = 'ttm-connect-input ttm-connect-input-phone';
    const rotPinInput = document.createElement('input');
    rotPinInput.type = 'password';
    rotPinInput.inputMode = 'numeric';
    rotPinInput.maxLength = 8;
    rotPinInput.autocomplete = 'off';
    rotPinInput.placeholder = 'Confirme seu PIN atual';
    rotPinInput.className = 'ttm-connect-input ttm-connect-input-phone';
    const rotBtnRow = document.createElement('div');
    rotBtnRow.className = 'ttm-inline-form';
    const rotSubmitBtn = document.createElement('button');
    rotSubmitBtn.type = 'submit';
    rotSubmitBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    rotSubmitBtn.textContent = '[salvar chave]';
    const rotGenBtn = document.createElement('button');
    rotGenBtn.type = 'button';
    rotGenBtn.className = 'ttm-btn-mini';
    rotGenBtn.textContent = '[gerar automático]';
    rotBtnRow.appendChild(rotSubmitBtn);
    rotBtnRow.appendChild(rotGenBtn);

    const rotResultEl = document.createElement('div');
    rotResultEl.className = 'ttm-code-badge ttm-code-badge-compact';
    rotResultEl.style.display = 'none';
    const rotHintEl = document.createElement('div');
    rotHintEl.className = 'ttm-field-hint';
    rotHintEl.textContent =
      'Defina uma chave pessoal fácil (mín. 6 caracteres, diferente do PIN) para entrar noutro aparelho.';
    const rotCopyBtn = document.createElement('button');
    rotCopyBtn.type = 'button';
    rotCopyBtn.className = 'ttm-btn-mini';
    rotCopyBtn.textContent = '[copiar chave]';
    rotCopyBtn.style.display = 'none';
    rotCopyBtn.addEventListener('click', async () => {
      const code = rotResultEl.textContent || '';
      if (code) {
        await navigator.clipboard?.writeText(code).catch(() => {});
        this.showConnectFeedback('Chave de recuperação copiada.');
      }
    });

    rotGenBtn.addEventListener('click', () => {
      rotCustomInput.value = generateRecoveryCode();
    });

    rotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = rotPinInput.value.trim();
      const customKey = rotCustomInput.value.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        this.showConnectFeedback('Digite seu PIN atual (4 a 8 dígitos).', true);
        return;
      }
      if (customKey) {
        const keyCheck = validateRecoverySecret(customKey, pin);
        if (!keyCheck.valid) {
          this.showConnectFeedback(keyCheck.error || 'Chave pessoal inválida.', true);
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
        rotHintEl.textContent = 'Chave de recuperação atualizada! Já pode usá-la no modo anónimo ou noutro aparelho.';
        this.showConnectFeedback('Chave de recuperação atualizada.');
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
    this.connectEmailStatusEl.textContent =
      'Opcional — apenas para efeitos de recuperação de conta (guarde este e-mail).';

    const emailForm = document.createElement('form');
    emailForm.className = 'ttm-form';

    this.connectEmailInput = document.createElement('input');
    this.connectEmailInput.type = 'email';
    this.connectEmailInput.maxLength = 120;
    this.connectEmailInput.autocomplete = 'email';
    this.connectEmailInput.inputMode = 'email';
    this.connectEmailInput.placeholder = 'E-mail de recuperação (opcional)';
    this.connectEmailInput.className = 'ttm-connect-input ttm-connect-input-phone';

    const emailPinInput = document.createElement('input');
    emailPinInput.type = 'password';
    emailPinInput.inputMode = 'numeric';
    emailPinInput.maxLength = 8;
    emailPinInput.autocomplete = 'off';
    emailPinInput.placeholder = 'Confirme seu PIN atual';
    emailPinInput.className = 'ttm-connect-input ttm-connect-input-phone';

    const saveEmailBtn = document.createElement('button');
    saveEmailBtn.type = 'submit';
    saveEmailBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    saveEmailBtn.textContent = '[associar e-mail]';

    emailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawEmail = this.connectEmailInput.value.trim();
      const pin = emailPinInput.value.trim();
      const check = validateOptionalRecoveryEmail(rawEmail);
      if (!check.valid || !check.email) {
        this.showConnectFeedback(check.error || 'Informe um endereço de e-mail válido.', true);
        return;
      }
      if (!/^\d{4,8}$/.test(pin)) {
        this.showConnectFeedback('Digite seu PIN atual (4 a 8 dígitos).', true);
        return;
      }
      if (!this.events.onAssociateRecoveryEmail) return;
      saveEmailBtn.disabled = true;
      try {
        const res = await this.events.onAssociateRecoveryEmail(pin, check.email);
        emailPinInput.value = '';
        if (res.status === 'already_active') {
          this.connectEmailStatusEl.textContent = `E-mail ativo: ${res.email}`;
          this.showConnectFeedback('Este e-mail já está ativo para recuperação.');
        } else {
          this.connectEmailStatusEl.textContent =
            `Confirmação enviada para ${res.email}. Abra o link no seu e-mail para ativar.`;
          this.showConnectFeedback(`Link de confirmação enviado para ${res.email}.`);
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
    curPinInp.placeholder = 'PIN atual';
    curPinInp.className = 'ttm-connect-input ttm-connect-input-phone';
    const nextPinInp = document.createElement('input');
    nextPinInp.type = 'password';
    nextPinInp.inputMode = 'numeric';
    nextPinInp.maxLength = 8;
    nextPinInp.autocomplete = 'off';
    nextPinInp.placeholder = 'Novo PIN (4 a 8 dígitos)';
    nextPinInp.className = 'ttm-connect-input ttm-connect-input-phone';
    const nextPinConfInp = document.createElement('input');
    nextPinConfInp.type = 'password';
    nextPinConfInp.inputMode = 'numeric';
    nextPinConfInp.maxLength = 8;
    nextPinConfInp.autocomplete = 'off';
    nextPinConfInp.placeholder = 'Confirmar novo PIN';
    nextPinConfInp.className = 'ttm-connect-input ttm-connect-input-phone';
    const savePinBtn = document.createElement('button');
    savePinBtn.type = 'submit';
    savePinBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
    savePinBtn.textContent = '[salvar novo PIN]';

    pinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cur = curPinInp.value.trim();
      const next = nextPinInp.value.trim();
      const conf = nextPinConfInp.value.trim();
      if (!/^\d{4,8}$/.test(cur) || !/^\d{4,8}$/.test(next)) {
        this.showConnectFeedback('Os PINs devem ter entre 4 e 8 dígitos numéricos.', true);
        return;
      }
      if (next !== conf) {
        this.showConnectFeedback('O novo PIN e a confirmação não coincidem.', true);
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
        this.showConnectFeedback('PIN da calculadora alterado com sucesso neste aparelho.');
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

    rotateCodeBtn.addEventListener('click', () => {
      const visible = this.connectRecoveryPanelEl.style.display === 'flex';
      this.connectRecoveryPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectEmailPanelEl.style.display = 'none';
      this.connectPinPanelEl.style.display = 'none';
      rotResultEl.style.display = 'none';
      rotCopyBtn.style.display = 'none';
    });

    recoveryEmailBtn.addEventListener('click', () => {
      const visible = this.connectEmailPanelEl.style.display === 'flex';
      this.connectEmailPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectRecoveryPanelEl.style.display = 'none';
      this.connectPinPanelEl.style.display = 'none';
    });

    changePinBtn.addEventListener('click', () => {
      const visible = this.connectPinPanelEl.style.display === 'flex';
      this.connectPinPanelEl.style.display = visible ? 'none' : 'flex';
      this.connectRecoveryPanelEl.style.display = 'none';
      this.connectEmailPanelEl.style.display = 'none';
    });

    selfCard.appendChild(selfTitle);
    selfCard.appendChild(selfRow);
    selfCard.appendChild(this.connectRecoveryPanelEl);
    selfCard.appendChild(this.connectEmailPanelEl);
    selfCard.appendChild(this.connectPinPanelEl);

    // Cartão 2: Procurar contacto por telefone exato e convidar
    const inviteCard = document.createElement('div');
    inviteCard.className = 'ttm-connect-card';

    const inviteTitle = document.createElement('div');
    inviteTitle.className = 'ttm-connect-section-title';
    inviteTitle.textContent = 'Convidar por número de telefone';

    const inviteForm = document.createElement('form');
    inviteForm.className = 'ttm-connect-form';

    this.connectTargetInput = document.createElement('input');
    this.connectTargetInput.type = 'tel';
    this.connectTargetInput.inputMode = 'tel';
    this.connectTargetInput.className = 'ttm-connect-input ttm-connect-input-phone';
    this.connectTargetInput.placeholder = '+244 9XX XXX XXX ou 9XXXXXXXX';
    this.connectTargetInput.maxLength = 24;
    this.connectTargetInput.autocomplete = 'tel';

    this.connectTargetPreviewEl = document.createElement('div');
    this.connectTargetPreviewEl.className = 'ttm-field-hint';
    this.connectTargetPreviewEl.textContent = 'Pesquisa exata por número declarado.';

    this.connectTargetInput.addEventListener('input', () => {
      const raw = this.connectTargetInput.value.trim();
      if (!raw) {
        this.connectTargetPreviewEl.textContent = 'Pesquisa exata por número declarado.';
        this.connectTargetPreviewEl.classList.remove('is-valid', 'is-invalid');
        return;
      }
      const res = normalizePhoneNumber(raw);
      if (res.valid && res.e164) {
        this.connectTargetPreviewEl.textContent = `Procurar: ${res.e164}`;
        this.connectTargetPreviewEl.classList.add('is-valid');
        this.connectTargetPreviewEl.classList.remove('is-invalid');
      } else {
        this.connectTargetPreviewEl.textContent = res.error || 'Número inválido.';
        this.connectTargetPreviewEl.classList.add('is-invalid');
        this.connectTargetPreviewEl.classList.remove('is-valid');
      }
    });

    this.connectInviteBtn = document.createElement('button');
    this.connectInviteBtn.type = 'submit';
    this.connectInviteBtn.className = 'ttm-btn ttm-btn-primary';
    this.connectInviteBtn.textContent = '[convidar]';

    this.connectFeedbackEl = document.createElement('div');
    this.connectFeedbackEl.className = 'ttm-connect-feedback';

    inviteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const targetPhone = this.connectTargetInput.value.trim();
      if (!targetPhone) {
        this.showConnectFeedback('Informe o número de telefone do contacto.', true);
        return;
      }
      if (!this.events.onSendInvite) return;
      this.connectInviteBtn.disabled = true;
      this.connectInviteBtn.textContent = '[enviando...]';
      this.showConnectFeedback('');
      try {
        await this.events.onSendInvite(targetPhone);
        this.connectTargetInput.value = '';
        this.connectTargetPreviewEl.textContent = 'Pesquisa exata por número declarado.';
        this.connectTargetPreviewEl.classList.remove('is-valid', 'is-invalid');
      } catch (err: any) {
        this.showConnectFeedback(this.extractReadableError(err), true);
      } finally {
        this.connectInviteBtn.disabled = false;
        this.connectInviteBtn.textContent = '[convidar]';
      }
    });

    inviteForm.appendChild(this.connectTargetInput);
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
    incomingTitle.textContent = 'Convites recebidos';
    this.incomingInvitesListEl = document.createElement('div');
    this.incomingInvitesListEl.className = 'ttm-connect-list';
    incomingCard.appendChild(incomingTitle);
    incomingCard.appendChild(this.incomingInvitesListEl);

    // Cartão 4: Convites Enviados
    const outgoingCard = document.createElement('div');
    outgoingCard.className = 'ttm-connect-card';
    const outgoingTitle = document.createElement('div');
    outgoingTitle.className = 'ttm-connect-section-title';
    outgoingTitle.textContent = 'Convites enviados';
    this.outgoingInvitesListEl = document.createElement('div');
    this.outgoingInvitesListEl.className = 'ttm-connect-list';
    outgoingCard.appendChild(outgoingTitle);
    outgoingCard.appendChild(this.outgoingInvitesListEl);

    // Cartão 5: Conversas Bilaterais Ativas
    const convCard = document.createElement('div');
    convCard.className = 'ttm-connect-card';
    const convTitle = document.createElement('div');
    convTitle.className = 'ttm-connect-section-title';
    convTitle.textContent = 'Conversas';
    this.conversationsListEl = document.createElement('div');
    this.conversationsListEl.className = 'ttm-connect-list';
    convCard.appendChild(convTitle);
    convCard.appendChild(this.conversationsListEl);

    this.connectViewEl.appendChild(selfCard);
    this.connectViewEl.appendChild(inviteCard);
    this.connectViewEl.appendChild(incomingCard);
    this.connectViewEl.appendChild(outgoingCard);
    this.connectViewEl.appendChild(convCard);
  }

  private extractReadableError(err: unknown): string {
    let msg = err instanceof Error ? err.message : String(err || 'Erro inesperado.');
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed.error === 'string') {
        msg = parsed.error;
      }
    } catch {
      // mantém texto original
    }
    if (msg.includes('Missing or insufficient permissions')) {
      return 'Permissão negada ao processar operação no Firestore.';
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

    // Topbar interna do chat
    const topBar = document.createElement('div');
    topBar.className = 'ttm-topbar';

    this.loadOlderBtn = document.createElement('button');
    this.loadOlderBtn.className = 'ttm-btn ttm-btn-secondary';
    this.loadOlderBtn.textContent = '[anteriores]';
    this.loadOlderBtn.style.display = 'none';
    this.loadOlderBtn.addEventListener('click', () => {
      this.events.onLoadOlder();
    });

    this.selectModeBtn = document.createElement('button');
    this.selectModeBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-sel-top';
    this.selectModeBtn.textContent = '[selecionar tudo]';
    this.selectModeBtn.title = 'Selecionar todas as mensagens da conversa';
    this.selectModeBtn.addEventListener('click', () => {
      if (this.renderedMessageIds.size === 0) {
        this.showTemporaryNotice('Nenhuma mensagem na conversa.');
        return;
      }
      if (this.isSelectionMode) {
        this.exitSelectionMode();
      } else {
        this.selectAllMessages();
      }
    });

    this.inactivityNoticeEl = document.createElement('span');
    this.inactivityNoticeEl.className = 'ttm-lock-badge';
    this.updateInactivityBadge();

    topBar.appendChild(this.loadOlderBtn);
    topBar.appendChild(this.selectModeBtn);
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
    this.msgInputEl.placeholder = 'Mensagem de texto puro...';
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
    sendBtn.textContent = '[enviar]';

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
    this.selectAllBtnEl.textContent = '[selecionar tudo]';
    this.selectAllBtnEl.title = 'Alternar seleção de todas as mensagens';
    this.selectAllBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSelectAll();
    });

    this.cancelSelectionBtnEl = document.createElement('button');
    this.cancelSelectionBtnEl.type = 'button';
    this.cancelSelectionBtnEl.className = 'ttm-btn ttm-btn-sel-cancel';
    this.cancelSelectionBtnEl.textContent = '[cancelar]';
    this.cancelSelectionBtnEl.title = 'Cancelar modo de seleção';
    this.cancelSelectionBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exitSelectionMode();
    });

    selectionLeft.appendChild(this.selectAllBtnEl);
    selectionLeft.appendChild(this.cancelSelectionBtnEl);

    this.deleteBtnEl = document.createElement('button');
    this.deleteBtnEl.type = 'button';
    this.deleteBtnEl.className = 'ttm-btn ttm-btn-compact-del';
    this.deleteBtnEl.textContent = 'Apagar';
    this.deleteBtnEl.title = 'Toque para confirmar a exclusão deste dispositivo';
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
    modalTitle.textContent = 'Definições Mínimas';

    // Configuração 1: Tempo de Sessão
    const sessionGroup = document.createElement('div');
    sessionGroup.className = 'ttm-setting-group';

    const sessionLabel = document.createElement('label');
    sessionLabel.className = 'ttm-setting-label';
    sessionLabel.textContent = 'Tempo de Sessão (desconecta ao expirar):';

    this.sessionSelectEl = document.createElement('select');
    this.sessionSelectEl.className = 'ttm-select';

    const sessionOptions = [
      { val: 1, label: '1 minuto' },
      { val: 5, label: '5 minutos (padrão)' },
      { val: 15, label: '15 minutos' },
      { val: 30, label: '30 minutos' },
      { val: 60, label: '60 minutos' },
      { val: 0, label: 'Desativado' },
    ];

    sessionOptions.forEach((opt) => {
      const option = document.createElement('option');
      option.value = String(opt.val);
      option.textContent = opt.label;
      if (opt.val === this.settings.sessionTimeoutMinutes) {
        option.selected = true;
      }
      this.sessionSelectEl.appendChild(option);
    });

    sessionGroup.appendChild(sessionLabel);
    sessionGroup.appendChild(this.sessionSelectEl);

    // Configuração 2: Bloqueio por Inatividade (5 minutos sem teclar padrão)
    const inactivityGroup = document.createElement('div');
    inactivityGroup.className = 'ttm-setting-group';

    const inactivityLabel = document.createElement('label');
    inactivityLabel.className = 'ttm-setting-label';
    inactivityLabel.textContent = 'Sem teclar (bloqueia na calculadora):';

    this.inactivitySelectEl = document.createElement('select');
    this.inactivitySelectEl.className = 'ttm-select';

    const inactivityOptions = [
      { val: 5, label: '5 segundos' },
      { val: 10, label: '10 segundos' },
      { val: 15, label: '15 segundos' },
      { val: 30, label: '30 segundos' },
      { val: 60, label: '1 minuto' },
      { val: 120, label: '2 minutos' },
      { val: 300, label: '5 minutos (padrão)' },
      { val: 600, label: '10 minutos' },
      { val: 900, label: '15 minutos' },
      { val: 0, label: 'Desativado' },
    ];

    inactivityOptions.forEach((opt) => {
      const option = document.createElement('option');
      option.value = String(opt.val);
      option.textContent = opt.label;
      if (opt.val === this.settings.inactivityLockSeconds) {
        option.selected = true;
      }
      this.inactivitySelectEl.appendChild(option);
    });

    inactivityGroup.appendChild(inactivityLabel);
    inactivityGroup.appendChild(this.inactivitySelectEl);

    // Botões de Ação do Modal
    const modalActions = document.createElement('div');
    modalActions.className = 'ttm-modal-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ttm-btn ttm-btn-primary';
    saveBtn.textContent = '[salvar definições]';
    saveBtn.addEventListener('click', () => {
      this.settings = {
        sessionTimeoutMinutes: Number(this.sessionSelectEl.value),
        inactivityLockSeconds: Number(this.inactivitySelectEl.value),
        version: 2,
      };
      this.events.onUpdateSettings(this.settings);
      this.updateInactivityBadge();
      this.closeSettingsModal();
      this.showTemporaryNotice('Definições atualizadas.');
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ttm-btn ttm-btn-secondary';
    cancelBtn.textContent = '[fechar]';
    cancelBtn.addEventListener('click', () => {
      this.closeSettingsModal();
    });

    modalActions.appendChild(saveBtn);
    modalActions.appendChild(cancelBtn);

    modalBox.appendChild(modalTitle);
    modalBox.appendChild(sessionGroup);
    modalBox.appendChild(inactivityGroup);
    modalBox.appendChild(modalActions);
    this.settingsModalEl.appendChild(modalBox);
  }

  public openSettingsModal(): void {
    this.sessionSelectEl.value = String(this.settings.sessionTimeoutMinutes);
    this.inactivitySelectEl.value = String(this.settings.inactivityLockSeconds);
    this.settingsModalEl.style.display = 'flex';
  }

  public closeSettingsModal(): void {
    this.settingsModalEl.style.display = 'none';
  }

  private updateInactivityBadge(): void {
    if (this.settings.inactivityLockSeconds > 0) {
      const label = this.settings.inactivityLockSeconds >= 60
        ? `${Math.round(this.settings.inactivityLockSeconds / 60)}m`
        : `${this.settings.inactivityLockSeconds}s`;
      this.inactivityNoticeEl.textContent = `[auto-lock: ${label}]`;
      this.inactivityNoticeEl.style.display = 'inline-block';
    } else {
      this.inactivityNoticeEl.textContent = '';
      this.inactivityNoticeEl.style.display = 'none';
    }
  }

  private setupAntiMediaGuards(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.showTemporaryNotice('Talk2TM aceita apenas texto puro. Arquivos rejeitados.');
    });

    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' || items[i].type.startsWith('image/')) {
          e.preventDefault();
          this.showTemporaryNotice('Imagens rejeitadas. Apenas texto puro.');
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

  public hideAllPrimaryViews(): void {
    this.exitSelectionMode();
    this.closeSettingsModal();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
  }

  public showCalculatorView(): void {
    this.hideAllPrimaryViews();
    this.calculator.show();
  }

  public showPassEntryView(): void {
    this.closeSettingsModal();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.passViewEl.style.display = 'flex';
    const hasSavedVault = getAllLocalIdentities().length > 0;
    this.passSubtitleEl.textContent = hasSavedVault
      ? 'Digite seu PIN numérico (4 a 8 dígitos) na calculadora ou abaixo:'
      : 'Modo anónimo ou aparelho novo? Para entrar numa conta já criada, toque em [entrar noutro aparelho / recuperar].';
    this.singlePassInput.value = '';
    this.singlePassInput.type = 'password';
    this.passErrorEl.textContent = '';
    setTimeout(() => {
      this.singlePassInput.focus();
    }, 100);
  }

  public showOnboardingView(): void {
    this.closeSettingsModal();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'flex';
    this.onboardingFormEl.style.display = 'flex';
    this.recoveryStepBoxEl.style.display = 'none';
    this.pendingOnboardingDraft = null;
    this.onboardingNameInput.value = '';
    this.onboardingPhoneInput.value = '';
    this.onboardingPinInput.value = '';
    this.onboardingPinConfirmInput.value = '';
    this.onboardingPinInput.type = 'password';
    this.onboardingPinConfirmInput.type = 'password';
    this.onboardingErrorEl.textContent = '';
    this.onboardingSecretInput.value = '';
    this.onboardingSecretInput.type = 'password';
    this.onboardingSecretConfirmInput.value = '';
    this.onboardingSecretConfirmInput.type = 'password';
    this.onboardingPmUsernameInput.value = '';
    this.onboardingEmailInput.value = '';
    this.onboardingEmailHintEl.textContent =
      'Opcional — apenas para efeitos de recuperação de conta (guarde este e-mail).';
    this.onboardingEmailHintEl.classList.remove('is-valid', 'is-invalid');
    this.onboardingSecretHintEl.textContent =
      'Regras: mínimo 6 caracteres, diferente do PIN da calculadora (maiúsculas e espaços são ignorados).';
    this.onboardingSecretHintEl.classList.remove('is-valid', 'is-invalid');
    this.onboardingStep2ErrorEl.textContent = '';
    this.recoveryStepCodeEl.textContent = '';
    this.recoveryStepCodeEl.style.display = 'none';
    this.onboardingCopyCodeBtn.style.display = 'none';
    this.updatePhonePreview('', this.onboardingPhonePreviewEl);
    this.onboardingSubmitBtn.disabled = false;
    this.onboardingSubmitBtn.textContent = '[continuar]';
    this.onboardingStep2SubmitBtn.disabled = false;
    this.onboardingStep2SubmitBtn.textContent = '[criar conta e entrar]';
    setTimeout(() => {
      this.onboardingNameInput.focus();
    }, 100);
  }

  public showRecoveryView(): void {
    this.closeSettingsModal();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'flex';
    this.recoveryMainFormEl.style.display = 'flex';
    this.recoveryResetBoxEl.style.display = 'none';
    this.recoveryOobBoxEl.style.display = 'none';
    this.activeOobCode = null;
    this.recoveryPhoneInput.value = '';
    this.recoveryEmailInput.value = '';
    this.recoveryCodeInput.value = '';
    this.recoveryCodeInput.type = 'password';
    this.recoveryPinInput.value = '';
    this.recoveryPinConfirmInput.value = '';
    this.recoveryPinInput.type = 'password';
    this.recoveryPinConfirmInput.type = 'password';
    this.recoveryErrorEl.textContent = '';
    this.recoveryPhonePreviewEl.textContent = 'Use o mesmo número declarado no cadastro.';
    this.recoveryPhonePreviewEl.classList.remove('is-valid', 'is-invalid');
    this.recoverySubmitBtn.disabled = false;
    this.recoverySubmitBtn.textContent = '[entrar na conta]';
    setTimeout(() => {
      this.recoveryPhoneInput.focus();
    }, 100);
  }

  public showInAppPasswordResetView(oobCode: string, email: string): void {
    this.showRecoveryView();
    this.activeOobCode = oobCode;
    this.recoveryMainFormEl.style.display = 'none';
    this.recoveryResetBoxEl.style.display = 'none';
    this.recoveryOobBoxEl.style.display = 'flex';
    this.recoveryOobEmailLabelEl.textContent =
      `Conta: ${email}. Defina a sua nova Chave Pessoal e o PIN da calculadora neste aparelho.`;
    this.recoveryOobSecretInput.value = '';
    this.recoveryOobSecretInput.type = 'password';
    this.recoveryOobSecretConfirmInput.value = '';
    this.recoveryOobSecretConfirmInput.type = 'password';
    this.recoveryOobPinInput.value = '';
    this.recoveryOobPinConfirmInput.value = '';
    this.recoveryOobErrorEl.textContent = '';
    setTimeout(() => {
      this.recoveryOobSecretInput.focus();
    }, 100);
  }

  public showConnectView(session: UserSession): void {
    this.currentSession = session;
    this.exitSelectionMode();
    this.closeSettingsModal();
    this.calculator.hide();
    this.passViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.headerEl.style.display = 'flex';
    this.connectViewEl.style.display = 'flex';
    this.connectRecoveryPanelEl.style.display = 'none';
    this.connectEmailPanelEl.style.display = 'none';
    this.connectPinPanelEl.style.display = 'none';
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-block' : 'none';
    this.connectSelfNameEl.textContent = session.displayName || 'Minha conta';
    this.connectSelfPhoneEl.textContent = session.phoneMasked
      ? `${session.phoneMasked} · descoberta ativa`
      : 'Descoberta ativa pelo número declarado';
    this.connectEmailInput.value = session.recoveryEmail || session.pendingRecoveryEmail || '';
    if (session.pendingRecoveryEmail) {
      this.connectEmailStatusEl.textContent =
        `Confirmação pendente para ${session.pendingRecoveryEmail}. Abra o link enviado ao seu e-mail para ativar.`;
    } else if (session.recoveryEmail) {
      this.connectEmailStatusEl.textContent =
        `E-mail de recuperação ativo: ${session.recoveryEmail}. Opcional — apenas para efeitos de recuperação de conta.`;
    } else {
      this.connectEmailStatusEl.textContent =
        'Opcional — apenas para efeitos de recuperação de conta (guarde este e-mail).';
    }
    this.connectFeedbackEl.textContent = '';
    this.connectFeedbackEl.classList.remove('is-error');
    this.roomInfoEl.textContent = `você: ${session.displayName} | convide por telefone ou aceite um convite`;
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
    if (!this.incomingInvitesListEl || !this.outgoingInvitesListEl || !this.conversationsListEl) return;

    // 1. Convites recebidos — formato minimalista obrigatório: «[Nome] quer conversar contigo»
    this.incomingInvitesListEl.innerHTML = '';
    if (data.incoming.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-connect-empty';
      empty.textContent = 'Nenhum convite pendente.';
      this.incomingInvitesListEl.appendChild(empty);
    } else {
      data.incoming.forEach((inv) => {
        const item = document.createElement('div');
        item.className = 'ttm-connect-item';

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        const senderName = inv.fromDisplayName || 'Contacto';
        nameEl.textContent = `${senderName} quer conversar contigo`;
        meta.appendChild(nameEl);

        const actions = document.createElement('div');
        actions.className = 'ttm-connect-item-actions';

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
        acceptBtn.textContent = '[aceitar]';
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
        declineBtn.textContent = '[recusar]';
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
      empty.textContent = 'Nenhum convite aguardando resposta.';
      this.outgoingInvitesListEl.appendChild(empty);
    } else {
      pendingOutgoing.forEach((inv) => {
        const item = document.createElement('div');
        item.className = 'ttm-connect-item';

        const meta = document.createElement('div');
        meta.className = 'ttm-connect-item-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'ttm-connect-item-name';
        nameEl.textContent = this.outgoingTargetNameCache.get(inv.inviteId) || 'Convite enviado';
        const subEl = document.createElement('div');
        subEl.className = 'ttm-connect-item-sub';
        subEl.textContent = 'Aguardando aceitação...';
        meta.appendChild(nameEl);
        meta.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'ttm-connect-item-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
        cancelBtn.textContent = '[cancelar]';
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
      empty.textContent = 'Nenhuma conversa ativa ainda.';
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
        nameEl.textContent = partnerName || 'Contacto';
        const subEl = document.createElement('div');
        subEl.className = 'ttm-connect-item-sub';
        subEl.textContent = 'Conversa privada 1:1';
        meta.appendChild(nameEl);
        meta.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'ttm-connect-item-actions';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
        openBtn.textContent = '[abrir]';
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
  }

  public hasCalculatorUnreadDot(): boolean {
    return this.calculator.hasUnreadDot();
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
    this.calculator.hide();
    this.passViewEl.style.display = 'none';
    this.onboardingViewEl.style.display = 'none';
    this.recoveryViewEl.style.display = 'none';
    this.connectViewEl.style.display = 'none';
    this.headerEl.style.display = 'flex';
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-block' : 'none';
    this.chatViewEl.style.display = 'flex';
    this.clearMessages();
    if (room) {
      this.currentRoom = room;
      this.updateRoomInfo(room, session);
      this.updateReadReceipts(room, session);
    } else if (session.talk2tmId) {
      this.roomInfoEl.textContent = `você: ${session.displayName} | conversa bilateral`;
    }
    setTimeout(() => {
      this.msgInputEl.focus();
    }, 100);
  }

  public updateConnectionState(state: ConnectionState): void {
    this.statusEl.setAttribute('data-state', state);
    this.statusEl.setAttribute('title', `Rede: ${state}`);
    this.statusEl.setAttribute('aria-label', `Rede: ${state}`);
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

  public updateRoomInfo(room: Room, session: UserSession): void {
    this.currentRoom = room;
    this.currentSession = session;
    this.connectionsBtnEl.style.display = session.talk2tmId ? 'inline-block' : 'none';

    let partnerName = '';
    if (session.conversationId) {
      if (room.participantA === session.userId) {
        partnerName = room.participantBName || '';
      } else if (room.participantB === session.userId) {
        partnerName = room.participantAName || '';
      } else {
        partnerName = room.participantAName === session.displayName
          ? (room.participantBName || '')
          : (room.participantAName || '');
      }
    } else {
      const isTruman = session.displayName === 'Truman';
      partnerName = isTruman ? 'Mãezinha' : 'Truman';
    }

    let partnerStatus = 'aguardando parceiro...';
    if (room.participantB && room.participantB !== '') {
      partnerStatus = `conectado com: ${partnerName || 'parceiro'}`;
    }

    this.roomInfoEl.textContent = `você: ${session.displayName} | ${partnerStatus}`;
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
      return { text: '·', dataStatus: 'pending', title: 'Pendente de envio' };
    }

    const partnerReadTime = this.getPartnerLastReadTime();
    if (msg.status === 'read' || (partnerReadTime && partnerReadTime >= msg.createdAt)) {
      return { text: '✓✓', dataStatus: 'read', title: 'Lida pelo parceiro' };
    }

    return { text: '✓', dataStatus: 'synced', title: 'Enviada' };
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
            statusSpan.setAttribute('title', 'Lida pelo parceiro');
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
    deleteBtn.title = 'Apagar mensagem localmente';
    deleteBtn.setAttribute('aria-label', 'Apagar mensagem');
    deleteBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      this.deleteSingleMessage(msg.messageId);
    });

    rowEl.appendChild(checkSpan);
    rowEl.appendChild(timeSpan);
    rowEl.appendChild(senderSpan);
    rowEl.appendChild(textSpan);
    if (isSelf) {
      rowEl.appendChild(statusSpan);
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
      deleteBtn.title = 'Apagar mensagem localmente';
      deleteBtn.setAttribute('aria-label', 'Apagar mensagem');
      deleteBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        this.deleteSingleMessage(msg.messageId);
      });

      rowEl.appendChild(checkSpan);
      rowEl.appendChild(timeSpan);
      rowEl.appendChild(senderSpan);
      rowEl.appendChild(textSpan);
      if (isSelf) {
        rowEl.appendChild(statusSpan);
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

    // Salva texto atual da sala no cabeçalho
    if (!this.roomInfoEl.hasAttribute('data-original-info')) {
      this.roomInfoEl.setAttribute('data-original-info', this.roomInfoEl.textContent || '');
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

    if (!this.roomInfoEl.hasAttribute('data-original-info')) {
      this.roomInfoEl.setAttribute('data-original-info', this.roomInfoEl.textContent || '');
    }

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
    const text = isAll ? `Todas selecionadas (${count})` : (count === 1 ? '1 selecionada' : `${count} selecionadas`);
    this.roomInfoEl.textContent = text;

    if (this.selectAllBtnEl) {
      this.selectAllBtnEl.textContent = isAll ? '[desmarcar tudo]' : '[selecionar tudo]';
    }

    if (this.selectModeBtn) {
      this.selectModeBtn.textContent = this.isSelectionMode ? '[sair seleção]' : '[selecionar tudo]';
    }

    if (!this.isConfirmPending) {
      this.deleteBtnEl.textContent = count > 1 ? `Apagar (${count})` : 'Apagar';
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
    this.deleteBtnEl.textContent = count > 1 ? `Apagar (${count})` : 'Apagar';
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
      this.deleteBtnEl.textContent = count > 1 ? `Confirmar (${count})?` : 'Confirmar?';

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
      this.showTemporaryNotice(count > 1 ? `${count} mensagens apagadas deste dispositivo.` : 'Mensagem apagada deste dispositivo.');
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
      this.selectModeBtn.textContent = '[selecionar tudo]';
    }

    const originalText = this.roomInfoEl.getAttribute('data-original-info');
    if (originalText !== null) {
      this.roomInfoEl.textContent = originalText;
      this.roomInfoEl.removeAttribute('data-original-info');
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
