// CLI que usan las corridas de Claude. Claude decide; acá se ejecuta y se tiran los dados.
//
//   node src/cli.ts hoy                      quiénes entran en esta corrida y qué les toca
//   node src/cli.ts sortear                  bajas tardías y asistencia de los partidos (dados)
//   node src/cli.ts estado                   resumen de lo que hay en la app simulada
//   node src/cli.ts <handle> <comando> ...   acciones de una persona (ver `ayuda`)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ENTORNO,
  ROOT,
  STATE,
  api,
  ApiError,
  CUPOS,
  activa,
  arquetipoDe,
  arquetipos,
  diaSemanaAR,
  fechaAR,
  guardarPartidos,
  guardarUsuarios,
  handlePorUserId,
  hoyAR,
  inicio,
  log,
  partidos,
  persona,
  pool,
  puedeOrganizar,
  readJson,
  usuarios,
  type PartidoRegistrado,
  type Persona,
} from './lib.ts';

const LUGARES = readJson<{ nombre: string; lat: number; lng: number; deportes: string[] }[]>(
  'personas/lugares.json',
  [],
);
const NIVELES = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
const HORA = 3_600_000;
const BAJA_TARDE_MS = 2 * HORA; // back/src/utils/matches/late-withdrawal.ts
const VENTANA_RATING_MS = 48 * HORA; // back/src/utils/ratings/rating-window.ts
// Las corridas son cada ~5 h y la baja tardía es en las 2 h previas: solo una parte de los
// partidos cae en esa ventana, así que el dado se escala para que la tasa efectiva se acerque a p_bajaTarde.
const ESCALA_BAJA_TARDE = 2;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const tirar = (p: number) => Math.random() < p;

// --- helpers ----------------------------------------------------------------

let sportIds: Record<string, string> | null = null;
const sportId = async (handle: string, nombre: string) => {
  sportIds ??= Object.fromEntries(
    (await api<{ id: string; name: string }[]>(handle, 'GET', '/sports')).map((s) => [s.name, s.id]),
  );
  const id = sportIds[nombre.toUpperCase()];
  if (!id) throw new Error(`Deporte inválido: ${nombre}. Opciones: ${Object.keys(sportIds).join(', ')}`);
  return id;
};

const userIdDe = async (handle: string) => {
  const ids = usuarios();
  if (!ids[handle]) {
    ids[handle] = (await api<{ id: string }>(handle, 'GET', '/users/me')).id;
    guardarUsuarios(ids);
  }
  return ids[handle];
};

const nombreDe = (userId: string) => handlePorUserId()[userId] ?? `(humano ${userId.slice(-4)})`;

// Los bots solo juegan entre bots: nunca se unen a un partido de un humano ni aceptan a un humano en
// el suyo. Así ninguna acción simulada se mezcla con cuentas reales en los KPIs (dev y prod).
const esBot = (userId: string) => userId in handlePorUserId();

/** Rechaza las solicitudes pendientes de humanos a un partido de un bot (les llega la notificación). */
const rechazarHumanos = async (organizador: string, id: string, reqs: any[]) => {
  const humanas = reqs.filter((r) => r.status === 'PENDING' && !esBot(r.userId));
  for (const r of humanas) {
    await api(organizador, 'PATCH', `/matches/${id}/join-requests/${r.id}`, { status: 'REJECTED' });
    log(`${organizador} rechazar-humano ${id} ${r.userId}`);
  }
  return humanas.length;
};

const linea = (m: any, viewer?: string) => {
  const estado = m.status === 'CANCELED' ? ' CANCELADO' : '';
  const yo = m.isJoined ? ' [anotado]' : m.myJoinRequest ? ` [solicitud ${m.myJoinRequest.status ?? m.myJoinRequest}]` : '';
  const pend = m.pendingRequests ? ` · ${m.pendingRequests} solicitudes pendientes` : '';
  const org = m.organizerId === viewer ? 'vos' : (m.organizer?.name ?? nombreDe(m.organizerId));
  return `${m.id} · ${m.sport?.name} ${m.level} · ${fechaAR(m.date)} · ${m.location} · ${m.joinedCount ?? '?'}/${m.capacity} · org: ${org}${estado}${yo}${pend}`;
};

