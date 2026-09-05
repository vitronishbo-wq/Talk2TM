import { ConnectionState, Message, Room, UserSession } from '../types';
import { AppSettings, getUserByPin, AllowedUser } from '../config';
import { formatTime } from '../utils/sanitize';
import { MobileCalculator } from './calculator';

export interface UIEvents {
  onUnlockByPin: (pin: string) => void;
  onLockToCalculator: () => void;
  onSendMessage: (text: string) => void;
  onLoadOlder: () => void;
  onUpdateSettings: (settings: AppSettings) => void;
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

  // Tela Única de Senha (Sem seleção de usuário, a senha determina a conta)
  private passViewEl!: HTMLElement;
  private singlePassInput!: HTMLInputElement;
  private passErrorEl!: HTMLElement;

  // Tela de Chat
  private chatViewEl!: HTMLElement;
  private msgListEl!: HTMLElement;
  private msgInputEl!: HTMLInputElement;
  private charCountEl!: HTMLElement;
  private loadOlderBtn!: HTMLButtonElement;

  // Modal de Definições Mínimas
  private settingsModalEl!: HTMLElement;
  private sessionSelectEl!: HTMLSelectElement;
  private inactivitySelectEl!: HTMLSelectElement;
  private inactivityNoticeEl!: HTMLElement;

  private renderedMessageIds: Set<string> = new Set();

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

    // 1. Calculadora Camuflada com teclado universal
    this.calculator = new MobileCalculator(this.appWrapper, {
      onUnlock: (_user, pin) => {
        this.events.onUnlockByPin(pin);
      },
      onOpenManualEntry: () => {
        this.showPassEntryView();
      },
    });

    // 2. Cabeçalho Minimalista
    this.headerEl = document.createElement('header');
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
    this.statusEl.textContent = 'conectando...';

    // Ações do cabeçalho
    const headerActions = document.createElement('div');
    headerActions.className = 'ttm-header-actions';

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'ttm-btn ttm-btn-def';
    settingsBtn.textContent = '[⚙ def]';
    settingsBtn.title = 'Definições mínimas (tempo de sessão e inatividade)';
    settingsBtn.addEventListener('click', () => {
      this.openSettingsModal();
    });

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'ttm-btn ttm-btn-lock';
    lockBtn.textContent = '[⌕ calc]';
    lockBtn.title = 'Bloquear imediatamente e camuflar na calculadora';
    lockBtn.addEventListener('click', () => {
      this.events.onLockToCalculator();
    });

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
    this.buildChatView();
    this.buildSettingsModal();

    this.mainEl.appendChild(this.passViewEl);
    this.mainEl.appendChild(this.chatViewEl);
    this.appWrapper.appendChild(this.mainEl);
    this.appWrapper.appendChild(this.settingsModalEl);

    this.container.appendChild(this.appWrapper);

