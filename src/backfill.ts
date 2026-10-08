// Retrotrae la simulación: escribe en la base, con sus fechas reales, lo que habrían hecho los bots si
// la simulación hubiera arrancado antes. Es una carga única, como un seed: no pasa por la API porque la
// API no acepta partidos en el pasado y fecha todo con `now()`.
//
//   node src/backfill.ts --desde 2026-09-30             simula e imprime el resumen (no escribe nada)
//   node src/backfill.ts --desde 2026-09-30 --aplicar   da de alta a las personas que faltan, escribe en
//                                                         la base (una transacción) y actualiza state/
//
// Usa DATABASE_URL_DEV / DATABASE_URL_PROD (según SIM_ENV) del .env. Corre la misma lógica que las
// corridas en vivo: 8 corridas por día, los mismos arquetipos y dados (`hoy`, `sortear`), y en lugar de
// Claude decide con reglas simples. Hasta la primera acción en vivo (acciones.log) hace todo; desde ahí
// hasta ahora solo lo obligatorio de sus propios partidos (aceptar, cancelar, calificar, bajas, asistencia),
// porque lo voluntario de esos días ya lo hicieron las corridas en vivo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  CUPOS,
  ENTORNO,
  ROOT,
  STATE,
  activa,
  altaPersona,
  arquetipoDe,
  guardarPartidos,
  inicio,
  partidos,
  pool,
  puedeOrganizar,
  readJson,
  usuarios,
  writeJson,
  type PartidoRegistrado,
  type Persona,
} from './lib.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const APLICAR = args.includes('--aplicar');
const DESDE = flag('desde');
const SEMILLA = Number(flag('semilla') ?? 2026);

const HORA = 3_600_000;
const DIA = 24 * HORA;
const AR = 3 * HORA; // Argentina es UTC−3 todo el año
const HORAS_CORRIDA = [0, 3, 6, 9, 12, 15, 18, 21]; // simular.yml: cron `10 */3 * * *`, hora argentina
const MAX_POR_CORRIDA = 12;
const MAX_ACCIONES = 3;
const BAJA_TARDE_MS = 2 * HORA;
const ESCALA_BAJA_TARDE = 2;
const VENTANA_RATING_MS = 48 * HORA;
const RATINGS_PER_PLAYER = 3;

// --- azar con semilla (el dry-run y el --aplicar sortean lo mismo) --------------

let estado = SEMILLA | 0;
const azar = () => {
  estado = (estado + 0x6d2b79f5) | 0;
  let v = Math.imul(estado ^ (estado >>> 15), 1 | estado);
  v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
  return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
};
const tirar = (p: number) => azar() < p;
const uno = <T>(xs: T[]): T => xs[Math.floor(azar() * xs.length)];
const entre = (min: number, max: number) => min + Math.floor(azar() * (max - min + 1));
const mezclar = <T>(xs: T[]) => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const cuid = () => 'c' + Array.from({ length: 24 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(azar() * 36)]).join('');

// --- fechas ---------------------------------------------------------------------

const diaAR = (ms: number) => new Date(ms - AR).toISOString().slice(0, 10);
const diaSemana = (ms: number) => new Date(ms - AR).getUTCDay();
const enAR = (dia: string, hora: number, minuto = 0) =>
  Date.parse(`${dia}T${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}:00-03:00`);
const sumarDias = (dia: string, n: number) => new Date(Date.parse(dia) + n * DIA).toISOString().slice(0, 10);
const legible = (ms: number) => new Date(ms - AR).toISOString().slice(0, 16).replace('T', ' ');

