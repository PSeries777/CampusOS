# CampusOS — Phase 5 Implementation Log

**Phase:** 5 — Document & Notes Management  
**Status:** Implemented and tested  
**Backend commit:** `f5f36afe24b37cdf21c1b845a3ad001842f8cac3`  
**Commit message:** `Complete backend Phase 5 document management`  
**Verification date:** 24 November 2026

This log records the Phase 5 backend work so the frontend/next-phase contributor can understand the implemented contract and avoid re-implementing existing functionality.

## 1. SRS scope and traceability

Phase 5 implements the document-management requirements in **SRS v2.0, FR-2**:

- **FR-2.1:** Teacher document uploads, with a maximum size of 50 MB per file.
- **FR-2.2:** Local device storage plus SQLite metadata.
- **FR-2.3:** Enrolled-student access to document listing and HTTP downloads, with path-safety protections.

The accepted file formats are PDF, DOCX, PNG, JPG/JPEG and ZIP.

**Important scope boundary:** Phase 5 is the backend document-management phase. It does not implement the SRS assessment/marks requirements (FR-3.1 to FR-3.3). A frontend demo screen using sample marks/materials is not evidence that those backend features exist.

## 2. Implemented API contract

All routes are mounted under `/api`. The API uses the existing response envelope for JSON responses.

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| POST | `/api/documents` | Teacher, admin | Upload one document as multipart form data |
| GET | `/api/documents?courseId=<id>&page=1&limit=50` | Authenticated user, subject to course access | List document metadata; optional course filter and pagination |
| PATCH | `/api/documents/:documentId` | Teacher, admin with course-management permission | Update title and/or description |
| DELETE | `/api/documents/:documentId` | Teacher, admin with course-management permission | Delete document metadata and stored file |
| GET | `/api/documents/:documentId/download` | Authenticated user with course access | Stream the document as an attachment |

### Upload request

Use `multipart/form-data` with these fields:

- `courseId` — required course UUID.
- `title` — required, non-blank title (maximum 200 characters).
- `description` — optional (maximum 1,000 characters).
- `file` — exactly one supported file.

Send `courseId` before the file part where possible. The backend checks course-management permission before staging the upload. File-first multipart requests are also supported and are still validated.

A successful upload returns **201 Created** with metadata. The stored filesystem key/path is not exposed in the returned metadata.

### Listing and pagination

- Page numbering starts at 1.
- Default page size is 50; maximum is 100.
- If another page exists, the response includes `X-Next-Page`.
- A page beyond the end returns an empty array.
- The metadata list does not disclose the internal storage path.

### Relevant outcomes

- Upload success: 201.
- Oversized file/archive or archive-entry limit: 413.
- Unsupported format, invalid signature or malformed document: 415.
- Invalid fields or unsafe filename: 400.
- Upload concurrency limit: 429 with `Retry-After`.
- Upload deadline: 408.
- Successful delete: 204.

Exact error codes/messages should be read from the implementation rather than duplicated in frontend code.

## 3. Validation and storage safeguards

The implementation includes the following protections:

- Maximum upload size is **50 MiB (52,428,800 bytes)**.
- Only one file is accepted per upload request.
- Extension and file-content/signature validation are both applied; renaming an unsupported file does not make it acceptable.
- PDF, PNG and JPEG structures are checked for malformed/truncated content.
- ZIP and DOCX archive structures are validated, with a configurable archive-entry ceiling.
- Path-like filenames, control characters, unsupported formats, malformed archives and mismatched file signatures are rejected.
- Upload streams are bounded by a configurable timeout and concurrency limit.
- Interrupted, truncated, oversized or failed uploads are cleaned up so they do not leave a published database row or partial document behind.
- Files are stored under generated UUID-based private storage keys, not user-supplied filenames.
- Download responses use attachment disposition, content length, `X-Content-Type-Options: nosniff`, and private/no-store caching.
- Course access and role authorization are enforced by the backend; the frontend must not be treated as the security boundary.

### Local storage / Android requirements

- `UPLOAD_DIR` must be a dedicated private directory.
- On Termux/Android, it must be beneath the Termux app's private application storage, not shared storage such as `/sdcard`.
- On POSIX systems, the upload root is expected to be owned by the server user and protected (normally mode `0700`).
- On Windows, use a private NTFS ACL for the upload directory and protect parent directories from replacement by other users.
- `DATABASE_PATH` must remain outside `UPLOAD_DIR`.
- Run one backend instance per database and upload directory.
- Startup validates the storage path and filesystem operations before the server begins listening. It also reconciles recognizable abandoned upload/delete reservations.

