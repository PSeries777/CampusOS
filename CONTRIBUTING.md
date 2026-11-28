# Contributing to CampusOS

Use Node.js 24 and npm. Install dependencies separately in `backend/` and `frontend/` using `npm ci`. Start with the [demo guide](docs/demo.md) for a seeded local environment or the [backend guide](backend/README.md#install-and-run) for persistent data.

## Run the checks

From `backend/`:

```sh
npm ci
npm test
```

From `frontend/`:

```sh
npm ci
npm run lint
npm test
npm run test:prepare
npm run test:integration
npm run build
```

GitHub Actions runs these checks on pull requests to `main` and pushes to `main`.

## Open a pull request

Use a branch from `main`. Describe the user-facing change and how you verified it. Include a screenshot for visible UI changes. Keep local environment files, SQLite data, uploads, and generated output out of commits. Update the changelog for user-facing changes and use [project history](docs/project-history/README.md) for implementation notes.
