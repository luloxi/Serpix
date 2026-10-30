# Serpix

ERP personal y extensible para relaciones comerciales, proyectos, tareas y finanzas.

## Stack

- Next.js App Router + React
- Cloudflare Workers con `@opennextjs/cloudflare`
- Cloudflare D1 (SQLite)
- Better Auth + Google OAuth
- GitHub como fuente del código y despliegues

## Acceso

El registro se realiza con Google. Las cuentas nuevas quedan en estado `pending` y no pueden acceder a los módulos hasta que un administrador las apruebe.

La cuenta administradora inicial es `lucianoolivabianco@gmail.com`. Su rol se asigna automáticamente en el primer inicio de sesión. Los roles y estados de aprobación son campos administrados por el servidor.

## Cloudflare

El Worker se llama `serpix`, usa la base D1 `serpix-production` y está previsto para `erp.lulox.com.ar`.

Configurar como secrets del Worker (nunca en Git):
- `BETTER_AUTH_SECRET`: valor aleatorio criptográficamente seguro de al menos 32 caracteres.
- `GOOGLE_CLIENT_ID`: ID del cliente OAuth de Google.
- `GOOGLE_CLIENT_SECRET`: secreto del cliente OAuth de Google.

El callback OAuth es `https://erp.lulox.com.ar/api/auth/callback/google`.

## Desarrollo

```bash
npm install
npm run dev
```

Para previsualizar en el runtime de Workers:

```bash
npm run preview
```

Para aplicar las migraciones remotas a D1:

```bash
npx wrangler d1 migrations apply serpix-production --remote
```

Para desplegar:

```bash
npm run deploy
```

## Estado funcional

- Google OAuth y sesiones: configurados en código; requieren los secrets y el despliegue.
- Aprobación de usuarios: flujo inicial, estados y endpoints administrativos implementados.
- CRM, proyectos, tareas y finanzas: esquema persistente y operaciones CRUD (crear, editar, eliminar) implementados en `/dashboard`, aislados por usuario.
- Logo e íconos: ouroboros rosa/celeste con S amarilla sobre negro. El original está en `brand/serpix-logo-master.jpg`; `python3 scripts/make-icons.py` genera los PNG/ICO livianos de `public/icons` (favicon, Apple Touch, PWA 192/512, logo de la barra lateral). Los nombres llevan versión (`.v3`) para evitar cachés viejas; el manifiesto es `manifest-v3.webmanifest`.
- Almacén canónico del logo: bucket R2 `serpix-assets` (plan gratuito), publicado en https://assets.lulox.com.ar/logo/v1/ (`serpix-logo-master.jpg`, `serpix-32.png`, `serpix-48.png`, `apple-touch-icon-180.png`, `icon-192.png`, `icon-512.png`, `logo-128.png`, `favicon.ico`; `Cache-Control: public, max-age=31536000, immutable`). La app sigue sirviendo favicon, Apple Touch, manifiesto y logo de la interfaz desde su propio origen (`public/icons`), porque los navegadores y la instalación de la PWA manejan mal los íconos de otro origen.
- No se incluye información ficticia ni datos de demostración.
- Navegación: Resumen · Contactos · Agenda · Finanzas + avatar de perfil (tema oscuro, administración, cerrar sesión).
- CRM: contactos con relación (cliente, cliente potencial, socio, socio potencial, proveedor, prospecto), filtro por relación, ficha expandible con tareas, eventos y notas vinculadas. Teléfono con `+54` sugerido y editable; X, Instagram, Telegram, WhatsApp y LinkedIn opcionales (aceptan `@usuario` o enlace); notas libres.
- Resumen: primera pantalla compacta (saludo, fecha corta, 4 indicadores con ícono y tooltip clickeables, próximas tareas con casilla para completarlas).
- Agenda: pestañas General (Atrasadas/Hoy/Próximo), Calendario (mes con puntos por tipo) y Lista (filtro por tipo). Tareas en checklist con fecha y contacto; eventos; notas en Markdown con lectura y edición a pantalla completa y vista previa.

## Functional status (English)

- Navigation: Overview · Contacts · Agenda · Finance + profile avatar (dark mode, admin, sign out).
- CRM: contacts with a relationship (client, potential client, partner, potential partner, supplier, prospect), relationship filter, expandable card with linked tasks, events and notes. Phone suggests `+54` but accepts any number; X, Instagram, Telegram, WhatsApp and LinkedIn are optional (`@handle` or URL); free-form notes.
- Agenda: General (Overdue/Today/Upcoming), Calendar (month view with per-type dots) and List (type filter) tabs. Checklist tasks with due date and contact; events; Markdown notes with full-screen read/edit and preview.
- Resumen: primera pantalla compacta (saludo + fecha corta, 4 indicadores con ícono y tooltip que llevan a su sección, próximas tareas con ícono de estado/fecha/contacto y casilla para completar).
- Money is stored in integer minor units (ARS/USD); data is isolated per user; no demo data.