// --- copia de back/src/utils/ratings/assign-rating-targets.ts --------------------
// Los targets que el back le asigna a cada jugador; el backfill tiene que calificar a los mismos.

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
const seededShuffle = (items: string[], seed: string) => {
  let s = hashString(seed) | 0;
  const random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let v = Math.imul(s ^ (s >>> 15), 1 | s);
    v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const assignRatingTargets = (matchId: string, playerIds: string[], raterId: string) => {
  const ordered = seededShuffle([...new Set(playerIds)].sort(), matchId);
  const position = ordered.indexOf(raterId);
  if (position === -1) return [];
  const count = Math.min(RATINGS_PER_PLAYER, ordered.length - 1);
  return Array.from({ length: count }, (_, step) => ordered[(position + step + 1) % ordered.length]);
};

// --- datos de las personas --------------------------------------------------------

type Lugar = { nombre: string; lat: number; lng: number; deportes: string[] };
const LUGARES = readJson<Lugar[]>('personas/lugares.json', []);
const CENTROS: Record<string, [number, number]> = {
  pilar: [-34.45, -58.89],
  norte: [-34.42, -58.6],
  caba: [-34.57, -58.43],
};
const zonaDe = (l: Lugar) =>
  Object.entries(CENTROS).sort(
    ([, a], [, b]) => Math.hypot(l.lat - a[0], l.lng - a[1]) - Math.hypot(l.lat - b[0], l.lng - b[1]),
  )[0][0];


const MOTIVOS = ['no se llenó', 'llueve', 'se lesionó', 'se complicó con el trabajo', 'no se juntó la gente', 'cerraron la cancha'];
const COMENTARIOS = ['buena onda, para repetir', 'puntual y buen compañero', 'juega bien, se nota que tiene años', 'muy buen partido', 'llegó tarde pero rindió', 'un poco calentón pero bien', 'excelente, lo invito de nuevo'];

// --- simulación -------------------------------------------------------------------

type Partido = {
  id: string;
  organizador: string;
  deporte: string;
  nivel: string;
  fecha: number;
  lugar: Lugar;
  cupo: number;
  descripcion: string | null;
  creado: number;
  cancelado: { motivo: string; en: number } | null;
  lleno: number | null;
  jugadores: Map<string, number>; // handle → cuándo entró
  solicitudes: Map<string, { id: string; estado: 'PENDING' | 'ACCEPTED' | 'REJECTED'; creada: number; actualizada: number }>;
  bajasTarde: { handle: string; en: number }[];
  bajasSorteadas: boolean;
  cancelSorteado: boolean;
  asistencia: Record<string, boolean> | null;
  calificaran: string[];
  calificaron: string[];
  ratings: { rater: string; rated: string; puntaje: number; comentario: string | null; en: number }[];
  noShows: { reporter: string; reported: string; en: number }[];
};

if (!DESDE || !/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) throw new Error('Uso: node src/backfill.ts --desde YYYY-MM-DD [--aplicar] [--semilla N]');
const inicioActual = inicio();
if (!inicioActual) throw new Error(`La simulación de ${ENTORNO} no arrancó todavía: no hay nada que retrotraer.`);
// --reconstruir <ISO de cuando se aplicó> --corte <inicio previo>: rehace solo diario/ y backfill.log
// de un backfill ya escrito en la base (misma semilla, mismo "ahora"); verifica contra partidos.json.
const RECONSTRUIR = flag('reconstruir');
if (!RECONSTRUIR && DESDE >= inicioActual) throw new Error(`${ENTORNO} ya arranca el ${inicioActual}: --desde tiene que ser anterior.`);
if (existsSync(join(ROOT, STATE, 'backfill.log'))) throw new Error(`${ENTORNO} ya tiene un backfill (${STATE}/backfill.log).`);

// Primera acción en vivo: hasta acá el backfill hace todo; después, solo lo obligatorio de sus partidos.
const logVivo = join(ROOT, STATE, 'acciones.log');
const primeraVivo = existsSync(logVivo) ? Date.parse(readFileSync(logVivo, 'utf8').split(' ')[0]) : NaN;
const CORTE = RECONSTRUIR ? enAR(flag('corte')!, 0) : Number.isNaN(primeraVivo) ? enAR(inicioActual, 0) : primeraVivo;
const AHORA = RECONSTRUIR ? Date.parse(RECONSTRUIR) : Date.now();

// Con el inicio corrido, las llegadas se corren igual: llegada = DESDE + diaLlegada.
// inicio.json se mueve recién después de escribir en la base.
const PERSONAS: Persona[] = pool().map((p) => ({ ...p, llegada: sumarDias(DESDE, p.diaLlegada) }));
const llegaron = PERSONAS.filter((p) => p.llegada <= diaAR(AHORA));
const porHandle = new Map(PERSONAS.map((p) => [p.handle, p]));
const altaEn = new Map<string, number>(); // handle → createdAt del User
for (const p of llegaron) altaEn.set(p.handle, enAR(p.llegada, entre(8, 22), entre(0, 59)));

const registro: Partido[] = [];
const actividad = new Set<string>(); // `${handle}|${dia}`
const acciones: { en: number; linea: string }[] = [];
const diario = new Map<string, string[]>();
const anotar = (handle: string, en: number, texto: string) => {
  acciones.push({ en, linea: `${handle} ${texto}` });
  diario.set(handle, [...(diario.get(handle) ?? []), `- ${legible(en)} · ${texto}`]);
};

const jugadoresDe = (m: Partido) => [m.organizador, ...m.jugadores.keys()];
const nombre = (h: string) => porHandle.get(h)!.nombre;
const fechaCorta = (ms: number) =>
  `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][diaSemana(ms)]} ${legible(ms).slice(8, 10)}/${legible(ms).slice(5, 7)} ${legible(ms).slice(11)}`;

/** `sortear` de cli.ts: bajas tardías en las 2 h previas y asistencia cuando ya se jugó. */
const sortear = (t: number) => {
  for (const m of registro) {
    if (m.cancelado) continue;
    if (m.asistencia) {
      if (t - m.fecha >= VENTANA_RATING_MS) m.calificaran = [...m.calificaron];
      continue;
    }
    if (!m.bajasSorteadas && m.fecha > t && m.fecha - t < BAJA_TARDE_MS) {
      for (const h of [...m.jugadores.keys()]) {
        if (!tirar(Math.min(1, arquetipoDe(porHandle.get(h)!).p_bajaTarde * ESCALA_BAJA_TARDE))) continue;
        m.jugadores.delete(h);
        m.solicitudes.delete(h); // removeParticipant borra también la solicitud
        m.bajasTarde.push({ handle: h, en: t });
        anotar(h, t, `se bajó a último momento del ${m.deporte.toLowerCase()} del ${fechaCorta(m.fecha)}`);
      }
      m.bajasSorteadas = true;
    }
    if (m.fecha <= t) {
      m.asistencia = { [m.organizador]: true };
      for (const h of m.jugadores.keys()) m.asistencia[h] = !tirar(arquetipoDe(porHandle.get(h)!).p_noShow);
      m.calificaran =
        t - m.fecha < VENTANA_RATING_MS
          ? Object.entries(m.asistencia).filter(([h, fue]) => fue && tirar(arquetipoDe(porHandle.get(h)!).p_calificar)).map(([h]) => h)
          : [];
    }
  }
};

const revisar = (h: string, m: Partido, t: number) => {
  const p = porHandle.get(h)!;
  const pAceptar = p.arquetipo === 'organizador-exigente' ? 0.67 : 0.95;
  for (const [quien, s] of m.solicitudes) {
    if (s.estado !== 'PENDING') continue;
    const hayLugar = m.jugadores.size < m.cupo;
    if (hayLugar && tirar(pAceptar)) {
      s.estado = 'ACCEPTED';
      m.jugadores.set(quien, t);
      if (m.jugadores.size === m.cupo && m.lleno === null) m.lleno = t;
      anotar(h, t, `aceptó a ${nombre(quien)} en su ${m.deporte.toLowerCase()} del ${fechaCorta(m.fecha)}`);
    } else {
      s.estado = 'REJECTED';
      anotar(h, t, `rechazó a ${nombre(quien)} en su ${m.deporte.toLowerCase()} del ${fechaCorta(m.fecha)}${hayLugar ? '' : ' (ya estaba lleno)'}`);
    }
    s.actualizada = t;
  }
};

const puntaje = (p: Persona) => {
  const r = azar();
  if (p.arquetipo === 'calificador-severo') return r < 0.4 ? 2 : r < 0.75 ? 3 : r < 0.95 ? 4 : 5;
  if (p.arquetipo === 'novato') return r < 0.7 ? 5 : 4;
  return r < 0.45 ? 5 : r < 0.85 ? 4 : r < 0.97 ? 3 : 2;
};

const calificar = (h: string, m: Partido, t: number) => {
  const ids = jugadoresDe(m);
  const noShows = ids.filter((x) => m.asistencia![x] === false);
  const targets = assignRatingTargets(m.id, ids.map((x) => uid(x)), uid(h))
    .map((id) => handleDeUid.get(id)!)
    .filter((x) => !noShows.includes(x));
  for (const rated of targets)
    m.ratings.push({ rater: h, rated, puntaje: puntaje(porHandle.get(h)!), comentario: tirar(1 / 3) ? uno(COMENTARIOS) : null, en: t });
  for (const reported of noShows) m.noShows.push({ reporter: h, reported, en: t });
  m.calificaron.push(h);
  anotar(h, t, `calificó el ${m.deporte.toLowerCase()} del ${fechaCorta(m.fecha)}${noShows.length ? ` (reportó que faltó ${noShows.map(nombre).join(', ')})` : ''}`);
};

const organizar = (h: string, t: number) => {
  const p = porHandle.get(h)!;
  const deporte = uno(p.deportes);
  const lugares = LUGARES.filter((l) => l.deportes.includes(deporte));
  const cerca = lugares.filter((l) => zonaDe(l) === p.zona);
  if (!lugares.length) return false;
  const lugar = uno(cerca.length ? cerca : lugares);
  const hoy = diaAR(t);
  const finde = p.arquetipo === 'organizador-finde';
  const opciones = Array.from({ length: 6 }, (_, i) => sumarDias(hoy, i + 1)).filter(
    (d) => !finde || [0, 6].includes(new Date(d).getUTCDay()),
  );
  if (!opciones.length) return false;
  const dia = uno(opciones);
  const esFinde = [0, 6].includes(new Date(dia).getUTCDay());
  const hora = finde || (esFinde && tirar(0.7)) ? entre(9, 11) : entre(19, 22);
  const nivel =
    p.arquetipo === 'organizador-exigente' ? 'ADVANCED' : p.arquetipo === 'novato' ? 'BEGINNER' : tirar(0.6) ? 'INTERMEDIATE' : uno(['BEGINNER', 'ADVANCED']);
  const m: Partido = {
    id: cuid(),
    organizador: h,
    deporte,
    nivel,
    fecha: enAR(dia, hora, uno([0, 0, 30])),
    lugar,
    cupo: uno(CUPOS[deporte]),
    descripcion: null,
    creado: t,
    cancelado: null,
    lleno: null,
    jugadores: new Map(),
    solicitudes: new Map(),
    bajasTarde: [],
    bajasSorteadas: false,
    cancelSorteado: false,
    asistencia: null,
    calificaran: [],
    calificaron: [],
    ratings: [],
    noShows: [],
  };
  registro.push(m);
  anotar(h, t, `organizó un ${deporte.toLowerCase()} ${nivel} para el ${fechaCorta(m.fecha)} en ${lugar.nombre}`);
  return true;
};

const unirse = (h: string, t: number) => {
  const p = porHandle.get(h)!;
  if (p.arquetipo === 'curioso' && !tirar(0.25)) return false;
  const posibles = registro.filter(
    (m) =>
      !m.cancelado &&
      m.fecha > t + HORA &&
      m.organizador !== h &&
      !m.jugadores.has(h) &&
      !m.solicitudes.has(h) &&
      m.jugadores.size < m.cupo &&
      p.deportes.includes(m.deporte) &&
      !(p.arquetipo === 'novato' && m.nivel === 'ADVANCED'),
  );
  const cerca = posibles.filter((m) => zonaDe(m.lugar) === p.zona);
  if (!posibles.length) return false;
  const m = uno(cerca.length && tirar(0.8) ? cerca : posibles);
  m.solicitudes.set(h, { id: cuid(), estado: 'PENDING', creada: t, actualizada: t });
  anotar(h, t, `pidió unirse al ${m.deporte.toLowerCase()} de ${nombre(m.organizador)} del ${fechaCorta(m.fecha)} en ${m.lugar.nombre}`);
  return true;
};

/** Una corrida: `sortear` + `hoy` + lo que haría cada persona que entra. */
const corrida = (t: number) => {
  sortear(t);
  const dia = diaAR(t);
  const voluntario = t < CORTE;
  const conTarea: [string, (() => void)[]][] = [];
  const sinTarea: string[] = [];

  for (const p of llegaron) {
    if (altaEn.get(p.handle)! > t) continue;
    const a = arquetipoDe(p);
    const tareas: (() => void)[] = [];
    for (const m of registro) {
      if (m.cancelado) continue;
      if (m.organizador === p.handle && m.fecha > t && [...m.solicitudes.values()].some((s) => s.estado === 'PENDING'))
        tareas.push(() => revisar(p.handle, m, t));
      if (m.calificaran.includes(p.handle) && !m.calificaron.includes(p.handle))
        tareas.push(() => calificar(p.handle, m, t));
      const vacio = m.jugadores.size + 1 < m.cupo / 2;
      const enVentana = m.organizador === p.handle && vacio && m.fecha > t && m.fecha - t < DIA;
      if (enVentana && !m.cancelSorteado && ((m.cancelSorteado = true), tirar(a.p_cancelar)))
        tareas.push(() => {
          m.cancelado = { motivo: uno(MOTIVOS), en: t };
          anotar(p.handle, t, `canceló su ${m.deporte.toLowerCase()} del ${fechaCorta(m.fecha)} (iba ${m.jugadores.size + 1}/${m.cupo})`);
        });
    }
    if (tareas.length) conTarea.push([p.handle, tareas]);
    else if (voluntario && tirar(activa(p, dia, diaSemana(t)) ? a.actividad : (a.p_volver ?? 0.03))) sinTarea.push(p.handle);
  }

  const elegidos = [...conTarea, ...mezclar(sinTarea).map((h): [string, (() => void)[]] => [h, []])].slice(
    0,
    Math.max(MAX_POR_CORRIDA, conTarea.length),
  );
  elegidos.forEach(([h, tareas], i) => {
    const en = t + i * 40_000; // cada persona entra unos segundos después de la anterior
    actividad.add(`${h}|${diaAR(en)}`);
    let hechas = 0;
    for (const tarea of tareas.slice(0, MAX_ACCIONES)) {
      tarea();
      hechas++;
    }
    if (!voluntario) return;
    const a = arquetipoDe(porHandle.get(h)!);
    const suyos = registro.filter((m) => m.organizador === h).map((m) => ({ ...m, cancelado: m.cancelado !== null }));
    if (hechas < MAX_ACCIONES && puedeOrganizar(porHandle.get(h)!, suyos, en) && tirar(a.p_organizar) && organizar(h, en)) hechas++;
    if (hechas < MAX_ACCIONES && tirar(a.p_unirse)) unirse(h, en);
  });
};

// ids: los que ya tienen cuenta salen de usuarios.json; al resto se le da de alta con --aplicar.
const faltan = llegaron.filter((p) => !usuarios()[p.handle]);
if (APLICAR) for (const p of faltan) await altaPersona(p);
const ids = { ...usuarios(), ...Object.fromEntries(faltan.filter((p) => !usuarios()[p.handle]).map((p) => [p.handle, `(nuevo:${p.handle})`])) };
const uid = (h: string) => ids[h];
const handleDeUid = new Map(Object.entries(ids).map(([h, id]) => [id, h]));

for (let dia = DESDE; dia <= diaAR(AHORA); dia = sumarDias(dia, 1))
  for (const hora of HORAS_CORRIDA) {
    const t = enAR(dia, hora, 10) + entre(0, 40) * 60_000; // GitHub demora los cron
    if (t <= AHORA) corrida(t);
  }

// --- resumen ----------------------------------------------------------------------

const porDia = new Map<string, Record<string, number>>();
const contar = (ms: number, k: string, n = 1) => {
  const d = diaAR(ms);
  const fila = porDia.get(d) ?? {};
  fila[k] = (fila[k] ?? 0) + n;
  porDia.set(d, fila);
};
for (const m of registro) {
  contar(m.creado, 'creados');
  if (m.lleno) contar(m.lleno, 'llenos');
  if (m.cancelado) contar(m.cancelado.en, 'cancelados');
  if (m.asistencia) {
    contar(m.fecha, 'jugados');
    contar(m.fecha, 'faltas', Object.values(m.asistencia).filter((f) => !f).length);
  }
  for (const s of m.solicitudes.values()) contar(s.creada, 'solicitudes');
  for (const b of m.bajasTarde) contar(b.en, 'bajasTarde');
  for (const r of m.ratings) contar(r.en, 'ratings');
}
for (const k of actividad) contar(enAR(k.split('|')[1], 12), 'activos');
for (const p of llegaron) contar(altaEn.get(p.handle)!, 'altas');

const columnas = ['altas', 'activos', 'creados', 'solicitudes', 'llenos', 'cancelados', 'jugados', 'faltas', 'bajasTarde', 'ratings'];
console.log(`Backfill de ${ENTORNO} desde ${DESDE} (semilla ${SEMILLA}); en vivo desde ${legible(CORTE)}.`);
console.log(['día       ', ...columnas].join('\t'));
for (const [d, fila] of [...porDia].sort())
  console.log([d, ...columnas.map((c) => String(fila[c] ?? 0))].join('\t'));
const llenos = registro.filter((m) => m.lleno && !m.cancelado);
const horas = llenos.map((m) => (m.lleno! - m.creado) / HORA).sort((a, b) => a - b);
console.log(
  `partidos: ${registro.length} · llenos ${llenos.length} (mediana ${horas.length ? horas[Math.floor(horas.length / 2)].toFixed(1) : '—'} h) · ` +
    `cancelados ${registro.filter((m) => m.cancelado).length} · próximos ${registro.filter((m) => !m.cancelado && m.fecha > AHORA).length} · ` +
    `personas ${llegaron.length} (${faltan.length} nuevas)`,
);

// Qué pasó con los partidos que ya se jugaron o se cancelaron, por deporte.
const cerrados = registro.filter((m) => m.cancelado || m.fecha <= AHORA);
console.log('\ndeporte\tcerrados\tllenos\tjugados sin llenar (ocupación media)\tcancelados\tlugares ofrecidos\tsolicitudes');
for (const d of Object.keys(CUPOS)) {
  const ms = cerrados.filter((m) => m.deporte === d);
  const jugadosSinLlenar = ms.filter((m) => !m.cancelado && !m.lleno);
  const ocup = jugadosSinLlenar.map((m) => m.jugadores.size / m.cupo);
  console.log([d, ms.length, ms.filter((m) => m.lleno && !m.cancelado).length,
    `${jugadosSinLlenar.length} (${ocup.length ? Math.round((100 * ocup.reduce((a, b) => a + b, 0)) / ocup.length) : 0}%)`,
    ms.filter((m) => m.cancelado).length, ms.reduce((a, m) => a + m.cupo, 0),
    ms.reduce((a, m) => a + m.solicitudes.size + m.bajasTarde.length, 0)].join('\t'));
}
const porArquetipo = new Map<string, number>();
for (const m of registro) porArquetipo.set(porHandle.get(m.organizador)!.arquetipo, (porArquetipo.get(porHandle.get(m.organizador)!.arquetipo) ?? 0) + 1);
console.log(`\norganizan: ${[...porArquetipo].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`);

{
  // Aproximación de los KPIs del back sobre los partidos con fecha ya pasada.
  const cohorte = registro.filter((m) => m.fecha <= AHORA);
  const activos = cohorte.filter((m) => !m.cancelado);
  const ttf = activos.filter((m) => m.lleno).map((m) => (m.lleno! - m.creado) / HORA).sort((a, b) => a - b);
  const plantel = activos.reduce((n, m) => n + 1 + m.jugadores.size, 0);
  const faltas = activos.reduce((n, m) => n + Object.values(m.asistencia ?? {}).filter((f) => !f).length, 0);
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : NaN);
  // Como el back: lleno = participantes actuales >= cupo (una baja tardía lo vuelve a abrir).
  console.log(`KPIS completion=${pct(activos.filter((m) => m.jugadores.size >= m.cupo).length, activos.length)}% ` +
    `cancel=${pct(cohorte.length - activos.length, cohorte.length)}% ttf=${ttf.length ? ttf[Math.floor(ttf.length / 2)].toFixed(0) : '-'}h ` +
    `ocupacion=${pct(activos.reduce((n, m) => n + m.jugadores.size, 0), activos.reduce((n, m) => n + m.cupo, 0))}% ` +
    `noshow=${pct(faltas, plantel)}% jugados=${activos.length} jugadores/partido=${(plantel / Math.max(1, activos.length)).toFixed(1)}`);
}

