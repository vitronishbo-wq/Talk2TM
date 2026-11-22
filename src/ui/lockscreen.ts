/**
 * Talk2TM — Tela de Entrada Direta por PIN (Padrão)
 * Exibe o símbolo oficial Talk2TM + teclado numérico limpo de PIN.
 * Preserva 100% dos atalhos de legado (852456, 135790) e rota admin (*123456789*#).
 */

import { AllowedUser, getUserByPin } from '../config';
import { getAllLocalIdentities } from '../identity';
import { isAdminRouteSequence, normalizeCalculatorSequence } from './calculator';

export function getTalk2TMIconSvg(size: number = 64, className: string = 'ttm-brand-mark-svg'): string {
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" aria-hidden="true"><circle cx="256" cy="256" r="244" fill="#2563EB"/><path fill="#FFFFFF" d="M168 134h120c28.7 0 52 23.3 52 52v50c0 28.7-23.3 52-52 52h-92l-46 30c-5.2 3.4-12-0.4-12-6.6v-25.2c-12.5-8.9-20-23.4-20-39.2v-61c0-28.7 23.3-52 50-52z"/><path fill="#FFFFFF" stroke="#2563EB" stroke-width="18" stroke-linejoin="round" d="M224 224h120c28.7 0 52 23.3 52 52v50c0 15.8-7.5 30.3-20 39.2v25.2c0 6.2-6.8 10-12 6.6l-46-30h-94c-28.7 0-52-23.3-52-52v-39c0-28.7 23.3-52 52-52z"/><path fill="#2563EB" d="M256 208c2.6 25.5 18.5 41.4 44 44-25.5 2.6-41.4 18.5-44 44-2.6-25.5-18.5-41.4-44-44 25.5-2.6 41.4-18.5 44-44z"/></svg>`;
}

export interface Talk2TMLockCallbacks {
  onUnlock: (user: AllowedUser, pin: string) => void;
  onCheckCustomPin?: (displayValue: string, inputSequence: string) => Promise<boolean>;
  onOpenOnboarding: () => void;
  onOpenRecovery: () => void;
  onOpenAdminRoute?: () => void;
}

export class Talk2TMLockScreen {
  private container: HTMLElement;
  private callbacks: Talk2TMLockCallbacks;

  private sequence: string = '';
  private checkSeq: number = 0;
  private isVisible: boolean = false;
  private hasUnreadDotState: boolean = false;

