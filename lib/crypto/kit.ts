// Recovery kit: plain-language instructions plus the password wrap.
// The password and the DEK are never written here. Losing both the passkey and the
// password means the data is gone; the text says so.
// There is no in-app import. The text must not tell the reader to import the file:
// today the app unlocks from the server copy, and this file is only a backup.

import { assertWrap, serializeWrap, type Wrap } from "./wrap.ts";

export const WRAP_BEGIN = "--- BEGIN SERPIX PASSWORD WRAP ---";
export const WRAP_END = "--- END SERPIX PASSWORD WRAP ---";

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export class KitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitError";
  }
}

export type RecoveryKit = {
  filename: string;
  text: string;
  html: string;
};

function kitDate(createdAt: string | Date): { display: string; stamp: string } {
  const date = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  if (Number.isNaN(date.getTime())) throw new KitError("invalid kit date");
  const display = `${date.getUTCDate()} de ${MONTHS[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
  const stamp = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return { display, stamp };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildRecoveryKit(input: {
  email: string;
  createdAt: string | Date;
  passwordWrap: Wrap;
  appUrl: string;
}): RecoveryKit {
  if (!input.email || !input.appUrl) throw new KitError("email and appUrl are required");
  const wrap = assertWrap(input.passwordWrap);
  if (wrap.type !== "password") throw new KitError("the kit only carries the password wrap");
  const json = serializeWrap(wrap);
  const { display, stamp } = kitDate(input.createdAt);
  const text = [
    "Serpix — kit de recuperación",
    "============================",
    "",
    "Guardá este archivo en un lugar seguro (impreso, o en un pendrive que no uses",
    "todos los días). Es una copia de respaldo de la clave protegida con tu",
    "contraseña de recuperación. No es la contraseña y no contiene la clave de los",
    "datos. Sin la contraseña, no alcanza para leer nada.",
    "",
    "Hoy desbloqueás la cuenta con la contraseña de recuperación o con una passkey,",
    "desde la copia del servidor.",
    "Importar este archivo en la app todavía no está disponible.",
    "Conservalo como resguardo: sirve para una recuperación futura, cuando la app",
    "permita importarlo.",
    "",
    `Cuenta: ${input.email}`,
    `Fecha: ${display}`,
    `Sitio: ${input.appUrl}`,
    "",
    "Qué hacer hoy",
    "-------------",
    `1. En un dispositivo nuevo, abrí ${input.appUrl} e ingresá con la contraseña`,
    "   de recuperación o con la passkey. La app usa la copia del servidor.",
    "2. Este archivo no hace falta para eso. Serpix no guarda la contraseña: no",
    "   está en este archivo y nadie puede leerla por vos.",
    "",
    "ADVERTENCIA",
    "-----------",
    "Si perdés la passkey Y la contraseña de recuperación, los datos se pierden",
    "para siempre. Nadie puede recuperarlos, ni siquiera el administrador.",
    "No hay una copia sin cifrar y no hay una puerta trasera.",
    "",
    WRAP_BEGIN,
    json,
    WRAP_END,
    "",
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Serpix — kit de recuperación</title>
<style>
  body { font-family: Georgia, serif; max-width: 40rem; margin: 2rem auto; color: #1a1a1a; line-height: 1.45; }
  h1 { font-size: 1.6rem; }
  .warn { border: 3px solid #9b1c1c; padding: 1rem 1.2rem; font-size: 1.25rem; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 0.8rem; background: #f4f4f4; padding: 0.8rem; }
</style>
</head>
<body>
<h1>Serpix — kit de recuperación</h1>
<p>Guardá esta hoja en un lugar seguro. Es una copia de respaldo de la clave protegida con tu contraseña de recuperación. No es la contraseña y no contiene la clave de los datos. Sin la contraseña, no alcanza para leer nada.</p>
<p>Hoy desbloqueás la cuenta con la contraseña de recuperación o con una passkey, desde la copia del servidor. Importar este archivo en la app todavía no está disponible. Conservalo como resguardo: sirve para una recuperación futura, cuando la app permita importarlo.</p>
<p><strong>Cuenta:</strong> ${escapeHtml(input.email)}<br>
<strong>Fecha:</strong> ${escapeHtml(display)}<br>
<strong>Sitio:</strong> ${escapeHtml(input.appUrl)}</p>
<p>En un dispositivo nuevo, abrí ${escapeHtml(input.appUrl)} e ingresá con la contraseña de recuperación o con la passkey. La app usa la copia del servidor. Este archivo no hace falta para eso. Serpix no guarda la contraseña: no está en este archivo y nadie puede leerla por vos.</p>
<div class="warn">
<p><strong>Advertencia.</strong> Si perdés la passkey Y la contraseña de recuperación, los datos se pierden para siempre. Nadie puede recuperarlos, ni siquiera el administrador. No hay una copia sin cifrar y no hay una puerta trasera.</p>
</div>
<pre>${escapeHtml(WRAP_BEGIN)}
${escapeHtml(json)}
${escapeHtml(WRAP_END)}</pre>
</body>
</html>
`;
  return { filename: `serpix-kit-recuperacion-${stamp}.txt`, text, html };
}

/** Pull the password wrap back out of a kit file (or the same markers copied from the printable page). */
export function parseRecoveryKit(text: string): Wrap {
  if (typeof text !== "string") throw new KitError("recovery kit must be text");
  const begin = text.indexOf(WRAP_BEGIN);
  const end = begin < 0 ? -1 : text.indexOf(WRAP_END, begin + WRAP_BEGIN.length);
  if (begin < 0 || end < 0) throw new KitError("recovery kit is missing the password wrap");
  const json = text.slice(begin + WRAP_BEGIN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KitError("recovery kit wrap is not JSON");
  }
  const wrap = assertWrap(parsed);
  if (wrap.type !== "password") throw new KitError("recovery kit wrap is not a password wrap");
  return wrap;
}