if (RECONSTRUIR) {
  const escritos = partidos();
  const distintos = registro.filter((m) => {
    const e = escritos[m.id];
    return !e || JSON.stringify([...e.jugadores].sort()) !== JSON.stringify([...m.jugadores.keys()].sort()) ||
      JSON.stringify(e.asistencia) !== JSON.stringify(m.asistencia) || e.cancelado !== (m.cancelado !== null);
  });
  if (distintos.length || registro.length !== Object.keys(escritos).filter((id) => registro.some((m) => m.id === id)).length)
    throw new Error(`La reconstrucción no coincide con partidos.json (${distintos.length} partidos distintos): no se escribe nada.`);
  console.log(`\nReconstrucción idéntica a partidos.json (${registro.length} partidos).`);
}

if (!APLICAR && !RECONSTRUIR) {
  console.log('\nDry-run: no se escribió nada. Para aplicarlo, repetir con --aplicar.');
  process.exit(0);
}

// --- escritura ----------------------------------------------------------------------

if (RECONSTRUIR) {
  escribirDiarioYLog();
  process.exit(0);
}

const url = process.env[`DATABASE_URL_${ENTORNO.toUpperCase()}`];
if (!url) throw new Error(`Falta DATABASE_URL_${ENTORNO.toUpperCase()} en el .env`);
const db = new pg.Client({ connectionString: url });
await db.connect();

