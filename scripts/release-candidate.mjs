#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const PRODUCT_ID = "tuyuweb";
const PLATFORM = "web";
const VERSION_MARKER = "dist/tuyuweb-release.json";
const ROOT_PAYLOAD = ["package-lock.json", "package.json"];

function fail(message) {
  throw new Error(message);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prettyStableJson(value) {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必须是对象`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} 字段集合不正确`);
}

function regularFiles(root) {
  const values = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) fail(`候选禁止符号链接：${relativePath}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) values.push(relativePath);
      else fail(`候选只允许普通文件和目录：${relativePath}`);
    }
  };
  visit(root);
  return values.sort();
}

function assertNoSecrets(root) {
  const forbiddenName = /(^|\/)(\.env(?:\.|$)|\.dev\.vars(?:\.|$)|\.wrangler(?:\/|$)|.*\.(?:pem|p8|p12|jks|keystore))$/i;
  const privateMaterial = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
  for (const path of regularFiles(root)) {
    if (forbiddenName.test(path)) fail(`候选包含禁止的本地或密钥文件：${path}`);
    if (privateMaterial.test(readFileSync(join(root, ...path.split("/")), "utf8"))) {
      fail(`候选疑似包含私密材料：${path}`);
    }
  }
}

function parsePackage(project) {
  const packageJson = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  const lockJson = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
  const version = String(packageJson.version || "");
  if (!/^\d+\.\d{1,2}\.\d{1,2}$/.test(version)) fail(`官网软件版本无效：${version}`);
  if (lockJson.version !== version || lockJson.packages?.[""]?.version !== version) {
    fail("package.json 与 package-lock.json 官网软件版本不一致");
  }
  return { lockJson, version };
}

function copyPayload(sourceRoot, outputRoot, path) {
  const destination = join(outputRoot, ...path.split("/"));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(join(sourceRoot, ...path.split("/")), destination);
}

function fileEntries(root, paths) {
  return paths.map((path) => ({ path, sha256: sha256File(join(root, ...path.split("/"))) }));
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) fail("Release 归档字段超过 tar 限制");
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function deterministicTar(candidate) {
  const chunks = [];
  for (const path of regularFiles(candidate)) {
    if (Buffer.byteLength(path) > 100) fail(`Release 归档路径过长：${path}`);
    const content = readFileSync(join(candidate, ...path.split("/")));
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function readTarOctal(header, offset, length, label) {
  const value = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) fail(`Release 归档 ${label} 无效`);
  return Number.parseInt(value, 8);
}

function verifyCanonicalArchive(archive, candidate) {
  const tar = gunzipSync(readFileSync(archive));
  if (!deterministicTar(candidate).equals(tar)) fail("Release 归档不是规范的确定性候选");
  let offset = 0;
  const paths = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const stored = readTarOctal(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    if (stored !== checksumHeader.reduce((sum, byte) => sum + byte, 0)) fail("Release 归档 checksum 无效");
    const nul = header.indexOf(0, 0);
    const path = header.subarray(0, nul < 0 ? 100 : nul).toString("utf8");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) fail("Release 归档路径不安全");
    const size = readTarOctal(header, 124, 12, "size");
    paths.push(path);
    offset += Math.ceil(size / 512) * 512;
  }
  if (JSON.stringify(paths) !== JSON.stringify(regularFiles(candidate))) fail("Release 归档文件集合无效");
}

export function verifyCandidate(candidatePath, {
  sourceSHA = null, ciRunID = null, version = null, archivePath = null,
} = {}) {
  const candidate = resolve(candidatePath);
  const manifestPath = join(candidate, "release-manifest.json");
  const checksumPath = join(candidate, "SHA256SUMS");
  if (!existsSync(manifestPath) || !existsSync(checksumPath)) fail("候选缺少正式校验资产");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  exactKeys(manifest, ["assets_sha256", "ci_run_id", "files", "git_commit_sha", "platform", "product_id", "software_version", "tools"], "release manifest");
  if (manifest.product_id !== PRODUCT_ID || manifest.platform !== PLATFORM) fail("候选产品或平台身份无效");
  if (!/^[0-9a-f]{40}$/.test(manifest.git_commit_sha)) fail("候选 Git SHA 无效");
  if (sourceSHA !== null && manifest.git_commit_sha !== sourceSHA) fail("候选 Git SHA 与 CI 来源不一致");
  if (!Number.isSafeInteger(manifest.ci_run_id) || manifest.ci_run_id < 1) fail("候选 CI Run ID 无效");
  if (ciRunID !== null && manifest.ci_run_id !== Number(ciRunID)) fail("候选 CI Run ID 与 Release 锁定值不一致");
  if (!/^\d+\.\d{1,2}\.\d{1,2}$/.test(manifest.software_version)) fail("候选软件版本无效");
  if (version !== null && manifest.software_version !== version) fail("候选软件版本与 Release 输入不一致");
  exactKeys(manifest.tools, ["node", "npm", "vite"], "候选工具版本");
  if (!Array.isArray(manifest.files) || manifest.files.length < 4) fail("候选文件清单无效");
  const paths = [];
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "sha256"], "候选文件条目");
    if (!/^(dist\/|package(?:-lock)?\.json$)[A-Za-z0-9._/-]*$/.test(entry.path)
        || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail("候选文件条目无效");
    const path = join(candidate, ...entry.path.split("/"));
    if (!existsSync(path) || !lstatSync(path).isFile() || sha256File(path) !== entry.sha256) {
      fail(`候选文件哈希不一致：${entry.path}`);
    }
    paths.push(entry.path);
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length) {
    fail("候选文件顺序或唯一性无效");
  }
  for (const required of [...ROOT_PAYLOAD, "dist/index.html", VERSION_MARKER]) {
    if (!paths.includes(required)) fail(`候选缺少必需文件：${required}`);
  }
  const packageVersion = parsePackage(candidate).version;
  if (packageVersion !== manifest.software_version) fail("候选 package 版本与 manifest 不一致");
  const assetEntries = manifest.files.filter(({ path }) => path.startsWith("dist/") && path !== VERSION_MARKER);
  if (sha256Bytes(stableJson(assetEntries)) !== manifest.assets_sha256) fail("候选静态资源摘要不一致");
  const marker = JSON.parse(readFileSync(join(candidate, ...VERSION_MARKER.split("/")), "utf8"));
  exactKeys(marker, ["assets_sha256", "git_commit_sha", "product_id", "software_version"], "官网版本标记");
  if (stableJson(marker) !== stableJson({
    product_id: PRODUCT_ID,
    software_version: manifest.software_version,
    git_commit_sha: manifest.git_commit_sha,
    assets_sha256: manifest.assets_sha256,
  })) fail("官网版本标记与 Release 候选不一致");
  const expectedChecksums = [
    ...manifest.files,
    { path: "release-manifest.json", sha256: sha256File(manifestPath) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const checksumText = `${expectedChecksums.map(({ sha256, path }) => `${sha256}  ${path}`).join("\n")}\n`;
  if (readFileSync(checksumPath, "utf8") !== checksumText) fail("候选 SHA256SUMS 不一致");
  const expectedFiles = [...paths, "release-manifest.json", "SHA256SUMS"].sort();
  if (JSON.stringify(regularFiles(candidate)) !== JSON.stringify(expectedFiles)) fail("候选包含未登记文件");
  assertNoSecrets(candidate);
  if (archivePath !== null) verifyCanonicalArchive(resolve(archivePath), candidate);
  return manifest;
}

export function buildCandidate({ projectPath, sourceDistPath, outputPath, archivePath, sourceSHA, ciRunID }) {
  const project = resolve(projectPath);
  const sourceDist = resolve(sourceDistPath);
  const output = resolve(outputPath);
  const archive = resolve(archivePath);
  if (!/^[0-9a-f]{40}$/.test(sourceSHA)) fail("Git commit SHA 必须是 40 位小写十六进制");
  if (!/^[1-9][0-9]*$/.test(ciRunID)) fail("CI Run ID 必须是正整数");
  if (!existsSync(sourceDist) || !lstatSync(sourceDist).isDirectory()) fail("官网 dist/client 目录不存在");
  if (existsSync(output) || existsSync(archive)) fail("候选输出已存在，拒绝覆盖");
  const distFiles = regularFiles(sourceDist);
  if (!distFiles.includes("index.html")) fail("官网正式构建缺少 index.html");
  assertNoSecrets(sourceDist);
  const { lockJson, version } = parsePackage(project);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const path of distFiles) copyPayload(sourceDist, join(output, "dist"), path);
  for (const path of ROOT_PAYLOAD) copyPayload(project, output, path);
  const assetPaths = distFiles.map((path) => `dist/${path}`).sort();
  const assets = fileEntries(output, assetPaths);
  const assetsSHA256 = sha256Bytes(stableJson(assets));
  writeFileSync(join(output, ...VERSION_MARKER.split("/")), prettyStableJson({
    product_id: PRODUCT_ID,
    software_version: version,
    git_commit_sha: sourceSHA,
    assets_sha256: assetsSHA256,
  }), { mode: 0o600 });
  const payloadPaths = [...ROOT_PAYLOAD, ...assetPaths, VERSION_MARKER].sort();
  const manifest = {
    product_id: PRODUCT_ID,
    platform: PLATFORM,
    software_version: version,
    git_commit_sha: sourceSHA,
    ci_run_id: Number(ciRunID),
    tools: {
      node: process.version.replace(/^v/, ""),
      npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
      vite: String(lockJson.packages?.["node_modules/vite"]?.version || ""),
    },
    assets_sha256: assetsSHA256,
    files: fileEntries(output, payloadPaths),
  };
  if (!/^\d+\.\d+\.\d+/.test(manifest.tools.vite)) fail("package-lock.json 缺少锁定的 Vite 版本");
  const manifestPath = join(output, "release-manifest.json");
  writeFileSync(manifestPath, prettyStableJson(manifest), { mode: 0o600 });
  const checksums = [
    ...manifest.files,
    { path: "release-manifest.json", sha256: sha256File(manifestPath) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(join(output, "SHA256SUMS"), `${checksums.map(({ sha256, path }) => `${sha256}  ${path}`).join("\n")}\n`, { mode: 0o600 });
  verifyCandidate(output, { sourceSHA, ciRunID });
  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  writeFileSync(archive, gzipSync(deterministicTar(output), { level: 9, mtime: 0 }), { mode: 0o600, flag: "wx" });
  verifyCandidate(output, { sourceSHA, ciRunID, archivePath: archive });
  return manifest;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || Object.hasOwn(result, key.slice(2))) {
      fail(`参数格式无效：${key || "(empty)"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const [command, ...values] = process.argv.slice(2);
    const args = parseArgs(values);
    if (command === "build") {
      for (const key of ["project", "dist", "output", "archive", "source-sha", "ci-run-id"]) {
        if (!args[key]) fail(`缺少参数 --${key}`);
      }
      const manifest = buildCandidate({
        projectPath: args.project,
        sourceDistPath: args.dist,
        outputPath: args.output,
        archivePath: args.archive,
        sourceSHA: args["source-sha"],
        ciRunID: args["ci-run-id"],
      });
      process.stdout.write(`TuyuWeb 候选已生成：${manifest.software_version}\n`);
    } else if (command === "verify") {
      for (const key of ["candidate", "archive", "source-sha", "ci-run-id", "version"]) {
        if (!args[key]) fail(`缺少参数 --${key}`);
      }
      const manifest = verifyCandidate(args.candidate, {
        sourceSHA: args["source-sha"], ciRunID: args["ci-run-id"],
        version: args.version, archivePath: args.archive,
      });
      process.stdout.write(`TuyuWeb 候选校验通过：${manifest.software_version}\n`);
    } else {
      fail(`候选命令未登记：${command || "(empty)"}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
