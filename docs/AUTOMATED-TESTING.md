# Automated Testing and Continuous Integration

## 1. Purpose

The project uses Vitest for automated tests and GitHub Actions for continuous integration. Automated checks help identify errors before code changes are merged into the main branch.

## 2. Requirements

Install the project dependencies:

```bash
npm ci
```

Node.js and npm must be installed.

## 3. Run automated tests

Run the complete Vitest suite:

```bash
npm test
```

Run one specific test file:

```bash
npx vitest run src/lib/sla-utils.test.ts
```

Run Vitest in watch mode during development:

```bash
npx vitest
```

Vitest reports the number of test files and individual tests that pass or fail. A failing test returns a nonzero exit code.

## 4. Run lint checks

Run ESLint across the entire repository:

```bash
npm run lint
```

Run ESLint only on changed JavaScript and TypeScript files:

```bash
git fetch origin main
npm run lint:changed
```

The changed-file lint script compares the current branch with its base branch and checks changed JavaScript and TypeScript files. In GitHub Actions, it uses the pull request's target branch.

The repository has existing lint findings in untouched files. The CI workflow uses changed-file lint to avoid blocking contributions because of unrelated legacy findings. The full-project lint command remains available for broader cleanup.

## 5. Build the application

Run the production build:

```bash
npm run build
```

A successful build exits with code zero. Build errors are reported in the terminal.

## 6. Continuous integration workflow

The workflow is located at:

`.github/workflows/ci.yml`

GitHub Actions runs the following checks when a pull request targets `main`:

1. Check out the repository.
2. Set up Node.js.
3. Install dependencies using `npm ci`.
4. Run the automated test suite using `npm test`.
5. Lint changed JavaScript and TypeScript files.
6. Build the application using `npm run build`.

A failed step causes the workflow job to fail. Open the workflow run in the GitHub Actions tab to inspect the logs and identify the failing command.

## 7. Troubleshooting test failures

- Read the failing test name and assertion message.
- Review the affected source file and test.
- Reproduce the failure locally with `npx vitest run path/to/test-file`.
- Correct the underlying issue and rerun the relevant test.
- Run the complete suite with `npm test` before submitting the change.

Do not skip or weaken a test simply to make the workflow pass.

## 8. Recommended pull request process

1. Create a feature branch from the latest `main`.
2. Make the code changes and add or update relevant tests.
3. Run tests, changed-file lint, and the production build.
4. Push the feature branch.
5. Open a pull request targeting `main`.
6. Review the GitHub Actions results and resolve any failures before merging.

This process helps the team detect regressions and validate changes consistently.
