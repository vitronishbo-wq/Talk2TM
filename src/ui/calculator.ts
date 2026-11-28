/**
 * Talk2TM — Calculadora Camuflada com Suporte Universal a Teclado
 * Suporta toque no mobile, teclado físico de laptop, teclado numérico de laptop, etc.
 * Senhas:
 *   Truman: 852456
 *   Mãezinha: 135790
 */

import { getUserByPin, AllowedUser } from '../config';
import { t } from '../i18n';

const DEFAULT_ADMIN_ROUTE_TRIGGER = '*123456789*#';

function getConfiguredAdminRouteTrigger(): string {
  const envTrigger =
    typeof import.meta !== 'undefined' && import.meta?.env
      ? (import.meta.env as Record<string, string | undefined>).VITE_ADMIN_ROUTE_TRIGGER
      : undefined;
  const candidate = (envTrigger || DEFAULT_ADMIN_ROUTE_TRIGGER).trim();
  return candidate.length >= 10 ? normalizeCalculatorSequence(candidate) : DEFAULT_ADMIN_ROUTE_TRIGGER;
}

/**
 * Normaliza símbolos equivalentes entre teclado físico, visor/toque da calculadora e modo DEG
 * (× / ∗ / ＊ -> *, ÷ -> /, = / ＃ -> #).
 */
export function normalizeCalculatorSequence(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/[×∗＊]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[＃=]/g, '#')
    .replace(/\s+/g, '');
}

/**
 * Atalho silencioso de roteamento de interface (NÃO é mecanismo de autenticação ou segurança).
 * Apenas abre a tela oculta de login Firebase Auth para contas administrativas.
 */
export function isAdminRouteSequence(raw: string): boolean {
  const normalized = normalizeCalculatorSequence(raw);
  const trigger = getConfiguredAdminRouteTrigger();
  return normalized.length >= 10 && normalized.endsWith(trigger);
}

export interface CalculatorCallbacks {
  onUnlock: (user: AllowedUser, pin: string) => void;
  onCheckCustomPin?: (displayValue: string, inputSequence: string) => Promise<boolean>;
  onOpenManualEntry?: () => void;
  onOpenAdminRoute?: () => void;
}

export class MobileCalculator {
  private container: HTMLElement;
  private callbacks: CalculatorCallbacks;

  private displayValue: string = '0';
  private expressionValue: string = '';
  private operator: string | null = null;
  private operand: number | null = null;
  private waitingForOperand: boolean = false;
  private inputSequence: string = '';
  private customPinCheckSeq: number = 0;

  private displayEl!: HTMLElement;
  private expressionEl!: HTMLElement;
  private rootEl!: HTMLElement;
  private topLabelEl!: HTMLElement;
  private manualBtnEl!: HTMLButtonElement;
  private hasUnreadDotState: boolean = false;
  private isVisible: boolean = true;

  constructor(container: HTMLElement, callbacks: CalculatorCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.buildDOM();
    this.setupUniversalKeyboard();
  }

