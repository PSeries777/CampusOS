# CampusOS demo

Use the [quick start](../README.md#quick-start) to run React and the real Fastify API with a fresh SQLite database in memory.

## Accounts

All fixture accounts use `CampusOS-Local-Test-Only`.

| Role | Email |
| --- | --- |
| Admin | `admin@integration.test` |
| Teacher | `teacher@integration.test` |
| Student | `student@integration.test` |
| Second student | `second@integration.test` |

Use separate browser profiles to keep role sessions independent. If demonstrating both students checking in, use different profiles because the API allows one check-in per browser fingerprint per session.

## Walkthrough

1. **Accounts and courses.** As admin, open **Users** to create a teacher or student. Under **Courses**, create a course and select a teacher by name. The seeded teacher and two students already have a course called CS101.
2. **Attendance.** As teacher, open **Attendance**, select CS101, and start a session. As student, enter the session code on **Overview**. Return to the teacher workspace to see the updated roster and end the session.
3. **Materials.** As teacher, open **Materials** and upload a small sample file for CS101. Download the file as the student.
4. **Marks.** As teacher, open **Marks**, create an assessment, and save a score for Test Student. Open **Marks** in the student session and refresh to see the result if needed. Check the second student's view to see an ungraded entry.

Restart the fixture API to reset records. For data that should survive restarts, use the [persistent setup](../backend/README.md#install-and-run).
