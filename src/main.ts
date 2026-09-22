/**
 * Talk2TM — Entrypoint principal (main.ts)
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { isValidSentryDsn, initObservability, captureException } from './observability';
import './style.css';
import { startApp } from './app';
import { testRealtimeSyncAtoB, testIdentityAcceptanceFlow } from './firebase/diagnostic';

// Inicialização do Sentry no topo do arquivo antes de qualquer renderização
const sentryDsn = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SENTRY_DSN)?.trim();
if (sentryDsn && isValidSentryDsn(sentryDsn)) {
  try {
    Sentry.init({
      dsn: sentryDsn,
      environment: (typeof import.meta !== 'undefined' && import.meta.env?.MODE) || 'production',
      sampleRate: 1.0,
    });
    console.log('[Sentry:React] Inicializado com sucesso antes da renderização.');
  } catch (err) {
    console.warn('[Sentry:React] Falha na inicialização:', err);
  }
}

// Inicializa a camada complementar de observabilidade e sanitização
initObservability();

// Expõe as ferramentas de diagnóstico e aceitação globalmente no console do navegador
if (typeof window !== 'undefined') {
  const win = window as unknown as {
    testRealtimeSyncAtoB: typeof testRealtimeSyncAtoB;
    testIdentityAcceptanceFlow: typeof testIdentityAcceptanceFlow;
  };
  win.testRealtimeSyncAtoB = testRealtimeSyncAtoB;
  win.testIdentityAcceptanceFlow = testIdentityAcceptanceFlow;

  console.log(
    '%c[Talk2TM] Ferramentas de Teste e Diagnóstico Disponíveis:%c\n' +
    '1. %cawait window.testIdentityAcceptanceFlow("Apelido")%c -> Executa o teste de aceitação controlado do cadastramento assistido.\n' +
    '2. %cawait window.testRealtimeSyncAtoB()%c -> Mede a latência em tempo real (A <-> B).',
    'font-weight: bold; color: #10b981;',
    'color: inherit;',
    'background: #1e293b; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-family: monospace;',
    'color: inherit;',
    'background: #1e293b; color: #a78bfa; padding: 2px 6px; border-radius: 4px; font-family: monospace;',
    'color: inherit;'
  );

  // Gatilhos via parâmetro de URL (ex: ?testIdentity=true ou ?testSync=true)
  if (window.location.search.includes('testIdentity=true')) {
    setTimeout(() => {
      console.log('[Talk2TM] Gatilho de URL detectado. Iniciando testIdentityAcceptanceFlow()...');
      testIdentityAcceptanceFlow('QA_Aceitacao_URL').catch((e) => console.error('Erro no teste de aceitação:', e));
    }, 1000);
  }

  if (window.location.search.includes('testSync=true') || window.location.search.includes('testRealtime=true')) {
    setTimeout(() => {
      console.log('[Talk2TM] Gatilho de URL detectado. Iniciando testRealtimeSyncAtoB()...');
      testRealtimeSyncAtoB().catch((e) => console.error('Erro no diagnóstico:', e));
    }, 1000);
  }
}

// Componente React raiz integrado com Sentry ErrorBoundary
function App(): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (containerRef.current) {
      startApp(containerRef.current).catch((err) => {
        captureException(err, { phase: 'startApp_bootstrap' });
        console.error('Falha fatal na inicialização do Talk2TM:', err);
      });
    }
  }, []);

  return React.createElement('div', {
    ref: containerRef,
    id: 'talk2tm-mount',
    className: 'w-full h-full',
  });
}

// Bloco de inicialização que envolve ReactDOM.createRoot para capturar erros de inicialização da aplicação
try {
  const rootElement = typeof document !== 'undefined' ? document.getElementById('root') : null;
  if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          Sentry.ErrorBoundary,
          { fallback: React.createElement('p', null, 'Ocorreu um erro inesperado.') },
          React.createElement(App)
        )
      )
    );
  } else {
    // Fallback para execução direta caso #root ainda não esteja montado no DOM
    startApp().catch((err) => {
      Sentry.captureException(err);
      captureException(err, { phase: 'startApp_fallback' });
      console.error('Falha fatal na inicialização do Talk2TM:', err);
    });
  }
} catch (initError) {
  Sentry.captureException(initError);
  captureException(initError, { phase: 'root_initialization_error' });
  console.error('Erro fatal durante ReactDOM.createRoot:', initError);
}


