import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- config ---------------------------------------------------------------

const loadEnv = () => {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
};
loadEnv();

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable ${name} (ver .env.example)`);
  return value;
};

/** Entorno contra el que corre la simulación. Cada uno tiene su propia URL y su propio estado. */
export const ENTORNO = process.env.SIM_ENV || 'dev';
if (!/^[a-z]+$/.test(ENTORNO)) throw new Error(`SIM_ENV inválido: ${ENTORNO}`);

/** Carpeta de estado del entorno: state/dev, state/prod… */
export const STATE = `state/${ENTORNO}`;

// API_URL_DEV, API_URL_PROD… Sin fallback a otra URL: correr prod contra dev (o al revés) mezcla estados.
export const API_URL = () => env(`API_URL_${ENTORNO.toUpperCase()}`).replace(/\/$/, '');

// --- archivos -------------------------------------------------------------

export const readJson = <T>(relPath: string, fallback: T): T => {
  const path = join(ROOT, relPath);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
};

export const writeJson = (relPath: string, data: unknown) => {
  const path = join(ROOT, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
};

export const log = (line: string) => {
  const path = join(ROOT, STATE, 'acciones.log');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
};

// --- personas -------------------------------------------------------------

export type Persona = {
  handle: string;
  nombre: string;
  email: string;
  arquetipo: string;
  deportes: string[];
  zona: string;
  rasgo: string;
  /** días desde el inicio de la simulación (state/<entorno>/inicio.json) en que se crea la cuenta */
  diaLlegada: number;
  /** fecha calculada: inicio + diaLlegada */
  llegada: string;
};

export type Arquetipo = {
  descripcion: string;
  actividad: number;
  p_organizar: number;
  p_unirse: number;
  p_noShow: number;
  p_bajaTarde: number;
  p_calificar: number;
  p_cancelar: number;
  /** días desde la llegada en los que usa la app; después deja (se-va, fantasma) */
  diasActivo?: number;
  /** días desde la llegada en los que desaparece y después vuelve */
  pausa?: { desde: number; hasta: number };
  /** días de la semana en los que entra (0 = domingo) */
  diasSemana?: number[];
  /** probabilidad por corrida de que entre igual cuando no está activo (default 0.03) */
  p_volver?: number;
};

/** Fecha en que arrancó la simulación; la fija el primer create-bots. */
export const inicio = (): string | null => readJson<{ fecha: string } | null>(`${STATE}/inicio.json`, null)?.fecha ?? null;

const sumarDias = (fecha: string, dias: number) =>
  new Date(Date.parse(fecha) + dias * 86_400_000).toISOString().slice(0, 10);

export const pool = (): Persona[] => {
  const desde = inicio();
  return readJson<Omit<Persona, 'llegada'>[]>('personas/pool.json', []).map((p) => ({
    ...p,
    // Sin inicio todavía, nadie llegó.
    llegada: desde ? sumarDias(desde, p.diaLlegada) : '9999-12-31',
  }));
};
export const arquetipos = (): Record<string, Arquetipo> =>
  readJson('personas/arquetipos.json', {});

export const persona = (handle: string): Persona => {
  const found = pool().find((p) => p.handle === handle);
  if (!found) throw new Error(`No existe la persona "${handle}" en personas/pool.json`);
  return found;
};

export const arquetipoDe = (p: Persona): Arquetipo => arquetipos()[p.arquetipo];

/** Si la persona usa la app ese día según su arquetipo (llegada, abandono, pausa, días de la semana). */
export const activa = (p: Persona, dia: string, diaSemana: number) => {
  if (p.llegada > dia) return false;
  const a = arquetipoDe(p);
  const dias = diasEntre(p.llegada, dia);
  if (a.diasActivo !== undefined && dias > a.diasActivo) return false;
  if (a.pausa && dias >= a.pausa.desde && dias < a.pausa.hasta) return false;
  if (a.diasSemana && !a.diasSemana.includes(diaSemana)) return false;
  return true;
};

// --- estado ---------------------------------------------------------------

/** handle → id de usuario en el back */
export type Usuarios = Record<string, string>;

export type PartidoRegistrado = {
  organizador: string;
  fecha: string;
  deporte: string;
  cupo?: number;
  /** handles anotados como participantes (sin el organizador) */
  jugadores: string[];
  /** handles con solicitud pendiente */
  pendientes: string[];
  bajasSorteadas: boolean;
  /** handle → fue o no; se completa cuando el partido ya se jugó */
  asistencia: Record<string, boolean> | null;
  /** handles que van a calificar este partido */
  calificaran: string[];
  calificaron: string[];
  cancelado: boolean;
  /** cuándo lo creó el organizador (ISO); falta en los partidos registrados antes de la regla */
  creado?: string;
  /** ya se sorteó si el organizador lo cancela por vacío (se sortea una sola vez) */
  cancelSorteado?: boolean;
  /** resultado de ese sorteo: el organizador tiene que cancelarlo */
  cancelar?: boolean;
};

/**
 * Cupo = lugares para los que se unen: el organizador no ocupa cupo (el back llena el partido cuando
 * participants >= capacity). Fútbol 5 = 9, fútbol 6 = 11, pádel 3, tenis singles 1 / dobles 3.
 */
export const CUPOS: Record<string, number[]> = {
  FUTBOL: [9, 9, 11],
  PADEL: [3],
  TENIS: [1, 3],
  BASQUET: [5, 7, 9],
  RUNNING: [3, 5, 7],
};

/**
 * Si la persona puede armar otro partido: como mucho uno por día, y solo mientras tenga menos de 2
 * próximos abiertos (1 si no es organizadora de arquetipo). Sin esto los organizadores publican más
 * partidos de los que la demanda llena.
 */
export const puedeOrganizar = (
  p: Persona,
  suyos: { fecha: number; creado?: number; cancelado: boolean }[],
  ahora: number,
) => {
  const abiertos = suyos.filter((m) => !m.cancelado && m.fecha > ahora).length;
  const dia = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
  const hoyYa = suyos.some((m) => m.creado !== undefined && dia(m.creado) === dia(ahora));
  return !hoyYa && abiertos < (p.arquetipo.startsWith('organizador') ? 2 : 1);
};

export const usuarios = (): Usuarios => readJson(`${STATE}/usuarios.json`, {});
export const guardarUsuarios = (data: Usuarios) => writeJson(`${STATE}/usuarios.json`, data);
export const partidos = (): Record<string, PartidoRegistrado> =>
  readJson(`${STATE}/partidos.json`, {});
export const guardarPartidos = (data: Record<string, PartidoRegistrado>) =>
  writeJson(`${STATE}/partidos.json`, data);

export const handlePorUserId = (): Record<string, string> =>
  Object.fromEntries(Object.entries(usuarios()).map(([handle, id]) => [id, handle]));

// --- Firebase -------------------------------------------------------------

type Token = { idToken: string; refreshToken: string; exp: number };

const identity = async (method: string, body: object) => {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${env('FIREBASE_API_KEY')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const data = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`Firebase ${method}: ${data.error?.message ?? res.status}`);
  return data;
};

export const signUp = async (p: Persona) => {
  const data = await identity('signUp', {
    email: p.email,
    password: env('BOT_PASSWORD'),
    returnSecureToken: true,
  });
  await identity('update', { idToken: data.idToken, displayName: p.nombre });
};

export const actualizarNombre = async (p: Persona) => {
  await identity('update', { idToken: await token(p.handle), displayName: p.nombre });
};

export const token = async (handle: string): Promise<string> => {
  const tokens = readJson<Record<string, Token>>('state/.tokens.json', {});
  const cached = tokens[handle];
  if (cached && cached.exp > Date.now() + 60_000) return cached.idToken;

  const data = await identity('signInWithPassword', {
    email: persona(handle).email,
    password: env('BOT_PASSWORD'),
    returnSecureToken: true,
  });
  tokens[handle] = {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    exp: Date.now() + Number(data.expiresIn) * 1000,
  };
  writeJson('state/.tokens.json', tokens);
  return data.idToken;
};

// --- API ------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const api = async <T = any>(
  handle: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${API_URL()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token(handle)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join('; ') : data?.message;
    throw new ApiError(res.status, `${res.status} ${message ?? res.statusText}`);
  }
  return data as T;
};

/**
 * Alta de la persona: cuenta de Firebase (si no la tiene) y su User en el back, que se crea en el
 * primer request autenticado (FirebaseAuthGuard → ensureExists). Sincroniza el nombre. Devuelve el id.
 */
export const altaPersona = async (p: Persona): Promise<string> => {
  if (!usuarios()[p.handle]) {
    try {
      await signUp(p);
    } catch (error) {
      if (!String(error).includes('EMAIL_EXISTS')) throw error;
    }
  }
  const me = await api<{ id: string; name: string }>(p.handle, 'GET', '/users/me');
  if (me.name !== p.nombre) {
    await actualizarNombre(p);
    await api(p.handle, 'PATCH', `/users/${me.id}`, { name: p.nombre });
    console.log(`${p.handle}: renombrado de "${me.name}" a "${p.nombre}"`);
  }
  const ids = usuarios();
  if (!ids[p.handle]) console.log(`${p.handle} → ${me.id}`);
  ids[p.handle] = me.id;
  guardarUsuarios(ids);
  return me.id;
};

// --- fechas ---------------------------------------------------------------

const AR = 'America/Argentina/Buenos_Aires';

export const fechaAR = (iso: string | Date) =>
  new Date(iso).toLocaleString('es-AR', {
    timeZone: AR,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export const diaSemanaAR = () =>
  ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'].indexOf(
    new Date().toLocaleDateString('es-AR', { timeZone: AR, weekday: 'short' }).replace('.', ''),
  );

export const hoyAR = () => new Date().toLocaleDateString('sv-SE', { timeZone: AR });

export const diasEntre = (desde: string, hasta: string) =>
  Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000);
