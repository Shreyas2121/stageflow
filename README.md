# StageFlow

StageFlow is a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

This checkout contains the P1-C01 workspace foundation. It cannot create a room yet. The API and web packages contain typed placeholders; application servers arrive in later slices.

Observed tools: Node `v22.23.2`, pnpm `12.9.1`, Docker `29.7.2`, and Docker Compose `v5.4.0`. Use Node 22 (`.nvmrc`).

From the workspace root in PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env
pnpm typecheck
pnpm lint
docker compose up -d
docker compose ps
```

Docker Desktop must be running with Linux containers. Postgres 16 uses port 5432, database/user/password `stageflow`, and a named data volume. Redis 7 uses port 6379 without a configured persistent volume. Both services have health checks. If either port is already occupied, resolve that conflict before starting Compose.

The root typecheck builds `@stageflow/shared` declarations and CommonJS output in `dist`, then checks all three packages. Shared and API use Node16 module resolution and CommonJS package types. Web uses ES modules and bundler resolution in preparation for Vite.

TypeScript `6.0.3` is the newest stable version supported by typescript-eslint `8.72.1` (which requires TypeScript below 6.1); TypeScript 7 is outside that range. ESLint `10.14.0` and its flat config cover all three packages, with explicit `any` forbidden. Only development tooling is installed in this slice.

The environment example includes keys needed by later phases. Its credentials and JWT secret are local development values. Keep the copied `.env` out of version control.
