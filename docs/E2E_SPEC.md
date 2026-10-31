# Serpix E2E encryption for invitees — specification (Phase C, v1)

Status: draft for architecture review (Vanellope). Not published. Admin (Luciano) stays in "server mode", unchanged.

## 1. Goals and non-goals
- Goal: for invited users (`user.encryption_mode = 'e2e'`), the server (Worker + D1 + Cloudflare, and the admin) can store and serve their data but cannot read it. Data is encrypted in the browser before upload.
- Non-goals: hiding metadata (see §9); protecting against a malicious JS bundle served by the operator (mitigated by CSP + published hash manifest, not eliminated); any public-key / PQ-KEM scheme (explicitly out: no ML-KEM, no public key). Symmetric AES-256 and a 256-bit key are what carry the quantum-resistance argument (Grover halves the effective strength to ~128 bits); Argon2id is memory-hard.

## 2. Keys
- **DEK**: 32 random bytes (`crypto.getRandomValues`) generated in the browser per user. Raw bytes exist only transiently: to wrap it at setup, and to import it. At runtime the DEK is a **non-extractable AES-GCM `CryptoKey`** held only in memory (module variable, never serialised, wiped on sign-out / `pagehide` is NOT a wipe).
- Optional device cache ("recordar en este dispositivo", default OFF): a random non-extractable AES-GCM device key (a `CryptoKey` stored in IndexedDB via structured clone) wraps the DEK into an IndexedDB record. Sign-out deletes both. Never stored in localStorage.

## 3. Record encryption
- Algorithm: AES-256-GCM, 96-bit random nonce per record version (never reused: fresh nonce on every write), 128-bit tag.
- AAD (UTF-8): `table|id|user_id` — binds a ciphertext to its table, row id and owner, so the server cannot move or swap records.
- Plaintext: canonical JSON of the row (all columns except the ones kept in clear, §6).
- Wire/storage envelope (JSON string in `records.blob`): `{"v":1,"n":"<b64url nonce>","c":"<b64url ciphertext||tag>"}`.

## 4. Key wraps (stored server side in `user_keys`, one row per wrap)
Wrap key derivation: `IKM -> HKDF-SHA-256(salt = 32 random bytes stored in the wrap, info = "serpix-e2e/v1/wrap/<type>") -> 256-bit AES-GCM key`. The DEK (32 raw bytes) is encrypted with AES-256-GCM, 96-bit random nonce, AAD = `wrap|<type>|<user_id>|<wrap_id>`.
1. **passkey** (WebAuthn + PRF extension): per-credential random 32-byte `prfSalt` stored in the wrap; IKM = PRF output (32 bytes) for `prf.eval.first = prfSalt`. At registration the code MUST verify the authenticator really returns a PRF result (do a follow-up `get()` if `create()` only reports `enabled`); if not, the passkey is not used as a wrap and the user is told to rely on the password.
2. **password** (recovery password, min 12 chars, strength meter, no word list / no 12-word phrase): IKM = Argon2id(password NFKC-normalised, salt 16 random bytes, m = 64 MiB, t = 3, p = 1, 32-byte output) via `hash-wasm`. Parameters (m,t,p, salt) are stored in the wrap so they can be raised later. Benchmark rule: if the median derive time on a mid-range device exceeds 2 s, lower m to 46 MiB (document how it was measured).
- Both wraps open the same DEK. Passkey is the fast path; the password is the universal recovery. If the passkey has no PRF, sign-in to the vault is by password only.
- **Recovery kit**: a downloadable/printable file with the account email, date, plain-language instructions, and a copy of the password wrap blob (so the vault can be recovered even if the server lost it). It never contains the password or the DEK. Losing both passkey and password = data is lost forever (no operator recovery); the UI says so and requires an explicit confirmation.

## 5. Server model (migration 0015, additive only)
- `user.encryption_mode TEXT NOT NULL DEFAULT 'server'` (`'server'|'e2e'`). Only a non-admin, approved user can switch to `'e2e'`, once, atomically with creating the first wrap.
- `user_keys(id PK, user_id, type, wrap TEXT json, credential_id TEXT NULL, created_at, last_used_at)`; at most one `password` wrap per user; the last wrap cannot be deleted.
- `records(user_id, collection, id, seq, version, blob, created_at, updated_at, deleted, doc_type, doc_number, doc_status, doc_due_date, PK(user_id,collection,id))` (seq = per-user monotonic sync cursor). Writes use optimistic concurrency (`expected version`), tombstones for deletes (blob replaced with an empty-envelope marker), cursor-based listing by `updated_at/seq`. Per-record size cap (1.9 M chars of blob). Per-user caps (rows per collection).
- `e2e_counters(user_id, kind, value)`: server-reserved document numbers (`next` is atomic) so two devices never issue the same number.
- Legacy plaintext routes (`/api/data`, `/api/finance`, `/api/documents`, `/api/time-entries`, `/api/timer`, `/api/recurring`, `/api/receipts*`, `/api/avatar`) answer 403 ("cuenta cifrada") for `'e2e'` users, so plaintext can never be written to the old tables by mistake.

## 6. In the clear (server-visible)
Row id, collection, user_id, `created_at`/`updated_at`, version, deleted flag, record size, and — for invoices/quotes only — `doc_type`, `doc_number`, `doc_status`, `doc_due_date` (for the overdue notice and numbering). Everything else (names, emails, phones, notes, amounts, currencies, categories, descriptions, links between rows, accounts, tickets, avatars, timer) is inside the ciphertext.

## 7. Client data engine
The plaintext working set lives only in memory in the browser, in an in-memory SQLite (sql.js) with the same schema as the server tables, so the existing business rules (totals, document numbering/conversion/collection, recurring materialisation, timer, search) run unchanged in the client. Sync: pull `records` since cursor -> decrypt -> upsert rows; local writes are captured with SQLite triggers into a dirty log, each dirty row is encrypted and pushed with its expected version; on 409 the client pulls and retries. Recurring rules are materialised on open (deterministic ids per rule and period, so two devices never duplicate).

## 8. AI ticket reading (opt-in, plaintext)
For an `'e2e'` user the ticket image is encrypted and stored as a record. "Leer con IA" is an explicit action that sends THAT image in the clear to the Worker -> Workers AI, with a clear notice; the Worker stores nothing (no D1 row) and returns the extracted fields; the same per-user (flag, 10/day) and global (7,000 neurons/day) quotas apply.

## 9. What the server still sees
Google name/email/photo, number and size of records per collection, timestamps, IP/user agent of sessions, push endpoints, invoice type/number/status/due date, and whatever the user sends to AI reading.

## 10. Hardening
Strict CSP (no `unsafe-eval`; `wasm-unsafe-eval` only for the Argon2id/SQLite wasm; no third-party origins) and a public per-deploy manifest of SHA-256 hashes of every static asset (`/.well-known/build.json`, generated at build, verifiable with `scripts/verify-build.mjs`). The operator can still serve different JS; the AGPL source and the manifest make that auditable, not impossible.

## 11. Not covered in this phase
Invoice overdue push for e2e users, R2 for tickets, account export/delete, key rotation UI, multi-passkey management UI beyond "add".
