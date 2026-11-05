import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateReport } from "./policy.mjs";

const { BASE_SHA, OUTPUT_DIR } = process.env;
if (!/^[a-f0-9]{40}$/.test(BASE_SHA || ""))
  throw new Error("Invalid base SHA.");
const git = (...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: process.argv[2],
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
git("add", "--all");
writeFileSync(
  join(OUTPUT_DIR, "implementation.patch"),
  git("diff", "--cached", "--binary", "--full-index", BASE_SHA),
);
git("merge-base", "--is-ancestor", BASE_SHA, "HEAD");
if (Number(git("rev-list", "--count", `${BASE_SHA}..HEAD`)) === 0)
  throw new Error("Implementation skill did not commit its work.");
validateReport(
  JSON.parse(readFileSync(join(OUTPUT_DIR, "report.json"), "utf8")),
);
