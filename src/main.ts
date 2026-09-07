/**
 * Talk2TM — Entrypoint principal (main.ts)
 */
import './style.css';
import { startApp } from './app';
import { testRealtimeSyncAtoB } from './firebase/diagnostic';

// Expõe a função de diagnóstico globalmente no console do navegador
if (typeof window !== 'undefined') {
  (window as unknown as { testRealtimeSyncAtoB: typeof testRealtimeSyncAtoB }).testRealtimeSyncAtoB = testRealtimeSyncAtoB;
  console.log(
    '%c[Talk2TM] Ferramenta de Diagnóstico Disponível:%c\nExecute %cawait window.testRealtimeSyncAtoB()%c no console para testar a sincronização em tempo real (A <-> B) e medir a latência.',
    'font-weight: bold; color: #10b981;',
    'color: inherit;',
    'background: #1e293b; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-family: monospace;',
    'color: inherit;'
  );

  // Gatilho via parâmetro de URL (ex: ?testSync=true ou ?testRealtime=true)
  if (window.location.search.includes('testSync=true') || window.location.search.includes('testRealtime=true')) {
    setTimeout(() => {
      console.log('[Talk2TM] Gatilho de URL detectado. Iniciando testRealtimeSyncAtoB()...');
      testRealtimeSyncAtoB().catch((e) => console.error('Erro no diagnóstico:', e));
    }, 1000);
  }
}

startApp().catch((err) => {
  console.error('Falha fatal na inicialização do Talk2TM:', err);
});

