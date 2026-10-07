// Alta de las cuentas de Firebase de las personas y registro de su id en el back.
// Uso: node src/create-bots.ts [handle ...]   (sin argumentos: todas las que ya llegaron)
// También sincroniza el nombre si cambió en personas/pool.json.
import { actualizarNombre, api, guardarUsuarios, hoyAR, inicio, pool, signUp, usuarios, writeJson } from './lib.ts';

const handles = process.argv.slice(2);
const hoy = hoyAR();
if (!inicio()) {
  writeJson('state/inicio.json', { fecha: hoy });
  console.log(`Simulación iniciada el ${hoy}.`);
}
const objetivo = pool().filter((p) =>
  handles.length ? handles.includes(p.handle) : p.llegada <= hoy,
);
const ids = usuarios();

for (const p of objetivo) {
  if (!ids[p.handle]) {
    try {
      await signUp(p);
    } catch (error) {
      if (!String(error).includes('EMAIL_EXISTS')) throw error;
    }
  }
  // El primer request autenticado crea el User en la base (FirebaseAuthGuard → ensureExists).
  const me = await api<{ id: string; name: string }>(p.handle, 'GET', '/users/me');
  if (me.name !== p.nombre) {
    await actualizarNombre(p);
    await api(p.handle, 'PATCH', `/users/${me.id}`, { name: p.nombre });
    console.log(`${p.handle}: renombrado de "${me.name}" a "${p.nombre}"`);
  }
  if (!ids[p.handle]) console.log(`${p.handle} → ${me.id}`);
  ids[p.handle] = me.id;
  guardarUsuarios(ids);
}
