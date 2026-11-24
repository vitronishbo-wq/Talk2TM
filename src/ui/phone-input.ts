/**
 * Talk2TM — Componente Único de Telefone Internacional (Seletor Pesquisável de País/Território + Número)
 * Reutilizado no Registo, Recuperação e Convites.
 *
 * - Suporta todos os 245 países e territórios (metadados Google libphonenumber).
 * - Permite pesquisa instantânea por nome (sem acentos), ISO ou indicativo (+264, 1, +44...).
 * - Destaca territórios que partilham indicativos (+1, +7, +39, +44, +262, etc.).
 */

import {
  PHONE_COUNTRIES,
  PhoneCountry,
  PhoneNormalizationResult,
  detectSuggestedCountry,
  findCountryByE164,
  getCountryByIso,
  getCountryDisplayName,
  normalizePhoneNumber,
  searchPhoneCountries,
} from '../utils/phone';
import { t } from '../i18n';

export interface PhoneInputFieldOptions {
  id?: string;
  name?: string;
  placeholder?: string;
  autocomplete?: AutoFill;
  variant?: 'default' | 'compact';
  onChange?: (raw: string, normalized: PhoneNormalizationResult, country: PhoneCountry) => void;
}

export interface PhoneInputField {
  wrapper: HTMLElement;
  input: HTMLInputElement;
  pickerButton: HTMLButtonElement;
  getCountry: () => PhoneCountry;
  setCountryIso: (iso: string) => void;
  openCountryPicker: () => void;
  validate: () => PhoneNormalizationResult;
  getValue: () => string;
  getE164OrRaw: () => string;
  refreshLocale: () => void;
  reset: () => void;
}

const PRIORITY_COUNTRY_ISOS: readonly string[] = [
  'AO',
  'NA',
  'MZ',
  'PT',
  'BR',
  'ZA',
  'CV',
  'ST',
  'GW',
  'TL',
  'US',
  'GB',
];

