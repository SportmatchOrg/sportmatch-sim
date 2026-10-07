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
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
};
loadEnv();

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable ${name} (ver .env.example)`);
  return value;
};

export const API_URL = () => env('API_URL').replace(/\/$/, '');

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
  const path = join(ROOT, 'state/acciones.log');
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
  /** días desde el inicio de la simulación (state/inicio.json) en que se crea la cuenta */
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
export const inicio = (): string | null => readJson<{ fecha: string } | null>('state/inicio.json', null)?.fecha ?? null;

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
};

export const usuarios = (): Usuarios => readJson('state/usuarios.json', {});
export const guardarUsuarios = (data: Usuarios) => writeJson('state/usuarios.json', data);
export const partidos = (): Record<string, PartidoRegistrado> =>
  readJson('state/partidos.json', {});
export const guardarPartidos = (data: Record<string, PartidoRegistrado>) =>
  writeJson('state/partidos.json', data);

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