  private buildDOM(): void {
    this.rootEl = document.createElement('div');
    this.rootEl.id = 'ttm-calc';
    this.rootEl.className = 'ttm-calc-shell';

    // Barra superior com label discreto
    const topBar = document.createElement('div');
    topBar.className = 'calc-topbar';

    this.topLabelEl = document.createElement('span');
    this.topLabelEl.className = 'calc-label';
    this.topLabelEl.textContent = t('calc.label');

    const manualBtn = document.createElement('button');
    manualBtn.type = 'button';
    manualBtn.className = 'calc-manual-btn';
    manualBtn.title = t('calc.degTitle');

    const degText = document.createElement('span');
    degText.textContent = 'DEG';

    const degDot = document.createElement('span');
    degDot.className = 'calc-deg-dot';
    degDot.setAttribute('aria-hidden', 'true');

    manualBtn.appendChild(degText);
    manualBtn.appendChild(degDot);
    manualBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.callbacks.onOpenManualEntry) {
        this.callbacks.onOpenManualEntry();
      }
    });
    this.manualBtnEl = manualBtn;

    topBar.appendChild(this.topLabelEl);
    topBar.appendChild(manualBtn);
    this.rootEl.appendChild(topBar);

    // Área do Visor
    const displayBox = document.createElement('div');
    displayBox.className = 'calc-display-box';

    this.expressionEl = document.createElement('div');
    this.expressionEl.className = 'calc-expression';
    this.expressionEl.textContent = '';

    this.displayEl = document.createElement('div');
    this.displayEl.className = 'calc-display';
    this.displayEl.textContent = '0';

    displayBox.appendChild(this.expressionEl);
    displayBox.appendChild(this.displayEl);
    this.rootEl.appendChild(displayBox);

    // Teclado da Calculadora
    const keypad = document.createElement('div');
    keypad.className = 'calc-keypad';

    const buttons = [
      { label: 'C', action: () => this.clear(), type: 'fn' },
      { label: '±', action: () => this.toggleSign(), type: 'fn' },
      { label: '%', action: () => this.percent(), type: 'fn' },
      { label: '÷', action: () => this.setOperator('÷'), type: 'op' },

      { label: '7', action: () => this.inputDigit('7'), type: 'num' },
      { label: '8', action: () => this.inputDigit('8'), type: 'num' },
      { label: '9', action: () => this.inputDigit('9'), type: 'num' },
      { label: '×', action: () => this.setOperator('×'), type: 'op' },

      { label: '4', action: () => this.inputDigit('4'), type: 'num' },
      { label: '5', action: () => this.inputDigit('5'), type: 'num' },
      { label: '6', action: () => this.inputDigit('6'), type: 'num' },
      { label: '-', action: () => this.setOperator('-'), type: 'op' },

      { label: '1', action: () => this.inputDigit('1'), type: 'num' },
      { label: '2', action: () => this.inputDigit('2'), type: 'num' },
      { label: '3', action: () => this.inputDigit('3'), type: 'num' },
      { label: '+', action: () => this.setOperator('+'), type: 'op' },

      { label: '0', action: () => this.inputDigit('0'), type: 'num', wide: true },
      { label: '.', action: () => this.inputDot(), type: 'num' },
      { label: '=', action: () => this.performEquals(), type: 'op-equal' },
    ];

    buttons.forEach((btn) => {
      const buttonEl = document.createElement('button');
      buttonEl.type = 'button';
      buttonEl.className = `calc-btn calc-btn-${btn.type} ${btn.wide ? 'calc-btn-wide' : ''}`;
      buttonEl.textContent = btn.label;
      buttonEl.setAttribute('aria-label', btn.label);

      buttonEl.addEventListener('click', (e) => {
        e.preventDefault();
        btn.action();
      });

      keypad.appendChild(buttonEl);
    });

    this.rootEl.appendChild(keypad);
    this.container.appendChild(this.rootEl);
  }

  /**
   * Suporte universal para qualquer teclado físico (laptop, numpad, mobile)
   */
  private setupUniversalKeyboard(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this.isVisible) return;

      // Se o usuário está digitando em um input de texto (ex: se houver outro campo aberto), ignore
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') return;

      const key = e.key;

      if (key >= '0' && key <= '9') {
        this.inputDigit(key);
      } else if (key === '.' || key === ',') {
        this.inputDot();
      } else if (key === '+' || key === '-') {
        this.setOperator(key);
      } else if (key === '*' || key === 'x' || key === 'X') {
        this.setOperator('×');
      } else if (key === '/') {
        e.preventDefault();
        this.setOperator('÷');
      } else if (key === '#') {
        e.preventDefault();
        this.inputHash();
      } else if (key === 'Enter' || key === '=') {
        e.preventDefault();
        if (this.checkSecretUnlock()) {
          return;
        }
        this.triggerCustomPinCheck();
        this.performEquals();
      } else if (key === 'Backspace') {
        this.backspace();
      } else if (key === 'Escape' || key.toLowerCase() === 'c') {
        this.clear();
      }
    });
  }

  private updateDisplay(): void {
    let formatted = this.displayValue;
    if (formatted.length > 11) {
      const num = Number(formatted);
      if (!isNaN(num)) {
        formatted = num.toPrecision(8).replace(/\.?0+$/, '');
      }
    }
    this.displayEl.textContent = formatted;
    this.expressionEl.textContent = this.expressionValue;
  }

  /**
   * Verifica se a senha de Truman (852456) ou Mãezinha (135790) foi digitada
   */
  public checkSecretUnlock(): boolean {
    const cleanDisplay = this.displayValue.trim();

    // 1. Verifica pelo display exato
    const userFromDisplay = getUserByPin(cleanDisplay);
    if (userFromDisplay) {
      this.clear();
      this.callbacks.onUnlock(userFromDisplay, cleanDisplay);
      return true;
    }

    // 2. Verifica se o display termina com a senha (caso haja dígitos anteriores)
    if (cleanDisplay.endsWith('852456')) {
      this.clear();
      this.callbacks.onUnlock('Truman', '852456');
      return true;
    }
    if (cleanDisplay.endsWith('135790')) {
      this.clear();
      this.callbacks.onUnlock('Mãezinha', '135790');
      return true;
    }

    // 3. Verifica sequência contínua digitada
    if (this.inputSequence.endsWith('852456')) {
      this.clear();
      this.callbacks.onUnlock('Truman', '852456');
      return true;
    }
    if (this.inputSequence.endsWith('135790')) {
      this.clear();
      this.callbacks.onUnlock('Mãezinha', '135790');
      return true;
    }

    return false;
  }

  private triggerCustomPinCheck(): void {
    if (!this.callbacks.onCheckCustomPin || !this.isVisible) return;
    const seq = ++this.customPinCheckSeq;
    const displaySnap = this.displayValue.trim();
    const sequenceSnap = this.inputSequence;

    void this.callbacks.onCheckCustomPin(displaySnap, sequenceSnap).then((unlocked) => {
      if (unlocked && seq === this.customPinCheckSeq) {
        this.clear();
      }
    }).catch(() => {
      // Silencioso: nunca quebra a calculadora
    });
  }

  private appendSequenceToken(token: string): boolean {
    const cleanToken = normalizeCalculatorSequence(token);
    if (!cleanToken) return false;
    this.inputSequence += cleanToken;
    if (this.inputSequence.length > 256) {
      this.inputSequence = this.inputSequence.slice(-128);
    }
    if (isAdminRouteSequence(this.inputSequence)) {
      this.clear();
      this.callbacks.onOpenAdminRoute?.();
      return true;
    }
    return false;
  }

  public inputDigit(digit: string): void {
    if (this.appendSequenceToken(digit)) {
      return;
    }

    if (this.waitingForOperand) {
      this.displayValue = digit;
      this.waitingForOperand = false;
    } else {
      this.displayValue = this.displayValue === '0' ? digit : this.displayValue + digit;
    }

    this.updateDisplay();

    // Verificação instantânea do segredo legado e, em seguida, PINs numéricos locais (>= 6 dígitos)
    if (!this.checkSecretUnlock()) {
      this.triggerCustomPinCheck();
    }
  }

  public inputDot(): void {
    if (this.appendSequenceToken('.')) {
      return;
    }
    if (this.waitingForOperand) {
      this.displayValue = '0.';
      this.waitingForOperand = false;
    } else if (!this.displayValue.includes('.')) {
      this.displayValue += '.';
    }
    this.updateDisplay();
  }

  public inputHash(): void {
    this.appendSequenceToken('#');
  }

  public backspace(): void {
    if (this.displayValue.length > 1) {
      this.displayValue = this.displayValue.slice(0, -1);
    } else {
      this.displayValue = '0';
    }
    if (this.inputSequence.length > 0) {
      this.inputSequence = this.inputSequence.slice(0, -1);
    }
    this.updateDisplay();
  }

  public clear(): void {
    this.displayValue = '0';
    this.expressionValue = '';
    this.operator = null;
    this.operand = null;
    this.waitingForOperand = false;
    this.inputSequence = '';
    this.updateDisplay();
  }

  public toggleSign(): void {
    const val = parseFloat(this.displayValue);
    if (!isNaN(val) && val !== 0) {
      this.displayValue = String(-val);
      this.updateDisplay();
    }
  }

  public percent(): void {
    if (this.appendSequenceToken('%')) {
      return;
    }
    const val = parseFloat(this.displayValue);
    if (!isNaN(val)) {
      this.displayValue = String(val / 100);
      this.updateDisplay();
    }
  }

  public setOperator(nextOperator: string): void {
    if (this.appendSequenceToken(nextOperator)) {
      return;
    }
    const inputValue = parseFloat(this.displayValue);

    if (this.operator && this.waitingForOperand) {
      this.operator = nextOperator;
      this.expressionValue = `${this.operand} ${nextOperator}`;
      this.updateDisplay();
      return;
    }

    if (this.operand === null) {
      this.operand = inputValue;
    } else if (this.operator) {
      const result = this.calculate(this.operand, inputValue, this.operator);
      this.displayValue = String(result);
      this.operand = result;
    }

    this.waitingForOperand = true;
    this.operator = nextOperator;
    this.expressionValue = `${this.operand} ${nextOperator}`;
    this.updateDisplay();
  }

  public performEquals(): void {
    if (this.appendSequenceToken('#')) {
      return;
    }

    if (this.checkSecretUnlock()) {
      return;
    }

    const inputValue = parseFloat(this.displayValue);

    if (this.operator && this.operand !== null) {
      const result = this.calculate(this.operand, inputValue, this.operator);
      this.expressionValue = `${this.operand} ${this.operator} ${inputValue} =`;
      this.displayValue = String(result);
      this.operand = null;
      this.operator = null;
      this.waitingForOperand = true;
      this.updateDisplay();

      this.checkSecretUnlock();
    }
  }

  private calculate(firstOperand: number, secondOperand: number, op: string): number {
    switch (op) {
      case '+':
        return firstOperand + secondOperand;
      case '-':
        return firstOperand - secondOperand;
      case '×':
        return firstOperand * secondOperand;
      case '÷':
        return secondOperand === 0 ? 0 : firstOperand / secondOperand;
      default:
        return secondOperand;
    }
  }

  public setUnreadDot(active: boolean): void {
    this.hasUnreadDotState = active;
    if (!this.manualBtnEl) return;
    if (active) {
      this.manualBtnEl.classList.add('calc-deg-unread');
    } else {
      this.manualBtnEl.classList.remove('calc-deg-unread');
    }
  }

  public hasUnreadDot(): boolean {
    return this.hasUnreadDotState;
  }

  public refreshLocale(): void {
    if (this.topLabelEl) {
      this.topLabelEl.textContent = t('calc.label');
    }
    if (this.manualBtnEl) {
      this.manualBtnEl.title = t('calc.degTitle');
    }
  }

  public show(): void {
    this.clear();
    this.refreshLocale();
    this.isVisible = true;
    this.rootEl.style.display = 'flex';
  }

  public hide(): void {
    this.isVisible = false;
    this.rootEl.style.display = 'none';
  }
}
