# Core Directive

Never write production code before writing a failing test. You must treat the "Refactor" step with the same rigor as writing functional code. Do not skip or rush it.

---

## The Double-Loop TDD Protocol

You must execute software changes exclusively using these two nesting loops. Do not write a single line of application logic outside of this cycle.

### Loop 1: The Outer Loop (Behavior / Integration)
1. **Write an Acceptance Test:** Write a single integration or end-to-end test defining the new feature, user story, or API endpoint from the outside in.
2. **Verify Failure (Red):** Run the outer test. Log the exact error. It must fail due to a missing implementation, not a syntax error.
3. **Drop into Inner Loop:** Maintain this failing state until all necessary unit blocks are built.
4. **Verify Success (Green):** Once the inner loop completes, run the outer test. It must pass.
5. **Outer Refactor:** Clean up high-level architecture, module boundaries, and environment configurations. Ensure tests remain green.

### Loop 2: The Inner Loop (Unit / Component)
For every micro-feature or internal component needed to satisfy the Outer Loop:
1. **Write Unit Test (Red):** Write the smallest possible test for a single class, function, or method. Run it and verify it fails.
2. **Make it Pass (Green):** Write the *minimum* possible production code to make the unit test pass. Do not over-engineer. Do not write ahead of the test.
3. **CRITICAL STEP: Explicit Refactor (Blue):** Stop. Do not write the next test yet. Look at the code you just wrote and ruthlessly optimize it (see "Refactoring Mandate" below).
4. **Repeat:** Cycle through the Inner Loop until the component logic is complete, then return to the Outer Loop.

---

## The Refactoring Mandate (Strict Enforcement)

AI agents frequently rush from Green straight to the next Red test, leaving behind messy code. **You are forbidden from skipping the Refactor phase.** 

Every time you reach a **Green** state (both in the inner and outer loops), you must evaluate the codebase against the following criteria and execute improvements:

### 1. Code Quality Diagnostics
* **Eliminate Duplication (DRY):** Look for structural or literal duplication between the new code, existing code, and even the test files. Extract shared helpers.
* **Remove Smells:** Break down functions longer than 15 lines. Extract classes if a single class holds more than two distinct responsibilities (Single Responsibility Principle).
* **Fix Naming:** Rename variables, parameters, and functions to perfectly match the domain vocabulary. Ensure test names explicitly state the business behavior they verify.
* **Maximize Readability:** Replace complex conditional logic with early returns (guard clauses) or descriptive boolean variables.

### 2. Execution Discipline
* **Small Steps:** Make one structural change at a time. Run your unit tests after *every single* small change (e.g., after renaming a variable, after extracting a method).
* **Zero Functional Changes:** Never add new features, edge cases, or bug fixes during the Refactor phase. If you notice a missing feature, finish refactoring the current structure first, then write a new Red test for it.
* **Test Refactoring:** Refactor your tests too. Clean up messy setup blocks (`beforeEach`), remove magic values, and ensure your assertions are highly readable.

---

## Changelog Maintenance (Strict Enforcement)

`CHANGELOG.md` at the repo root records every user-visible change. A gate in the test
suite fails a release whose tag has no changelog section — the file is not optional.

1. Every commit that changes user-visible behavior (features, fixes, UX, packaging,
   release/distribution behavior) MUST add an entry under `## [Unreleased]` in the same
   commit. No entry, no commit.
2. Internal refactors, test-only changes, and CI chores do NOT get entries.
3. When tagging `vX.Y.Z`: move the `## [Unreleased]` entries under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading BEFORE pushing the tag.
4. Entry format: Keep a Changelog categories (Added / Changed / Fixed / Removed).
   Write user-facing sentences ("the sign-in logo now appears on installed apps"), not
   commit-log phrasing.
5. Never invent entries: every line must trace to an actual change.

---

## Release Rules (Strict Enforcement)

A release is one operation: **changelog → notes → version → tag**. The tag
carries the version — the release workflow stamps `package.json` and
`appinfo.json` from the tag at publish time, so the agent's version decision
is the tag name. An agent must never push a release tag with a stale
changelog, notes that do not describe the actual diff, or unacknowledged
warnings.

