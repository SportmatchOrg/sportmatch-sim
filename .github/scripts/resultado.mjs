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

// CLAUDE.md le pide a Claude que termine con CORRIDA_FALLIDA, sola en la última línea, si no pudo hacer
// la corrida. Solo cuenta así: nombrarlo en una frase ("así que no corresponde `CORRIDA_FALLIDA`.") no
// es una corrida fallida (falso positivo del 11/11 08:10).
const fallida = /(^|\n)[\s`*]*CORRIDA_FALLIDA[\s`*]*$/.test(salida.result ?? '');
if (salida.is_error || salida.subtype !== 'success' || fallida) process.exit(1);
