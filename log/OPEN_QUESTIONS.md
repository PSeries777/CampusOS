# Backend and deployment follow-ups

- Student search has no route. Enrollment uses the student UUID until a search contract is available.
- Assessments, marks, and listing users still need API contracts. Marks and Users remain available with demo data in mock mode. Materials uses the Phase 5 document API in real mode. Admin course management uses the real course routes.
- Attendance tier thresholds are provisional. When the backend begins sending a tier, the frontend shows Pending check on disagreement and reports it to the development console. A logging endpoint is pending.
- Confirm production SPA fallback, static hosting, compression, and CSP with the backend owner.