  private rootEl!: HTMLElement;
  private logoWrapEl!: HTMLElement;
  private unreadDotEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private pinDotsEl!: HTMLElement;
  private backspaceBtnEl!: HTMLButtonElement;
  private feedbackEl!: HTMLElement;
  private feedbackTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, callbacks: Talk2TMLockCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.buildDOM();
    this.setupKeyboard();
  }

  private buildDOM(): void {
    this.rootEl = document.createElement('div');
    this.rootEl.id = 'ttm-lock-screen';
    this.rootEl.className = 'ttm-lock-shell';
    this.rootEl.style.display = 'none';

    // Cabeçalho visual com símbolo oficial Talk2TM
    const heroEl = document.createElement('div');
    heroEl.className = 'ttm-lock-hero';

    this.logoWrapEl = document.createElement('div');
    this.logoWrapEl.className = 'ttm-lock-logo-wrap';
    this.logoWrapEl.innerHTML = getTalk2TMIconSvg(64, 'ttm-lock-logo');

    this.unreadDotEl = document.createElement('span');
    this.unreadDotEl.className = 'ttm-lock-unread-dot';
    this.unreadDotEl.setAttribute('aria-label', 'Nova mensagem');
    this.unreadDotEl.title = 'Nova mensagem';
    this.logoWrapEl.appendChild(this.unreadDotEl);

    const titleEl = document.createElement('h1');
    titleEl.className = 'ttm-lock-title';
    titleEl.textContent = 'Talk2TM';

    this.subtitleEl = document.createElement('p');
    this.subtitleEl.className = 'ttm-lock-subtitle';
    this.subtitleEl.textContent = 'Digite o seu PIN de acesso';

    heroEl.appendChild(this.logoWrapEl);
    heroEl.appendChild(titleEl);
    heroEl.appendChild(this.subtitleEl);

    // Visor limpo do PIN
    const pinBarEl = document.createElement('div');
    pinBarEl.className = 'ttm-pin-visor';

    this.pinDotsEl = document.createElement('div');
    this.pinDotsEl.className = 'ttm-pin-dots';
    this.pinDotsEl.setAttribute('aria-live', 'polite');

    this.backspaceBtnEl = document.createElement('button');
    this.backspaceBtnEl.type = 'button';
    this.backspaceBtnEl.className = 'ttm-pin-backspace';
    this.backspaceBtnEl.textContent = '⌫';
    this.backspaceBtnEl.title = 'Apagar último dígito';
    this.backspaceBtnEl.setAttribute('aria-label', 'Apagar último dígito');
    this.backspaceBtnEl.disabled = true;
    this.backspaceBtnEl.addEventListener('click', (e) => {
      e.preventDefault();
      this.backspace();
    });

    pinBarEl.appendChild(this.pinDotsEl);
    pinBarEl.appendChild(this.backspaceBtnEl);

    this.feedbackEl = document.createElement('div');
    this.feedbackEl.className = 'ttm-lock-feedback';
    this.feedbackEl.setAttribute('role', 'status');
    this.feedbackEl.textContent = '';

    // Teclado numérico 3x4 limpo (suporta PINs numéricos e sequência *123456789*#)
    const keypad = document.createElement('div');
    keypad.className = 'ttm-pin-keypad';

    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    keys.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        key === '*' || key === '#' ? 'ttm-pin-key ttm-pin-key-sym' : 'ttm-pin-key';
      btn.textContent = key;
      btn.setAttribute('aria-label', key === '*' ? 'Asterisco' : key === '#' ? 'Cardinal' : key);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.inputToken(key);
      });
      keypad.appendChild(btn);
    });

    // Ações secundárias discretas (Criar conta · Recuperar acesso)
    const footerActions = document.createElement('div');
    footerActions.className = 'ttm-lock-footer';

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'ttm-lock-link';
    createBtn.textContent = 'Criar conta';
    createBtn.addEventListener('click', () => {
      this.callbacks.onOpenOnboarding();
    });

    const sep = document.createElement('span');
    sep.className = 'ttm-lock-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';

    const recoverBtn = document.createElement('button');
    recoverBtn.type = 'button';
    recoverBtn.className = 'ttm-lock-link';
    recoverBtn.textContent = 'Recuperar acesso';
    recoverBtn.addEventListener('click', () => {
      this.callbacks.onOpenRecovery();
    });

    footerActions.appendChild(createBtn);
    footerActions.appendChild(sep);
    footerActions.appendChild(recoverBtn);

    this.rootEl.appendChild(heroEl);
    this.rootEl.appendChild(pinBarEl);
    this.rootEl.appendChild(this.feedbackEl);
    this.rootEl.appendChild(keypad);
    this.rootEl.appendChild(footerActions);

    this.container.appendChild(this.rootEl);
    this.renderPinVisor();
  }

  private setupKeyboard(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this.isVisible) return;
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;

      const key = e.key;
      if (key >= '0' && key <= '9') {
        this.inputToken(key);
      } else if (key === '*' || key === 'x' || key === 'X') {
        this.inputToken('*');
      } else if (key === '#') {
        e.preventDefault();
        this.inputToken('#');
      } else if (key === 'Backspace') {
        this.backspace();
      } else if (key === 'Escape' || key.toLowerCase() === 'c') {
        this.clear();
      } else if (key === 'Enter' || key === '=') {
        e.preventDefault();
        void this.verifyManualSubmit();
      }
    });
  }

  public inputToken(rawToken: string): void {
    const clean = normalizeCalculatorSequence(rawToken);
    if (!clean) return;

    this.clearFeedback();
    this.sequence += clean;
    if (this.sequence.length > 32) {
      this.sequence = this.sequence.slice(-24);
    }
    this.renderPinVisor();

    if (isAdminRouteSequence(this.sequence)) {
      this.clear();
      this.callbacks.onOpenAdminRoute?.();
      return;
    }

    if (this.checkLegacyUnlock()) {
      return;
    }

    void this.checkVaultUnlock(false);
  }

  private checkLegacyUnlock(): boolean {
    const exactUser = getUserByPin(this.sequence);
    if (exactUser) {
      const matched = this.sequence;
      this.clear();
      this.callbacks.onUnlock(exactUser, matched);
      return true;
    }
    if (this.sequence.endsWith('852456')) {
      this.clear();
      this.callbacks.onUnlock('Truman', '852456');
      return true;
    }
    if (this.sequence.endsWith('135790')) {
      this.clear();
      this.callbacks.onUnlock('Mãezinha', '135790');
      return true;
    }
    return false;
  }

  private async checkVaultUnlock(showErrorOnMiss: boolean): Promise<boolean> {
    if (!this.callbacks.onCheckCustomPin || !this.isVisible) return false;
    const seqId = ++this.checkSeq;
    const snap = this.sequence;
    try {
      const unlocked = await this.callbacks.onCheckCustomPin(snap, snap);
      if (unlocked && seqId === this.checkSeq) {
        this.clear();
        return true;
      }
      if (showErrorOnMiss && seqId === this.checkSeq && snap.length > 0) {
        const hasAccounts = getAllLocalIdentities().length > 0;
        this.showError(
          hasAccounts
            ? 'PIN incorreto neste aparelho.'
            : 'Sem conta neste aparelho — toque em Criar conta ou Recuperar.'
        );
      }
    } catch {
      // Silencioso
    }
    return false;
  }

  private async verifyManualSubmit(): Promise<void> {
    if (isAdminRouteSequence(this.sequence)) {
      this.clear();
      this.callbacks.onOpenAdminRoute?.();
      return;
    }
    if (this.checkLegacyUnlock()) {
      return;
    }
    if (!this.sequence) {
      this.showError('Digite o seu PIN de acesso.');
      return;
    }
    await this.checkVaultUnlock(true);
  }

  public backspace(): void {
    if (this.sequence.length > 0) {
      this.sequence = this.sequence.slice(0, -1);
      this.clearFeedback();
      this.renderPinVisor();
    }
  }

  public clear(): void {
    this.sequence = '';
    this.clearFeedback();
    this.renderPinVisor();
  }

  private renderPinVisor(): void {
    if (!this.pinDotsEl) return;
    this.backspaceBtnEl.disabled = this.sequence.length === 0;
    this.pinDotsEl.innerHTML = '';

    if (this.sequence.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'ttm-pin-placeholder';
      placeholder.textContent = '• • • •';
      this.pinDotsEl.appendChild(placeholder);
      return;
    }

    const visibleCount = Math.min(this.sequence.length, 14);
    for (let i = 0; i < visibleCount; i++) {
      const dot = document.createElement('span');
      dot.className = 'ttm-pin-dot is-filled';
      dot.setAttribute('aria-hidden', 'true');
      this.pinDotsEl.appendChild(dot);
    }
  }

  private showError(msg: string): void {
    if (!this.feedbackEl) return;
    this.feedbackEl.textContent = msg;
    if (this.feedbackTimerId) {
      clearTimeout(this.feedbackTimerId);
    }
    this.feedbackTimerId = setTimeout(() => {
      this.feedbackEl.textContent = '';
      this.feedbackTimerId = null;
    }, 3200);
  }

  private clearFeedback(): void {
    if (this.feedbackTimerId) {
      clearTimeout(this.feedbackTimerId);
      this.feedbackTimerId = null;
    }
    if (this.feedbackEl) {
      this.feedbackEl.textContent = '';
    }
  }

  public setUnreadDot(active: boolean): void {
    this.hasUnreadDotState = active;
    if (!this.logoWrapEl) return;
    if (active) {
      this.logoWrapEl.classList.add('is-unread');
    } else {
      this.logoWrapEl.classList.remove('is-unread');
    }
  }

  public hasUnreadDot(): boolean {
    return this.hasUnreadDotState;
  }

  public show(): void {
    this.clear();
    const hasVault = getAllLocalIdentities().length > 0;
    this.subtitleEl.textContent = hasVault
      ? 'Digite o seu PIN de acesso'
      : 'Digite o PIN ou crie uma conta';
    this.isVisible = true;
    this.rootEl.style.display = 'flex';
  }

  public hide(): void {
    this.isVisible = false;
    this.rootEl.style.display = 'none';
  }
}
