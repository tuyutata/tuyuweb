#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.TUYUWEB_DIST
  ? path.resolve(process.env.TUYUWEB_DIST)
  : path.join(tmpdir(), "tuyuweb", "dist");
if (!path.isAbsolute(dist) || dist === root || dist.startsWith(root + path.sep)) {
  throw new Error("TUYUWEB_DIST必须是TuyuWeb源码外的绝对路径");
}
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker.js");
const hosting = path.join(root, "hosting.json");

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
const placeholder = JSON.stringify("__TUYU_INDEX_HTML_PLACEHOLDER__");
const workerSource = readFileSync(worker, "utf8");
if (!workerSource.includes(placeholder)) {
  throw new Error("Missing Sites HTML injection placeholder");
}

const builtWorker = workerSource.replace(
  placeholder,
  JSON.stringify(readFileSync(index, "utf8")),
);

writeFileSync(path.join(dist, "server", "index.js"), builtWorker);
writeFileSync(path.join(dist, ".openai", "hosting.json"), readFileSync(hosting));

console.log("Prepared Sites build: kept static index and emitted worker/hosting manifest");