### Cutting a release (once release is approved)

1. **Read the changelog.** Every entry under `## [Unreleased]` ships in this
   release. If a user-visible change since the last tag has no entry, add the
   entry first, then continue.
2. **Verify against the diff.** `git diff v<prev>..HEAD` must correspond to the
   entries: every user-visible change in the diff has an entry, and every entry
   traces to the diff. An entry with no change behind it is invented — delete it.
3. **Choose the version** per the Version Selection Ladder below. If the ladder
   produces a warning, present the Release Plan and stop (Warning Protocol).
4. **Write the release notes** from the section: every entry appears in the
   notes (changelog entries are already user-facing sentences), and the notes
   carry the compare link `v<prev>...v<new>` — the actual diff between the
   previous release and this one. A bare commit list is not a release
   description.
5. **Move the section**: the `## [Unreleased]` entries go under
   `## [<new>] - YYYY-MM-DD` (leave an empty `## [Unreleased]`), commit, push.
6. **Cut and push the tag `v<new>`.** The workflow builds, runs the full suite,
   packages the `.ipk`, publishes the release, and updates `repo.json`. On
   failure no release is published — fix and push a corrected tag.
7. **Verify after publish:** the release exists with the `.ipk` asset; the
   notes match the section from step 4 (if the workflow auto-generated notes,
   replace them with the step-4 notes); `repo.json` on main shows `<new>` with
   fresh hash/size.

### Version Selection Ladder

Evaluate the release contents top to bottom, stop at the first match:

1. **Major (`X.0.0`)** — anything that makes the software incompatible with the
   previous installed version: removed or renamed features, incompatible
   settings or saved data, changed app id or permissions.
2. **Minor (`X.(Y+1).0`)** — completely new functionality that did not exist in
   any previous release: a capability the user could not have had before.
   Refactors, internal improvements, and fixes to existing features never
   justify a minor.
3. **Patch (`X.Y.(Z+1)`)** — everything else: fixes, improvements, polish of
   existing features.

The 1.0.x line predates this ladder (features shipped as patches); from the
next release on, new features bump minor.

### Warning Protocol (stop and wait)

* **Incompatibility (major):** warn the user — what exactly breaks, for whom —
  and wait for explicit confirmation before cutting, unless the release
  instruction already named a major version or explicitly approved breaking
  changes.
* **New functionality (minor):** state the recommendation ("brand-new X →
  1.1.0, not 1.0.4") and wait for confirmation, unless a specific version was
  already instructed or a major is already in progress (a major subsumes a
  minor — no second warning).

A warning is never silently folded into an already-cut tag. When a warning
applies, present the full Release Plan in one message and stop.

### Release Plan (required output before any tag)

```
RELEASE PLAN v<new>  (from v<prev>)
  Contents : one line per changelog entry
  Bump     : patch | minor | major — <ladder reason>
  Warnings : none | breaking: <what breaks, for whom> | new feature: <what is new>
  Notes    : <draft, or "from CHANGELOG [<new>] section + compare link">
```

If any warning is non-`none` without confirmation → the tag does not move.

### Mechanical backstops (already in place)

`test/changelog.test.mjs` fails a tag that has no `## [X.Y.Z]` section; the
release workflow runs the full suite before publishing and publishes nothing
on failure. These gates catch structure — the rules above catch meaning
(completeness of the notes, correctness of the version, and the warnings that
must be acknowledged).

---

## Output Format and State Tracking

To prove you are adhering to this workflow, you must prepend every response or code block with a state header matching this format:

[LOOP STATE] -> [LAYER] -> [NEXT IMMEDIATE STEP]

Examples:
- `[RED] -> [OUTER] -> Writing failing integration test for user registration.`
- `[GREEN] -> [INNER] -> Unit test passing. Evaluating code for duplication.`
- `[REFACTOR] -> [INNER] -> Extracting password validation into a standalone utility function.`

If a test pass reveals an opportunity for refactoring, explicitly state: **"ENTERING REFACTORING PHASE"**, list the code smells identified, and execute the structural clean-up step-by-step.