## 4. Configuration

The following document settings are available:

| Environment variable | Default | Allowed range / purpose |
|---|---:|---|
| `DOCUMENT_UPLOAD_CONCURRENCY` | 2 | 1–16 simultaneous uploads per backend process |
| `DOCUMENT_UPLOAD_TIMEOUT_MS` | 120000 | 1–900000 milliseconds |
| `DOCUMENT_ARCHIVE_MAX_ENTRIES` | 1000 | 1–10000 ZIP/DOCX entries |
| `UPLOAD_DIR` | `./uploads` | Dedicated private local storage directory |

Keep deployment-specific values in the local environment; do not commit secrets, databases or uploaded files.

## 5. Main implementation files

- `backend/src/modules/documents/documents.routes.js` — route registration, authentication/authorization, multipart limits, concurrency and timeout.
- `backend/src/modules/documents/documents.controller.js` — request parsing, course permission checks, HTTP responses and download headers.
- `backend/src/modules/documents/documents.service.js` — document metadata operations and access rules.
- `backend/src/modules/documents/documents.storage.js` — file staging, storage, reading, deletion and recovery operations.
- `backend/src/modules/documents/documents.validation.js` — supported-format and document-content validation.
- `backend/src/modules/documents/documents.schema.js` — route/query/body validation and pagination limits.
- `backend/src/config/documents.js` — upload configuration defaults and validation.
- `backend/src/config/upload-root.js` — private storage-root validation, including Android/Termux path policy.
- `backend/src/database/migrations/002_documents_original_filename.sql` — adds original filename metadata without discarding existing document rows.
- `backend/src/database/migrations/003_documents_pagination_index.sql` — adds the document-list pagination index.

Tests and fixtures are under `backend/tests/`, including `phase5.test.js`, `phase5-api.test.js`, `startup-storage.test.js`, `env.test.js` and `document-fixtures.js`.

## 6. Test and verification record

The complete backend test suite was run after Phase 5 implementation.

| Environment | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Windows (Node.js) | 146 | 145 | 0 | 1 |
| Android Termux | 146 | 146 | 0 | 0 |

The single Windows skip is the POSIX ownership/mode-permission test, which requires a POSIX runner. The Android Termux run exercised the Android storage policy and hard-link-denial coverage.

The Termux verification was performed in an isolated test copy. Its generated database, environment secrets and runtime files are not part of the Windows master repository.

The Android server also started successfully, applied migrations, listened on port 8080 and returned a healthy response from `/api/health`. The reported database status included WAL journal mode and foreign keys enabled.

### Test areas covered

- Existing document rows survive the filename migration; migrations are idempotent.
- Upload, metadata persistence, listing and streaming for supported file types.
- Exact 50 MiB boundary and rejection above the limit.
- Unsupported extensions, mismatched signatures, malformed/truncated PDF, PNG, JPEG, ZIP and DOCX structures.
- Unsafe/path-like filenames and invalid multipart requests.
- Upload interruption, database failure and filesystem failure cleanup.
- Course access, role restrictions, metadata updates and deletion behavior.
- Pagination and document download behavior.
- Private storage root, unsafe permissions, symlinks/replaced directories and Android Termux path policy.
- Storage behavior when hard-link operations are unavailable.
- Startup rejection when storage configuration is unsafe or the database is placed under the upload root.

**Recorded result:** zero failed tests on both environments. The Fastify deprecation warning observed during tests was non-fatal and did not cause a test failure.

## 7. Guidance for the frontend / next-phase contributor

1. Treat the API table in Section 2 as the backend document API contract.
2. Use the authenticated API; do not build document authorization decisions only in the browser.
3. Upload with multipart form data and send `courseId` and `title`; do not manually set a multipart boundary header.
4. Use the document ID returned by the API for downloads; do not construct or expose filesystem paths.
5. Handle pagination using `X-Next-Page`.
6. Display the server's upload errors (especially 413, 415, 429 and 408) in a user-friendly way.
7. Do not assume marks/assessments are implemented by Phase 5. They are separate SRS FR-3 requirements and need their own backend implementation and tests.
8. Before integrating a frontend branch, sync it with the latest `main` so it includes the Phase 5 backend commit.

## 8. Source of truth

The implementation and tests in the repository are authoritative. This log is a contributor-oriented summary; if a detail here differs from the code, migrations or tests, verify the implementation and update this log.

- Phase 5 commit: `f5f36afe24b37cdf21c1b845a3ad001842f8cac3`
- Repository: https://github.com/PSeries777/CampusOS
- Backend README: `backend/README.md`
