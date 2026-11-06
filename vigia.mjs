#!/usr/bin/env node
// VIGÍA de Marcos Galperin. Programa común, sin IA. Corre cada 10 minutos (ver vigia.yml) y despierta a Marcos SOLO si hace falta:
//   1) evento: chiqui_cambios  -> Chiqui cambió, en su libreta, algo de un partido que Marcos YA publicó (día, hora, estado, equipos o estadio).
//   2) evento: cierre          -> un partido publicado llegó a su hora de cierre de venta (la web corta sola la compra 24 h antes).
// Si no pasa ninguna de las dos, no hace nada. Nunca escribe en la web ni en la libreta: solo mira y avisa.
//
// Uso: node vigia.mjs --libreta <libreta.json de Chiqui> --estado <estado.json del vigía> [--partidos <partidos.json o URL>] [--ahora <ISO>] [--dry-run]
// Variable (solo si va a despertar a Marcos de verdad; se carga en GitHub, nunca en archivos): VIGIA_SECRET. Opcional: VIGIA_URL (para pruebas).
// Sin --dry-run despierta a Marcos por la puerta del puente (api/vigia.js). Con --dry-run solo cuenta qué haría.
// La primera vez (sin estado) NO despierta a nadie: solo toma nota de cómo están las cosas.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const URL_PARTIDOS = "https://raw.githubusercontent.com/passioncultureba-ops/pcba-web-datos/main/partidos.json";
const CIERRE_HORAS = 24;              // igual que CIERRE_HORAS de la web
const MAX_ATRASO_CIERRE_H = 6;        // un cierre que se pasó hace más de esto ya no se avisa (se anota y listo)
const HORA = 3600 * 1000;

function leerArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2), sig = argv[i + 1];
    if (sig === undefined || sig.startsWith("--")) a[k] = true; else { a[k] = sig; i++; }
  }
  return a;
}
const leer = (ruta) => JSON.parse(readFileSync(ruta, "utf8"));

// Cuándo empieza un partido (hora argentina, UTC-3). Sin hora confirmada: null (no se puede calcular el cierre).
export function inicioMs(p) {
  if (!p.confirmed || !p.exactDate || !p.exactTime) return null;
  const t = Date.parse(`${p.exactDate}T${p.exactTime}:00-03:00`);
  return Number.isNaN(t) ? null : t;
}
export const cierreMs = (p) => {
  const ini = inicioMs(p);
  if (ini === null) return null;
  const h = typeof p.cierre_horas === "number" && p.cierre_horas >= 0 ? p.cierre_horas : CIERRE_HORAS;
  return ini - h * HORA;
};

// Huella de lo que importa de un partido en la libreta de Chiqui. Lo demás (fuente, "visto por última vez", notas) cambia en cada corrida y no cuenta.
export function huella(c) {
  if (!c) return "ausente";
  return JSON.stringify([c.fecha ?? null, c.hora ?? null, c.estado ?? null, c.local ?? null, c.visitante ?? null, c.estadio ?? null]);
}

