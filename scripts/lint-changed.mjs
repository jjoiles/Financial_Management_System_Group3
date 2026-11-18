import { execFileSync } from "node:child_process";

const baseRef = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : (process.env.LINT_BASE_REF ?? "origin/main");

let changedFiles;

try {
  changedFiles = execFileSync("git", ["diff", "--name-only", "-z", `${baseRef}...HEAD`], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
} catch {
  console.error(`Could not compare against ${baseRef}.`);
  console.error("Fetch the base branch and try again.");
  process.exit(1);
}

const sourceFiles = changedFiles.filter((file) => /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(file));

if (sourceFiles.length === 0) {
  console.log("No changed JavaScript or TypeScript files to lint.");
  process.exit(0);
}

console.log(`Linting ${sourceFiles.length} changed source file(s):`);
sourceFiles.forEach((file) => console.log(`- ${file}`));

execFileSync("npx", ["eslint", ...sourceFiles], {
  stdio: "inherit",
});
