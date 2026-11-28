# CampusOS frontend

The CampusOS web app uses React, TypeScript, Tailwind CSS, and Vite. Phase 6 introduced the role-based interface. Phase 7 connected it to the Fastify API.

## Workspaces

| Role | Features backed by the API |
| --- | --- |
| Admin | Create accounts, assign teachers, manage courses and rosters, and manage course materials. |
| Teacher | Manage owned courses, find and enroll students, run attendance, upload materials, and record assessment scores. |
| Student | View enrolled courses, check in with a session code, download materials, and view personal attendance and marks. |

## Requirements

Use Node.js 24 with npm. Run `npm ci` from `frontend/` to install the locked dependencies.

## Development with the real API

Follow the [repository quick start](../README.md#quick-start) for a seeded API, or start the [persistent backend](../backend/README.md#install-and-run) and run Vite with `VITE_USE_MOCKS=false`. For the seeded accounts and feature walkthrough, see the [demo guide](../docs/demo.md).

### Environment

| Variable | Purpose |
| --- | --- |
| `VITE_USE_MOCKS` | Set to `false` for the real API or `true` for the frontend-only sample. |
| `API_PROXY_TARGET` | Vite development proxy target for `/api`. Defaults to `http://127.0.0.1:8080`. |

Use `.env.local` for local settings and restart Vite after changing them. Production builds use same-origin `/api` URLs. Serve the frontend and API over HTTPS in production. Browser sessions use tab-scoped storage and clear their tokens on sign-out or expiration.

## Frontend-only demo

Set `VITE_USE_MOCKS=true` in `frontend/.env.local` and restart Vite. Update the setting in your shell as well if it already defines `VITE_USE_MOCKS`. The sign-in screen offers demo account buttons. Mock attendance is stored in the browser, so switch roles in the same profile to see those changes.

## Checks

Run these commands from `frontend/`.

```sh
npm run lint
npm test
npm run test:prepare
npm run test:integration
npm run build
```

The integration suite exercises React against the real Fastify API with SQLite. `npm run test:prepare` copies the backend source and installs its dependencies into the ignored `tests/.backend/` directory. See the [contribution guide](../CONTRIBUTING.md#run-the-checks) for the full repository checks.
