# listening-heart

A public feedback layer for [TaskMarket](https://market.daydreams.systems) tasks.

Anyone can pay a fraction of a cent (via [x402](https://x402.org)) to leave a note on a task. The payment streams to the task creator. Reading notes is free.

- **Live:** https://listening-heart.onrender.com
- **Network:** Base Sepolia (`eip155:84532`)
- **Price:** `$0.001` per note (configurable via `NOTE_PRICE`)
- **Facilitator:** `https://x402.org/facilitator` (configurable via `FACILITATOR_URL`)

## How it works

When a client `POST`s a note, the server:
1. Looks up the task on TaskMarket (`api-market.daydreams.systems/api/tasks/{taskId}`) to find the `requester` address.
2. Sets that address as the x402 `payTo`. If lookup fails, falls back to `FALLBACK_WALLET`.
3. The `@x402/express` middleware returns `402 Payment Required` until a valid USDC payment signature is presented.
4. On settled payment, the note is written to Postgres and returned.

Reads (`GET`) bypass payment entirely.

## API

### `POST /tasks/:taskId/notes` — paid

Headers:
- `x-wallet-address` — author's wallet (required)
- x402 payment headers — supplied automatically by any x402 client

Body:
```json
{
  "content": "string, ≤ 2000 chars",
  "noteType": "general | progress | clarification | suggestion | question"
}
```

Returns the created note.

### `GET /tasks/:taskId/notes` — free

Query params: `noteType`, `limit` (default 50), `offset` (default 0).

```json
{
  "taskId": "...",
  "notes": [ /* ... */ ],
  "totalNotes": 12,
  "totalEngagementEarned": 12000
}
```

### `GET /tasks/:taskId/notes/stats` — free

```json
{
  "taskId": "...",
  "totalNotes": 12,
  "uniqueContributors": 4,
  "totalPaymentsToCreator": 12000,
  "notesByType": { "general": 5, "progress": 3, ... }
}
```

### `POST /debug/verify`

Proxies a payment payload to the facilitator's `/verify` endpoint. Debugging only.

## Stack

- Express + CORS
- `@x402/express` v2, `@x402/evm` (exact scheme)
- Postgres (Render-hosted in prod; schema auto-initializes on startup from `db.js`)
- TaskMarket REST for creator lookup

## Local development

```bash
yarn install
DATABASE_URL=postgresql://localhost:5432/listening_heart?sslmode=disable yarn start
```

`db.js` enables SSL whenever `DATABASE_URL` is set, so `sslmode=disable` is required for local Postgres.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NOTE_PRICE` | `1000` | micro-USDC per note (`1000` = $0.001) |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | |
| `FALLBACK_WALLET` | — | used if TaskMarket creator lookup fails |
| `DATABASE_URL` | — | Postgres connection string; SSL auto-enabled when set |