    // Inicia na calculadora por padrão
    this.showCalculatorView();
  }

  /**
   * Caixa Única de Digitação de Senha (Sem seleção de usuário)
   * Suporta teclado de mobile, laptop, numérico etc.
   */
  private buildPassEntryView(): void {
    this.passViewEl = document.createElement('div');
    this.passViewEl.id = 'ttm-pass-view';
    this.passViewEl.className = 'ttm-pass-box';
    this.passViewEl.style.display = 'none';

    const titleEl = document.createElement('h1');
    titleEl.className = 'ttm-title';
    titleEl.textContent = 'Talk2TM';

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'ttm-subtitle';
    subtitleEl.textContent = 'Digite a senha para acessar a conta:';

    const formEl = document.createElement('form');
    formEl.className = 'ttm-form';

    this.singlePassInput = document.createElement('input');
    this.singlePassInput.type = 'password';
    this.singlePassInput.id = 'ttm-single-pass';
    this.singlePassInput.className = 'ttm-input ttm-input-single';
    this.singlePassInput.placeholder = 'Senha de 6 dígitos...';
    this.singlePassInput.maxLength = 12;
    this.singlePassInput.autocomplete = 'current-password';
    this.singlePassInput.inputMode = 'numeric';
    this.singlePassInput.pattern = '[0-9]*';

    this.passErrorEl = document.createElement('div');
    this.passErrorEl.className = 'ttm-error';
    this.passErrorEl.textContent = '';

    const enterBtn = document.createElement('button');
    enterBtn.type = 'submit';
    enterBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-large';
    enterBtn.textContent = '[entrar]';

    const backToCalcBtn = document.createElement('button');
    backToCalcBtn.type = 'button';
    backToCalcBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-large';
    backToCalcBtn.textContent = '[voltar para calculadora]';
    backToCalcBtn.addEventListener('click', () => {
      this.events.onLockToCalculator();
    });

    formEl.appendChild(this.singlePassInput);
    formEl.appendChild(this.passErrorEl);
    formEl.appendChild(enterBtn);
    formEl.appendChild(backToCalcBtn);

    // Validação da senha única: determina automaticamente a conta
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this.passErrorEl.textContent = '';
      const pin = this.singlePassInput.value.trim();

      if (!pin) {
        this.passErrorEl.textContent = 'Digite a senha.';
        return;
      }

      const user = getUserByPin(pin);
      if (!user) {
        this.passErrorEl.textContent = 'Senha inválida.';
        this.singlePassInput.value = '';
        this.singlePassInput.focus();
        return;
      }

      this.events.onUnlockByPin(pin);
    });

    this.passViewEl.appendChild(titleEl);
    this.passViewEl.appendChild(subtitleEl);
    this.passViewEl.appendChild(formEl);
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

    this.inactivityNoticeEl = document.createElement('span');
    this.inactivityNoticeEl.className = 'ttm-lock-badge';
    this.updateInactivityBadge();

    topBar.appendChild(this.loadOlderBtn);
    topBar.appendChild(this.inactivityNoticeEl);
    this.chatViewEl.appendChild(topBar);

    // Mensagens
    this.msgListEl = document.createElement('div');
    this.msgListEl.id = 'ttm-msg-list';
    this.msgListEl.className = 'ttm-msg-list';
    this.chatViewEl.appendChild(this.msgListEl);

    // Formulário de envio
    const sendForm = document.createElement('form');
    sendForm.className = 'ttm-send-form';

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

    sendForm.appendChild(inputRow);
    sendForm.appendChild(this.charCountEl);

    sendForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.msgInputEl.value;
      if (!text.trim()) return;
      this.events.onSendMessage(text);
      this.msgInputEl.value = '';
      this.charCountEl.textContent = '0/2000';
      this.msgInputEl.focus();
    });

    this.chatViewEl.appendChild(sendForm);
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
      { val: 5, label: '5 minutos' },
      { val: 15, label: '15 minutos (recomendado)' },
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

    // Configuração 2: Bloqueio por Inatividade (5 segundos sem teclar)
    const inactivityGroup = document.createElement('div');
    inactivityGroup.className = 'ttm-setting-group';

    const inactivityLabel = document.createElement('label');
    inactivityLabel.className = 'ttm-setting-label';
    inactivityLabel.textContent = 'Sem teclar (bloqueia na calculadora):';

    this.inactivitySelectEl = document.createElement('select');
    this.inactivitySelectEl.className = 'ttm-select';

    const inactivityOptions = [
      { val: 5, label: '5 segundos (conforme solicitado)' },
      { val: 10, label: '10 segundos' },
      { val: 30, label: '30 segundos' },
      { val: 60, label: '60 segundos' },
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
      this.inactivityNoticeEl.textContent = `[auto-lock: ${this.settings.inactivityLockSeconds}s]`;
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

  public showCalculatorView(): void {
    this.closeSettingsModal();
    this.headerEl.style.display = 'none';
    this.passViewEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.calculator.show();
  }

  public showPassEntryView(): void {
    this.closeSettingsModal();
    this.calculator.hide();
    this.headerEl.style.display = 'none';
    this.chatViewEl.style.display = 'none';
    this.passViewEl.style.display = 'flex';
    this.singlePassInput.value = '';
    this.passErrorEl.textContent = '';
    // Auto-focus para teclado físico e mobile
    setTimeout(() => {
      this.singlePassInput.focus();
    }, 100);
  }

  public showChatView(session: UserSession, room: Room): void {
    this.closeSettingsModal();
    this.calculator.hide();
    this.passViewEl.style.display = 'none';
    this.headerEl.style.display = 'flex';
    this.chatViewEl.style.display = 'flex';
    this.updateRoomInfo(room, session);
    setTimeout(() => {
      this.msgInputEl.focus();
    }, 100);
  }

  public updateConnectionState(state: ConnectionState): void {
    this.statusEl.textContent = state;
    this.statusEl.setAttribute('data-state', state);
  }

  public updateRoomInfo(room: Room, session: UserSession): void {
    const isTruman = session.displayName === 'Truman';
    const partnerName = isTruman ? 'Mãezinha' : 'Truman';

    let partnerStatus = 'aguardando parceiro...';
    if (room.participantB && room.participantB !== '') {
      partnerStatus = `conectado com: ${partnerName}`;
    }

    this.roomInfoEl.textContent = `você: ${session.displayName} | ${partnerStatus}`;
  }

  public setHasOlderMessages(hasOlder: boolean): void {
    this.loadOlderBtn.style.display = hasOlder ? 'inline-block' : 'none';
  }

  public appendOrUpdateMessage(msg: Message, isSelf: boolean): void {
    const existingRow = document.getElementById(`ttm-msg-${msg.messageId}`);

    if (existingRow) {
      const statusSpan = existingRow.querySelector('.msg-status');
      if (statusSpan) {
        statusSpan.textContent = msg.status === 'pending' ? '· ...' : '· ok';
        statusSpan.setAttribute('data-status', msg.status || 'synced');
      }
      return;
    }

    const rowEl = document.createElement('div');
    rowEl.id = `ttm-msg-${msg.messageId}`;
    rowEl.className = 'ttm-msg-row';
    if (isSelf) {
      rowEl.classList.add('ttm-msg-self');
    }
    if (msg.sender === 'Truman') {
      rowEl.classList.add('ttm-msg-truman');
    } else if (msg.sender === 'Mãezinha') {
      rowEl.classList.add('ttm-msg-maezinha');
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = `[${formatTime(msg.createdAt)}] `;

    const senderSpan = document.createElement('span');
    senderSpan.className = 'msg-sender';
    senderSpan.textContent = `${msg.sender}: `;

    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.textContent = msg.text;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'msg-status';
    statusSpan.textContent = msg.status === 'pending' ? '· ...' : '· ok';
    statusSpan.setAttribute('data-status', msg.status || 'synced');

    rowEl.appendChild(timeSpan);
    rowEl.appendChild(senderSpan);
    rowEl.appendChild(textSpan);
    rowEl.appendChild(statusSpan);

    this.msgListEl.appendChild(rowEl);
    this.renderedMessageIds.add(msg.messageId);

    this.scrollToBottom();
  }

  public prependMessages(messages: Message[], currentUserId: string): void {
    if (messages.length === 0) return;

    const previousHeight = this.msgListEl.scrollHeight;
    const fragment = document.createDocumentFragment();

    messages.forEach((msg) => {
      if (this.renderedMessageIds.has(msg.messageId)) return;

      const isSelf = msg.senderId === currentUserId;
      const rowEl = document.createElement('div');
      rowEl.id = `ttm-msg-${msg.messageId}`;
      rowEl.className = 'ttm-msg-row';
      if (isSelf) {
        rowEl.classList.add('ttm-msg-self');
      }
      if (msg.sender === 'Truman') {
        rowEl.classList.add('ttm-msg-truman');
      } else if (msg.sender === 'Mãezinha') {
        rowEl.classList.add('ttm-msg-maezinha');
      }

      const timeSpan = document.createElement('span');
      timeSpan.className = 'msg-time';
      timeSpan.textContent = `[${formatTime(msg.createdAt)}] `;

      const senderSpan = document.createElement('span');
      senderSpan.className = 'msg-sender';
      senderSpan.textContent = `${msg.sender}: `;

      const textSpan = document.createElement('span');
      textSpan.className = 'msg-text';
      textSpan.textContent = msg.text;

      const statusSpan = document.createElement('span');
      statusSpan.className = 'msg-status';
      statusSpan.textContent = msg.status === 'pending' ? '· ...' : '· ok';

      rowEl.appendChild(timeSpan);
      rowEl.appendChild(senderSpan);
      rowEl.appendChild(textSpan);
      rowEl.appendChild(statusSpan);

      fragment.appendChild(rowEl);
      this.renderedMessageIds.add(msg.messageId);
    });

    this.msgListEl.insertBefore(fragment, this.msgListEl.firstChild);
    this.msgListEl.scrollTop = this.msgListEl.scrollHeight - previousHeight;
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
