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
- `PORTFOLIO_INBOUND_SECRET`: secreto compartido con el portfolio (`steal-this-portfolio`, donde se llama `SERPIX_INBOUND_SECRET`). El portfolio lo manda en el header `x-serpix-secret` a `POST /api/inbound/portfolio`.
- `VAPID_PRIVATE_KEY`: clave privada VAPID (base64url) para las notificaciones push. La pública es la variable `VAPID_PUBLIC_KEY` de `wrangler.jsonc`.

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
- Relaciones: un contacto puede ser a la vez cliente, socio y/o proveedor, cada uno potencial o confirmado (columna `contacts.relations`, JSON; si es NULL se deriva del `role` viejo sin modificar filas: client/partner/supplier → confirmado, client_potential/partner_potential → potencial, `potential` ("prospecto") → sin relación). Al guardar se escribe `relations` y se mantiene `role` coherente. Filtros por relación y estado en Contactos.
- Foto de contacto: iniciales por defecto; se puede elegir la foto de X, Telegram, GitHub, LinkedIn o del email (Gravatar por SHA-256), o subir una propia. Todas se descargan una vez, se recortan a 256 px y se guardan como WebP (unos KB) en D1 (`contacts.avatar_data`, columnas aditivas `avatar_data`, `avatar_source`, `github_url`) y se sirven desde `/api/avatar/<id>` solo al dueño. Fuentes sin API key: unavatar.io (X, Telegram, GitHub, LinkedIn; plan gratuito ~25 consultas/día por IP) y Gravatar; Instagram no ofrece foto sin pago, por eso no se ofrece.
- Foto automática: si un contacto no tiene foto elegida/subida, al abrir su ficha (o al guardarlo) el navegador prueba en orden GitHub, X, Telegram, LinkedIn y Gravatar del email, toma la primera imagen válida y la guarda (`avatar_source = auto:<red>`). Nunca pisa una foto elegida o subida. Si ninguna red tiene foto, guarda el intento (`avatar_tried_at/key`) y no vuelve a probar hasta que cambien las redes o pasen 7 días; la lista nunca consulta servicios externos. unavatar.io devuelve una silueta SVG (200) cuando no puede leer un perfil de LinkedIn: se descarta (no es foto). Instagram queda fuera (403 de pago en unavatar; la API web exige login).
- Agenda: pestañas General (Atrasadas/Hoy/Próximo), Calendario (mes con puntos por tipo) y Lista (filtro por tipo). Tareas en checklist con fecha y contacto; eventos; notas en Markdown con lectura y edición a pantalla completa y vista previa.
- Solicitudes del portfolio: el formulario de `lulox.com.ar` (/contratar) sigue mandando el mail y además reenvía la solicitud a `POST /api/inbound/portfolio` por Service Binding (tabla `inquiries`; secreto en `x-serpix-secret`, 401 sin él; máx. 12 KB, 5 por hora por mail y 30 cada 10 min). Se ve en **Contactos → Solicitudes** (con contador sin leer en el menú, en el ícono bandeja de Resumen y en la pestaña): leída/no leída, archivar, responder por mail (`mailto:`) y convertir en contacto (crea uno nuevo como cliente potencial; si ya hay un contacto con ese mail solo se vincula, sin modificarlo).
- Notificaciones push: Web Push con VAPID implementado sobre WebCrypto (`lib/webpush.ts`, sin dependencias; `npm test`). Se activan por dispositivo en Perfil → Notificaciones (tabla `push_subscriptions`). Al entrar una solicitud el Worker avisa a todos tus dispositivos; tocar el aviso abre la solicitud. En iPhone hay que instalar Serpix en la pantalla de inicio primero.

## Functional status (English)

- Navigation: Overview · Contacts · Agenda · Finance + profile avatar (dark mode, admin, sign out).
- CRM: contacts with a relationship (client, potential client, partner, potential partner, supplier, prospect), relationship filter, expandable card with linked tasks, events and notes. Phone suggests `+54` but accepts any number; X, Instagram, Telegram, WhatsApp and LinkedIn are optional (`@handle` or URL); free-form notes.
- Agenda: General (Overdue/Today/Upcoming), Calendar (month view with per-type dots) and List (type filter) tabs. Checklist tasks with due date and contact; events; Markdown notes with full-screen read/edit and preview.
- Portfolio inquiries: the `lulox.com.ar` (/contratar) form still sends the email and also forwards the inquiry to `POST /api/inbound/portfolio` over a Service Binding (`inquiries` table; secret in `x-serpix-secret`, 401 without it; max 12 KB, 5 per hour per email and 30 per 10 min). Find them under **Contacts → Requests** (unread counter on the nav, the Overview inbox icon and the tab): read/unread, archive, reply by email (`mailto:`) and convert to contact (creates a new potential-client contact; if a contact with that email exists it is only linked, never modified).
- Push notifications: Web Push with VAPID built on WebCrypto (`lib/webpush.ts`, dependency-free; `npm test`). Enable per device in Profile → Notifications (`push_subscriptions` table). A new inquiry pushes to all your devices; tapping the notification opens it. On iPhone, add Serpix to the home screen first.
- Overview: compact first screen (one-line greeting, short date, 4 icon KPIs with tooltips that link to their section, upcoming tasks with status/date/contact icons and a complete checkbox).
- Relations: a contact can be client, partner and/or supplier at once, each potential or confirmed (`contacts.relations` JSON column; when NULL it is derived from the legacy `role` without touching rows: client/partner/supplier → confirmed, client_potential/partner_potential → potential, `potential` ("prospect") → no relation). Saving writes `relations` and keeps `role` coherent. Relation and state filters in Contacts.
- Contact photo: initials by default; pick the photo from X, Telegram, GitHub, LinkedIn or the email (Gravatar via SHA-256), or upload your own. Each is downloaded once, center-cropped to 256 px and stored as a few-KB WebP in D1 (additive columns `avatar_data`, `avatar_source`, `github_url`), served from `/api/avatar/<id>` to the owner only. Key-less sources: unavatar.io (X, Telegram, GitHub, LinkedIn; free tier ~25 lookups/day per IP) and Gravatar; Instagram requires a paid plan, so it is not offered.
- Automatic photo: if a contact has no chosen/uploaded photo, opening its card (or saving it) makes the browser try GitHub, X, Telegram, LinkedIn and the email Gravatar in order, keep the first valid image and store it (`avatar_source = auto:<network>`). It never overrides a chosen or uploaded photo. If no network has a photo, the attempt is recorded (`avatar_tried_at/key`) and not retried until the networks change or 7 days pass; the list never calls external services. unavatar.io answers 200 with a generic SVG silhouette when it cannot read a LinkedIn profile: that is discarded (not a photo). Instagram is excluded (paid on unavatar; the web API requires login).
- Money is stored in integer minor units (ARS/USD); data is isolated per user; no demo data.
