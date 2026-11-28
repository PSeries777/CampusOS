# Architecture

The React frontend uses Vite, React Router, and TanStack Query. It sends same-origin `/api` requests. During development, Vite forwards them to Fastify on port 8080 by default.

```text
Browser / React
  -> /api
  -> Fastify routes, request validation, and access checks
  -> feature services
  -> SQLite and local course material storage
```

The Fastify API validates requests and uses a JWT to identify the signed-in user. Course-level checks use the course owner or current enrollment. The backend stores entities and relationships in SQLite and applies migrations from `backend/src/database/migrations/`. Course material metadata lives in SQLite, and file contents live in the configured upload directory.

The integration fixture runs the real API with in-memory SQLite, seeded role accounts, and a temporary upload directory. The persistent setup uses the database and upload paths configured in the backend environment.

See the [backend API and configuration](../backend/README.md), [frontend guide](../frontend/README.md), and [demo walkthrough](demo.md).
