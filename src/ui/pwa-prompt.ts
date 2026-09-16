/**
 * Talk2TM — Motor de Notificação e Instalação PWA com Persistência Robusta
 * Arquitetura de 3 Estados Persistentes + Gestão de Cooldown e Fallback de Storage.
 */

export const PWA_PROMPT_VERSION = 'v1';
export const PWA_STORAGE_KEY = `talk2tm_pwa_prompt_${PWA_PROMPT_VERSION}`;

export type PWADecision = 'unprompted' | 'install_pending' | 'installed' | 'continued' | 'dismissed';

export interface PWAPersistedState {
  version: string;
  decision: PWADecision;
  timestamp: number;
  impressions: number;
}

export const PWA_COOLDOWNS = {
  CONTINUED_MS: 7 * 24 * 60 * 60 * 1000,   // 7 dias de cooldown após "Continuar"
  DISMISSED_MS: 14 * 24 * 60 * 60 * 1000,  // 14 dias de cooldown após rejeição nativa
  INSTALL_PENDING_MS: 24 * 60 * 60 * 1000, // 1 dia de tolerância se a instalação ficou pendente
};

// Fallback em memória caso localStorage esteja indisponível (ex: navegação anônima estrita)
let inMemoryFallback: string | null = null;

export function getSafeStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const testKey = '__storage_test__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    }
  } catch {
    // localStorage indisponível ou bloqueado
  }

  return {
    getItem: (key: string) => (key === PWA_STORAGE_KEY ? inMemoryFallback : null),
    setItem: (key: string, value: string) => {
      if (key === PWA_STORAGE_KEY) inMemoryFallback = value;
    },
    removeItem: (key: string) => {
      if (key === PWA_STORAGE_KEY) inMemoryFallback = null;
    },
  };
}

export function isStandaloneMode(win?: Window): boolean {
  const targetWin = win || (typeof window !== 'undefined' ? window : undefined);
  if (!targetWin) return false;

  const matchMediaMatches =
    typeof targetWin.matchMedia === 'function' &&
    targetWin.matchMedia('(display-mode: standalone)').matches;

  const navStandalone =
    (targetWin.navigator as unknown as { standalone?: boolean })?.standalone === true;

  return Boolean(matchMediaMatches || navStandalone);
}

export function isAppleMobileDevice(win?: Window): boolean {
  const targetWin = win || (typeof window !== 'undefined' ? window : undefined);
  if (!targetWin) return false;

  const ua = targetWin.navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isIPadOS =
    targetWin.navigator.platform === 'MacIntel' && targetWin.navigator.maxTouchPoints > 1;

  return isIOS || isIPadOS;
}

export function getPWAState(storage = getSafeStorage()): PWAPersistedState {
  try {
    const raw = storage.getItem(PWA_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === PWA_PROMPT_VERSION) {
        return {
          version: parsed.version,
          decision: parsed.decision || 'unprompted',
          timestamp: Number(parsed.timestamp) || 0,
          impressions: Number(parsed.impressions) || 0,
        };
      }
    }
  } catch {
    // Falha de parsing
  }

  return {
    version: PWA_PROMPT_VERSION,
    decision: 'unprompted',
    timestamp: 0,
    impressions: 0,
  };
}

