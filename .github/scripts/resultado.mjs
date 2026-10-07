// Lee la salida JSON de `claude -p` y sale con error si la corrida no terminó bien.
// Imprime el resumen y el consumo para que queden en el log del workflow.
import { readFileSync } from 'node:fs';

const salida = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const usage = salida.usage ?? {};

console.log(salida.result ?? '(sin resultado)');
console.log(
  `\nturnos: ${salida.num_turns} · duración: ${Math.round((salida.duration_ms ?? 0) / 1000)} s · ` +
    `tokens entrada: ${usage.input_tokens ?? '?'} (+ caché ${usage.cache_read_input_tokens ?? 0} leída, ` +
    `${usage.cache_creation_input_tokens ?? 0} escrita) · salida: ${usage.output_tokens ?? '?'} · ` +
    `costo equivalente API: US$ ${salida.total_cost_usd?.toFixed(2) ?? '?'}`,
);

if (salida.is_error || salida.subtype !== 'success') process.exit(1);