const registrar = (id: string, data: Partial<PartidoRegistrado> & { organizador: string; fecha: string; deporte: string }) => {
  const all = partidos();
  const previo = all[id];
  all[id] = previo
    ? { ...previo, ...data }
    : {
        jugadores: [],
        pendientes: [],
        bajasSorteadas: false,
        asistencia: null,
        calificaran: [],
        calificaron: [],
        cancelado: false,
        ...data,
      };
  guardarPartidos(all);
  return all[id];
};

const actualizar = (id: string, fn: (p: PartidoRegistrado) => void) => {
  const all = partidos();
  if (!all[id]) return;
  fn(all[id]);
  guardarPartidos(all);
};

// --- comandos globales -------------------------------------------------------

const hoy = () => {
  if (!inicio()) {
    console.log('La simulación no arrancó todavía. Correr: node src/create-bots.ts');
    return;
  }
  const dia = hoyAR();
  const diaSemana = diaSemanaAR();
  const max = Number(flag('max') ?? 12);
  const registro = partidos();
  const ids = usuarios();
  const conTarea: string[] = [];
  const sinTarea: string[] = [];
  const ahora = Date.now();
  let sorteoNuevo = false;

  for (const p of pool()) {
    if (!ids[p.handle]) continue; // sin cuenta todavía (correr create-bots)
    const a = arquetipoDe(p);
    const esActiva = activa(p, dia, diaSemana);
    const obligatorio: string[] = [];

    for (const [id, m] of Object.entries(registro)) {
      if (m.cancelado) continue;
      const empieza = Date.parse(m.fecha);
      if (m.organizador === p.handle && m.pendientes.length && empieza > ahora)
        obligatorio.push(`revisar solicitudes del partido ${id} (${m.pendientes.length})`);
      if (m.calificaran.includes(p.handle) && !m.calificaron.includes(p.handle))
        obligatorio.push(`calificar el partido ${id}`);
      // Partido a menos de 24 h que no llega a la mitad del cupo: el organizador puede cancelarlo.
      // Se sortea una sola vez por partido; si no, con 8 corridas por día casi todos terminan cancelados.
      const vacio = m.cupo !== undefined && m.jugadores.length + 1 < m.cupo / 2;
      if (m.organizador === p.handle && vacio && empieza > ahora && empieza - ahora < 24 * HORA && !m.cancelSorteado) {
        m.cancelSorteado = true;
        m.cancelar = tirar(a.p_cancelar);
        sorteoNuevo = true;
      }
      if (m.organizador === p.handle && m.cancelar && empieza > ahora)
        obligatorio.push(`cancelar el partido ${id}: va ${m.jugadores.length}/${m.cupo} y no se llena`);
    }

    const prob = esActiva ? a.actividad : p.llegada <= dia ? (a.p_volver ?? 0.03) : 0;
    if (!obligatorio.length && !tirar(prob)) continue;

    const puede: string[] = [];
    const suyos = Object.values(registro)
      .filter((m) => m.organizador === p.handle)
      .map((m) => ({ fecha: Date.parse(m.fecha), creado: m.creado ? Date.parse(m.creado) : undefined, cancelado: m.cancelado }));
    if (puedeOrganizar(p, suyos, ahora) && tirar(a.p_organizar)) puede.push('organizar un partido');
    if (tirar(a.p_unirse)) puede.push('unirse a un partido');
    const ficha = [
      `## ${p.handle} — ${p.nombre}`,
      `arquetipo: ${p.arquetipo} (${a.descripcion})`,
      `deportes: ${p.deportes.join(', ')} · zona: ${p.zona} · ${p.rasgo} · en la app desde ${p.llegada}`,
      `tiene que: ${obligatorio.join('; ') || 'nada obligatorio'}`,
      `le toca poder: ${puede.join(' y ') || 'solo mirar y leer notificaciones'}`,
    ].join('\n');
    (obligatorio.length ? conTarea : sinTarea).push(ficha);
  }

  if (sorteoNuevo) guardarPartidos(registro);

  // Tope por corrida: primero los que tienen algo obligatorio, después el resto al azar.
  sinTarea.sort(() => Math.random() - 0.5);
  const elegidos = [...conTarea, ...sinTarea].slice(0, Math.max(max, conTarea.length));
  const salida = [...elegidos];
  const nuevas = pool().filter((p) => p.llegada <= dia && !ids[p.handle]).map((p) => p.handle);
  if (nuevas.length) salida.push(`## Altas pendientes\nCorrer: node src/create-bots.ts ${nuevas.join(' ')}`);
  console.log(salida.join('\n\n') || 'Nadie entra en esta corrida.');
};