const insertar = async (tabla: string, columnasSql: string[], filas: unknown[][], tipos: Record<number, string> = {}, sufijo = '') => {
  for (let i = 0; i < filas.length; i += 500) {
    const lote = filas.slice(i, i + 500);
    const valores: unknown[] = [];
    const tuplas = lote.map((fila) =>
      `(${fila.map((v, j) => {
        valores.push(v);
        return `$${valores.length}${tipos[j] ? `::${tipos[j]}` : ''}`;
      }).join(', ')})`,
    );
    await db.query(`INSERT INTO ${tabla} (${columnasSql.map((c) => `"${c}"`).join(', ')}) VALUES ${tuplas.join(', ')} ${sufijo}`, valores);
  }
};
const fecha = (ms: number | null) => (ms === null ? null : new Date(ms));

try {
  // Que la base sea la del entorno: todos los ids de usuarios.json tienen que existir y ser bots.
  const { rows: existentes } = await db.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ANY($1)', [Object.values(ids)]);
  const mal = existentes.filter((u) => !u.email.endsWith('@sim-sportmatch.test'));
  if (existentes.length !== Object.keys(ids).length || mal.length)
    throw new Error(`La base no coincide con state/${ENTORNO}/usuarios.json (${existentes.length}/${Object.keys(ids).length} bots encontrados). ¿DATABASE_URL de otro entorno?`);
  const { rows: deportes } = await db.query<{ id: string; name: string }>('SELECT id, name FROM sports');
  const sportId = Object.fromEntries(deportes.map((s) => [s.name, s.id]));

  await db.query('BEGIN');
  for (const [h, en] of altaEn)
    await db.query('UPDATE users SET "createdAt" = $1 WHERE id = $2 AND "createdAt" > $1', [new Date(en), uid(h)]);

  await insertar(
    'matches',
    ['id', 'sportId', 'level', 'date', 'location', 'latitude', 'longitude', 'capacity', 'description', 'status', 'cancelReason', 'canceledAt', 'filledAt', 'organizerId', 'createdAt', 'updatedAt'],
    registro.map((m) => {
      const ultimo = Math.max(m.creado, m.lleno ?? 0, m.cancelado?.en ?? 0);
      return [m.id, sportId[m.deporte], m.nivel, fecha(m.fecha), m.lugar.nombre, m.lugar.lat, m.lugar.lng, m.cupo, m.descripcion,
        m.cancelado ? 'CANCELED' : 'ACTIVE', m.cancelado?.motivo ?? null, fecha(m.cancelado?.en ?? null), fecha(m.lleno), uid(m.organizador), fecha(m.creado), fecha(ultimo)];
    }),
    { 2: '"level"', 9: '"match_status"' },
  );
  await insertar('participants', ['id', 'matchId', 'userId', 'createdAt'],
    registro.flatMap((m) => [...m.jugadores].map(([h, en]) => [cuid(), m.id, uid(h), fecha(en)])));
  await insertar('join_requests', ['id', 'matchId', 'userId', 'status', 'createdAt', 'updatedAt'],
    registro.flatMap((m) => [...m.solicitudes].map(([h, s]) => [s.id, m.id, uid(h), s.estado, fecha(s.creada), fecha(s.actualizada)])),
    { 3: '"join_request_status"' });
  await insertar('late_withdrawals', ['id', 'matchId', 'userId', 'createdAt'],
    registro.flatMap((m) => m.bajasTarde.map((b) => [cuid(), m.id, uid(b.handle), fecha(b.en)])));
  await insertar('ratings', ['id', 'matchId', 'raterId', 'ratedUserId', 'score', 'comment', 'createdAt'],
    registro.flatMap((m) => m.ratings.map((r) => [cuid(), m.id, uid(r.rater), uid(r.rated), r.puntaje, r.comentario, fecha(r.en)])));
  await insertar('no_show_reports', ['id', 'matchId', 'reporterId', 'reportedUserId', 'createdAt'],
    registro.flatMap((m) => m.noShows.map((n) => [cuid(), m.id, uid(n.reporter), uid(n.reported), fecha(n.en)])));
  await insertar('user_activity_days', ['id', 'userId', 'activityDate', 'firstSeenAt'],
    [...actividad].map((k) => {
      const [h, d] = k.split('|');
      return [cuid(), uid(h), d, new Date(enAR(d, 12))];
    }),
    { 2: 'date' },
    'ON CONFLICT ("userId", "activityDate") DO NOTHING');
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await db.end();
}

