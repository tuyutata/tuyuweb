import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCandidate, verifyCandidate } from "../scripts/release-candidate.mjs";

const sourceSHA = "0123456789abcdef0123456789abcdef01234567";
const ciRunID = "33027284353";

test("builds and verifies the immutable official website candidate", () => {
  const temporary = mkdtempSync(join(tmpdir(), "tuyuweb-release-test-"));
  try {
    const candidate = join(temporary, "candidate");
    const archive = join(temporary, "tuyuweb.tgz");
    const manifest = buildCandidate({
      projectPath: new URL("..", import.meta.url).pathname,
      sourceDistPath: process.env.TUYUWEB_DIST
        ? join(process.env.TUYUWEB_DIST, "client")
        : new URL("../dist/client", import.meta.url).pathname,
      outputPath: candidate,
      archivePath: archive,
      sourceSHA,
      ciRunID,
    });
    assert.equal(manifest.product_id, "tuyuweb");
    assert.equal(manifest.platform, "web");
    assert.equal(manifest.git_commit_sha, sourceSHA);
    assert.equal(manifest.ci_run_id, Number(ciRunID));
    assert.ok(manifest.files.some(({ path }) => path === "dist/index.html"));
    assert.ok(manifest.files.some(({ path }) => path === "dist/tuyuweb-release.json"));
    assert.equal(verifyCandidate(candidate, {
      sourceSHA,
      ciRunID,
      version: manifest.software_version,
      archivePath: archive,
    }).assets_sha256, manifest.assets_sha256);
    assert.match(readFileSync(join(candidate, "SHA256SUMS"), "utf8"), /  dist\/index\.html\n/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
