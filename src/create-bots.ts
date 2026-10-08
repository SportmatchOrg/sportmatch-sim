// Alta de las cuentas de Firebase de las personas y registro de su id en el back.
// Uso: node src/create-bots.ts [handle ...]   (sin argumentos: todas las que ya llegaron)
// También sincroniza el nombre si cambió en personas/pool.json.
import { ENTORNO, STATE, altaPersona, hoyAR, inicio, pool, writeJson } from './lib.ts';

const handles = process.argv.slice(2);
const hoy = hoyAR();
if (!inicio()) {
  writeJson(`${STATE}/inicio.json`, { fecha: hoy });
  console.log(`Simulación en ${ENTORNO} iniciada el ${hoy}.`);
}
const objetivo = pool().filter((p) =>
  handles.length ? handles.includes(p.handle) : p.llegada <= hoy,
);

for (const p of objetivo) await altaPersona(p);
