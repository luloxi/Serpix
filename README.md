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
- No se incluye información ficticia ni datos de demostración.
