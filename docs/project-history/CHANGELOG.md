# CampusOS frontend changelog

## 2026-11-25 — Student search browser walkthrough

- Verified the teacher roster against the disposable local API. Created ZZ201, found a test student by name and email, verified that changing rosters cleared the selection, and enrolled the student. The roster refreshed and the search result became disabled with an Already enrolled label. Also checked the empty search state and the manual UUID form.
- Closed the browser test tab. Stopped both local test listeners. No application source files changed.

## 2026-11-25 — Student search frontend, milestone 2

- Added the teacher and admin roster picker with debounced name and email search, already-enrolled indicators, loading, empty, and error states, and manual UUID enrollment. Switching courses clears the selected student. A successful enrollment refreshes the roster and search results.
- TypeScript, targeted lint, the Vite build, and all 14 frontend tests passed. The new rendered integration test uses real Fastify and SQLite to verify course switching, enrollment, and duplicate selection prevention. A live browser walkthrough is pending.

## 2026-11-25 — Student search frontend, milestone 1

- Added the authenticated course-scoped search client and debounced React Query hook. Searches wait 300 ms after the latest eligible term and are disabled in mock mode. The roster picker remains a follow-up.
- TypeScript, targeted lint, the Vite build, and all nine frontend unit tests passed. Two new cases cover the request contract, the three-character threshold, debounce, and course-scoped query keys.

## 2026-11-25 — Student search backend, milestone 2

- Added four Fastify and SQLite integration tests covering partial name and email lookup, the roster update after enrollment, per-course enrollment status, role and ownership restrictions, query validation, literal matching, and the 20-result cap. All four passed.
- Full backend suite on Node 24: 149 passed, 1 skipped, 0 failed. The initial sandbox run lacked a usable temporary directory. The rerun used a dedicated temporary directory for the fixtures.

## 2026-11-25 — Student search backend, milestone 1

- Added the course-scoped student search endpoint and documented the API contract in the backend README. It uses the existing management permissions and reports enrollment status for each result.
- Module syntax, Git whitespace checks, and an in-memory SQLite service smoke check passed. The HTTP integration suite and roster picker remain follow-ups.

## 2026-11-24 — Frontend demo

- M0–M2 delivered the React scaffold, typed API and mock adapters, role navigation, login, and light and dark styles. Login tokens use localStorage as agreed. Lite mode is deferred.
- M3–M4 added student attendance and history, course and roster management, and teacher session controls with four-second roster polling. Percentages come from the backend and display with two decimals. A raw 74.996% is returned as 75.00% by the backend, so the frontend classifies it as Satisfactory.
- M5–M6 added labeled sample materials, marks, and user screens. Enrollment by UUID remains available while student search is pending.
- M7–M8 added route splitting, keyboard-operable check-in, and a disposable real Fastify/SQLite integration fixture under `frontend/tests/`. Production hosting remains with the backend owner.
- Prepared as one frontend demo commit for review. The original `backend/` checkout is untouched.

- Verification passed: TypeScript, ESLint, the production build, seven attendance unit cases, and two integration cases against the real API. The React integration test covers starting a session, pasting a student code, seeing the updated percentage and teacher roster, and ending the session. Local HTTP verification also passed for the Vite page and the proxied health endpoint. The in-app browser timed out, so browser layout was not visually verified.
- The real-API build starts with approximately 68 kB of gzip-compressed JavaScript. Loading the signed-out screen and its shared chunks brings the total to approximately 93 kB. Main CSS is approximately 4 kB gzip.
- Manual demo check passed: signed in as the disposable Test Teacher and opened Live Attendance with CS101 and the Start session control available. Stopped the frontend and test API afterward.
- Review status: awaiting project-owner feedback. Record each requested revision in this changelog with the date, affected files, checks run, and any unresolved items.

## Admin provisioning — milestone 1

- Implemented interactive first-admin creation with hidden password entry, bcrypt hashing, and a transaction that prevents a second bootstrap.
- Verified input validation, concurrent bootstrap attempts, and authentication with the new credentials on Node.js 24.

## Admin provisioning — milestone 2

- Connected the Users screen to admin-only account listing and teacher/student creation. Course assignment now selects a teacher by name and email.
- Verified frontend types and API enforcement for unauthenticated and non-admin requests, restricted roles, case-insensitive duplicate emails, and public-only user responses.

## Admin provisioning — milestone 3

- Verified the workflow in the React UI against an empty SQLite database: bootstrap and sign in as admin, create both accounts, assign the teacher, enroll the student, record a check-in, and view the updated teacher roster.
- Node.js 24 verification: 151 backend tests passed (1 POSIX-only test skipped on Windows), 15 frontend tests passed, and the production build succeeded.

## Live Marks — milestone 1

- Added course-scoped assessments and mark entry using the existing SQLite tables. Teachers can write marks for enrolled students in their own courses. Students can read only their own results.
- Verified access checks, score validation, repeat saves, and zero versus ungraded behavior in the backend Marks test on Node.js 24.

## Live Marks — milestone 2

- Connected the live Marks route to course and assessment selection, teacher score entry, and a read-only student results view. Mock mode retains its sample Marks screen.
- Verified frontend types on Node.js 24.

## Live Marks — milestone 3

- Verified in the React integration suite that a teacher can create an assessment, save zero, reopen the screen and see the saved score, and that only the graded student sees it. Backend coverage also rejects writes by another teacher.
- Node.js 24 verification: 152 backend tests passed (1 POSIX-only skip on Windows), 16 frontend tests passed, and the production build succeeded.

## Assessment form debugging

- Corrected browser validation for whitespace-only titles and zero assessment maxima. Regression coverage includes positive fractional maxima and saving a student score of zero.
- Verified 16 frontend tests, lint, production build, and 152 backend tests with one platform-specific skip.
