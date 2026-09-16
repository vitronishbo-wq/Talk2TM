import { ConnectionState, Message, Room, UserSession } from '../types';
import { AppSettings, getUserByPin, AllowedUser } from '../config';
import { formatTime } from '../utils/sanitize';
import { MobileCalculator } from './calculator';
import { getPartnerLastRead } from '../firebase/firestore';
import { PWAPromptBar } from './pwa-prompt';

export interface UIEvents {
  onUnlockByPin: (pin: string) => void;
  onLockToCalculator: () => void;
  onSendMessage: (text: string) => void;
  onLoadOlder: () => void;
  onUpdateSettings: (settings: AppSettings) => void;
  onDeleteMessagesLocally?: (messageIds: string[]) => void;
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
  private sendFormEl!: HTMLFormElement;

  // Modo de Seleção e Exclusão Local Minimalista (1 a 1 + Apagar + Clicar fora para cancelar)
  private isSelectionMode: boolean = false;
  private selectedMessageIds: Set<string> = new Set();
  private selectionBarEl!: HTMLElement;
  private deleteBtnEl!: HTMLButtonElement;
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
      onOpenManualEntry: () => {
        this.showPassEntryView();
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

    // Barra Ultra-Minimalista: Apenas botão direto 'Apagar' (ou 'Confirmar?')
    this.selectionBarEl = document.createElement('div');
    this.selectionBarEl.className = 'ttm-selection-bar';
    this.selectionBarEl.style.display = 'none';

    this.deleteBtnEl = document.createElement('button');
    this.deleteBtnEl.type = 'button';
    this.deleteBtnEl.className = 'ttm-btn ttm-btn-compact-del';
    this.deleteBtnEl.textContent = 'Apagar';
    this.deleteBtnEl.title = 'Toque para confirmar a exclusão deste dispositivo';
    this.deleteBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleDeleteBtnClick();
    });

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
    this.exitSelectionMode();
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

  public isChatActive(): boolean {
    return this.chatViewEl ? this.chatViewEl.style.display === 'flex' : false;
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
    this.headerEl.style.display = 'flex';
    this.chatViewEl.style.display = 'flex';
    this.clearMessages();
    if (room) {
      this.currentRoom = room;
      this.updateRoomInfo(room, session);
      this.updateReadReceipts(room, session);
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

  public getPartnerLastReadTime(): string | null {
    if (!this.currentRoom || !this.currentSession) return null;
    return getPartnerLastRead(this.currentRoom, this.currentSession.displayName, this.currentSession.userId);
  }

  public computeMessageStatus(msg: Message, isSelf: boolean): { text: string; dataStatus: string; title: string } {
    if (!isSelf) {
      return { text: '', dataStatus: 'incoming', title: '' };
    }
    if (msg.status === 'pending') {
      return { text: '· ...', dataStatus: 'pending', title: 'Pendente de envio' };
    }

    const partnerReadTime = this.getPartnerLastReadTime();
    if (partnerReadTime && partnerReadTime >= msg.createdAt) {
      return { text: '✓✓ visto', dataStatus: 'read', title: 'Visto pelo parceiro' };
    }

    return { text: '✓', dataStatus: 'synced', title: 'Enviado' };
  }

  public updateReadReceipts(room: Room, session: UserSession): void {
    this.currentRoom = room;
    this.currentSession = session;
    const partnerReadTime = getPartnerLastRead(room, session.displayName, session.userId);
    if (!partnerReadTime) return;

    for (const [messageId, item] of this.renderedMessages.entries()) {
      if (item.isSelf && item.msg.status !== 'pending') {
        const isRead = partnerReadTime >= item.msg.createdAt;
        if (isRead) {
          item.msg.status = 'read';
          const row = document.getElementById(`ttm-msg-${messageId}`);
          if (row) {
            const statusSpan = row.querySelector('.msg-status');
            if (statusSpan) {
              statusSpan.textContent = '✓✓ visto';
              statusSpan.setAttribute('data-status', 'read');
              statusSpan.setAttribute('title', 'Visto pelo parceiro');
            }
          }
        }
      }
    }
  }

  public appendOrUpdateMessage(msg: Message, isSelf: boolean): void {
    this.renderedMessages.set(msg.messageId, { msg, isSelf });
    const statusInfo = this.computeMessageStatus(msg, isSelf);

    const existingRow = document.getElementById(`ttm-msg-${msg.messageId}`);
    if (existingRow) {
      const statusSpan = existingRow.querySelector('.msg-status');
      if (statusSpan && isSelf) {
        statusSpan.textContent = statusInfo.text;
        statusSpan.setAttribute('data-status', statusInfo.dataStatus);
        if (statusInfo.title) statusSpan.setAttribute('title', statusInfo.title);
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

    if (this.isSelectionMode && this.selectedMessageIds.has(msg.messageId)) {
      rowEl.classList.add('ttm-msg-selected');
    }

    const checkSpan = document.createElement('span');
    checkSpan.className = 'msg-check';
    checkSpan.textContent = '✓ ';

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
      this.renderedMessages.set(msg.messageId, { msg, isSelf });
      const statusInfo = this.computeMessageStatus(msg, isSelf);

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

      if (this.isSelectionMode && this.selectedMessageIds.has(msg.messageId)) {
        rowEl.classList.add('ttm-msg-selected');
      }

      const checkSpan = document.createElement('span');
      checkSpan.className = 'msg-check';
      checkSpan.textContent = '✓ ';

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
    this.msgListEl.scrollTop = this.msgListEl.scrollHeight - previousHeight;
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
    const text = count === 1 ? '1 selecionada' : `${count} selecionadas`;
    this.roomInfoEl.textContent = text;

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