// Decide qué avisar. Devuelve { avisos: [{evento, texto}], estado: nuevo estado }. No toca archivos ni la red.
export function decidir({ publicados, libreta, estado, ahoraMs }) {
  const primera = !estado;
  const st = { huellas: { ...(estado?.huellas || {}) }, cierres: { ...(estado?.cierres || {}) } };
  const avisos = [];
  const hoyFecha = new Date(ahoraMs - 3 * HORA).toISOString().slice(0, 10);
  const vivos = (publicados.partidos || []).filter((p) => p && typeof p.id === "string" && p.oculto !== true && p.iso >= hoyFecha);
  const nombre = (p) => `${p.home} vs ${p.away}`;

  // 1) Cambios de Chiqui en partidos publicados.
  const cambiados = [];
  const recienVistos = new Set();   // partidos que el vigía ve por primera vez en esta vuelta
  for (const p of vivos) {
    if (estado && estado.huellas?.[p.id] === undefined) recienVistos.add(p.id);
    const h = huella((libreta.partidos || []).find((x) => x.id === p.id));
    if (!primera && st.huellas[p.id] !== undefined && st.huellas[p.id] !== h) cambiados.push(p);
    st.huellas[p.id] = h;
  }
  if (cambiados.length) {
    avisos.push({
      evento: "chiqui_cambios",
      texto: ["evento: chiqui_cambios", ...cambiados.map((p) => `partido: ${nombre(p)} (id ${p.id})`)].join("\n")
    });
  }

  // 2) Cierres de venta que ya llegaron.
  const cierran = [];
  for (const p of vivos) {
    const c = cierreMs(p), ini = inicioMs(p);
    if (c === null || ini === null || st.cierres[p.id] === c) continue;   // ya avisado (o sin hora confirmada)
    if (c > ahoraMs) continue;                                              // todavía no
    st.cierres[p.id] = c;
    // Un partido que ya estaba cerrado cuando se publicó (se publicó con menos de 24 h) nunca estuvo abierto: se anota y no se avisa.
    if (!primera && !recienVistos.has(p.id) && ahoraMs - c <= MAX_ATRASO_CIERRE_H * HORA && ini > ahoraMs) cierran.push(p);
  }
  if (cierran.length) {
    avisos.push({
      evento: "cierre",
      texto: ["evento: cierre", ...cierran.map((p) => `partido: ${nombre(p)} (id ${p.id}) · ${p.exactDate} ${p.exactTime}`)].join("\n")
    });
  }

  // Limpieza: se olvida lo que ya no está publicado.
  const ids = new Set((publicados.partidos || []).map((p) => p.id));
  for (const k of Object.keys(st.huellas)) if (!ids.has(k)) delete st.huellas[k];
  for (const k of Object.keys(st.cierres)) if (!ids.has(k)) delete st.cierres[k];
  return { avisos, estado: st };
}

// Despierta a Marcos por la puerta del puente (marcos-puente-telegram/api/vigia.js), que es quien guarda el token de la rutina.
async function despertar(texto) {
  const secreto = process.env.VIGIA_SECRET;
  if (!secreto) throw new Error("falta VIGIA_SECRET");
  const url = process.env.VIGIA_URL || "https://marcos-puente-telegram.vercel.app/api/vigia";
  const r = await fetch(url, {
    method: "POST",
    headers: { "X-Vigia-Secret": secreto, "Content-Type": "application/json" },
    body: JSON.stringify({ text: texto })
  });
  if (r.status !== 200) throw new Error("no se pudo despertar a Marcos: HTTP " + r.status);
}

async function principal() {
  const a = leerArgs(process.argv.slice(2));
  if (!a.libreta || !a.estado) throw new Error("Falta --libreta y/o --estado");
  const libreta = leer(a.libreta);
  let publicados;
  const src = typeof a.partidos === "string" ? a.partidos : URL_PARTIDOS + "?t=" + Date.now();
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { cache: "no-store" });
    if (!r.ok) throw new Error("no se pudo leer partidos.json: HTTP " + r.status);
    publicados = await r.json();
  } else publicados = leer(src);
  const estado = existsSync(a.estado) ? leer(a.estado) : null;
  const ahoraMs = typeof a.ahora === "string" ? Date.parse(a.ahora) : Date.now();

  const { avisos, estado: nuevo } = decidir({ publicados, libreta, estado, ahoraMs });
  if (!a["dry-run"]) {
    // Primero se despierta; el estado se guarda solo si salió bien (si falla, se reintenta en la próxima vuelta).
    for (const av of avisos) await despertar(av.texto);
    writeFileSync(a.estado, JSON.stringify(nuevo, null, 2) + "\n");
  }
  console.log(JSON.stringify({ primera_vez: !estado, avisos: avisos.map((x) => x.texto), dry_run: !!a["dry-run"] }, null, 2));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
}
