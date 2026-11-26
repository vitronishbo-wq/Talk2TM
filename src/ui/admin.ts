/**
 * Talk2TM — Interface Administrativa Ultraminimalista (Carregada sob Demanda)
 *
 * - Carregada apenas via import() dinâmico quando o atalho de navegação é acionado.
 * - Sessão isolada em instância Firebase Auth secundária (inMemoryPersistence).
 * - Coluna única densa e supercompacta com paginação estrita (20 por página) e apenas phoneMasked.
 * - Sem coluna de convidados e sem acesso a mensagens ou conversas privadas.
 */

import { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import {
  AdminGrowthMetricsSnapshot,
  AdminOverlayTab,
  AdminPhotoFilter,
  AdminPhotoQueueItem,
  AdminReportFilter,
  AdminStatusFilter,
  AdminUserRow,
  ModerationReport,
  ReportReason,
  ReportSourceType,
} from '../types';
import {
  fetchAdminDatingPhotosPage,
  fetchAdminGrowthMetrics,
  fetchAdminModerationReportsPage,
  fetchAdminUsersPage,
  getAdminCurrentUser,
  lookupAdminUserByPhone,
  moderateAdminDatingPhoto,
  reviewAdminModerationReport,
  setAdminUserActiveState,
  signInAdminWithCredentials,
  signInAdminWithGoogle,
  signOutAdmin,
  suspendReportedAccountAndResolve,
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

  let activeTab: AdminOverlayTab = 'users';
  let activeFilter: AdminStatusFilter = 'all';
  let rows: AdminUserRow[] = [];
  let lastCursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let hasMore = false;

  let activeReportFilter: AdminReportFilter = 'pending';
  let reportRows: ModerationReport[] = [];
  let reportLastCursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let reportHasMore = false;
  let pendingSuspendReportId: string | null = null;

  let activePhotoFilter: AdminPhotoFilter = 'pending';
  let photoRows: AdminPhotoQueueItem[] = [];
  let photoLastCursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let photoHasMore = false;

  let metricsSnapshot: AdminGrowthMetricsSnapshot | null = null;

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

  // Barra de separadores (Utilizadores | Denúncias | Fotos)
  const tabsEl = document.createElement('div');
  tabsEl.className = 'ttm-admin-tabs';

  const tabUsersBtn = document.createElement('button');
  tabUsersBtn.type = 'button';
  tabUsersBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
  tabUsersBtn.textContent = 'Utilizadores';

  const tabReportsBtn = document.createElement('button');
  tabReportsBtn.type = 'button';
  tabReportsBtn.className = 'ttm-btn-mini';
  tabReportsBtn.textContent = 'Denúncias';

  const tabPhotosBtn = document.createElement('button');
  tabPhotosBtn.type = 'button';
  tabPhotosBtn.className = 'ttm-btn-mini';
  tabPhotosBtn.textContent = 'Fotos';

  const tabMetricsBtn = document.createElement('button');
  tabMetricsBtn.type = 'button';
  tabMetricsBtn.className = 'ttm-btn-mini';
  tabMetricsBtn.textContent = 'Métricas';

  tabsEl.appendChild(tabUsersBtn);
  tabsEl.appendChild(tabReportsBtn);
  tabsEl.appendChild(tabPhotosBtn);
  tabsEl.appendChild(tabMetricsBtn);

  // Barra de filtro e busca pontual O(1) — Utilizadores
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
  searchInput.placeholder = 'Buscar por tel. exato (+244, +264...)';

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

  // Barra de filtro — Denúncias
  const reportControlsEl = document.createElement('div');
  reportControlsEl.className = 'ttm-admin-controls';
  reportControlsEl.style.display = 'none';

  const reportFilterBar = document.createElement('div');
  reportFilterBar.className = 'ttm-admin-filters';

  const reportFilterButtons: Record<AdminReportFilter, HTMLButtonElement> = {
    pending: document.createElement('button'),
    resolved: document.createElement('button'),
    dismissed: document.createElement('button'),
    all: document.createElement('button'),
  };

  (
    [
      ['pending', 'pendentes'],
      ['resolved', 'resolvidas'],
      ['dismissed', 'dispensadas'],
      ['all', 'todas'],
    ] as [AdminReportFilter, string][]
  ).forEach(([key, label]) => {
    const btn = reportFilterButtons[key];
    btn.type = 'button';
    btn.className = 'ttm-btn-mini';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (isLoading) return;
      activeReportFilter = key;
      pendingSuspendReportId = null;
      updateFilterButtons();
      void loadInitialReportsPage();
    });
    reportFilterBar.appendChild(btn);
  });
  reportControlsEl.appendChild(reportFilterBar);

  // Barra de filtro — Fotos Dating
  const photoControlsEl = document.createElement('div');
  photoControlsEl.className = 'ttm-admin-controls';
  photoControlsEl.style.display = 'none';

  const photoFilterBar = document.createElement('div');
  photoFilterBar.className = 'ttm-admin-filters';

  const photoFilterButtons: Record<AdminPhotoFilter, HTMLButtonElement> = {
    pending: document.createElement('button'),
    reported: document.createElement('button'),
    rejected: document.createElement('button'),
    approved: document.createElement('button'),
  };

  (
    [
      ['pending', 'pendentes'],
      ['reported', 'denunciadas'],
      ['rejected', 'rejeitadas'],
      ['approved', 'aprovadas'],
    ] as [AdminPhotoFilter, string][]
  ).forEach(([key, label]) => {
    const btn = photoFilterButtons[key];
    btn.type = 'button';
    btn.className = 'ttm-btn-mini';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (isLoading) return;
      activePhotoFilter = key;
      updateFilterButtons();
      void loadInitialPhotosPage();
    });
    photoFilterBar.appendChild(btn);
  });
  photoControlsEl.appendChild(photoFilterBar);

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
  panelEl.appendChild(tabsEl);
  panelEl.appendChild(controlsEl);
  panelEl.appendChild(reportControlsEl);
  panelEl.appendChild(photoControlsEl);
  panelEl.appendChild(feedbackEl);
  panelEl.appendChild(listEl);
  panelEl.appendChild(loadMoreBtn);

  rootEl.appendChild(topBar);
  rootEl.appendChild(loginCard);
  rootEl.appendChild(panelEl);
  appWrapper.appendChild(rootEl);

  tabUsersBtn.addEventListener('click', () => {
    if (activeTab === 'users' || isLoading) return;
    activeTab = 'users';
    pendingSuspendReportId = null;
    updateFilterButtons();
    if (rows.length === 0) {
      void loadInitialPage();
    } else {
      renderCurrentTab();
    }
  });

  tabReportsBtn.addEventListener('click', () => {
    if (activeTab === 'reports' || isLoading) return;
    activeTab = 'reports';
    pendingSuspendReportId = null;
    updateFilterButtons();
    if (reportRows.length === 0) {
      void loadInitialReportsPage();
    } else {
      renderCurrentTab();
    }
  });

  tabPhotosBtn.addEventListener('click', () => {
    if (activeTab === 'photos' || isLoading) return;
    activeTab = 'photos';
    pendingSuspendReportId = null;
    updateFilterButtons();
    if (photoRows.length === 0) {
      void loadInitialPhotosPage();
    } else {
      renderCurrentTab();
    }
  });

  tabMetricsBtn.addEventListener('click', () => {
    if (activeTab === 'metrics' || isLoading) return;
    activeTab = 'metrics';
    pendingSuspendReportId = null;
    updateFilterButtons();
    if (!metricsSnapshot) {
      void loadGrowthMetrics();
    } else {
      renderCurrentTab();
    }
  });

  function updateFilterButtons(): void {
    tabUsersBtn.classList.toggle('ttm-btn-mini-primary', activeTab === 'users');
    tabReportsBtn.classList.toggle('ttm-btn-mini-primary', activeTab === 'reports');
    tabPhotosBtn.classList.toggle('ttm-btn-mini-primary', activeTab === 'photos');
    tabMetricsBtn.classList.toggle('ttm-btn-mini-primary', activeTab === 'metrics');
    controlsEl.style.display = activeTab === 'users' ? 'flex' : 'none';
    reportControlsEl.style.display = activeTab === 'reports' ? 'flex' : 'none';
    photoControlsEl.style.display = activeTab === 'photos' ? 'flex' : 'none';

    (['all', 'active', 'inactive'] as AdminStatusFilter[]).forEach((key) => {
      if (key === activeFilter && !isSearchMode) {
        filterButtons[key].classList.add('ttm-btn-mini-primary');
      } else {
        filterButtons[key].classList.remove('ttm-btn-mini-primary');
      }
    });
    (['pending', 'resolved', 'dismissed', 'all'] as AdminReportFilter[]).forEach((key) => {
      reportFilterButtons[key].classList.toggle('ttm-btn-mini-primary', key === activeReportFilter);
    });
    (['pending', 'reported', 'rejected', 'approved'] as AdminPhotoFilter[]).forEach((key) => {
      photoFilterButtons[key].classList.toggle('ttm-btn-mini-primary', key === activePhotoFilter);
    });
    clearSearchBtn.style.display = isSearchMode ? 'inline-block' : 'none';
  }

  function updateSummary(): void {
    if (activeTab === 'metrics') {
      summaryEl.textContent = metricsSnapshot
        ? `WAU: ${metricsSnapshot.weeklyActiveUsers} · atv: ${metricsSnapshot.totalActiveUsers}`
        : 'indicadores de crescimento';
      return;
    }
    if (activeTab === 'photos') {
      const pendingCount = photoRows.filter((p) => p.photoStatus === 'pending').length;
      summaryEl.textContent = `fotos: ${photoRows.length} (${pendingCount} pend.)`;
      return;
    }
    if (activeTab === 'reports') {
      const pendingCount = reportRows.filter((r) => r.status === 'pending').length;
      summaryEl.textContent = `denúncias: ${reportRows.length} (${pendingCount} pend.)`;
      return;
    }
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

  function formatReportReasonLabel(reason: ReportReason): string {
    switch (reason) {
      case 'spam':
        return 'Spam / Abuso';
      case 'harassment':
        return 'Assédio / Ofensa';
      case 'fake_profile':
        return 'Perfil Falso';
      case 'underage':
        return 'Suspeita de Menor';
      case 'scam':
        return 'Burla / Golpe';
      default:
        return 'Outro';
    }
  }

  function formatReportSourceLabel(sourceType: ReportSourceType): string {
    switch (sourceType) {
      case 'dating_profile':
        return 'Perfil Dating';
      case 'dating_match':
        return 'Match Dating';
      case 'chat_message':
        return 'Mensagem';
      default:
        return 'Conexão 1:1';
    }
  }

  function renderCurrentTab(): void {
    if (activeTab === 'metrics') {
      renderMetricsView();
    } else if (activeTab === 'photos') {
      renderPhotoRows();
    } else if (activeTab === 'reports') {
      renderReportRows();
    } else {
      renderRows();
    }
  }

  function buildMetricCard(label: string, value: string, sublabel: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ttm-kpi-card';

    const labelEl = document.createElement('div');
    labelEl.className = 'ttm-kpi-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.className = 'ttm-kpi-value';
    valueEl.textContent = value;

    const subEl = document.createElement('div');
    subEl.className = 'ttm-kpi-sub';
    subEl.textContent = sublabel;

    card.appendChild(labelEl);
    card.appendChild(valueEl);
    card.appendChild(subEl);
    return card;
  }

  function buildMetricsSection(title: string, children: HTMLElement[]): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'ttm-metrics-section';

    const head = document.createElement('div');
    head.className = 'ttm-metrics-section-title';
    head.textContent = title;
    sec.appendChild(head);

    children.forEach((c) => sec.appendChild(c));
    return sec;
  }

  function renderMetricsView(): void {
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }
    loadMoreBtn.style.display = 'none';
    updateSummary();

    if (!metricsSnapshot) {
      const empty = document.createElement('div');
      empty.className = 'ttm-admin-empty';
      empty.textContent = isLoading
        ? 'A calcular indicadores de crescimento...'
        : 'Toque em [atualizar] para carregar os indicadores.';
      listEl.appendChild(empty);
      return;
    }

    const m = metricsSnapshot;

    // 1. Aquisição
    const acqGrid = document.createElement('div');
    acqGrid.className = 'ttm-metrics-grid';
    acqGrid.appendChild(
      buildMetricCard(
        'Registos por convite',
        String(m.referralConvertedUsers),
        `${m.referralConversionSharePercent}% das ${m.totalActiveUsers} contas ativas`
      )
    );
    acqGrid.appendChild(
      buildMetricCard(
        'Conversão do link',
        `${m.referralLinkConversionRatePercent}%`,
        `${m.totalReferralShares} partilhas · ${m.totalActiveReferralLinks} links ativos`
      )
    );
    listEl.appendChild(buildMetricsSection('Aquisição', [acqGrid]));

    // 2. Engajamento
    const engGrid = document.createElement('div');
    engGrid.className = 'ttm-metrics-grid';
    engGrid.appendChild(
      buildMetricCard(
        'Média matches / utilizador',
        m.avgMatchesPerUser.toFixed(2),
        `${m.activeMatchedCount} matches ativos · ${m.totalDatingProfiles} perfis Dating`
      )
    );
    engGrid.appendChild(
      buildMetricCard(
        'Conversas após match',
        `${m.postMatchConversationRatePercent}%`,
        `${m.matchesWithChatStarted} iniciadas de ${m.totalMatchesCreated} matches`
      )
    );
    listEl.appendChild(buildMetricsSection('Engajamento', [engGrid]));

    // 3. Retenção & Geografia
    const retGrid = document.createElement('div');
    retGrid.className = 'ttm-metrics-grid';
    retGrid.appendChild(
      buildMetricCard(
        'Ativos semanais (WAU)',
        String(m.weeklyActiveUsers),
        `${m.weeklyRetentionPercent}% de retenção 7d (${m.totalActiveUsers} ativas)`
      )
    );
    retGrid.appendChild(
      buildMetricCard(
        'Cidades com atividade',
        String(m.cityDistribution.length),
        'Distribuição declarada sem GPS contínuo'
      )
    );

    const cityList = document.createElement('div');
    cityList.className = 'ttm-city-list';
    if (m.cityDistribution.length === 0) {
      const emptyCities = document.createElement('div');
      emptyCities.className = 'ttm-admin-cell-meta';
      emptyCities.textContent = 'Sem cidades declaradas em perfis Dating ativos.';
      cityList.appendChild(emptyCities);
    } else {
      m.cityDistribution.forEach((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'ttm-city-row';

        const cityName = document.createElement('span');
        cityName.className = 'ttm-city-name';
        cityName.textContent =
          row.countryCode && row.countryCode !== '--'
            ? `${row.city} (${row.countryCode})`
            : row.city;

        const cityMetric = document.createElement('span');
        cityMetric.className = 'ttm-city-metric';
        cityMetric.textContent = `${row.activeCount} · ${row.sharePercent}%`;

        rowEl.appendChild(cityName);
        rowEl.appendChild(cityMetric);
        cityList.appendChild(rowEl);
      });
    }

    listEl.appendChild(buildMetricsSection('Retenção & Geografia', [retGrid, cityList]));
  }

  function renderPhotoRows(): void {
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }

    updateSummary();

    if (photoRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-admin-empty';
      empty.textContent = isLoading
        ? 'A carregar fotografias...'
        : 'Nenhuma fotografia encontrada neste filtro.';
      listEl.appendChild(empty);
      loadMoreBtn.style.display = 'none';
      return;
    }

    photoRows.forEach((item) => {
      const cell = document.createElement('div');
      cell.className = `ttm-admin-cell ttm-admin-photo-cell is-${item.photoStatus}`;

      const rowBody = document.createElement('div');
      rowBody.className = 'ttm-admin-photo-row';

      if (item.photoUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'ttm-admin-photo-thumb';
        thumb.src = item.photoUrl;
        thumb.alt = item.displayName;
        thumb.loading = 'lazy';
        thumb.referrerPolicy = 'no-referrer';
        rowBody.appendChild(thumb);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'ttm-admin-photo-empty';
        placeholder.textContent = 'Sem foto';
        rowBody.appendChild(placeholder);
      }

      const info = document.createElement('div');
      info.className = 'ttm-admin-photo-info';

      const line1 = document.createElement('div');
      line1.className = 'ttm-admin-cell-head';

      const nameEl = document.createElement('strong');
      nameEl.className = 'ttm-admin-cell-name';
      nameEl.textContent = `${item.displayName}, ${item.age} · ${item.city || item.countryCode}`;

      const statusBadge = document.createElement('span');
      statusBadge.className = `ttm-admin-report-badge is-${
        item.photoStatus === 'approved' ? 'resolved' : item.photoStatus === 'rejected' ? 'dismissed' : 'pending'
      }`;
      statusBadge.textContent =
        item.photoStatus === 'approved'
          ? 'Aprovada'
          : item.photoStatus === 'rejected'
          ? 'Rejeitada'
          : 'Pendente';

      line1.appendChild(nameEl);
      line1.appendChild(statusBadge);

      const line2 = document.createElement('div');
      line2.className = 'ttm-admin-cell-meta';
      line2.textContent = `Actualizada: ${formatAdminActivationDate(item.photoUpdatedAt)} · Alvo: ${item.uid.slice(0, 14)}`;

      info.appendChild(line1);
      info.appendChild(line2);

      if (item.reportReason) {
        const repEl = document.createElement('div');
        repEl.className = 'ttm-admin-report-evidence';
        repEl.textContent = `Denúncia (${item.reportReason}): ${item.reportEvidence || ''}`;
        info.appendChild(repEl);
      } else if (item.photoModerationNote) {
        const noteEl = document.createElement('div');
        noteEl.className = 'ttm-admin-cell-meta';
        noteEl.textContent = `Nota: ${item.photoModerationNote}`;
        info.appendChild(noteEl);
      }

      const actionsEl = document.createElement('div');
      actionsEl.className = 'ttm-admin-report-actions';

      if (item.photoUrl && item.photoStatus !== 'approved') {
        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
        approveBtn.textContent = '[aprovar]';
        approveBtn.addEventListener('click', () => {
          void handleModeratePhoto(item, 'approved', approveBtn);
        });
        actionsEl.appendChild(approveBtn);
      }

      if (item.photoUrl || item.photoStatus === 'pending') {
        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'ttm-btn-mini ttm-btn-mini-danger';
        rejectBtn.textContent = '[rejeitar]';
        rejectBtn.addEventListener('click', () => {
          void handleModeratePhoto(item, 'rejected', rejectBtn);
        });
        actionsEl.appendChild(rejectBtn);
      }

      if (actionsEl.childElementCount > 0) {
        info.appendChild(actionsEl);
      }

      rowBody.appendChild(info);
      cell.appendChild(rowBody);
      listEl.appendChild(cell);
    });

    loadMoreBtn.style.display = photoHasMore ? 'block' : 'none';
    loadMoreBtn.disabled = isLoading;
    loadMoreBtn.textContent = isLoading ? 'A carregar...' : '[carregar mais 20]';
  }

  function renderReportRows(): void {
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }

    updateSummary();

    if (reportRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ttm-admin-empty';
      empty.textContent = isLoading
        ? 'A carregar denúncias...'
        : 'Nenhuma denúncia encontrada neste filtro.';
      listEl.appendChild(empty);
      loadMoreBtn.style.display = 'none';
      return;
    }

    reportRows.forEach((rep) => {
      const cell = document.createElement('div');
      cell.className = `ttm-admin-cell ttm-admin-report-cell is-${rep.status}`;

      const line1 = document.createElement('div');
      line1.className = 'ttm-admin-cell-head';

      const targetLabel = document.createElement('strong');
      targetLabel.className = 'ttm-admin-cell-name';
      targetLabel.textContent = `${rep.targetDisplayName || rep.targetUid.slice(0, 12)} · ${formatReportReasonLabel(rep.reason)}`;

      const statusBadge = document.createElement('span');
      statusBadge.className = `ttm-admin-report-badge is-${rep.status}`;
      statusBadge.textContent =
        rep.status === 'pending' ? 'Pendente' : rep.status === 'resolved' ? 'Resolvida' : 'Dispensada';

      line1.appendChild(targetLabel);
      line1.appendChild(statusBadge);

      const line2 = document.createElement('div');
      line2.className = 'ttm-admin-cell-meta';
      line2.textContent = `Origem: ${formatReportSourceLabel(rep.sourceType)} · Data: ${formatAdminActivationDate(rep.createdAt)} · Alvo: ${rep.targetUid.slice(0, 14)}`;

      const evidenceEl = document.createElement('div');
      evidenceEl.className = 'ttm-admin-report-evidence';
      evidenceEl.textContent = `Prova congelada: "${rep.evidenceSnapshot}"${rep.details ? ` — Nota: ${rep.details}` : ''}`;

      cell.appendChild(line1);
      cell.appendChild(line2);
      cell.appendChild(evidenceEl);

      if (rep.resolutionNote && rep.status !== 'pending') {
        const resMeta = document.createElement('div');
        resMeta.className = 'ttm-admin-cell-meta';
        resMeta.textContent = `Acção: ${rep.resolutionNote}`;
        cell.appendChild(resMeta);
      }

      if (rep.status === 'pending') {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'ttm-admin-report-actions';

        const isConfirmingSuspend = pendingSuspendReportId === rep.reportId;
        const suspendBtn = document.createElement('button');
        suspendBtn.type = 'button';
        suspendBtn.className = isConfirmingSuspend
          ? 'ttm-btn-mini ttm-btn-mini-danger is-armed'
          : 'ttm-btn-mini ttm-btn-mini-danger';
        suspendBtn.textContent = isConfirmingSuspend ? '[confirmar suspensão?]' : '[suspender conta]';
        suspendBtn.addEventListener('click', () => {
          if (pendingSuspendReportId !== rep.reportId) {
            pendingSuspendReportId = rep.reportId;
            renderReportRows();
            return;
          }
          void handleSuspendFromReport(rep, suspendBtn);
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'ttm-btn-mini';
        dismissBtn.textContent = '[dispensar]';
        dismissBtn.addEventListener('click', () => {
          void handleResolveOrDismissReport(rep, 'dismissed', 'dismissed', dismissBtn);
        });

        const resolveBtn = document.createElement('button');
        resolveBtn.type = 'button';
        resolveBtn.className = 'ttm-btn-mini ttm-btn-mini-primary';
        resolveBtn.textContent = '[resolver]';
        resolveBtn.addEventListener('click', () => {
          void handleResolveOrDismissReport(rep, 'resolved', 'none', resolveBtn);
        });

        actionsEl.appendChild(suspendBtn);
        actionsEl.appendChild(dismissBtn);
        actionsEl.appendChild(resolveBtn);
        cell.appendChild(actionsEl);
      }

      listEl.appendChild(cell);
    });

    loadMoreBtn.style.display = reportHasMore ? 'block' : 'none';
    loadMoreBtn.disabled = isLoading;
    loadMoreBtn.textContent = isLoading ? 'A carregar...' : '[carregar mais 20]';
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

  async function handleSuspendFromReport(
    rep: ModerationReport,
    btn: HTMLButtonElement
  ): Promise<void> {
    btn.disabled = true;
    setFeedback('');
    try {
      await suspendReportedAccountAndResolve({
        targetUid: rep.targetUid,
        reportId: rep.reportId,
        resolutionNote: 'Conta suspensa por moderação.',
      });
      pendingSuspendReportId = null;
      if (activeReportFilter === 'pending') {
        reportRows = reportRows.filter((r) => r.reportId !== rep.reportId);
      } else {
        rep.status = 'resolved';
        rep.resolutionAction = 'account_suspended';
        rep.resolutionNote = 'Conta suspensa por moderação.';
      }
      const userRow = rows.find((r) => r.uid === rep.targetUid);
      if (userRow) {
        userRow.active = false;
      }
      renderReportRows();
      setFeedback(`Conta de ${rep.targetDisplayName || rep.targetUid.slice(0, 10)} suspensa e denúncia resolvida.`);
    } catch (err: any) {
      btn.disabled = false;
      setFeedback(err?.message || 'Erro ao suspender conta reportada.', true);
    }
  }

  async function handleResolveOrDismissReport(
    rep: ModerationReport,
    nextStatus: 'resolved' | 'dismissed',
    action: 'none' | 'dismissed',
    btn: HTMLButtonElement
  ): Promise<void> {
    btn.disabled = true;
    setFeedback('');
    const note = nextStatus === 'dismissed' ? 'Alerta dispensado sem penalização.' : 'Denúncia resolvida.';
    try {
      await reviewAdminModerationReport({
        reportId: rep.reportId,
        status: nextStatus,
        resolutionAction: action,
        resolutionNote: note,
      });
      pendingSuspendReportId = null;
      if (activeReportFilter === 'pending') {
        reportRows = reportRows.filter((r) => r.reportId !== rep.reportId);
      } else {
        rep.status = nextStatus;
        rep.resolutionAction = action;
        rep.resolutionNote = note;
      }
      renderReportRows();
      setFeedback(note);
    } catch (err: any) {
      btn.disabled = false;
      setFeedback(err?.message || 'Erro ao atualizar denúncia.', true);
    }
  }

  async function loadInitialReportsPage(): Promise<void> {
    if (isLoading || isDestroyed) return;
    isLoading = true;
    reportRows = [];
    reportLastCursor = null;
    reportHasMore = false;
    setFeedback('');
    renderReportRows();

    try {
      const page = await fetchAdminModerationReportsPage({ filter: activeReportFilter });
      if (isDestroyed) return;
      reportRows = page.rows;
      reportLastCursor = page.lastCursor;
      reportHasMore = page.hasMore;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar denúncias.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed && activeTab === 'reports') renderReportRows();
    }
  }

  async function loadNextReportsPage(): Promise<void> {
    if (isLoading || !reportHasMore || !reportLastCursor || isDestroyed) return;
    isLoading = true;
    renderReportRows();
    setFeedback('');

    try {
      const page = await fetchAdminModerationReportsPage({
        filter: activeReportFilter,
        cursor: reportLastCursor,
      });
      if (isDestroyed) return;
      const seen = new Set(reportRows.map((r) => r.reportId));
      const fresh = page.rows.filter((r) => !seen.has(r.reportId));
      reportRows = [...reportRows, ...fresh];
      reportLastCursor = page.lastCursor;
      reportHasMore = page.hasMore;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar mais denúncias.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed && activeTab === 'reports') renderReportRows();
    }
  }

  async function handleModeratePhoto(
    item: AdminPhotoQueueItem,
    decision: 'approved' | 'rejected',
    btn: HTMLButtonElement
  ): Promise<void> {
    btn.disabled = true;
    setFeedback('');
    try {
      await moderateAdminDatingPhoto({
        targetUid: item.uid,
        decision,
        note: decision === 'rejected' ? 'Fotografia removida por não cumprir as diretrizes.' : undefined,
      });
      photoRows = photoRows.filter((p) => p.uid !== item.uid);
      renderPhotoRows();
      setFeedback(
        decision === 'approved'
          ? `Fotografia de ${item.displayName} aprovada.`
          : `Fotografia de ${item.displayName} rejeitada e removida.`
      );
    } catch (err: any) {
      btn.disabled = false;
      setFeedback(err?.message || 'Erro ao moderar fotografia.', true);
    }
  }

  async function loadInitialPhotosPage(): Promise<void> {
    if (isLoading || isDestroyed) return;
    isLoading = true;
    photoRows = [];
    photoLastCursor = null;
    photoHasMore = false;
    setFeedback('');
    renderPhotoRows();

    try {
      const page = await fetchAdminDatingPhotosPage({ filter: activePhotoFilter });
      if (isDestroyed) return;
      photoRows = page.rows;
      photoLastCursor = page.lastCursor;
      photoHasMore = page.hasMore;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar fila de fotografias.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed && activeTab === 'photos') renderPhotoRows();
    }
  }

  async function loadNextPhotosPage(): Promise<void> {
    if (isLoading || !photoHasMore || !photoLastCursor || isDestroyed) return;
    isLoading = true;
    renderPhotoRows();
    setFeedback('');

    try {
      const page = await fetchAdminDatingPhotosPage({
        filter: activePhotoFilter,
        cursor: photoLastCursor,
      });
      if (isDestroyed) return;
      const seen = new Set(photoRows.map((p) => p.uid));
      const fresh = page.rows.filter((p) => !seen.has(p.uid));
      photoRows = [...photoRows, ...fresh];
      photoLastCursor = page.lastCursor;
      photoHasMore = page.hasMore;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar mais fotografias.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed && activeTab === 'photos') renderPhotoRows();
    }
  }

  async function loadGrowthMetrics(): Promise<void> {
    if (isLoading || isDestroyed) return;
    isLoading = true;
    setFeedback('');
    renderMetricsView();

    try {
      const snap = await fetchAdminGrowthMetrics();
      if (isDestroyed) return;
      metricsSnapshot = snap;
    } catch (err: any) {
      if (!isDestroyed) {
        setFeedback(err?.message || 'Erro ao carregar indicadores de crescimento.', true);
      }
    } finally {
      isLoading = false;
      if (!isDestroyed && activeTab === 'metrics') renderMetricsView();
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
      if (!isDestroyed && activeTab === 'users') renderRows();
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
      if (!isDestroyed && activeTab === 'users') renderRows();
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
    pendingSuspendReportId = null;
    if (activeTab === 'metrics') {
      void loadGrowthMetrics();
      return;
    }
    if (activeTab === 'photos') {
      void loadInitialPhotosPage();
      return;
    }
    if (activeTab === 'reports') {
      void loadInitialReportsPage();
      return;
    }
    isSearchMode = false;
    searchInput.value = '';
    updateFilterButtons();
    void loadInitialPage();
  });

  loadMoreBtn.addEventListener('click', () => {
    if (activeTab === 'photos') {
      void loadNextPhotosPage();
      return;
    }
    if (activeTab === 'reports') {
      void loadNextReportsPage();
      return;
    }
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
