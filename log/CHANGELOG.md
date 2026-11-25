# CampusOS frontend changelog

## 2026-11-25 — Phase 5 review handoff

- Verified the local Student and Admin dashboards in separate tabs connected to the Teacher backend. Student saw the active CS101 session. Admin saw Courses and Materials. All three local frontend listeners and the disposable API were stopped before handoff.
- Final pre-commit verification passed on Node 24: TypeScript, ESLint, Vite production build, and all 10 automated tests.
- Excluded generated Vite dependency cache files from the review branch.
- Student search still needs a backend contract. The current roster supports enrollment by student UUID.

## 2026-11-25 — Hide demo-only screens in real mode

- Hid Marks and admin Users from real-mode navigation and blocked direct access. The demo screens remain available to their existing roles in mock mode. TypeScript and the rendered regression passed, including both direct-route and navigation checks.

## 2026-11-25 — Browser UI smoke test

- Passed the live Materials flow with disposable teacher and student accounts. The teacher uploaded and renamed a PDF, the student saw and downloaded it with read-only controls, and the teacher deleted it after confirmation. The empty state returned. The downloaded bytes matched the original. At 390 px the download control remained visible and there was no horizontal overflow.
- The Marks link was still visible in real API mode. Demo-screen removal was outside this test run. Test servers were stopped. No source or test files were edited.

## 2026-11-25 — API integration verification

- Passed both saved API integration scenarios against disposable Fastify and SQLite. Attendance passed, and the Materials lifecycle passed for upload, listing, metadata edit, byte-for-byte download, deletion by the teacher, and rejection of student deletion.
- Passed a separate API smoke check for X-Next-Page across two pages and HTTP 403 for listing or downloading after the student was removed from the course. The browser scenario was excluded. No source or test files changed.

## 2026-11-25 — Unit-only verification

- All 7 existing unit tests passed. They cover attendance tier thresholds, percentage formatting, and tier disagreement. Document form validation and pagination have no standalone unit cases yet. API and browser tests were outside this run.

## 2026-11-25 — Phase 5 Materials integration

1. Contract and read flow. Confirmed the Phase 5 API and added the course picker, paginated listing, and authenticated file downloads.
2. Staff management. Added teacher and admin upload, metadata editing, and confirmed deletion. The client handles multipart uploads and empty deletion responses. Students use the same course list and download flow with read-only controls.
3. Verification. Refreshed the isolated Fastify fixture with temporary storage. TypeScript, ESLint, the production build, and all 10 tests passed on Node 24. The document test verifies upload, listing, exact downloaded bytes, editing, student deletion denial, and teacher deletion. The rendered student view and attendance regression passed in jsdom. Live browser layout and multi-page navigation were outside this run.

Materials uses sample data in mock mode. Marks and admin Users are available only in mock mode.

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