export function savePWAState(
  state: Partial<PWAPersistedState>,
  storage = getSafeStorage()
): PWAPersistedState {
  const current = getPWAState(storage);
  const updated: PWAPersistedState = {
    version: PWA_PROMPT_VERSION,
    decision: state.decision !== undefined ? state.decision : current.decision,
    timestamp: state.timestamp !== undefined ? state.timestamp : Date.now(),
    impressions: state.impressions !== undefined ? state.impressions : current.impressions,
  };

  try {
    storage.setItem(PWA_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    inMemoryFallback = JSON.stringify(updated);
  }

  return updated;
}

/**
 * Avalia se o prompt deve ser renderizado baseado no estado persistente,
 * no modo standalone e nos cooldowns definidos.
 */
export function shouldShowPWAPrompt(
  now: number = Date.now(),
  storage = getSafeStorage(),
  isStandaloneOverride?: boolean
): boolean {
  const standalone = isStandaloneOverride !== undefined ? isStandaloneOverride : isStandaloneMode();
  if (standalone) {
    // Se detectado como standalone, atualiza silenciosamente para 'installed'
    const current = getPWAState(storage);
    if (current.decision !== 'installed') {
      savePWAState({ decision: 'installed', timestamp: now }, storage);
    }
    return false;
  }

  const state = getPWAState(storage);

  // 1. Já instalado: nunca mais exibir
  if (state.decision === 'installed') {
    return false;
  }

  // 2. Continuar: cooldown de 7 dias
  if (state.decision === 'continued') {
    const elapsed = now - state.timestamp;
    if (elapsed < PWA_COOLDOWNS.CONTINUED_MS) {
      return false;
    }
  }

  // 3. Recusado (dismissed nativo): cooldown longo de 14 dias
  if (state.decision === 'dismissed') {
    const elapsed = now - state.timestamp;
    if (elapsed < PWA_COOLDOWNS.DISMISSED_MS) {
      return false;
    }
  }

  // 4. Instalação pendente: cooldown de tolerância de 24h
  if (state.decision === 'install_pending') {
    const elapsed = now - state.timestamp;
    if (elapsed < PWA_COOLDOWNS.INSTALL_PENDING_MS) {
      return false;
    }
  }

  return true;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export class PWAPromptBar {
  private container: HTMLElement;
  private bannerEl: HTMLElement | null = null;
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private isIOS: boolean = false;
  private isStandalone: boolean = false;
  private storage = getSafeStorage();

  constructor(parentContainer: HTMLElement) {
    this.container = parentContainer;
    this.isStandalone = isStandaloneMode();
    this.isIOS = isAppleMobileDevice();

    if (this.isStandalone) {
      savePWAState({ decision: 'installed', timestamp: Date.now() }, this.storage);
      return;
    }

    this.bindEvents();
  }

  private bindEvents(): void {
    if (typeof window === 'undefined') return;

    // 1. Monitora o evento 'appinstalled' globalmente (Android, Chrome, Edge)
    window.addEventListener('appinstalled', () => {
      savePWAState({ decision: 'installed', timestamp: Date.now() }, this.storage);
      this.dismiss(false);
    });

    // 2. Intercepta 'beforeinstallprompt'
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;

      if (shouldShowPWAPrompt(Date.now(), this.storage, this.isStandalone)) {
        this.renderBanner();
      }
    });

    // 3. Suporte para iOS ou navegadores que não disparam beforeinstallprompt imediatamente
    if (this.isIOS || !this.isStandalone) {
      setTimeout(() => {
        if (!this.bannerEl && shouldShowPWAPrompt(Date.now(), this.storage, this.isStandalone)) {
          this.renderBanner();
        }
      }, 1000);
    }
  }

  private renderBanner(): void {
    if (this.bannerEl || this.isStandalone) return;
    if (!shouldShowPWAPrompt(Date.now(), this.storage, this.isStandalone)) return;

    // Incrementa contador de impressões
    const currentState = getPWAState(this.storage);
    savePWAState({ impressions: currentState.impressions + 1 }, this.storage);

    this.bannerEl = document.createElement('div');
    this.bannerEl.id = 'ttm-pwa-bar';
    this.bannerEl.className = 'ttm-pwa-bar';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'ttm-pwa-actions';

    const installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.className = 'ttm-pwa-btn ttm-pwa-btn-install';
    installBtn.textContent = 'Instalar';
    installBtn.addEventListener('click', () => this.handleInstallClick());

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'ttm-pwa-btn ttm-pwa-btn-continue';
    continueBtn.textContent = 'Continuar';
    continueBtn.title = 'Continuar no navegador';
    continueBtn.addEventListener('click', () => this.handleContinueClick());

    actionsDiv.appendChild(installBtn);
    actionsDiv.appendChild(continueBtn);

    this.bannerEl.appendChild(actionsDiv);

    if (this.container.firstChild) {
      this.container.insertBefore(this.bannerEl, this.container.firstChild);
    } else {
      this.container.appendChild(this.bannerEl);
    }
  }

  private async handleInstallClick(): Promise<void> {
    // Fluxo Chromium / Android / Desktop com evento nativo
    if (this.deferredPrompt) {
      try {
        await this.deferredPrompt.prompt();
        const choice = await this.deferredPrompt.userChoice;

        if (choice.outcome === 'accepted') {
          // accepted → install_pending (aguardará appinstalled para marcar 'installed')
          savePWAState({ decision: 'install_pending', timestamp: Date.now() }, this.storage);
        } else {
          // recusado pelo usuário no diálogo nativo → dismissed (cooldown longo de 14 dias)
          savePWAState({ decision: 'dismissed', timestamp: Date.now() }, this.storage);
        }
      } catch (err) {
        console.debug('Talk2TM [PWA Prompt]: erro na chamada do prompt:', err);
      } finally {
        this.deferredPrompt = null;
        this.dismiss(false);
      }
      return;
    }

    // Fluxo iPhone / iPad
    if (this.isIOS) {
      this.showIOSInstructions();
      return;
    }

    // Navegadores desktop sem beforeinstallprompt direto
    alert('Para instalar: clique no ícone de instalação na barra de endereços do navegador.');
    this.dismiss(false);
  }

  private showIOSInstructions(): void {
    if (!this.bannerEl) return;

    let textSpan = this.bannerEl.querySelector('.ttm-pwa-text') as HTMLElement | null;
    if (!textSpan) {
      textSpan = document.createElement('span');
      textSpan.className = 'ttm-pwa-text';
      this.bannerEl.insertBefore(textSpan, this.bannerEl.firstChild);
    }
    textSpan.textContent = 'Toque em Compartilhar e "Adicionar à Tela de Início"';
    textSpan.style.color = '#38bdf8';

    const actionsDiv = this.bannerEl.querySelector('.ttm-pwa-actions') as HTMLElement | null;
    if (actionsDiv) {
      while (actionsDiv.firstChild) {
        actionsDiv.removeChild(actionsDiv.firstChild);
      }

      const understoodBtn = document.createElement('button');
      understoodBtn.type = 'button';
      understoodBtn.className = 'ttm-pwa-btn ttm-pwa-btn-continue';
      understoodBtn.textContent = 'Entendido';
      understoodBtn.addEventListener('click', () => {
        // Ao clicar em Entendido no iOS, registra 'continued' para dar tempo ao usuário
        // Quando abrir pelo ícone, o detector standalone marcará 'installed' automaticamente
        savePWAState({ decision: 'continued', timestamp: Date.now() }, this.storage);
        this.dismiss(false);
      });

      actionsDiv.appendChild(understoodBtn);
    }
  }

  private handleContinueClick(): void {
    // Continuar → cooldown de 7 dias
    savePWAState({ decision: 'continued', timestamp: Date.now() }, this.storage);
    this.dismiss(false);
  }

  public dismiss(saveDecision = true): void {
    if (saveDecision) {
      const current = getPWAState(this.storage);
      if (current.decision === 'unprompted') {
        savePWAState({ decision: 'continued', timestamp: Date.now() }, this.storage);
      }
    }

    if (this.bannerEl && this.bannerEl.parentNode) {
      this.bannerEl.classList.add('ttm-pwa-bar-hiding');
      setTimeout(() => {
        if (this.bannerEl && this.bannerEl.parentNode) {
          this.bannerEl.parentNode.removeChild(this.bannerEl);
          this.bannerEl = null;
        }
      }, 200);
    }
  }
}
