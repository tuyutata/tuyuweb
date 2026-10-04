#!/usr/bin/env node
// RELEASE_BUILD: full; CARGO_INCREMENTAL=0; 单平台目录不重复包装 web。

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const identity = Object.freeze({
  product: "tuyuweb",
  platform: "web",
  prefix: "tuyuweb-web-v",
  ciTitle: "途遇官网 · Web · CI",
  workflow: "tuyuweb.web.release",
  archive: "tuyuweb.tgz",
});
const candidateTool = fileURLToPath(new URL("../release-candidate.mjs", import.meta.url));

function required(value, message) {
  if (!value) throw new Error(message);
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d{0,1})\.(0|[1-9]\d{0,1})$/.exec(value || "");
  required(match, `Web 软件版本无效：${value || "(empty)"}`);
  return match.slice(1).map(Number);
}

function inputs() {
  const value = {
    repository: process.env.GITHUB_REPOSITORY,
    source: process.env.SOURCE_SHA,
    ciRunID: process.env.CI_RUN_ID,
    version: process.env.SOFTWARE_VERSION,
    tag: process.env.VERSION_TAG,
    candidate: process.env.CANDIDATE_DIR,
    archive: process.env.ARCHIVE_PATH,
  };
  required(value.repository === "tuyutata/tuyuweb", "途遇网站仓库身份无效");
  required(/^[0-9a-f]{40}$/.test(value.source || ""), "Web Release 源提交无效");
  required(/^[1-9][0-9]*$/.test(value.ciRunID || ""), "Web CI Run ID 无效");
  required(/^\d+\.\d{1,2}\.\d{1,2}$/.test(value.version || ""), "Web 版本无效");
  required(value.tag === `${identity.prefix}${value.version}`, "Web Tag 无效");
  return value;
}

function githubJSON(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", env: process.env }));
}


function verifyReleaseSource(value) {
  required(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === value.source,
    "Web 源码提交不一致");
  const run = githubJSON([
    "api", `repos/${value.repository}/actions/runs/${value.ciRunID}`,
    "--jq", "{id,head_sha,head_branch,event,status,conclusion,display_title,path}",
  ]);
  required(String(run.id) === value.ciRunID
    && run.head_sha === value.source
    && run.head_branch === "main"
    && run.event === "workflow_dispatch"
    && run.status === "completed"
    && run.conclusion === "success"
    && String(run.display_title || '') === identity.ciTitle
    && run.path === ".github/workflows/tuyuweb-web-ci.yml", "Web CI Run 身份不一致");
}

function applyVersion(version) {
  for (const path of ["tuyuweb/package.json", "tuyuweb/package-lock.json"]) {
    const json = JSON.parse(readFileSync(path, "utf8"));
    json.version = version;
    if (path.endsWith("package-lock.json")) {
      required(json.packages?.[""], "Web package-lock 根包缺失");
      json.packages[""].version = version;
    }
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
}

function buildRelease(value) {
  applyVersion(value.version);
  execFileSync("npm", ["ci"], { cwd: "tuyuweb", stdio: "inherit", env: process.env });
  execFileSync("npm", ["run", "build"], { cwd: "tuyuweb", stdio: "inherit", env: process.env });
  execFileSync("npm", ["run", "test:contracts"], { cwd: "tuyuweb", stdio: "inherit", env: process.env });
  execFileSync("npm", ["run", "test:sites"], { cwd: "tuyuweb", stdio: "inherit", env: process.env });
  execFileSync("npm", ["run", "test:release"], { cwd: "tuyuweb", stdio: "inherit", env: process.env });
  execFileSync("npm", ["audit", "--audit-level=high"], { cwd: "tuyuweb", stdio: "inherit", env: process.env });
  const root = process.env.RELEASE_DIR || `${process.env.RUNNER_TEMP}/tuyuweb-release`;
  rmSync(root, { recursive: true, force: true });
  execFileSync(process.execPath, [
    candidateTool, "build",
    "--project", "tuyuweb", "--dist", "tuyuweb/dist/client",
    "--output", `${root}/candidate`, "--archive", `${root}/${identity.archive}`,
    "--source-sha", value.source,
    "--ci-run-id", value.ciRunID,
  ], { stdio: "inherit", env: process.env });
  process.env.CANDIDATE_DIR = `${root}/candidate`;
  process.env.ARCHIVE_PATH = `${root}/${identity.archive}`;
  verifyCandidate({ ...value, candidate: process.env.CANDIDATE_DIR, archive: process.env.ARCHIVE_PATH });
}

function verifyCandidate(value) {
  required(value.candidate && value.archive, "Web Release 候选路径缺失");
  required(existsSync(value.candidate) && lstatSync(value.candidate).isDirectory(), "Web CI 候选目录不存在");
  required(existsSync(value.archive) && lstatSync(value.archive).isFile(), "Web CI 规范归档不存在");
  execFileSync(process.execPath, [
    candidateTool, "verify",
    "--candidate", value.candidate,
    "--archive", value.archive,
    "--source-sha", value.source,
    "--ci-run-id", value.ciRunID,
    "--version", value.version,
  ], { stdio: "inherit", env: process.env });
}

function writeContext(value) {
  writeFileSync("release-context.json", `${JSON.stringify({
    repository: value.repository,
    product_id: identity.product,
    platform: identity.platform,
    software_flow: "release",
    software_version: value.version,
    version_tag: value.tag,
    source_sha: value.source,
    ci_run_id: Number(value.ciRunID),
    workflow: identity.workflow,
  }, null, 2)}\n`);
}

function commandSucceeded(command, args) {
  return spawnSync(command, args, { stdio: "ignore", env: process.env }).status === 0;
}

function publishRelease(value) {
  verifyCandidate(value);
  required(!commandSucceeded("gh", ["release", "view", value.tag, "--repo", value.repository]),
    "同名 Web GitHub Release 已存在，拒绝覆盖");
  required(!commandSucceeded("gh", [
    "api", `repos/${value.repository}/git/ref/tags/${value.tag}`,
  ]), "同名 Web Git Tag 已存在，拒绝覆盖");
  const manifest = `${value.candidate}/release-manifest.json`;
  const checksums = `${value.candidate}/SHA256SUMS`;
  execFileSync("gh", [
    "release", "create", value.tag,
    value.archive, manifest, checksums,
    "--repo", value.repository,
    "--title", "途遇官网 · Release · Web",
    "--notes", `途遇官网 ${value.version}；只允许正式发布器消费本 Release。`,
    "--latest=false",
  ], { stdio: "inherit", env: process.env });
  const release = githubJSON([
    "release", "view", value.tag, "--repo", value.repository,
    "--json", "tagName,isDraft,isPrerelease,assets,url",
  ]);
  required(release.tagName === value.tag && release.isDraft === false && release.isPrerelease === false,
    "Web GitHub Release 状态无效");
  const names = release.assets.map((asset) => asset.name).sort();
  required(JSON.stringify(names) === JSON.stringify(["SHA256SUMS", "release-manifest.json", identity.archive].sort()),
    "Web GitHub Release 资产集合无效");
  process.stdout.write(`途遇官网正式 Release：${release.url}\n`);
}

try {
  const command = process.argv[2];
  const value = inputs();
  if (command === "verify-release-source") verifyReleaseSource(value);
  else if (command === "build-release") buildRelease(value);
  else if (command === "verify-candidate") verifyCandidate(value);
  else if (command === "write-context") writeContext(value);
  else if (command === "publish-release") publishRelease(value);
  else throw new Error(`Web Release 子命令未登记：${command || "(empty)"}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
