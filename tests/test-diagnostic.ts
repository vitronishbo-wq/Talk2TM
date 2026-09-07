/**
 * Talk2TM — Executável de Diagnóstico testRealtimeSyncAtoB
 */
import { testRealtimeSyncAtoB } from '../src/firebase/diagnostic';

async function main() {
  console.log('Iniciando teste via testRealtimeSyncAtoB()...');
  try {
    const result = await testRealtimeSyncAtoB();
    if (result.success) {
      console.log(`\nDiagnóstico concluído com sucesso! Latência: ${result.latencyMs} ms`);
      process.exit(0);
    } else {
      console.error(`\nDiagnóstico falhou: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Erro na execução do diagnóstico:', err);
    process.exit(1);
  }
}

main();
