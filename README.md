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

La cuenta definida en `ADMIN_EMAIL` se promueve a administradora automáticamente en su primer inicio de sesión. Actualmente está configurada como `lucianoolivabianco@gmail.com`.

## Cloudflare

El Worker usa el nombre `serpix`, la base D1 `serpix-production` y el dominio previsto `erp.lulox.com.ar`.

Secrets requeridos (configurar en Cloudflare, nunca en Git):
- `BETTER_AUTH_SECRET`: cadena aleatoria criptográficamente segura de al menos 32 caracteres.
- `GOOGLE_CLIENT_SECRET`: secreto del cliente OAuth de Google.

Variables configuradas en `wrangler.jsonc`:
- `BETTER_AUTH_URL`
- `ADMIN_EMAIL`
- `GOOGLE_CLIENT_ID`

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

- Google OAuth y sesiones: configurados en código; requieren los secrets de Cloudflare y el despliegue.
- Aprobación de usuarios: esquema, promoción inicial del administrador y endpoints de aprobación implementados.
- CRM, trabajo y finanzas: esquema persistente creado; las pantallas y operaciones CRUD todavía deben implementarse antes de usar esos módulos.
- No se incluye información ficticia ni datos de demostración.