const sortear = async () => {
  const all = partidos();
  const ahora = Date.now();
  const resumen: string[] = [];

  for (const [id, m] of Object.entries(all)) {
    if (m.cancelado || m.asistencia) continue;
    const empieza = Date.parse(m.fecha);

    let detalle: any;
    try {
      detalle = await api(m.organizador, 'GET', `/matches/${id}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        m.cancelado = true;
        continue;
      }
      throw error;
    }
    if (detalle.status === 'CANCELED') {
      m.cancelado = true;
      continue;
    }
    if (empieza > ahora) {
      const reqs = await api<any[]>(m.organizador, 'GET', `/matches/${id}/join-requests`);
      const rechazadas = await rechazarHumanos(m.organizador, id, reqs);
      if (rechazadas) resumen.push(`${id}: ${rechazadas} solicitudes de humanos rechazadas`);
    }

    const porId = handlePorUserId();
    m.jugadores = (detalle.participants ?? [])
      .map((x: any) => porId[x.user?.id ?? x.id])
      .filter(Boolean);

    // Bajas tardías: en las 2 h previas al partido.
    if (!m.bajasSorteadas && empieza > ahora && empieza - ahora < BAJA_TARDE_MS) {
      for (const handle of [...m.jugadores]) {
        const p = Math.min(1, arquetipoDe(persona(handle)).p_bajaTarde * ESCALA_BAJA_TARDE);
        if (!tirar(p)) continue;
        await api(handle, 'DELETE', `/matches/${id}/participants/me`);
        m.jugadores = m.jugadores.filter((h) => h !== handle);
        log(`${handle} baja-tarde ${id}`);
        resumen.push(`${handle} se bajó tarde de ${id}`);
      }
      m.bajasSorteadas = true;
    }

    // Asistencia: cuando el partido ya se jugó.
    if (empieza <= ahora) {
      m.asistencia = { [m.organizador]: true };
      for (const handle of m.jugadores)
        m.asistencia[handle] = !tirar(arquetipoDe(persona(handle)).p_noShow);
      // Califican los que fueron, según su p_calificar, dentro de la ventana de 48 h.
      m.calificaran =
        ahora - empieza < VENTANA_RATING_MS
          ? Object.entries(m.asistencia)
              .filter(([h, fue]) => fue && tirar(arquetipoDe(persona(h)).p_calificar))
              .map(([h]) => h)
          : [];
      const faltaron = Object.entries(m.asistencia).filter(([, fue]) => !fue).map(([h]) => h);
      log(`sorteo ${id} faltaron=[${faltaron.join(',')}] calificaran=[${m.calificaran.join(',')}]`);
      resumen.push(`${id}: jugado; faltaron ${faltaron.join(', ') || 'nadie'}; califican ${m.calificaran.length}`);
    }
  }

  // Los que no calificaron dentro de la ventana, ya no pueden.
  for (const m of Object.values(all))
    if (m.asistencia && ahora - Date.parse(m.fecha) >= VENTANA_RATING_MS) m.calificaran = [...m.calificaron];

  guardarPartidos(all);
  console.log(resumen.join('\n') || 'Sin novedades.');
};

const estado = () => {
  const all = Object.entries(partidos());
  const ahora = Date.now();
  const futuros = all.filter(([, m]) => !m.cancelado && Date.parse(m.fecha) > ahora);
  const jugados = all.filter(([, m]) => m.asistencia);
  const faltas = jugados.flatMap(([, m]) => Object.values(m.asistencia!)).filter((f) => !f).length;
  const asistencias = jugados.flatMap(([, m]) => Object.values(m.asistencia!)).length;
  console.log(
    [
      `entorno: ${ENTORNO}`,
      `personas con cuenta: ${Object.keys(usuarios()).length}/${pool().length}`,
      `partidos registrados: ${all.length} (próximos ${futuros.length}, jugados ${jugados.length}, cancelados ${all.filter(([, m]) => m.cancelado).length})`,
      `faltas sorteadas: ${faltas}/${asistencias}`,
      ...futuros.map(([id, m]) => `  ${id} · ${m.deporte} · ${fechaAR(m.fecha)} · org ${m.organizador} · ${m.jugadores.length} anotados · ${m.pendientes.length} pendientes`),
    ].join('\n'),
  );
};

// --- comandos de persona ------------------------------------------------------

const comandos: Record<string, (handle: string, rest: string[]) => Promise<void>> = {
  async perfil(handle) {
    const me = await api(handle, 'GET', '/users/me');
    console.log(JSON.stringify({ nombre: me.name, ...me.stats }));
  },

  async partidos(handle) {
    const viewer = await userIdDe(handle);
    const deporte = flag('deporte');
    const lista = (await api<any[]>(handle, 'GET', '/matches')).filter(
      (m) => !deporte || m.sport?.name === deporte.toUpperCase(),
    );
    const visibles = lista.filter((m) => esBot(m.organizerId));
    console.log(visibles.map((m) => linea(m, viewer)).join('\n') || 'No hay partidos próximos.');
  },

  async mios(handle) {
    const viewer = await userIdDe(handle);
    const mine = await api(handle, 'GET', '/matches/mine');
    for (const [k, titulo] of [
      ['organizing', 'Organizo'],
      ['playing', 'Juego'],
      ['requested', 'Pedí unirme'],
      ['played', 'Jugados'],
    ]) {
      if (mine[k].length) console.log(`${titulo}:\n${mine[k].map((m: any) => '  ' + linea(m, viewer)).join('\n')}`);
    }
  },

  async crear(handle) {
    const deporte = (flag('deporte') ?? '').toUpperCase();
    const nivel = (flag('nivel') ?? '').toUpperCase();
    const [dia, hora, lugarIdx, cupo] = [flag('dia'), flag('hora'), flag('lugar'), Number(flag('cupo'))];
    if (!deporte || !NIVELES.includes(nivel) || !dia || !hora || lugarIdx === undefined || !cupo)
      throw new Error('Uso: crear --deporte FUTBOL --nivel INTERMEDIATE --dia 2026-10-10 --hora 19:30 --lugar <n> --cupo 9 [--desc "..."]\n' +
        `Cupos (sin contar al organizador): ${Object.entries(CUPOS).map(([d, c]) => `${d} ${c.join('/')}`).join(', ')}\n` +
        LUGARES.map((l, i) => `  lugar ${i}: ${l.nombre} (${l.deportes.join(', ')})`).join('\n'));
    const lugar = LUGARES[Number(lugarIdx)];
    if (!lugar) throw new Error(`Lugar inválido: ${lugarIdx}`);
    const date = new Date(`${dia}T${hora}:00-03:00`);
    const m = await api(handle, 'POST', '/matches', {
      sportId: await sportId(handle, deporte),
      level: nivel,
      date: date.toISOString(),
      location: lugar.nombre,
      latitude: lugar.lat,
      longitude: lugar.lng,
      capacity: cupo,
      description: flag('desc'),
    });
    registrar(m.id, { organizador: handle, fecha: date.toISOString(), deporte, cupo, creado: new Date().toISOString() });
    log(`${handle} crear ${m.id} ${deporte} ${date.toISOString()}`);
    console.log(`Creado: ${linea(m, m.organizerId)}`);
  },

  async unirse(handle, [id]) {
    const m = await api(handle, 'GET', `/matches/${id}`);
    const organizador = handlePorUserId()[m.organizerId];
    if (!organizador) throw new Error(`El partido ${id} lo organiza un humano: los bots solo se unen a partidos de bots.`);
    const req = await api(handle, 'POST', `/matches/${id}/join-requests`);
    registrar(id, { organizador, fecha: m.date, deporte: m.sport.name, cupo: m.capacity });
    actualizar(id, (p) => void (p.pendientes = [...new Set([...p.pendientes, handle])]));
    log(`${handle} unirse ${id}`);
    console.log(`Solicitud enviada (${req.status}). La tiene que aceptar ${organizador}.`);
  },

  async solicitudes(handle, [id]) {
    const reqs = await api<any[]>(handle, 'GET', `/matches/${id}/join-requests`);
    // Las de humanos se rechazan solas: los bots solo juegan con bots.
    const rechazadas = await rechazarHumanos(handle, id, reqs);
    if (rechazadas) console.log(`(${rechazadas} solicitudes de humanos rechazadas)`);
    const pendientes = reqs.filter((r) => r.status === 'PENDING' && esBot(r.userId));
    console.log(
      pendientes.map((r) => `${r.id} · ${r.user?.name ?? nombreDe(r.userId)} (${nombreDe(r.userId)})`).join('\n') ||
        'No hay solicitudes pendientes.',
    );
    const enApi = new Set(pendientes.map((r) => handlePorUserId()[r.userId]).filter(Boolean));
    actualizar(id, (p) => void (p.pendientes = p.pendientes.filter((h) => enApi.has(h))));
  },

  async aceptar(handle, [id, reqId]) {
    await resolver(handle, id, reqId, 'ACCEPTED');
  },

  async rechazar(handle, [id, reqId]) {
    await resolver(handle, id, reqId, 'REJECTED');
  },

  async bajarse(handle, [id]) {
    await api(handle, 'DELETE', `/matches/${id}/participants/me`);
    actualizar(id, (p) => void (p.jugadores = p.jugadores.filter((h) => h !== handle)));
    log(`${handle} bajarse ${id}`);
    console.log('Te bajaste del partido.');
  },

  async cancelar(handle, [id]) {
    const motivo = flag('motivo');
    if (!motivo) throw new Error('Uso: cancelar <id> --motivo "..."');
    await api(handle, 'PATCH', `/matches/${id}/cancel`, { reason: motivo });
    actualizar(id, (p) => void (p.cancelado = true));
    log(`${handle} cancelar ${id}`);
    console.log('Partido cancelado.');
  },

  async pendiente(handle, [id]) {
    const { targets, noShows } = await asignacion(handle, id);
    console.log(
      [
        `A calificar (1 a 5): ${targets.map((t: any) => `${t.id} ${t.name}`).join(' · ') || 'nadie'}`,
        `No vinieron (se reportan solos): ${noShows.map((u) => nombreDe(u)).join(', ') || 'nadie'}`,
      ].join('\n'),
    );
  },

  async calificar(handle, [id]) {
    // --puntajes userId=4,userId=5   --comentarios '{"userId":"..."}'
    const { targets, noShows } = await asignacion(handle, id);
    const puntajes = Object.fromEntries(
      (flag('puntajes') ?? '').split(',').filter(Boolean).map((kv) => {
        const [k, v] = kv.split('=');
        return [k.trim(), Number(v)];
      }),
    );
    const comentarios = JSON.parse(flag('comentarios') ?? '{}') as Record<string, string>;
    const faltan = targets.filter((t: any) => !(t.id in puntajes));
    if (faltan.length) throw new Error(`Faltan puntajes para: ${faltan.map((t: any) => `${t.id} ${t.name}`).join(', ')}`);
    const res = await api(handle, 'POST', `/matches/${id}/ratings`, {
      ratings: targets.map((t: any) => ({
        ratedUserId: t.id,
        score: puntajes[t.id],
        ...(comentarios[t.id] ? { comment: comentarios[t.id].slice(0, 280) } : {}),
      })),
      noShowUserIds: noShows,
    });
    actualizar(id, (p) => void p.calificaron.push(handle));
    log(`${handle} calificar ${id} ratings=${res.count} noShows=${res.noShowCount}`);
    console.log(`Calificación enviada: ${res.count} puntajes, ${res.noShowCount} no-shows.`);
  },

  async diario(handle, rest) {
    const path = join(ROOT, STATE, 'diario', `${handle}.md`);
    const texto = rest.join(' ').trim();
    if (!texto) {
      // Sin texto: muestra las últimas entradas.
      const lineas = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
      console.log(lineas.slice(-8).join('\n') || 'Diario vacío: es su primera vez en la app.');
      return;
    }
    const ahora = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(0, 16);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `- ${ahora} · ${texto}\n`);
    console.log('Anotado.');
  },

  async notifs(handle) {
    const lista = await api<any[]>(handle, 'GET', '/notifications');
    const nuevas = lista.filter((n) => !n.readAt);
    console.log(
      nuevas.map((n) => `${n.type}${n.matchId ? ` · partido ${n.matchId}` : ''}${n.actor ? ` · ${n.actor.name}` : ''}`).join('\n') ||
        'Sin notificaciones nuevas.',
    );
    if (args.includes('--leer') && nuevas.length) {
      await api(handle, 'PATCH', '/notifications/read-all');
      log(`${handle} leer-notificaciones ${nuevas.length}`);
    }
  },
};

const resolver = async (handle: string, id: string, reqId: string, status: 'ACCEPTED' | 'REJECTED') => {
  const reqs = await api<any[]>(handle, 'GET', `/matches/${id}/join-requests`);
  const req = reqs.find((r) => r.id === reqId);
  if (!req) throw new Error(`No existe la solicitud ${reqId}`);
  if (status === 'ACCEPTED' && !esBot(req.userId))
    throw new Error(`La solicitud ${reqId} es de un humano: los bots nunca aceptan humanos.`);
  await api(handle, 'PATCH', `/matches/${id}/join-requests/${reqId}`, { status });
  const quien = handlePorUserId()[req.userId];
  actualizar(id, (p) => {
    p.pendientes = p.pendientes.filter((h) => h !== quien);
    if (status === 'ACCEPTED' && quien) p.jugadores = [...new Set([...p.jugadores, quien])];
  });
  log(`${handle} ${status === 'ACCEPTED' ? 'aceptar' : 'rechazar'} ${id} ${quien ?? req.userId}`);
  console.log(`${status === 'ACCEPTED' ? 'Aceptado' : 'Rechazado'}: ${quien ?? req.userId}`);
};

/** Targets que el back asigna + no-shows según el sorteo de asistencia. */
const asignacion = async (handle: string, id: string) => {
  const registro = partidos()[id];
  if (!registro?.asistencia) throw new Error('Este partido todavía no tiene asistencia sorteada (correr `sortear`).');
  if (registro.asistencia[handle] === false) throw new Error(`${handle} no fue a este partido: no puede calificar.`);
  const pending = await api(handle, 'GET', `/matches/${id}/ratings/pending`);
  const ids = usuarios();
  const noShows = Object.entries(registro.asistencia)
    .filter(([h, fue]) => !fue && ids[h])
    .map(([h]) => ids[h])
    .filter((uid) => pending.players.some((p: any) => p.id === uid));
  const targets = pending.targets.filter((t: any) => !noShows.includes(t.id));
  return { targets, noShows };
};

// --- main -----------------------------------------------------------------------

const AYUDA = `Globales: hoy [--max 12] | sortear | estado
Persona: <handle> perfil | partidos [--deporte X] | mios | notifs [--leer]
         crear --deporte --nivel --dia --hora --lugar <n> --cupo [--desc] | unirse <id> | bajarse <id>
         solicitudes <id> | aceptar <id> <reqId> | rechazar <id> <reqId> | cancelar <id> --motivo
         pendiente <id> | calificar <id> --puntajes uid=4,uid=5 [--comentarios '{"uid":"..."}'] | diario ["texto"]
Niveles: ${NIVELES.join(', ')} · Arquetipos: ${Object.keys(arquetipos()).join(', ')}`;

try {
  const [a, b, ...rest] = args;
  if (a === 'hoy') hoy();
  else if (a === 'sortear') await sortear();
  else if (a === 'estado') estado();
  else if (!a || a === 'ayuda' || !b) console.log(AYUDA);
  else if (comandos[b]) {
    persona(a);
    await comandos[b](a, rest);
  } else console.log(`Comando desconocido: ${b}\n${AYUDA}`);
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
