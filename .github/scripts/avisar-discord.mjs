// Avisa en Discord que una corrida falló, distinguiendo "sin límite de uso" de otros errores.
import { existsSync, readFileSync } from 'node:fs';

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.log('Sin DISCORD_WEBHOOK: no se avisa.');
  process.exit(0);
}

const path = process.argv[2];
let detalle = 'Claude no devolvió salida (ver el log).';
let sinLimite = false;
if (path && existsSync(path) && readFileSync(path, 'utf8').trim()) {
  try {
    const salida = JSON.parse(readFileSync(path, 'utf8'));
    detalle = String(salida.result ?? salida.subtype ?? 'error desconocido').slice(0, 300);
    sinLimite = /limit|límite|usage|quota/i.test(detalle);
  } catch {
    detalle = readFileSync(path, 'utf8').slice(0, 300);
  }
}

const hora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
const content = [
  sinLimite
    ? `⚠️ **sportmatch-sim (${process.env.SIM_ENV ?? 'dev'})**: la corrida de las ${hora} no se hizo — la cuenta de Claude se quedó sin límite de uso.`
    : `❌ **sportmatch-sim (${process.env.SIM_ENV ?? 'dev'})**: la corrida de las ${hora} falló.`,
  `> ${detalle}`,
  process.env.RUN_URL ?? '',
].join('\n');

const res = await fetch(webhook, {
  method: 'POST',
  // Discord rechaza algunos User-Agent por defecto.
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; SportMatchSim/1.0)' },
  body: JSON.stringify({ content: content.slice(0, 1900) }),
});
console.log(`Discord: ${res.status}`);
