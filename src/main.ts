/**
 * Talk2TM — Entrypoint principal (main.ts)
 */
import './style.css';
import { startApp } from './app';

startApp().catch((err) => {
  console.error('Falha fatal na inicialização do Talk2TM:', err);
});
