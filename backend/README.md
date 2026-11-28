# CampusOS backend

CampusOS uses Fastify and SQLite to manage accounts, courses, enrollments, attendance, course materials, and individual assessment scores. For the seeded demo, follow the [repository quick start](../README.md#quick-start).

## Project phases

| Phase | Scope |
| --- | --- |
| 1–4 | Backend foundation, authentication, courses and enrollments, and attendance |
| 5 | Backend course materials, including upload, listing, download, editing, and deletion |
| 6 | Role-based React user interface |
| 7 | Integration of the frontend and live API |

This guide covers the current backend, including account provisioning and assessment scores. See the [frontend guide](../frontend/README.md) for the UI and integration.

## Install and run

Use Node.js 24 with npm and run these commands from `backend/`.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

On macOS or Linux, use `cp .env.example .env`. Put the generated value in `JWT_SECRET` in `.env`. Keep the file private. Changing the signing secret invalidates existing tokens.

Run `npm run db:seed` once on a fresh database to create the first admin. Then run `npm run dev` and check `http://127.0.0.1:8080/api/health`. The server applies pending migrations at startup. Run `npm run db:migrate` to apply them separately, or `npm start` to run without watching for file changes.

### Create the first admin

Run `npm run db:seed` in an interactive terminal after configuring `.env`. The command applies pending migrations and prompts for the admin's name, email, and password. Sign in through the frontend with those credentials, then use **Users** to create teacher and student accounts.

## Architecture and checks

Routes validate requests and check permissions before calling feature services. Services read and write SQLite with parameterized SQL. `buildApp()` accepts configuration and a database handle so tests can run in isolation.

- `src/config/` contains environment parsing and SQLite configuration.
- `src/database/` contains the connection, migrations, and admin bootstrap command.
- `src/modules/` contains feature routes and services.

Run `npm test` from `backend/`. The [contributor guide](../CONTRIBUTING.md#run-the-checks) lists frontend and integration checks.

## Environment variables
| Name | Default | Notes |
|---|---|---|
| NODE_ENV | development | `production` hides internal error messages |
| PORT / HOST | 8080 / 127.0.0.1 | Set `HOST` explicitly for external access |
| DATABASE_PATH | ./data/sms.sqlite | directory is created automatically |
| UPLOAD_DIR | ./uploads | Dedicated private local directory |
| DOCUMENT_UPLOAD_CONCURRENCY | 2 | Simultaneous uploads per backend process, 1–16. Excess requests receive 429 and a `Retry-After` header. |
| DOCUMENT_UPLOAD_TIMEOUT_MS | 120000 | Upload deadline in milliseconds, 1–900000. Timed-out uploads receive 408. |
| DOCUMENT_ARCHIVE_MAX_ENTRIES | 1000 | Maximum ZIP or DOCX entries, 1–10000. Larger archives receive 413. |
| JWT_SECRET | Required | At least 32 random characters in every environment |
| JWT_EXPIRES_IN | 8h | Token lifetime |
| LOG_LEVEL | info (prod) / debug | |

## Course materials (Phase 5)

| Method | Route | Access and purpose |
| --- | --- | --- |
| `POST` | `/api/documents` | Course owner or admin uploads a file using multipart form data. |
| `GET` | `/api/documents?courseId=<id>` | Course owner, admin, or enrolled student lists course materials. |
| `GET` | `/api/documents/:documentId/download` | Course owner, admin, or enrolled student downloads the file. |
| `PATCH` | `/api/documents/:documentId` | Course owner or admin edits the title or description. |
| `DELETE` | `/api/documents/:documentId` | Course owner or admin deletes the document. |

### Requests and storage

Send `courseId` before the file part in `POST /api/documents` so course authorization runs before staging. File-first requests remain supported and receive the same size limit and deadline.

`GET /api/documents?courseId=<id>&page=1&limit=50` returns the existing metadata array in `data`. Pages start at 1, the default limit is 50, and the maximum is 100. Follow `X-Next-Page` when present. The final page has no next-page header. A page beyond the end returns an empty array.

Run **one backend instance** per database and upload directory, including during restarts. Concurrent delete requests for one document return 204 for the first successful deletion and 404 after its row is gone. DELETE also removes stale metadata when the file is already missing.

Keep `DATABASE_PATH` outside `UPLOAD_DIR` on private local storage that supports SQLite WAL and file locking. On Termux, use the `com.termux` app's internal private home. Use real, app-owned directories beneath the Android app-data path. The standard `files` wrapper may be `0771` when its owner and group both match the app UID. Other ancestors must remain protected from group and public writes. On POSIX, the server account must own the upload root and its mode should be `0700`. For an existing checkout, run `chmod 700 ./uploads` before starting. On Windows, use a private NTFS ACL for the upload directory and protect its parents from replacement by other users.

Startup validates the upload path and probes directory creation, exclusive file creation, and cleanup before opening SQLite. It checks directory identities again during document operations. Validation and reconciliation errors abort startup before the server listens.

Uploads reserve a private `.UUID.document` directory and create its marker and payload exclusively. The file stays at the same path while it is streamed and validated. The SQLite insert is the publication point. For deletes, SQLite commits the removal first, while the file remains in place. A failed transaction leaves the file available at its original path. Committed flat UUID files from the earlier layout remain readable. Their deletion uses a small exclusive marker with the file's identity so cleanup can detect a replacement.

Before listening, startup removes recognizable, unreferenced reservations left by interrupted uploads or committed deletes. A referenced reservation is retained. For a legacy delete marker, startup checks the file identity and whether a row still refers to it before removing bytes. Unexpected contents, malformed markers, and older `.part`, `.quarantine`, and `.deleted` artifacts are left for manual inspection. This protocol covers process termination under single-instance operation on private local storage. Recovery from power loss also depends on the filesystem and SQLite durability settings.

## Database
Migrations live in `src/database/migrations/NNN_name.sql`, run in order, each in a transaction,
and are tracked in `schema_migrations`. Never edit an applied migration; add a new one.
Pragmas (WAL, synchronous=NORMAL, foreign_keys=ON, temp_store=MEMORY, busy_timeout=5000) are applied per connection.

## API conventions
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/health | none | liveness + DB pragma status |

Response envelope: `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code", "message" } }`.

## Authentication (Phase 2)
`POST /api/auth/login` with `{ "email", "password" }` returns `{ success, data: { token, user } }`.
Send the token on protected routes as `Authorization: Bearer <token>`.

- Passwords: bcrypt, cost 10. Hashes are never returned by any endpoint.
- JWT (HS256): payload is `sub` (user id), `role`, `iat`, `exp`. Secret from `JWT_SECRET`, lifetime from `JWT_EXPIRES_IN`.
- The backend pins `@fastify/jwt` 10.2.9 for the patched `fast-jwt` 6.x verifier. The latest 9.x plugin release stays on the affected 5.x verifier. The v10 plugin supports Fastify 5. The verifier's stricter claim handling accepts the scalar claims CampusOS issues and the configured HS256 algorithm.
- Failures: bad/missing/expired token or bad credentials -> 401; authenticated but wrong role -> 403.
- Guards are Fastify `onRequest` hooks: `onRequest: [authenticate, authorize('teacher', 'admin')]`.
  Roles are explicit and never implied.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/login | none | exchange credentials for a JWT |

## Courses & enrollments (Phase 3)
Access model (the SRS leaves exact filtering open; this is the smallest reasonable reading):

| Role | Courses they can see | Courses they can manage |
|---|---|---|
| admin | all | all |
| teacher | courses where `teacher_id` is them | the same |
| student | courses they are enrolled in | none |

Course not found -> 404; exists but not permitted -> 403; malformed id -> 400.

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/courses | any | filtered by role as above |
| POST | /api/courses | teacher, admin | body `course_code`, `title`, `teacher_id` (required for admin; a teacher can only use their own id) |
| GET | /api/courses/:courseId | any (if permitted) | |
| PUT | /api/courses/:courseId | owner teacher, admin | body `course_code`, `title`, optional `teacher_id` (admin only) |
| DELETE | /api/courses/:courseId | owner teacher, admin | enrollments are removed with it; refused with 409 if attendance, document or assessment records exist |
| POST | /api/courses/:courseId/enrollments | owner teacher, admin | body `student_id`; must be an existing user with role `student`; duplicate -> 409 |
| GET | /api/courses/:courseId/enrollments | owner teacher, admin | roster: `student_id, full_name, email, enrolled_at` |
| DELETE | /api/courses/:courseId/enrollments/:studentId | owner teacher, admin | 404 if not enrolled |
| GET | /api/me/courses | student | the caller's own enrollments (identity from the JWT only) |
| GET | /api/courses/:courseId/students/search?q= | owner teacher, admin | find students by partial name or email |

Student search trims `q` and requires 3 characters after trimming. The query may be at most 254 characters. It uses literal substring matching with SQLite’s built-in ASCII case folding. The result contains at most 20 students ordered by name and student ID. A successful response is `{ success: true, data: [{ student_id, full_name, email, already_enrolled }] }`, with a boolean enrollment flag for the selected course. An empty result returns `data: []`. Continue to use the enrollment endpoint with the selected UUID.

## Attendance (Phase 4)
Staff = teacher (own courses only) or admin (all courses). Students use only the student endpoints.
The student's identity always comes from the JWT; no endpoint accepts a student id for a punch.
Errors use the standard envelope `{ success:false, error:{ code, message } }`.

| Method | Path | Role | Body / query | Success | Errors |
|---|---|---|---|---|---|
| POST | /api/attendance/start | staff | `{course_id}` | 201 `{id, course_id, otp_code, is_active, started_at, ended_at}` | 400 bad id, 401, 403 not owner, 404 no course, 409 `SESSION_ALREADY_ACTIVE` |
| POST | /api/attendance/stop | staff | `{session_id}` | 200 session (idempotent: stopping an already closed session succeeds; the OTP is omitted from the response) | 400, 401, 403, 404 |
| POST | /api/attendance/punch | student | `{session_id, otp, device_fingerprint}` (otp = 6 digits, fingerprint = UUID) | 201 `{session_id, course_id, punched_at}` | 400 `INVALID_OTP` / `SESSION_CLOSED` / bad payload, 401, 403 `NOT_ENROLLED` or wrong role, 404 `SESSION_NOT_FOUND`, 409 `ALREADY_PUNCHED` / `DEVICE_ALREADY_USED` |
| GET | /api/attendance/active | student | none | 200 active sessions in the student's courses (never the OTP) | 401, 403 |
| GET | /api/attendance/me | student | optional `course_id` | 200 `{courses:[{..., total_sessions, sessions_attended, attendance_percentage}], records:[...]}` | 400, 401, 403 |
| GET | /api/attendance/sessions | staff | `?course_id=` (required) | 200 sessions with `attendance_count` | 400, 401, 403, 404 |
| GET | /api/attendance/sessions/:sessionId | staff | none | 200 `{session, present[], absent[]}`; `otp_code` only while active | 400, 401, 403, 404 |
| POST | /api/attendance/sessions/:sessionId/records | staff | `{student_id}` | 201 manual present record | 400 not a student / `STUDENT_NOT_ENROLLED`, 401, 403, 404, 409 `ALREADY_PUNCHED` |
| DELETE | /api/attendance/sessions/:sessionId/records/:studentId | staff | none | 200 | 400, 401, 403, 404 |

Rules and assumptions (the SRS leaves these open):
- Punch checks run in this order: session exists, student is enrolled, session is active, OTP matches, no earlier punch by this student, device not used by another student. Enrollment is checked first so outsiders learn nothing about a session's state or code.
- Fingerprints are stored lower-cased so UUID case variants cannot bypass `UNIQUE(session_id, device_fingerprint)`. A client-supplied fingerprint is not proof of physical hardware identity.
- One active session per course at a time (enforced in the service, inside the write transaction).
- No automatic expiry: the teacher stops sessions manually.
- Percentage = `sessions_attended / total_sessions * 100` (2 decimals). `total_sessions` counts every closed session of the course plus a still-open session only if the student already punched it; 0 sessions gives 0%. Enrollment date is not considered.
- Manual override = staff add or delete an attendance record (the schema has no status column). Manual records use a synthetic fingerprint `manual:<uuid>` and are flagged `manual: true` in session detail. There is no audit trail of who made the change or why.
- There is no rate limiting: a 6-digit OTP can be guessed by an enrolled student during an open session.

## Account provisioning

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/users` | Admin lists accounts. |
| `POST` | `/api/users` | Admin creates a teacher or student with `full_name`, `email`, `password`, and `role`. |

Email addresses are normalized, and duplicate addresses return `409 EMAIL_ALREADY_REGISTERED`. Account responses contain the user's ID, name, email, and role.

## Assessments and marks

| Method | Route | Access and purpose |
| --- | --- | --- |
| `GET` | `/api/courses/:courseId/assessments` | Course owner lists assessments. An enrolled student sees only their own scores. |
| `POST` | `/api/courses/:courseId/assessments` | Course owner creates an assessment with `title` and positive `max_marks`. |
| `GET` | `/api/courses/:courseId/assessments/:assessmentId/marks` | Course owner views the enrolled roster and saved scores. |
| `PUT` | `/api/courses/:courseId/assessments/:assessmentId/marks/:studentId` | Course owner saves or updates `marks_obtained` for an enrolled student. |

Scores may range from zero to the assessment maximum. A missing score is returned as `null` and displayed as **Ungraded**.
