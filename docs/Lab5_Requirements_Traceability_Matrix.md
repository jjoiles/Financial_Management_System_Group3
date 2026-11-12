# Requirements Traceability Matrix - Lab 5 Evidence Addendum

**Project:** Financial Request Management System (Group 3)  
**Assignment deadline (user-confirmed):** November 2, 2026  
**Prepared:** November 12, 2026  
**Original source:** team Requirements.docx (24 functional requirements). This Markdown edition retains the original objective mapping and adds GitHub traceability.  

## Objective legend
- **Submission:** Simplified Submission & Accurate Data Entry
- **Workflow:** Automated Workflow & Communication
- **Insights:** Data-Driven Insights & Oversight
- **Security:** Security, Governance & Audit Readiness

## Functional requirements and evidence

| ID | Functional requirement | Original objective mapping | Backlog issue | Implementation evidence | Verification / board status |
|---|---|---|---|---|---|
| F1 | Conditional Logic | Submission | [#1](https://github.com/jjoiles/Financial_Management_System_Group3/issues/1) | Not verified | Not independently verified |
| F2 | Input Validation | Submission | [#2](https://github.com/jjoiles/Financial_Management_System_Group3/issues/2) | Not verified | Not independently verified |
| F3 | File Handling & Uploads | Submission | [#3](https://github.com/jjoiles/Financial_Management_System_Group3/issues/3) | Not verified | Not independently verified |
| F4 | Automated Metadata Generation | Submission; Security | [#4](https://github.com/jjoiles/Financial_Management_System_Group3/issues/4) | Not verified | Not independently verified |
| F5 | Automated Data Logging | Submission; Insights | [#5](https://github.com/jjoiles/Financial_Management_System_Group3/issues/5) | [PR #114](https://github.com/jjoiles/Financial_Management_System_Group3/pull/114) (merged 2026-10-15) | Issue closed; board Done; runtime tests unverified |
| F6 | Automated Record Linking | Submission | [#6](https://github.com/jjoiles/Financial_Management_System_Group3/issues/6) | Not verified | Not independently verified |
| F7 | Power Automate Workflow Initialization | Workflow | [#7](https://github.com/jjoiles/Financial_Management_System_Group3/issues/7) | Not verified | Not independently verified |
| F8 | Intelligent Branching Routing Logic | Workflow | [#8](https://github.com/jjoiles/Financial_Management_System_Group3/issues/8) | Not verified | Not independently verified |
| F9 | Real-time Status Tracking | Workflow; Insights | [#9](https://github.com/jjoiles/Financial_Management_System_Group3/issues/9) | Not verified | Not independently verified |
| F10 | Automated Reviewer Notifications | Workflow | [#10](https://github.com/jjoiles/Financial_Management_System_Group3/issues/10) | Not verified | Not independently verified |
| F11 | Automated Requester Status Updates | Workflow | [#11](https://github.com/jjoiles/Financial_Management_System_Group3/issues/11) | Not verified | Not independently verified |
| F12 | Filtering, Sorting & Searching | Insights | [#12](https://github.com/jjoiles/Financial_Management_System_Group3/issues/12) | Not verified | Not independently verified |
| F13 | Audit-Ready Activity Logs | Security | [#13](https://github.com/jjoiles/Financial_Management_System_Group3/issues/13) | Not verified | Not independently verified |
| F14 | Dedicated Test Environment | Security | [#14](https://github.com/jjoiles/Financial_Management_System_Group3/issues/14) | Not verified | Not independently verified |
| F15 | Dashboard Visualization (Power BI) | Insights | [#15](https://github.com/jjoiles/Financial_Management_System_Group3/issues/15) | Not verified | Not independently verified |
| F16 | SLA Tracking Engine | Insights | [#16](https://github.com/jjoiles/Financial_Management_System_Group3/issues/16) | Not verified | Not independently verified |
| F17 | Real-time Reporting Templates | Insights | [#17](https://github.com/jjoiles/Financial_Management_System_Group3/issues/17) | Not verified | Not independently verified |
| F18 | Temporal Filtering (Academic Term/Month) | Insights | [#18](https://github.com/jjoiles/Financial_Management_System_Group3/issues/18) | Not verified | Not independently verified |
| F19 | Efficiency & Process Analytics | Insights | [#19](https://github.com/jjoiles/Financial_Management_System_Group3/issues/19) | Not verified | Not independently verified |
| F20 | Immutable Audit Logs | Security | [#20](https://github.com/jjoiles/Financial_Management_System_Group3/issues/20) | Not verified | Not independently verified |
| F21 | Role-Based Access Control (RBAC) | Security | [#21](https://github.com/jjoiles/Financial_Management_System_Group3/issues/21) | Not verified | Not independently verified |
| F22 | Data Validation Gateways | Insights; Security | [#22](https://github.com/jjoiles/Financial_Management_System_Group3/issues/22) | [PR #110](https://github.com/jjoiles/Financial_Management_System_Group3/pull/110) (merged 2026-10-15) | Issue closed; board Done; migration/tests unverified |
| F23 | One-Click Export & Distribution | Insights; Security | [#23](https://github.com/jjoiles/Financial_Management_System_Group3/issues/23) | [PR #121](https://github.com/jjoiles/Financial_Management_System_Group3/pull/121) (open at last check) | Not verified complete |
| F24 | Automated Escalations & Reminders | Workflow; Insights | [#24](https://github.com/jjoiles/Financial_Management_System_Group3/issues/24) | Not verified | Not independently verified |

## Lab 5 acceptance and testing evidence

| Requirement | Expected behavior | Evidence available | Remaining acceptance check |
|---|---|---|---|
| F22 | Form/payload/database reject invalid financial requests; user receives field-specific errors | [Merged PR #110](https://github.com/jjoiles/Financial_Management_System_Group3/pull/110), code diff, [test instructions](https://github.com/jjoiles/Financial_Management_System_Group3/blob/main/docs/F22_Data_Validation_Gateways.md) | Run and record tests: external email, amount with 3 decimal places, missing research/university fields; confirm Supabase migration applied |
| F5 | Request/attachment changes generate events; activity list displays them | [Merged PR #114](https://github.com/jjoiles/Financial_Management_System_Group3/pull/114), code diff, [test instructions](https://github.com/jjoiles/Financial_Management_System_Group3/blob/main/docs/F5_Automated_Data_Logging.md) | Run and record: request creation, attachment event, status update, Activity UI; confirm Supabase migration applied |

**Important:** PR #110 and PR #114 were merged October 15, before the documented November 2-13 Sprint 1 plan. They are pre-deadline implementation evidence, **not proof of November sprint execution**. No runtime test pass or AI coding transcript is claimed here.

## Sprint 1 process traceability (separate from functional requirements)

| Sprint item | Issue | Owner | Last observed state | Acceptance / dependency |
|---|---|---|---|---|
| S1 - Board cleanup | [#125](https://github.com/jjoiles/Financial_Management_System_Group3/issues/125) | Jean Joiles | Closed; board Done | Acceptance checkboxes unchecked; duplicate closures not verified |
| S10 - End-to-end verification | [#128](https://github.com/jjoiles/Financial_Management_System_Group3/issues/128) | Jean Joiles | Open; board Todo | Depends on S4 and S6; requester/reviewer/Supabase/localStorage demo pending |

**Board:** https://github.com/users/jjoiles/projects/3/views/3  
**Sprint plan:** https://github.com/jjoiles/Financial_Management_System_Group3/pull/123  
**Snapshot caveat:** The supplied current-iteration board view was observed November 12 (11 Todo, 1 Done), not at the November 2 assignment deadline.

## AI-assisted development and responsible verification

The sprint plan documents AI-supported planning and human revision. The two implementation PRs contain code changes and testing instructions, but the available record does **not** independently establish the specific AI coding prompts, human review steps, or test execution outcomes for F5/F22. Add real screenshots, tool histories, test logs, and actual outcomes before claiming that these rubric elements are met.