// --- estado: que las corridas en vivo sigan estos partidos ---------------------------

const vivos = partidos();
for (const m of registro) {
  const r: PartidoRegistrado = {
    organizador: m.organizador,
    fecha: new Date(m.fecha).toISOString(),
    deporte: m.deporte,
    cupo: m.cupo,
    jugadores: [...m.jugadores.keys()],
    pendientes: [...m.solicitudes].filter(([, s]) => s.estado === 'PENDING').map(([h]) => h),
    bajasSorteadas: m.bajasSorteadas,
    asistencia: m.asistencia,
    calificaran: m.calificaran,
    calificaron: m.calificaron,
    cancelado: m.cancelado !== null,
    creado: new Date(m.creado).toISOString(),
    cancelSorteado: m.cancelSorteado,
  };
  vivos[m.id] = r;
}
guardarPartidos(vivos);
writeJson(`${STATE}/inicio.json`, { fecha: DESDE });

escribirDiarioYLog();
console.log(`\nAplicado: ${registro.length} partidos escritos en ${ENTORNO}; inicio movido a ${DESDE}.`);

function escribirDiarioYLog() {
mkdirSync(join(ROOT, STATE, 'diario'), { recursive: true });
for (const [h, lineas] of diario) {
  const path = join(ROOT, STATE, 'diario', `${h}.md`);
  const previo = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, lineas.join('\n') + '\n' + previo);
}
writeFileSync(
  join(ROOT, STATE, 'backfill.log'),
  `# backfill desde ${DESDE} (semilla ${SEMILLA}), aplicado ${new Date().toISOString()}\n` +
    acciones.sort((a, b) => a.en - b.en).map((a) => `${new Date(a.en).toISOString()} ${a.linea}`).join('\n') + '\n',
);
}