export function createPhoneInputField(options: PhoneInputFieldOptions = {}): PhoneInputField {
  const suggestedInitial = detectSuggestedCountry();
  let selectedCountry: PhoneCountry = suggestedInitial;
  let activeModalCleanup: (() => void) | null = null;

  const wrapper = document.createElement('div');
  wrapper.className =
    options.variant === 'compact' ? 'ttm-phone-group is-compact' : 'ttm-phone-group';

  const pickerButton = document.createElement('button');
  pickerButton.type = 'button';
  pickerButton.className = 'ttm-country-picker';
  pickerButton.setAttribute('aria-haspopup', 'dialog');
  pickerButton.setAttribute('aria-expanded', 'false');

  const badge = document.createElement('span');
  badge.className = 'ttm-country-badge';

  const caret = document.createElement('span');
  caret.className = 'ttm-country-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';

  pickerButton.appendChild(badge);
  pickerButton.appendChild(caret);

  const syncBadge = () => {
    const localizedName = getCountryDisplayName(selectedCountry);
    badge.textContent = `${selectedCountry.flag} ${selectedCountry.dialCode}`;
    pickerButton.title = t('phone.pickerTitle', {
      country: localizedName,
      dialCode: selectedCountry.dialCode,
    });
    pickerButton.setAttribute(
      'aria-label',
      t('phone.pickerAria', {
        country: localizedName,
        dialCode: selectedCountry.dialCode,
      })
    );
  };

  syncBadge();

  const input = document.createElement('input');
  input.type = 'tel';
  input.inputMode = 'tel';
  if (options.id) input.id = options.id;
  if (options.name) input.name = options.name;
  input.className =
    options.variant === 'compact'
      ? 'ttm-connect-input ttm-connect-input-phone ttm-phone-input'
      : 'ttm-input ttm-input-left ttm-phone-input';
  input.placeholder = options.placeholder || t('phone.placeholder');
  input.maxLength = 24;
  input.autocomplete = options.autocomplete || 'tel';

  const emitChange = () => {
    const raw = input.value.trim();
    if (raw.startsWith('+') || raw.startsWith('00')) {
      const matched = findCountryByE164(raw, selectedCountry.iso);
      if (matched && matched.iso !== selectedCountry.iso) {
        selectedCountry = matched;
        syncBadge();
      }
    }
    const res = raw ? normalizePhoneNumber(raw, selectedCountry.iso) : { valid: false };
    options.onChange?.(raw, res, selectedCountry);
  };

  const closeModal = () => {
    if (activeModalCleanup) {
      activeModalCleanup();
      activeModalCleanup = null;
    }
    pickerButton.setAttribute('aria-expanded', 'false');
  };

  const openCountryPicker = () => {
    closeModal();

    const mountTarget = wrapper.closest('.talk2tm-shell') || document.body;
    const backdrop = document.createElement('div');
    backdrop.className = 'ttm-country-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', t('phone.modalAria'));

    const sheet = document.createElement('div');
    sheet.className = 'ttm-country-modal';

    const topRow = document.createElement('div');
    topRow.className = 'ttm-country-modal-head';

    const heading = document.createElement('strong');
    heading.className = 'ttm-country-modal-title';
    heading.textContent = t('phone.modalTitle', { count: PHONE_COUNTRIES.length });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ttm-btn-mini';
    closeBtn.textContent = t('common.close');
    closeBtn.addEventListener('click', () => {
      closeModal();
      pickerButton.focus();
    });

    topRow.appendChild(heading);
    topRow.appendChild(closeBtn);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ttm-input ttm-input-left ttm-country-search';
    searchInput.placeholder = t('phone.searchPlaceholder');
    searchInput.autocomplete = 'off';
    searchInput.autocapitalize = 'none';

    const listEl = document.createElement('div');
    listEl.className = 'ttm-country-list';

    const createCountryRow = (country: PhoneCountry): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        country.iso === selectedCountry.iso ? 'ttm-country-item is-selected' : 'ttm-country-item';

      const flagEl = document.createElement('span');
      flagEl.className = 'ttm-country-item-flag';
      flagEl.textContent = country.flag;

      const nameEl = document.createElement('span');
      nameEl.className = 'ttm-country-item-name';
      nameEl.textContent = getCountryDisplayName(country);

      const isoEl = document.createElement('span');
      isoEl.className = 'ttm-country-item-iso';
      isoEl.textContent = country.iso;

      const codeEl = document.createElement('span');
      codeEl.className = 'ttm-country-item-code';
      codeEl.textContent = country.dialCode;

      btn.appendChild(flagEl);
      btn.appendChild(nameEl);
      btn.appendChild(isoEl);
      btn.appendChild(codeEl);

      btn.addEventListener('click', () => {
        selectedCountry = country;
        syncBadge();
        emitChange();
        closeModal();
        input.focus();
      });

      return btn;
    };

    const appendSectionLabel = (text: string) => {
      const label = document.createElement('div');
      label.className = 'ttm-country-section-label';
      label.textContent = text;
      listEl.appendChild(label);
    };

    const renderList = (query: string) => {
      listEl.innerHTML = '';
      const trimmed = query.trim();
      if (!trimmed) {
        const seen = new Set<string>();
        const priorityList: PhoneCountry[] = [];
        for (const iso of [selectedCountry.iso, suggestedInitial.iso, ...PRIORITY_COUNTRY_ISOS]) {
          if (seen.has(iso)) continue;
          seen.add(iso);
          priorityList.push(getCountryByIso(iso));
        }

        appendSectionLabel(t('phone.suggestedSection'));
        priorityList.forEach((c) => listEl.appendChild(createCountryRow(c)));

        appendSectionLabel(t('phone.allSection', { count: PHONE_COUNTRIES.length }));
        PHONE_COUNTRIES.forEach((c) => listEl.appendChild(createCountryRow(c)));
        return;
      }

      const matches = searchPhoneCountries(trimmed);
      if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ttm-country-empty';
        empty.textContent = t('phone.noResults');
        listEl.appendChild(empty);
        return;
      }

      matches.forEach((c) => listEl.appendChild(createCountryRow(c)));
    };

    renderList('');

    searchInput.addEventListener('input', () => {
      renderList(searchInput.value);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
        pickerButton.focus();
      }
    };

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeModal();
        pickerButton.focus();
      }
    });

    sheet.appendChild(topRow);
    sheet.appendChild(searchInput);
    sheet.appendChild(listEl);
    backdrop.appendChild(sheet);
    mountTarget.appendChild(backdrop);

    window.addEventListener('keydown', onKeyDown);
    pickerButton.setAttribute('aria-expanded', 'true');

    activeModalCleanup = () => {
      window.removeEventListener('keydown', onKeyDown);
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
    };

    setTimeout(() => {
      searchInput.focus();
    }, 30);
  };

  pickerButton.addEventListener('click', () => {
    openCountryPicker();
  });

  input.addEventListener('input', emitChange);

  wrapper.appendChild(pickerButton);
  wrapper.appendChild(input);

  return {
    wrapper,
    input,
    pickerButton,
    getCountry: () => selectedCountry,
    setCountryIso: (iso: string) => {
      selectedCountry = getCountryByIso(iso);
      syncBadge();
      emitChange();
    },
    openCountryPicker,
    validate: () => normalizePhoneNumber(input.value.trim(), selectedCountry.iso),
    getValue: () => input.value.trim(),
    getE164OrRaw: () => {
      const raw = input.value.trim();
      if (!raw) return '';
      const res = normalizePhoneNumber(raw, selectedCountry.iso);
      return res.valid && res.e164 ? res.e164 : raw;
    },
    refreshLocale: () => {
      syncBadge();
      if (!options.placeholder) {
        input.placeholder = t('phone.placeholder');
      }
      emitChange();
    },
    reset: () => {
      closeModal();
      input.value = '';
      selectedCountry = detectSuggestedCountry();
      syncBadge();
      emitChange();
    },
  };
}
