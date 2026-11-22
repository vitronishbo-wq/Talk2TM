/**
 * Talk2TM — Interface Administrativa Ultraminimalista (Carregada sob Demanda)
 *
 * - Carregada apenas via import() dinâmico quando o atalho de navegação é acionado.
 * - Sessão isolada em instância Firebase Auth secundária (inMemoryPersistence).
 * - Coluna única densa e supercompacta com paginação estrita (20 por página) e apenas phoneMasked.
 * - Sem coluna de convidados e sem acesso a mensagens ou conversas privadas.
 */

import { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { AdminStatusFilter, AdminUserRow } from '../types';
import {
  fetchAdminUsersPage,
  getAdminCurrentUser,
  lookupAdminUserByPhone,
  setAdminUserActiveState,
  signInAdminWithCredentials,
  signInAdminWithGoogle,
  signOutAdmin,
} from '../firebase/admin';

export function formatAdminActivationDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

export interface AdminOverlayController {
  destroy: () => Promise<void>;
}

export function mountAdminOverlay(
  appWrapper: HTMLElement,
  callbacks: { onExit: () => void }
): AdminOverlayController {
  const rootEl = document.createElement('section');
  rootEl.id = 'ttm-admin-view';
  rootEl.className = 'ttm-admin-view';

  let activeFilter: AdminStatusFilter = 'all';
  let rows: AdminUserRow[] = [];
  let lastCursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let hasMore = false;
  let isSearchMode = false;
  let isLoading = false;
  let isDestroyed = false;

  // Cabeçalho supercompacto
  const topBar = document.createElement('div');
  topBar.className = 'ttm-admin-topbar';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'ttm-admin-title-wrap';
  const titleEl = document.createElement('strong');
  titleEl.textContent = 'Admin';
  const summaryEl = document.createElement('span');
  summaryEl.className = 'ttm-admin-summary';
  summaryEl.textContent = 'sessão isolada';
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(summaryEl);

  const topActions = document.createElement('div');
  topActions.className = 'ttm-admin-top-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'ttm-btn-mini';
  refreshBtn.textContent = '[atualizar]';
  refreshBtn.style.display = 'none';

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
  exitBtn.textContent = '[sair]';

  topActions.appendChild(refreshBtn);
  topActions.appendChild(exitBtn);
  topBar.appendChild(titleWrap);
  topBar.appendChild(topActions);

  // Vista 1: Login Firebase Auth padrão (nenhuma credencial embutida no código)
  const loginCard = document.createElement('form');
  loginCard.className = 'ttm-admin-login-card';

  const loginTitle = document.createElement('div');
  loginTitle.className = 'ttm-pass-title';
  loginTitle.textContent = 'Autenticação Administrativa';

  const loginSub = document.createElement('div');
  loginSub.className = 'ttm-pass-sub';
  loginSub.textContent = 'Sessão isolada em memória. Autorização validada pelo e-mail verificado nas regras.';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.name = 'username';
  emailInput.autocomplete = 'username';
  emailInput.className = 'ttm-input ttm-input-left';
  emailInput.placeholder = 'E-mail administrativo';
  emailInput.required = true;

  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.name = 'password';
  passInput.autocomplete = 'current-password';
  passInput.className = 'ttm-input ttm-input-left';
  passInput.placeholder = 'Senha Firebase Auth';
  passInput.required = true;

  const loginErrorEl = document.createElement('div');
  loginErrorEl.className = 'ttm-error-text';

  const loginSubmitBtn = document.createElement('button');
  loginSubmitBtn.type = 'submit';
  loginSubmitBtn.className = 'ttm-btn ttm-btn-primary ttm-btn-full';
  loginSubmitBtn.textContent = '[autenticar]';

  const loginDivider = document.createElement('div');
  loginDivider.className = 'ttm-admin-divider';
  loginDivider.textContent = 'ou';

  const googleSignInBtn = document.createElement('button');
  googleSignInBtn.type = 'button';
  googleSignInBtn.className = 'ttm-btn ttm-btn-secondary ttm-btn-full';
  googleSignInBtn.textContent = '[entrar com Google]';

  loginCard.appendChild(loginTitle);
  loginCard.appendChild(loginSub);
  loginCard.appendChild(emailInput);
  loginCard.appendChild(passInput);
  loginCard.appendChild(loginErrorEl);
  loginCard.appendChild(loginSubmitBtn);
  loginCard.appendChild(loginDivider);
  loginCard.appendChild(googleSignInBtn);

  // Vista 2: Painel denso em coluna única
  const panelEl = document.createElement('div');
  panelEl.className = 'ttm-admin-panel';
  panelEl.style.display = 'none';

  // Barra de filtro e busca pontual O(1)
  const controlsEl = document.createElement('div');
  controlsEl.className = 'ttm-admin-controls';

  const filterBar = document.createElement('div');
  filterBar.className = 'ttm-admin-filters';

  const filterButtons: Record<AdminStatusFilter, HTMLButtonElement> = {
    all: document.createElement('button'),
    active: document.createElement('button'),
    inactive: document.createElement('button'),
  };

  (
    [
      ['all', 'todos'],
      ['active', 'activos'],
      ['inactive', 'desactivados'],
    ] as [AdminStatusFilter, string][]
  ).forEach(([key, label]) => {
    const btn = filterButtons[key];
    btn.type = 'button';
    btn.className = 'ttm-btn-mini';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (isLoading) return;
      isSearchMode = false;
      searchInput.value = '';
      activeFilter = key;
      updateFilterButtons();
      void loadInitialPage();
    });
    filterBar.appendChild(btn);
  });

  const searchForm = document.createElement('form');
  searchForm.className = 'ttm-admin-search-form';

  const searchInput = document.createElement('input');
  searchInput.type = 'tel';
  searchInput.autocomplete = 'off';
  searchInput.className = 'ttm-admin-search-input';
  searchInput.placeholder = 'Buscar por tel. exato (+244...)';

  const searchBtn = document.createElement('button');
  searchBtn.type = 'submit';
  searchBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
  searchBtn.textContent = 'buscar';

  const clearSearchBtn = document.createElement('button');
  clearSearchBtn.type = 'button';
  clearSearchBtn.className = 'ttm-btn-mini';
  clearSearchBtn.textContent = 'limpar';
  clearSearchBtn.style.display = 'none';

  searchForm.appendChild(searchInput);
  searchForm.appendChild(searchBtn);
  searchForm.appendChild(clearSearchBtn);

  const feedbackEl = document.createElement('div');
  feedbackEl.className = 'ttm-admin-feedback';

  const listEl = document.createElement('div');
  listEl.className = 'ttm-admin-list';

  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.type = 'button';
  loadMoreBtn.className = 'ttm-btn ttm-btn-full ttm-admin-more-btn';
  loadMoreBtn.textContent = '[carregar mais 20]';
  loadMoreBtn.style.display = 'none';

  controlsEl.appendChild(filterBar);
  controlsEl.appendChild(searchForm);
  panelEl.appendChild(controlsEl);
  panelEl.appendChild(feedbackEl);
  panelEl.appendChild(listEl);
  panelEl.appendChild(loadMoreBtn);

  rootEl.appendChild(topBar);
  rootEl.appendChild(loginCard);
  rootEl.appendChild(panelEl);
  appWrapper.appendChild(rootEl);

  function updateFilterButtons(): void {
    (['all', 'active', 'inactive'] as AdminStatusFilter[]).forEach((key) => {
      if (key === activeFilter && !isSearchMode) {
        filterButtons[key].classList.add('ttm-btn-mini-primary');
      } else {
        filterButtons[key].classList.remove('ttm-btn-mini-primary');
      }
    });
    clearSearchBtn.style.display = isSearchMode ? 'inline-block' : 'none';
  }

  function updateSummary(): void {
    const activeCount = rows.filter((r) => r.active).length;
    const inactiveCount = rows.length - activeCount;
    summaryEl.textContent = isSearchMode
      ? `busca: ${rows.length}`
      : `${rows.length} carregados (${activeCount} atv · ${inactiveCount} des)`;
  }

  function setFeedback(text: string, isError: boolean = false): void {
    feedbackEl.textContent = text;
    if (isError) {
      feedbackEl.classList.add('is-error');
    } else {
      feedbackEl.classList.remove('is-error');
    }
  }

  function renderRows(): void {
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }

    updateSummary();

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-admin-empty';
      empty.textContent = isLoading
        ? 'A carregar utilizadores...'
        : 'Nenhum utilizador encontrado nesta vista.';
      listEl.appendChild(empty);
      loadMoreBtn.style.display = 'none';
      return;
    }

    rows.forEach((row) => {
      const cell = document.createElement('div');
      cell.className = `ttm-admin-cell ${row.active ? 'is-active' : 'is-inactive'}`;

      const line1 = document.createElement('div');
      line1.className = 'ttm-admin-cell-head';

      const nameEl = document.createElement('strong');
      nameEl.className = 'ttm-admin-cell-name';
      nameEl.textContent = row.displayName;

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = row.active
        ? 'ttm-admin-toggle is-on'
        : 'ttm-admin-toggle is-off';
      toggleBtn.textContent = row.active ? 'Ativa · Desactivar' : 'Desactivado · Activar';
      toggleBtn.addEventListener('click', () => {
        void handleToggleUser(row, toggleBtn);
      });

      line1.appendChild(nameEl);
      line1.appendChild(toggleBtn);

      const line2 = document.createElement('div');
      line2.className = 'ttm-admin-cell-meta';
      line2.textContent = `Tel: ${row.phoneMasked} · Data de activação: ${formatAdminActivationDate(row.createdAt)}`;

      const line3 = document.createElement('div');
      line3.className = 'ttm-admin-cell-meta';
      line3.textContent = `Plano activo: ${row.plan} · Estado operacional: ${row.active ? 'Ativa' : 'Desactivado'}`;

      cell.appendChild(line1);
      cell.appendChild(line2);
      cell.appendChild(line3);
      listEl.appendChild(cell);
    });

    loadMoreBtn.style.display = !isSearchMode && hasMore ? 'block' : 'none';
    loadMoreBtn.disabled = isLoading;
    loadMoreBtn.textContent = isLoading ? 'A carregar...' : '[carregar mais 20]';
  }

  async function handleToggleUser(row: AdminUserRow, btn: HTMLButtonElement): Promise<void> {
    const nextActive = !row.active;
    btn.disabled = true;
    setFeedback('');

    try {
      await setAdminUserActiveState({
        uid: row.uid,
        talk2tmId: row.talk2tmId,
        phoneHash: row.phoneHash,
        active: nextActive,
      });
      row.active = nextActive;
      if (activeFilter === 'active' && !nextActive) {
        rows = rows.filter((r) => r.uid !== row.uid);
      } else if (activeFilter === 'inactive' && nextActive) {
        rows = rows.filter((r) => r.uid !== row.uid);
      }
      renderRows();
      setFeedback(
        `${row.displayName}: estado atualizado para ${nextActive ? 'Ativa' : 'Desactivado'}.`
      );
    } catch (err: any) {
      btn.disabled = false;
      setFeedback(err?.message || 'Erro ao atualizar estado operacional.', true);
    }
  }

  async function loadInitialPage(): Promise<void> {
    if (isLoading || isDestroyed) return;
    isLoading = true;
    rows = [];
    lastCursor = null;
    hasMore = false;
    setFeedback('');
    renderRows();

    try {
      const page = await fetchAdminUsersPage({ filter: activeFilter });
      if (isDestroyed) return;
      rows = page.rows;
      lastCursor = page.lastCursor;
      hasMore = page.hasMore;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar página de utilizadores.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed) renderRows();
    }
  }

  async function loadNextPage(): Promise<void> {
    if (isLoading || !hasMore || !lastCursor || isDestroyed) return;
    isLoading = true;
    renderRows();
    setFeedback('');

    try {
      const page = await fetchAdminUsersPage({
        filter: activeFilter,
        cursor: lastCursor,
      });
      if (isDestroyed) return;
      const seen = new Set(rows.map((r) => r.uid));
      const fresh = page.rows.filter((r) => !seen.has(r.uid));
      rows = [...rows, ...fresh];
      lastCursor = page.lastCursor;
      hasMore = page.hasMore;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar próxima página.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed) renderRows();
    }
  }

  function showAuthenticatedPanel(initialPage?: {
    rows: AdminUserRow[];
    lastCursor: QueryDocumentSnapshot<DocumentData> | null;
    hasMore: boolean;
  }): void {
    loginCard.style.display = 'none';
    panelEl.style.display = 'flex';
    refreshBtn.style.display = 'inline-block';
    emailInput.value = '';
    passInput.value = '';
    updateFilterButtons();

    if (initialPage) {
      rows = initialPage.rows;
      lastCursor = initialPage.lastCursor;
      hasMore = initialPage.hasMore;
      renderRows();
    } else {
      void loadInitialPage();
    }
  }

  loginCard.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginErrorEl.textContent = '';
    loginSubmitBtn.disabled = true;
    googleSignInBtn.disabled = true;
    loginSubmitBtn.textContent = '[a validar...]';

    try {
      const firstPage = await signInAdminWithCredentials(emailInput.value, passInput.value);
      if (isDestroyed) return;
      showAuthenticatedPanel(firstPage);
    } catch (err: any) {
      if (!isDestroyed) {
        loginErrorEl.textContent = err?.message || 'Falha na autenticação.';
      }
    } finally {
      if (!isDestroyed) {
        loginSubmitBtn.disabled = false;
        googleSignInBtn.disabled = false;
        loginSubmitBtn.textContent = '[autenticar]';
      }
    }
  });

  googleSignInBtn.addEventListener('click', async () => {
    loginErrorEl.textContent = '';
    loginSubmitBtn.disabled = true;
    googleSignInBtn.disabled = true;
    googleSignInBtn.textContent = '[a abrir Google...]';

    try {
      const firstPage = await signInAdminWithGoogle();
      if (isDestroyed) return;
      showAuthenticatedPanel(firstPage);
    } catch (err: any) {
      if (!isDestroyed) {
        const rawMsg = typeof err?.message === 'string' ? err.message.trim() : '';
        const errorCode = typeof err?.code === 'string' && err.code.trim() ? err.code.trim() : '';
        const baseMsg = rawMsg && !rawMsg.includes('Não foi possível autenticar via Google')
          ? `Não foi possível autenticar via Google: ${rawMsg}`
          : rawMsg || 'Não foi possível autenticar via Google.';
        loginErrorEl.textContent =
          errorCode && !baseMsg.includes(errorCode) ? `${baseMsg} [${errorCode}]` : baseMsg;
      }
    } finally {
      if (!isDestroyed) {
        loginSubmitBtn.disabled = false;
        googleSignInBtn.disabled = false;
        googleSignInBtn.textContent = '[entrar com Google]';
      }
    }
  });

  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = searchInput.value.trim();
    if (!raw) {
      isSearchMode = false;
      updateFilterButtons();
      void loadInitialPage();
      return;
    }

    isLoading = true;
    isSearchMode = true;
    updateFilterButtons();
    setFeedback('');
    renderRows();

    try {
      const found = await lookupAdminUserByPhone(raw);
      if (isDestroyed) return;
      rows = found ? [found] : [];
      hasMore = false;
      lastCursor = null;
      if (!found) {
        setFeedback('Nenhuma conta encontrada para este número.');
      }
    } catch (err: any) {
      if (!isDestroyed) {
        rows = [];
        setFeedback(err?.message || 'Erro ao buscar por telefone.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed) renderRows();
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    isSearchMode = false;
    updateFilterButtons();
    void loadInitialPage();
  });

  refreshBtn.addEventListener('click', () => {
    isSearchMode = false;
    searchInput.value = '';
    updateFilterButtons();
    void loadInitialPage();
  });

  loadMoreBtn.addEventListener('click', () => {
    void loadNextPage();
  });

  const destroy = async (): Promise<void> => {
    if (isDestroyed) return;
    isDestroyed = true;
    emailInput.value = '';
    passInput.value = '';
    searchInput.value = '';
    rows = [];
    lastCursor = null;
    await signOutAdmin();
    if (rootEl.parentElement) {
      rootEl.parentElement.removeChild(rootEl);
    }
  };

  exitBtn.addEventListener('click', () => {
    void destroy().then(() => callbacks.onExit());
  });

  if (getAdminCurrentUser()) {
    showAuthenticatedPanel();
  } else {
    setTimeout(() => {
      if (!isDestroyed) emailInput.focus();
    }, 80);
  }

  return { destroy };
}
