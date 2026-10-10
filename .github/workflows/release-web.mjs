#!/usr/bin/env node
// 正式版本身份由本仓自动化解析，独立于本机编译。
// 本仓本目标的完整自动化只由同名Workflow调用；版本与产物均在GitHub生成。
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function tuyuWebRelease(release,platform,readTag){
 if(platform!=='web')fail('途遇官网只有Web发布入口');
 const name=release?.tag_name,beginning='tuyuweb-web-v';
 if(typeof name!=='string'||!name.startsWith(beginning))return null;
 const sections=name.slice(beginning.length).split('-');
 if(sections.length!==3||!/^\d+\.\d+\.\d+$/u.test(sections[0])||!/^r[1-9]\d*$/u.test(sections[1])||!/^a[1-9]\d*$/u.test(sections[2]))fail('途遇官网正式版本结构无效');
 const run_id=Number(sections[1].slice(1)),run_attempt=Number(sections[2].slice(1));
 if(!Number.isSafeInteger(run_id)||!Number.isSafeInteger(run_attempt))fail('途遇官网Run坐标越界');
 const source=await readTag(name);
 if(source?.ref!=='refs/tags/'+name||source.object?.type!=='commit'||!/^[a-f0-9]{40}$/u.test(source.object.sha||''))fail('途遇官网正式Tag不是源码提交');
 return {tag:name,version:sections[0],source_sha:source.object.sha,run_attempt,run_id};
}

export const owner = Object.freeze({
  "product": "tuyuweb",
  "platform": "web",
  "repository": "tuyutata/tuyuweb",
  "version_source": {
    "kind": "json",
    "path": "package.json"
  },
  "required_assets": [],
  "asset_locations": [
    "$RELEASE_DIR",
    "$RUNNER_TEMP/tuyuweb-release"
  ],
  "asset_patterns": [
    "*.tgz",
    "*.json",
    "SHA256SUMS",
    "tuyuweb.tgz"
  ],
  "required_patterns": [
    "tuyuweb.tgz",
    "release-manifest.json",
    "SHA256SUMS"
  ]
});
const commands = Object.freeze({
  "1": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-web.mjs\" action package build-release"
  }
});
const actions = Object.freeze({
  "package": {
    "source": "#!/usr/bin/env node\n\nimport { execFileSync, spawnSync } from \"node:child_process\";\nimport { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from \"node:fs\";\nimport { fileURLToPath } from \"node:url\";\n\nconst identity = Object.freeze({\n  product: \"tuyuweb\",\n  platform: \"web\",\n  prefix: \"tuyuweb-web-v\",\n  \n  \n  archive: \"tuyuweb.tgz\",\n});\nconst candidateTool = process.env.GITHUB_WORKSPACE + \"/.github/workflows/release-web.mjs\";\n\nfunction required(value, message) {\n  if (!value) throw new Error(message);\n}\n\n\n\nfunction inputs() { return {repository:process.env.GITHUB_REPOSITORY,source:process.env.SOURCE_SHA,sourceSHA:process.env.SOURCE_SHA,version:process.env.SOFTWARE_VERSION,tag:process.env.VERSION_TAG,runID:process.env.GITHUB_RUN_ID,runId:process.env.GITHUB_RUN_ID}; }\n\n\n\n\nfunction verifyReleaseSource(value) { if (execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() !== process.env.SOURCE_SHA) throw new Error('本仓源码提交不一致'); }\n\nfunction applyVersion(version) {\n  for (const path of [\"tuyuweb/package.json\", \"tuyuweb/package-lock.json\"]) {\n    const json = JSON.parse(readFileSync(path, \"utf8\"));\n    json.version = version;\n    if (path.endsWith(\"package-lock.json\")) {\n      required(json.packages?.[\"\"], \"Web package-lock 根包缺失\");\n      json.packages[\"\"].version = version;\n    }\n    writeFileSync(path, `${JSON.stringify(json, null, 2)}\\n`);\n  }\n}\n\nfunction buildRelease(value) {\n  applyVersion(value.version);\n  execFileSync(\"npm\", [\"ci\"], { cwd: \"tuyuweb\", stdio: \"inherit\", env: process.env });\n  execFileSync(\"npm\", [\"run\", \"build\"], { cwd: \"tuyuweb\", stdio: \"inherit\", env: process.env });\n  execFileSync(\"npm\", [\"run\", \"test:contracts\"], { cwd: \"tuyuweb\", stdio: \"inherit\", env: process.env });\n  execFileSync(\"npm\", [\"run\", \"test:sites\"], { cwd: \"tuyuweb\", stdio: \"inherit\", env: process.env });\n  execFileSync(\"npm\", [\"run\", \"test:release\"], { cwd: \"tuyuweb\", stdio: \"inherit\", env: process.env });\n  execFileSync(\"npm\", [\"audit\", \"--audit-level=high\"], { cwd: \"tuyuweb\", stdio: \"inherit\", env: process.env });\n  const root = process.env.RELEASE_DIR || `${process.env.RUNNER_TEMP}/tuyuweb-release`;\n  rmSync(root, { recursive: true, force: true });\n  execFileSync(process.execPath, [\n    candidateTool, \"build\",\n    \"--project\", \"tuyuweb\", \"--dist\", \"tuyuweb/dist/client\",\n    \"--output\", `${root}/candidate`, \"--archive\", `${root}/${identity.archive}`,\n    \"--source-sha\", value.source,\n    \"--run-id\", value.runID,\n  ], { stdio: \"inherit\", env: process.env });\n  process.env.CANDIDATE_DIR = `${root}/candidate`;\n  process.env.ARCHIVE_PATH = `${root}/${identity.archive}`;\n  verifyCandidate({ ...value, candidate: process.env.CANDIDATE_DIR, archive: process.env.ARCHIVE_PATH });\n}\n\nfunction verifyCandidate(value) {\n  required(value.candidate && value.archive, \"Web Release 候选路径缺失\");\n  required(existsSync(value.candidate) && lstatSync(value.candidate).isDirectory(), \"Web构建 候选目录不存在\");\n  required(existsSync(value.archive) && lstatSync(value.archive).isFile(), \"Web构建 规范归档不存在\");\n  execFileSync(process.execPath, [\n    candidateTool, \"verify\",\n    \"--candidate\", value.candidate,\n    \"--archive\", value.archive,\n    \"--source-sha\", value.source,\n    \"--run-id\", value.runID,\n    \"--version\", value.version,\n  ], { stdio: \"inherit\", env: process.env });\n}\n\n\n\nfunction commandSucceeded(command, args) {\n  return spawnSync(command, args, { stdio: \"ignore\", env: process.env }).status === 0;\n}\n\n\n\n\nconst command=process.argv[2];\nif(command==='build-release'){await buildRelease({...inputs(),build:process.env.GITHUB_RUN_NUMBER});}else{throw new Error('本仓组包动作无效');}\n",
    "shell": "node"
  },
  "web-package": {
    "shell": "node",
    "source": "#!/usr/bin/env node\n\nimport { createHash } from \"node:crypto\";\nimport { execFileSync } from \"node:child_process\";\nimport {\n  copyFileSync,\n  existsSync,\n  lstatSync,\n  mkdirSync,\n  readFileSync,\n  readdirSync,\n  writeFileSync,\n} from \"node:fs\";\nimport { dirname, join, relative, resolve, sep } from \"node:path\";\nimport { gunzipSync, gzipSync } from \"node:zlib\";\n\nconst PRODUCT_ID = \"tuyuweb\";\nconst PLATFORM = \"web\";\nconst VERSION_MARKER = \"dist/tuyuweb-release.json\";\nconst ROOT_PAYLOAD = [\"package-lock.json\", \"package.json\"];\n\nfunction fail(message) {\n  throw new Error(message);\n}\n\nfunction sha256Bytes(value) {\n  return createHash(\"sha256\").update(value).digest(\"hex\");\n}\n\nfunction sha256File(path) {\n  return sha256Bytes(readFileSync(path));\n}\n\nfunction stableJson(value) {\n  if (Array.isArray(value)) return `[${value.map(stableJson).join(\",\")}]`;\n  if (value && typeof value === \"object\") {\n    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(\",\")}}`;\n  }\n  return JSON.stringify(value);\n}\n\nfunction prettyStableJson(value) {\n  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\\n`;\n}\n\nfunction exactKeys(value, expected, label) {\n  if (!value || typeof value !== \"object\" || Array.isArray(value)) fail(`${label} 必须是对象`);\n  const actual = Object.keys(value).sort();\n  const wanted = [...expected].sort();\n  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} 字段集合不正确`);\n}\n\nfunction regularFiles(root) {\n  const values = [];\n  const visit = (directory) => {\n    for (const name of readdirSync(directory).sort()) {\n      const path = join(directory, name);\n      const info = lstatSync(path);\n      const relativePath = relative(root, path).split(sep).join(\"/\");\n      if (info.isSymbolicLink()) fail(`候选禁止符号链接：${relativePath}`);\n      if (info.isDirectory()) visit(path);\n      else if (info.isFile()) values.push(relativePath);\n      else fail(`候选只允许普通文件和目录：${relativePath}`);\n    }\n  };\n  visit(root);\n  return values.sort();\n}\n\nfunction assertNoSecrets(root) {\n  const forbiddenName = /(^|\\/)(\\.env(?:\\.|$)|\\.dev\\.vars(?:\\.|$)|\\.wrangler(?:\\/|$)|.*\\.(?:pem|p8|p12|jks|keystore))$/i;\n  const privateMaterial = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;\n  for (const path of regularFiles(root)) {\n    if (forbiddenName.test(path)) fail(`候选包含禁止的本地或密钥文件：${path}`);\n    if (privateMaterial.test(readFileSync(join(root, ...path.split(\"/\")), \"utf8\"))) {\n      fail(`候选疑似包含私密材料：${path}`);\n    }\n  }\n}\n\nfunction parsePackage(project) {\n  const packageJson = JSON.parse(readFileSync(join(project, \"package.json\"), \"utf8\"));\n  const lockJson = JSON.parse(readFileSync(join(project, \"package-lock.json\"), \"utf8\"));\n  const version = String(packageJson.version || \"\");\n  if (!/^\\d+\\.\\d{1,2}\\.\\d{1,2}$/.test(version)) fail(`官网软件版本无效：${version}`);\n  if (lockJson.version !== version || lockJson.packages?.[\"\"]?.version !== version) {\n    fail(\"package.json 与 package-lock.json 官网软件版本不一致\");\n  }\n  return { lockJson, version };\n}\n\nfunction copyPayload(sourceRoot, outputRoot, path) {\n  const destination = join(outputRoot, ...path.split(\"/\"));\n  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });\n  copyFileSync(join(sourceRoot, ...path.split(\"/\")), destination);\n}\n\nfunction fileEntries(root, paths) {\n  return paths.map((path) => ({ path, sha256: sha256File(join(root, ...path.split(\"/\"))) }));\n}\n\nfunction writeOctal(buffer, offset, length, value) {\n  const text = value.toString(8).padStart(length - 1, \"0\");\n  if (text.length >= length) fail(\"Release 归档字段超过 tar 限制\");\n  buffer.write(`${text}\\0`, offset, length, \"ascii\");\n}\n\nfunction deterministicTar(candidate) {\n  const chunks = [];\n  for (const path of regularFiles(candidate)) {\n    if (Buffer.byteLength(path) > 100) fail(`Release 归档路径过长：${path}`);\n    const content = readFileSync(join(candidate, ...path.split(\"/\")));\n    const header = Buffer.alloc(512);\n    header.write(path, 0, 100, \"utf8\");\n    writeOctal(header, 100, 8, 0o600);\n    writeOctal(header, 108, 8, 0);\n    writeOctal(header, 116, 8, 0);\n    writeOctal(header, 124, 12, content.length);\n    writeOctal(header, 136, 12, 0);\n    header.fill(0x20, 148, 156);\n    header[156] = \"0\".charCodeAt(0);\n    header.write(\"ustar\\0\", 257, 6, \"ascii\");\n    header.write(\"00\", 263, 2, \"ascii\");\n    const checksum = header.reduce((sum, byte) => sum + byte, 0);\n    header.write(`${checksum.toString(8).padStart(6, \"0\")}\\0 `, 148, 8, \"ascii\");\n    chunks.push(header, content);\n    const padding = (512 - (content.length % 512)) % 512;\n    if (padding) chunks.push(Buffer.alloc(padding));\n  }\n  chunks.push(Buffer.alloc(1024));\n  return Buffer.concat(chunks);\n}\n\nfunction readTarOctal(header, offset, length, label) {\n  const value = header.subarray(offset, offset + length).toString(\"ascii\").replace(/\\0.*$/, \"\").trim();\n  if (!/^[0-7]+$/.test(value)) fail(`Release 归档 ${label} 无效`);\n  return Number.parseInt(value, 8);\n}\n\nfunction verifyCanonicalArchive(archive, candidate) {\n  const tar = gunzipSync(readFileSync(archive));\n  if (!deterministicTar(candidate).equals(tar)) fail(\"Release 归档不是规范的确定性候选\");\n  let offset = 0;\n  const paths = [];\n  while (offset + 512 <= tar.length) {\n    const header = tar.subarray(offset, offset + 512);\n    offset += 512;\n    if (header.every((byte) => byte === 0)) break;\n    const stored = readTarOctal(header, 148, 8, \"checksum\");\n    const checksumHeader = Buffer.from(header);\n    checksumHeader.fill(0x20, 148, 156);\n    if (stored !== checksumHeader.reduce((sum, byte) => sum + byte, 0)) fail(\"Release 归档 checksum 无效\");\n    const nul = header.indexOf(0, 0);\n    const path = header.subarray(0, nul < 0 ? 100 : nul).toString(\"utf8\");\n    if (!path || path.startsWith(\"/\") || path.split(\"/\").includes(\"..\")) fail(\"Release 归档路径不安全\");\n    const size = readTarOctal(header, 124, 12, \"size\");\n    paths.push(path);\n    offset += Math.ceil(size / 512) * 512;\n  }\n  if (JSON.stringify(paths) !== JSON.stringify(regularFiles(candidate))) fail(\"Release 归档文件集合无效\");\n}\n\nexport function verifyCandidate(candidatePath, {\n  sourceSHA = null, runID = null, version = null, archivePath = null,\n} = {}) {\n  const candidate = resolve(candidatePath);\n  const manifestPath = join(candidate, \"release-manifest.json\");\n  const checksumPath = join(candidate, \"SHA256SUMS\");\n  if (!existsSync(manifestPath) || !existsSync(checksumPath)) fail(\"候选缺少正式校验资产\");\n  const manifest = JSON.parse(readFileSync(manifestPath, \"utf8\"));\n  exactKeys(manifest, [\"assets_sha256\", \"producer_run_id\", \"files\", \"git_commit_sha\", \"platform\", \"product_id\", \"software_version\", \"tools\"], \"release manifest\");\n  if (manifest.product_id !== PRODUCT_ID || manifest.platform !== PLATFORM) fail(\"候选产品或平台身份无效\");\n  if (!/^[0-9a-f]{40}$/.test(manifest.git_commit_sha)) fail(\"候选 Git SHA 无效\");\n  if (sourceSHA !== null && manifest.git_commit_sha !== sourceSHA) fail(\"候选 Git SHA 与 CI 来源不一致\");\n  if (!Number.isSafeInteger(manifest.producer_run_id) || manifest.producer_run_id < 1) fail(\"候选 CI Run ID 无效\");\n  if (runID !== null && manifest.producer_run_id !== Number(runID)) fail(\"候选 CI Run ID 与 Release 锁定值不一致\");\n  if (!/^\\d+\\.\\d{1,2}\\.\\d{1,2}$/.test(manifest.software_version)) fail(\"候选软件版本无效\");\n  if (version !== null && manifest.software_version !== version) fail(\"候选软件版本与 Release 输入不一致\");\n  exactKeys(manifest.tools, [\"node\", \"npm\", \"vite\"], \"候选工具版本\");\n  if (!Array.isArray(manifest.files) || manifest.files.length < 4) fail(\"候选文件清单无效\");\n  const paths = [];\n  for (const entry of manifest.files) {\n    exactKeys(entry, [\"path\", \"sha256\"], \"候选文件条目\");\n    if (!/^(dist\\/|package(?:-lock)?\\.json$)[A-Za-z0-9._/-]*$/.test(entry.path)\n        || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(\"候选文件条目无效\");\n    const path = join(candidate, ...entry.path.split(\"/\"));\n    if (!existsSync(path) || !lstatSync(path).isFile() || sha256File(path) !== entry.sha256) {\n      fail(`候选文件哈希不一致：${entry.path}`);\n    }\n    paths.push(entry.path);\n  }\n  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length) {\n    fail(\"候选文件顺序或唯一性无效\");\n  }\n  for (const required of [...ROOT_PAYLOAD, \"dist/index.html\", VERSION_MARKER]) {\n    if (!paths.includes(required)) fail(`候选缺少必需文件：${required}`);\n  }\n  const packageVersion = parsePackage(candidate).version;\n  if (packageVersion !== manifest.software_version) fail(\"候选 package 版本与 manifest 不一致\");\n  const assetEntries = manifest.files.filter(({ path }) => path.startsWith(\"dist/\") && path !== VERSION_MARKER);\n  if (sha256Bytes(stableJson(assetEntries)) !== manifest.assets_sha256) fail(\"候选静态资源摘要不一致\");\n  const marker = JSON.parse(readFileSync(join(candidate, ...VERSION_MARKER.split(\"/\")), \"utf8\"));\n  exactKeys(marker, [\"assets_sha256\", \"git_commit_sha\", \"product_id\", \"software_version\"], \"官网版本标记\");\n  if (stableJson(marker) !== stableJson({\n    product_id: PRODUCT_ID,\n    software_version: manifest.software_version,\n    git_commit_sha: manifest.git_commit_sha,\n    assets_sha256: manifest.assets_sha256,\n  })) fail(\"官网版本标记与 Release 候选不一致\");\n  const expectedChecksums = [\n    ...manifest.files,\n    { path: \"release-manifest.json\", sha256: sha256File(manifestPath) },\n  ].sort((left, right) => left.path.localeCompare(right.path));\n  const checksumText = `${expectedChecksums.map(({ sha256, path }) => `${sha256}  ${path}`).join(\"\\n\")}\\n`;\n  if (readFileSync(checksumPath, \"utf8\") !== checksumText) fail(\"候选 SHA256SUMS 不一致\");\n  const expectedFiles = [...paths, \"release-manifest.json\", \"SHA256SUMS\"].sort();\n  if (JSON.stringify(regularFiles(candidate)) !== JSON.stringify(expectedFiles)) fail(\"候选包含未登记文件\");\n  assertNoSecrets(candidate);\n  if (archivePath !== null) verifyCanonicalArchive(resolve(archivePath), candidate);\n  return manifest;\n}\n\nexport function buildCandidate({ projectPath, sourceDistPath, outputPath, archivePath, sourceSHA, runID }) {\n  const project = resolve(projectPath);\n  const sourceDist = resolve(sourceDistPath);\n  const output = resolve(outputPath);\n  const archive = resolve(archivePath);\n  if (!/^[0-9a-f]{40}$/.test(sourceSHA)) fail(\"Git commit SHA 必须是 40 位小写十六进制\");\n  if (!/^[1-9][0-9]*$/.test(runID)) fail(\"CI Run ID 必须是正整数\");\n  if (!existsSync(sourceDist) || !lstatSync(sourceDist).isDirectory()) fail(\"官网 dist/client 目录不存在\");\n  if (existsSync(output) || existsSync(archive)) fail(\"候选输出已存在，拒绝覆盖\");\n  const distFiles = regularFiles(sourceDist);\n  if (!distFiles.includes(\"index.html\")) fail(\"官网正式构建缺少 index.html\");\n  assertNoSecrets(sourceDist);\n  const { lockJson, version } = parsePackage(project);\n  mkdirSync(output, { recursive: true, mode: 0o700 });\n  for (const path of distFiles) copyPayload(sourceDist, join(output, \"dist\"), path);\n  for (const path of ROOT_PAYLOAD) copyPayload(project, output, path);\n  const assetPaths = distFiles.map((path) => `dist/${path}`).sort();\n  const assets = fileEntries(output, assetPaths);\n  const assetsSHA256 = sha256Bytes(stableJson(assets));\n  writeFileSync(join(output, ...VERSION_MARKER.split(\"/\")), prettyStableJson({\n    product_id: PRODUCT_ID,\n    software_version: version,\n    git_commit_sha: sourceSHA,\n    assets_sha256: assetsSHA256,\n  }), { mode: 0o600 });\n  const payloadPaths = [...ROOT_PAYLOAD, ...assetPaths, VERSION_MARKER].sort();\n  const manifest = {\n    product_id: PRODUCT_ID,\n    platform: PLATFORM,\n    software_version: version,\n    git_commit_sha: sourceSHA,\n    producer_run_id: Number(runID),\n    tools: {\n      node: process.version.replace(/^v/, \"\"),\n      npm: execFileSync(\"npm\", [\"--version\"], { encoding: \"utf8\" }).trim(),\n      vite: String(lockJson.packages?.[\"node_modules/vite\"]?.version || \"\"),\n    },\n    assets_sha256: assetsSHA256,\n    files: fileEntries(output, payloadPaths),\n  };\n  if (!/^\\d+\\.\\d+\\.\\d+/.test(manifest.tools.vite)) fail(\"package-lock.json 缺少锁定的 Vite 版本\");\n  const manifestPath = join(output, \"release-manifest.json\");\n  writeFileSync(manifestPath, prettyStableJson(manifest), { mode: 0o600 });\n  const checksums = [\n    ...manifest.files,\n    { path: \"release-manifest.json\", sha256: sha256File(manifestPath) },\n  ].sort((left, right) => left.path.localeCompare(right.path));\n  writeFileSync(join(output, \"SHA256SUMS\"), `${checksums.map(({ sha256, path }) => `${sha256}  ${path}`).join(\"\\n\")}\\n`, { mode: 0o600 });\n  verifyCandidate(output, { sourceSHA, runID });\n  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });\n  writeFileSync(archive, gzipSync(deterministicTar(output), { level: 9, mtime: 0 }), { mode: 0o600, flag: \"wx\" });\n  verifyCandidate(output, { sourceSHA, runID, archivePath: archive });\n  return manifest;\n}\n\nfunction parseArgs(values) {\n  const result = {};\n  for (let index = 0; index < values.length; index += 2) {\n    const key = values[index];\n    const value = values[index + 1];\n    if (!key?.startsWith(\"--\") || value === undefined || Object.hasOwn(result, key.slice(2))) {\n      fail(`参数格式无效：${key || \"(empty)\"}`);\n    }\n    result[key.slice(2)] = value;\n  }\n  return result;\n}\n\nif (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {\n  try {\n    const [command, ...values] = process.argv.slice(2);\n    const args = parseArgs(values);\n    if (command === \"build\") {\n      for (const key of [\"project\", \"dist\", \"output\", \"archive\", \"source-sha\", \"run-id\"]) {\n        if (!args[key]) fail(`缺少参数 --${key}`);\n      }\n      const manifest = buildCandidate({\n        projectPath: args.project,\n        sourceDistPath: args.dist,\n        outputPath: args.output,\n        archivePath: args.archive,\n        sourceSHA: args[\"source-sha\"],\n        runID: args[\"run-id\"],\n      });\n      process.stdout.write(`TuyuWeb 候选已生成：${manifest.software_version}\\n`);\n    } else if (command === \"verify\") {\n      for (const key of [\"candidate\", \"archive\", \"source-sha\", \"run-id\", \"version\"]) {\n        if (!args[key]) fail(`缺少参数 --${key}`);\n      }\n      const manifest = verifyCandidate(args.candidate, {\n        sourceSHA: args[\"source-sha\"], runID: args[\"run-id\"],\n        version: args.version, archivePath: args.archive,\n      });\n      process.stdout.write(`TuyuWeb 候选校验通过：${manifest.software_version}\\n`);\n    } else {\n      fail(`候选命令未登记：${command || \"(empty)\"}`);\n    }\n  } catch (error) {\n    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);\n    process.exitCode = 1;\n  }\n}\n"
  }
});

const shaPattern = /^[0-9a-f]{40}$/u;
const fail = message => { throw new Error(message); };
const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = `.github/workflows/release-${owner.platform}.yml`;
const prefix = `${owner.product}-${owner.platform}-v`;

export function context(environment = process.env) {
  const number = name => {
    const value = environment[name];
    if (!/^[1-9][0-9]*$/u.test(value || '') || !Number.isSafeInteger(Number(value))) fail('GitHub运行坐标无效');
    return Number(value);
  };
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== owner.repository
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !shaPattern.test(environment.GITHUB_SHA || '')
    || environment.GITHUB_WORKFLOW_REF !== `${owner.repository}/${workflowPath}@refs/heads/main`) fail('所属GitHub运行身份无效');
  return { repository: owner.repository, product_id: owner.product, platform: owner.platform,
    source_sha: environment.GITHUB_SHA, run_id: number('GITHUB_RUN_ID'),
    run_number: number('GITHUB_RUN_NUMBER'), run_attempt: number('GITHUB_RUN_ATTEMPT'), workflow: workflowPath };
}

export async function request(path, { method = 'GET', body, raw = false, size, fetch: send = globalThis.fetch } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || /[\s\u0000-\u001f\u007f]/u.test(token)) fail('缺少GitHub任务令牌');
  const url = path.startsWith('https://') ? new URL(path) : new URL(`https://api.github.com/repos/${owner.repository}/${path}`);
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || !url.pathname.startsWith(`/repos/${owner.repository}/`)) fail('GitHub接口地址无效');
  const headers = { Authorization: `Bearer ${token}`, Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': owner.product };
  if (body !== undefined) headers['Content-Type'] = body?.pipe ? 'application/octet-stream' : 'application/json';
  if(body?.pipe){if(!Number.isSafeInteger(size)||size<=0)fail('资产上传长度无效');headers['Content-Length']=String(size);}
  let response = await send(url, { method, headers, redirect: raw ? 'manual' : 'error', signal: AbortSignal.timeout(300_000),
    ...(body === undefined ? {} : { body: body?.pipe ? body : JSON.stringify(body), ...(body?.pipe ? { duplex: 'half' } : {}) }) });
  if(raw&&response.status===302){
    const location=new URL(response.headers.get('location'));
    if(location.protocol!=='https:'||location.username||location.password)fail('正式资产回读地址无效');
    response=await send(location,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(300_000)});
  }
  if (response.status === 404) return null;
  if (!response.ok) fail(`GitHub接口失败：${response.status}，操作未确认`);
  if (raw) return response;
  return response.status === 204 ? {} : response.json();
}

export async function pages(path, field = null, api = request) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const values = field ? data?.[field] : data;
    if (!Array.isArray(values)) fail('GitHub分页数据无效');
    rows.push(...values);
    if (values.length < 100) return rows;
  }
}

function seedVersion() {
  const source = owner.version_source;
  if (source.kind === 'sequence') return '0.0.0';
  const text = readFileSync(join(root, source.path), 'utf8');
  if (source.kind === 'json') return String(JSON.parse(text).version);
  if (source.kind === 'spec') {
    const matches = [...text.matchAll(/^\s*spec_version:\s*(\d+)\s*,\s*$/gm)];
    if (matches.length !== 1) fail('Runtime版本真源不唯一');
    return matches[0][1];
  }
  if (source.kind === 'cargo') {
    const value = /^\[package\][\s\S]*?^version\s*=\s*"(\d+\.\d+\.\d+)"/mu.exec(text)?.[1];
    if (!value) fail('本仓Cargo版本真源无效');
    return value;
  }
  const value = /^version:\s*(\d+\.\d+\.\d+)(?:\+\d+)?\s*$/mu.exec(text)?.[1];
  if (!value) fail('本仓软件版本真源无效');
  return value;
}

export function nextVersion(seed, versions, protocol = false, runNumber = 1) {
  if (protocol) {
    if (!/^\d+$/u.test(seed) || versions.some(value => !/^\d+$/u.test(value))) fail('协议版本无效');
    const value = Math.max(Number(seed), ...versions.map(Number)) + (versions.length ? 1 : 0);
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) fail('协议版本越界');
    return String(value);
  }
  const parse = value => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/u.exec(value);
    if (!match) fail('软件版本无效');
    const parts=match.slice(1).map(Number);if(parts.some(value=>!Number.isSafeInteger(value)))fail('软件版本越界');return parts;
  };
  const values = [seed, ...versions].map(parse).sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  let [major, minor, patch] = values.at(-1);
  if (versions.length) { if (++patch > 99) { patch = 0; if (++minor > 99) { minor = 0; major++; } } }
  if(!Number.isSafeInteger(runNumber)||runNumber<1)fail('版本运行序号无效');
  const initial=parse(seed),floor=BigInt(initial[0])*10000n+BigInt(initial[1])*100n+BigInt(initial[2])+BigInt(runNumber-1);
  const historical=BigInt(major)*10000n+BigInt(minor)*100n+BigInt(patch);
  if(floor>historical){major=Number(floor/10000n);minor=Number(floor/100n%100n);patch=Number(floor%100n);}
  if(![major,minor,patch].every(Number.isSafeInteger))fail('软件版本越界');
  return `${major}.${minor}.${patch}`;
}

function output(name, value, file = process.env.GITHUB_OUTPUT) {
  if (!file || /[\r\n]/u.test(String(value))) fail('GitHub步骤输出无效');
  appendFileSync(file, `${name}=${value}\n`);
}

export async function prepare() {
  const identity = context();
  const releases = await pages('releases');
  const versions = [];
  for (const release of releases) {
    if (release.draft || release.prerelease || !String(release.tag_name).startsWith(prefix)) continue;
    const notes = (await tuyuWebRelease(release,owner.platform,tag=>request('git/ref/tags/'+encodeURIComponent(tag))));
    if (!notes || notes.platform !== owner.platform) continue;
    const run = await request(`actions/runs/${notes.run_id}`);
    if (run?.status === 'completed' && run.conclusion === 'success' && run.path === workflowPath) versions.push(notes.version);
  }
  const version = nextVersion(seedVersion(), versions, owner.version_source.kind === 'spec', identity.run_number);
  const tag = `${prefix}${version}-r${identity.run_id}-a${identity.run_attempt}`;
  for (const [name,value] of Object.entries({version, tag, source_sha:identity.source_sha,
    run_id:identity.run_id, run_attempt:identity.run_attempt, run_number:identity.run_number})) output(name,value);
}

function runVersion() {
  const identity = context();
  const version = process.env.RELEASE_VERSION;
  const tag = process.env.RELEASE_TAG;
  nextVersion(version, [], owner.version_source.kind === 'spec');
  if (tag !== `${prefix}${version}-r${identity.run_id}-a${identity.run_attempt}`) fail('本次版本与Tag不一致');
  return {...identity, version, tag};
}

export function job() {
  const identity = runVersion();
  if (execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim() !== identity.source_sha) fail('检出源码不符');
  const work = join(process.env.RUNNER_TEMP, owner.product, owner.platform, String(identity.run_id), String(identity.run_attempt), process.env.GITHUB_JOB);
  mkdirSync(work,{recursive:true});
  const variables = {RELEASE_WORK:work, RELEASE_ASSETS_DIR:join(work,'assets'), SOURCE_SHA:identity.source_sha,
    SOFTWARE_VERSION:identity.version, VERSION_TAG:identity.tag, BUILD_NUMBER:String(identity.run_number),
    CARGO_HOME:join(work,'cargo-home'), CARGO_TARGET_DIR:join(work,'cargo'), PUB_CACHE:join(work,'pub'),
    GRADLE_USER_HOME:join(work,'gradle'), npm_config_cache:join(work,'npm'), XDG_CACHE_HOME:join(work,'cache'),
    TMPDIR:join(work,'tmp'), TMP:join(work,'tmp'), TEMP:join(work,'tmp')};
  for (const path of ['cargo-home','cargo','pub','gradle','npm','cache','tmp','assets']) mkdirSync(join(work,path),{recursive:true});
  for (const [name,value] of Object.entries(variables)) { process.env[name]=value; output(name,value,process.env.GITHUB_ENV); }
}

export function step(key) {
  runVersion();
  const value = commands[key];
  if (!value || !['bash','pwsh'].includes(value.shell)) fail('本目标构建步骤无效');
  const directory = join(process.env.RELEASE_WORK,'commands');mkdirSync(directory,{recursive:true});
  const file = join(directory, value.shell === 'pwsh' ? 'step.ps1' : 'step.sh');
  writeFileSync(file, value.shell === 'bash' ? 'set -euo pipefail\n'+value.source : "$ErrorActionPreference = 'Stop'\n"+value.source,{mode:0o700});
  const result = spawnSync(value.shell === 'pwsh' ? 'pwsh' : 'bash', value.shell === 'pwsh' ? ['-NoProfile','-File',file] : [file],
    {cwd:process.cwd(),env:process.env,stdio:'inherit'});
  rmSync(file,{force:true});
  if (result.error || result.status !== 0) fail(`本仓构建步骤失败：${key}`);
}

export function action(name, args) {
  runVersion();
  const value = actions[name];if (!value) fail('本目标动作无效');
  const directory = join(process.env.RELEASE_WORK,'commands');mkdirSync(directory,{recursive:true});
  const file = join(directory,value.shell === 'bash'?'action.sh':'action.mjs');
  const source=value.source.replace(/__PRODUCT_URL__([^'"\s]+)__END_URL__/gu,(_,path)=>pathToFileURL(join(root,path)).href);
  writeFileSync(file,source,{mode:0o700});
  const result=spawnSync(value.shell==='bash'?'bash':process.execPath,[file,...args],{cwd:root,env:process.env,stdio:'inherit'});
  rmSync(file,{force:true});if(result.error||result.status!==0)fail(`本仓动作失败：${name}`);
}

function regular(path) {
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0)fail('正式产物不是非空普通文件');return stat;
}
async function digestFile(path) { const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex'); }
function assetName(name) { if(!name||name!==basename(name)||/[\u0000-\u001f\u007f]/u.test(name))fail('正式资产文件名无效');return name; }

export async function collect(paths) {
  const identity=runVersion(),destination=process.env.RELEASE_ASSETS_DIR;
  if(!destination||!paths.length)fail('本仓没有完整产物');mkdirSync(destination,{recursive:true});
  const files=[];
  for(const path of paths){const file=resolve(path),stat=regular(file),name=assetName(basename(file));
    if(files.some(row=>row.name===name))fail('正式资产重名');
    const target=join(destination,name);if(file!==target)copyFileSync(file,target);
    files.push({name,size:stat.size,sha256:await digestFile(target)});
  }
  if(owner.required_assets.some(name=>!files.some(row=>row.name===name)))fail('本目标必要产物缺失');
  const metadata={schema:1,...identity,assets:files};
  writeFileSync(join(destination,'automation.json'),JSON.stringify(metadata,null,2)+'\n');
  output('assets',destination);return metadata;
}

export async function collectProduced() {
  const paths=[],seen=new Set();
  const expand=value=>value.replace(/\$\{([A-Z_]+)\}|\$([A-Z_]+)/gu,(_,a,b)=>process.env[a||b]||'');
  for(const location of owner.asset_locations){
    const path=expand(location);if(!path||!existsSync(path))continue;
    const candidates=lstatSync(path).isDirectory()?readdirSync(path).map(name=>join(path,name)):[path];
    for(const candidate of candidates){if(!lstatSync(candidate).isFile()||seen.has(resolve(candidate)))continue;
      const name=basename(candidate);if(!owner.asset_patterns.some(pattern=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/gu,'\\$&').replaceAll('*','.*')+'$','u').test(name)))continue;
      seen.add(resolve(candidate));paths.push(candidate);
    }
  }
  if(owner.required_patterns.some(pattern=>!paths.some(path=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/gu,'\\$&').replaceAll('*','.*')+'$','u').test(basename(path)))))fail('本目标完整正式资产缺失');
  return collect(paths);
}



export async function publish(directory) {
  const identity=runVersion();const metadata=JSON.parse(readFileSync(join(directory,'automation.json'),'utf8'));
  if(Object.entries(identity).some(([key,value])=>metadata[key]!==value)||!Array.isArray(metadata.assets)||!metadata.assets.length)fail('完整产物身份无效');
  const files=metadata.assets;
  if(readdirSync(directory).sort().join('\0')!==[...files.map(value=>value.name),'automation.json'].sort().join('\0'))fail('产物目录与完整资产集合不符');
  for(const file of files){const path=join(directory,assetName(file.name));if(regular(path).size!==file.size||await digestFile(path)!==file.sha256)fail('正式产物在交付前改变');}
  if(await request(`git/ref/tags/${encodeURIComponent(identity.tag)}`)!==null)fail('本次Tag已经存在');
  await request('git/refs',{method:'POST',body:{ref:`refs/tags/${identity.tag}`,sha:identity.source_sha}});
  const release=await request('releases',{method:'POST',body:{tag_name:identity.tag,target_commitish:identity.source_sha,
    name:`${owner.product} · ${owner.platform} · ${identity.version}`,draft:false,prerelease:false,make_latest:'false',
    body:`${owner.product} · ${owner.platform} · ${identity.version}\nSource: ${identity.source_sha}\nRun: ${identity.run_id} / ${identity.run_attempt}`}});
  if(!Number.isSafeInteger(release?.id)||!release.upload_url)fail('正式Release创建未确认');
  for(const file of files){const url=new URL(release.upload_url.replace(/\{.*$/u,''));url.searchParams.set('name',file.name);
    const asset=await request(url.href,{method:'POST',body:createReadStream(join(directory,file.name)),size:file.size});
    if(asset?.name!==file.name||asset.size!==file.size||asset.state!=='uploaded')fail('正式资产上传未确认');
    const response=await request(asset.url,{raw:true});if(!response?.body)fail('正式资产回读失败');
    const hash=createHash('sha256');let size=0;for await(const bytes of response.body){hash.update(bytes);size+=bytes.length;if(size>file.size)fail('正式资产回读超过声明大小');}
    if(size!==file.size||hash.digest('hex')!==file.sha256)fail('GitHub资产逐件回读不一致');
  }
  const readback=await request(`releases/${release.id}`);if((await tuyuWebRelease(readback,owner.platform,tag=>request('git/ref/tags/'+encodeURIComponent(tag))))?.run_id!==identity.run_id||readback.draft||readback.prerelease
    ||readback.assets?.length!==files.length)fail('完整正式Release回查失败');
  for(const file of files){const asset=readback.assets.find(value=>value.name===file.name);if(!asset||asset.state!=='uploaded'||asset.size!==file.size||asset.digest!==`sha256:${file.sha256}`)fail('完整正式资产证明回查失败');}
  output('verified','true');output('release_id',release.id);output('tag',identity.tag);
}

function ownedRun(run) {
  // 每个目标只处理自身现行Workflow；文件缺失不能证明历史任务归属。
  return Number.isSafeInteger(run?.id)&&run.id>0&&run.path===workflowPath
    &&run.head_branch==='main'&&run.event==='workflow_dispatch'
    &&(!run.repository||run.repository.full_name===owner.repository);
}

export function cleanupPlan(runs,current,result) {
  if(!['success','failed'].includes(result)||!ownedRun(current)||!Number.isFinite(Date.parse(current.created_at)))fail('清理所属任务身份无效');
  const earlier=run=>Date.parse(run.created_at)<Date.parse(current.created_at)
    ||Date.parse(run.created_at)===Date.parse(current.created_at)&&run.id<current.id;
  return runs.filter(run=>ownedRun(run)&&run.id!==current.id&&run.status==='completed'&&earlier(run)
    &&(run.conclusion==='success'?'success':'failed')===result).sort((a,b)=>a.id-b.id);
}

async function remove(path,api) { await api(path,{method:'DELETE'});const readPath=path.replace(/^git\/refs\//u,'git/ref/');if(await api(readPath)!==null)fail('删除回查仍存在，清理失败'); }
async function removeRunRelease(run,releases,api) {
  for(const release of releases){
    const metadata=(await tuyuWebRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if(!metadata||metadata.run_id!==run.id)continue;
    if(metadata.source_sha!==run.head_sha)fail('正式Release与所属Run不一致');
    const tag=metadata.tag;
    const again=await api(`actions/runs/${run.id}`);
    if(again&&again.id!==Number(process.env.GITHUB_RUN_ID)
      &&(again.status!=='completed'||again.run_attempt!==run.run_attempt||again.conclusion!==run.conclusion))fail('所属任务已变化，停止清理');
    await remove(`releases/${release.id}`,api);
    const beforeTag=await api(`actions/runs/${run.id}`);
    if(beforeTag&&beforeTag.id!==Number(process.env.GITHUB_RUN_ID)
      &&(beforeTag.status!=='completed'||beforeTag.run_attempt!==run.run_attempt||beforeTag.conclusion!==run.conclusion))fail('所属任务已变化，停止清理');
    await remove(`git/refs/tags/${encodeURIComponent(tag)}`,api);
  }
}
export async function cleanup(result,identity=context(),api=request) {
  const current=await api(`actions/runs/${identity.run_id}`);
  const plan=cleanupPlan(await pages('actions/runs','workflow_runs',api),current,result);
  const releases=await pages('releases',null,api),removed=[];
  for(const row of plan){const run=await api(`actions/runs/${row.id}`);if(!run){removed.push(row.id);continue;}
    if(run.run_attempt!==row.run_attempt||cleanupPlan([run],current,result).length!==1)continue;
    await removeRunRelease(run,releases,api);
    // 失败若只形成Tag也按它的准确Run坐标处理，不能留下同类孤立产物。
    const tags=await api(`git/matching-refs/tags/${prefix}`);
    if(!Array.isArray(tags))fail('所属Tag集合无效');
    for(const reference of tags){
      const tag=String(reference.ref||'').slice('refs/tags/'.length);
      if(!String(reference.ref||'').startsWith('refs/tags/'+prefix)
        ||!new RegExp(`-r${run.id}-a[1-9][0-9]*$`,'u').test(tag)||Number(tag.slice(tag.lastIndexOf('-a')+2))>run.run_attempt)continue;
      if(reference.object?.type!=='commit'||reference.object.sha!==run.head_sha)fail('所属Tag来源已改变，停止清理');
      const again=await api(`actions/runs/${run.id}`);
      if(!again||cleanupPlan([again],current,result).length!==1)fail('所属任务已改变，停止清理');
      await remove(`git/refs/tags/${encodeURIComponent(tag)}`,api);
    }
    for(const asset of await pages(`actions/runs/${run.id}/artifacts`,'artifacts',api)){
      if(!Number.isSafeInteger(asset.id)||asset.id<=0)fail('所属Artifact坐标无效');
      const again=await api(`actions/runs/${run.id}`);if(!again||again.status!=='completed'||again.run_attempt!==run.run_attempt||again.conclusion!==run.conclusion)fail('历史任务已变化，停止清理');
      await remove(`actions/artifacts/${asset.id}`,api);
    }
    const final=await api(`actions/runs/${run.id}`);
    if(final&&(final.run_attempt!==run.run_attempt||cleanupPlan([final],current,result).length!==1))fail('历史任务状态改变，停止清理');
    if(final)await remove(`actions/runs/${run.id}`,api);removed.push(run.id);
  }
  return removed;
}

export function precedingResult(needs) {
  if(!needs||typeof needs!=='object'||Array.isArray(needs)||!Object.keys(needs).length)fail('前置任务结果缺失');
  return Object.values(needs).every(value=>value?.result==='success')?'success':'failed';
}
async function discardCurrent(identity,api) {
  for(const release of await pages('releases',null,api)){
    const metadata=(await tuyuWebRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if(metadata?.run_id===identity.run_id&&metadata.run_attempt===identity.run_attempt)
      await removeRunRelease({id:identity.run_id,head_sha:identity.source_sha},[release],api);
  }
  const tag=process.env.RELEASE_TAG;
  if(tag&&tag.startsWith(prefix)&&tag.endsWith(`-r${identity.run_id}-a${identity.run_attempt}`)){
    const path=`git/refs/tags/${encodeURIComponent(tag)}`;
    if(await api(path.replace(/^git\/refs\//u,'git/ref/'))!==null)await remove(path,api);
  }
}
export async function finish(needs=JSON.parse(process.env.RELEASE_NEEDS||'null'),api=request,identity=context()) {
  const result=precedingResult(needs),errors=[];
  const attempt=async action=>{try{return await action();}catch(error){errors.push(error);return null;}};
  let removed;
  if(result==='success') {
    removed=await attempt(()=>cleanup('success',identity,api));
    if(errors.length) {
      await attempt(()=>discardCurrent(identity,api));
      await attempt(()=>cleanup('failed',identity,api));
    }
  } else {
    // 本次撤销失败也必须尝试清理同目标旧失败；各项真实错误均保留。
    await attempt(()=>discardCurrent(identity,api));
    removed=await attempt(()=>cleanup('failed',identity,api));
  }
  if(errors.length)throw new AggregateError(errors,'本目标最后处理失败：'+errors.map(error=>error.message).join('；'));
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`本目标${result==='success'?'成功':'失败'}；已清理同类旧Run：${removed.join('、')||'无'}。\n`);
  if(result==='failed')fail('前置任务未全部成功');
}

// 本目标实际构建与组包接口。
async function productCommand(command,args) { if (!["build","verify"].includes(command)) return false; action("web-package",[command,...args]); return true; }

const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
const testing=direct&&Boolean(process.env.NODE_TEST_CONTEXT)&&process.argv.length===2;
if(direct&&!testing){
  try{const [command,...args]=process.argv.slice(2);
    if(command==='prepare')await prepare();else if(command==='job')job();else if(command==='step')step(args[0]);
    else if(command==='action')action(args[0],args.slice(1));else if(command==='collect')await collect(args);
    else if(command==='collect-produced')await collectProduced();else if(command==='publish')await publish(args[0]);else if(command==='finish')await finish();
    else if(!await productCommand(command,args))fail('自动化命令无效');
  }catch(error){console.error(error.message);process.exitCode=1;}
}

if(testing){
  const {default:assert}=await import('node:assert/strict');const {default:test}=await import('node:test');

  test('旧入口不能成为任一现行平台的清理归属证明',()=>{
    const current={id:9,path:workflowPath,head_branch:'main',event:'workflow_dispatch',created_at:'2026-01-02T00:00:00Z'};
    const old={...current,id:1,status:'completed',conclusion:'success',created_at:'2026-01-01T00:00:00Z'};
    for(const path of ['.github/workflows/release.yml',`.github/workflows/${owner.product}-${owner.platform}-ci.yml`,'.github/workflows/deleted.yml'])
      assert.deepEqual(cleanupPlan([{...old,path}],current,'success'),[]);
  });
  test('撤销当前产物失败仍处理旧失败且最终失败',async()=>{
    const current={id:9,path:workflowPath,head_branch:'main',event:'workflow_dispatch',created_at:'2026-01-02T00:00:00Z'};
    let releases=0,history=0;
    const api=async path=>{
      if(path.startsWith('releases?')){if(++releases===1)throw Error('撤销中断');return [];}
      if(path==='actions/runs/9')return current;
      if(path.startsWith('actions/runs?')){history++;return {workflow_runs:[]};}
      throw Error('未声明请求');
    };
    await assert.rejects(finish({build:{result:'failure'}},api,{run_id:9}),/撤销中断/);
    assert.equal(history,1);assert.equal(releases,2);
  });
  test('清理旧失败Run同时回收其多个Attempt的准确孤立Tag',async()=>{
    const old={id:2,run_attempt:2,path:workflowPath,head_branch:'main',event:'workflow_dispatch',head_sha:'a'.repeat(40),status:'completed',conclusion:'failure',created_at:'2026-01-01T00:00:00Z'},current={...old,id:9,status:'in_progress',created_at:'2026-01-02T00:00:00Z'};
    const deleted=new Set(),tags=[1,2].map(attempt=>({ref:`refs/tags/${prefix}1.0.0-r2-a${attempt}`,object:{type:'commit',sha:old.head_sha}}));
    const api=async(path,options={})=>{
      if(options.method==='DELETE'){deleted.add(path);return {};}
      if(deleted.has(path)||deleted.has(path.replace('git/ref/','git/refs/')))return null;
      if(path.startsWith('actions/runs?'))return {workflow_runs:[old,current]};
      if(path.startsWith('releases?')||path.includes('/artifacts?'))return path.includes('/artifacts?')?{artifacts:[]}:[];
      if(path.startsWith('git/matching-refs/'))return tags;
      if(path==='actions/runs/2')return old;if(path==='actions/runs/9')return current;
      throw Error('未声明的请求');
    };
    assert.deepEqual(await cleanup('failed',{run_id:9},api),[2]);assert.equal([...deleted].filter(path=>path.startsWith('git/refs/')).length,2);
  });
  test('全部前置成功才成功，其余结论一律失败',()=>{
    assert.equal(precedingResult({build:{result:'success'},publish:{result:'success'}}),'success');
    for(const result of ['failure','cancelled','skipped','timed_out',undefined])assert.equal(precedingResult({build:{result}}),'failed');
    assert.throws(()=>precedingResult({}));
  });
  test('当前Run尚在运行也能清理同目标旧结果，保护其它目标和活动任务',()=>{
    const row=(id,conclusion='success',status='completed',path=workflowPath)=>({id,conclusion,status,path,head_branch:'main',event:'workflow_dispatch',created_at:new Date(1700000000000+id*1000).toISOString()});
    const current=row(6,null,'in_progress');const rows=[row(1),row(2,'failure'),row(3,'success','in_progress'),row(4,'success','completed','.github/workflows/release-other.yml'),current,row(7)];
    assert.deepEqual(cleanupPlan(rows,current,'success').map(row=>row.id),[1]);
    assert.deepEqual(cleanupPlan(rows,current,'failed').map(row=>row.id),[2]);
  });
  test('软件版本进位与协议版本边界',()=>{
    assert.equal(nextVersion('1.0.0',['1.99.99']),'2.0.0');assert.equal(nextVersion('9',['9'],true),'10');
    assert.throws(()=>nextVersion(String(0xffffffff),[String(0xffffffff)],true));
  });
  test('历史完整分页不截断超过1000条记录',async()=>{
    const rows=Array.from({length:1005},(_,id)=>({id}));const api=async path=>rows.slice((Number(/page=(\d+)$/u.exec(path)[1])-1)*100,Number(/page=(\d+)$/u.exec(path)[1])*100);
    assert.equal((await pages('releases',null,api)).length,1005);
  });
  test('失败清理只删除所属旧失败产物及Run，成功和活动任务独立保留',async()=>{
    const row=(id,conclusion,status='completed')=>({id,run_attempt:1,conclusion,status,path:workflowPath,head_branch:'main',event:'workflow_dispatch',repository:{full_name:owner.repository},head_sha:'a'.repeat(40),created_at:new Date(1700000000000+id*1000).toISOString()});
    const current=row(10,null,'in_progress'),rows=[row(1,'success'),row(2,'failure'),row(3,null,'in_progress'),current];
    const gone=new Set(),removed=[];
    const api=async(path,options={})=>{
      if(options.method==='DELETE'){removed.push(path);gone.add(path);return {};}
      if(gone.has(path))return null;
      if(path.startsWith('actions/runs?'))return {workflow_runs:rows};
      if(path.startsWith('releases?')||path.startsWith('git/matching-refs/'))return [];
      if(path.startsWith('actions/runs/2/artifacts?'))return {artifacts:[{id:20}]};
      if(path==='actions/artifacts/20')return {id:20};
      const match=/^actions\/runs\/(\d+)$/u.exec(path);if(match)return rows.find(row=>row.id===Number(match[1]))??null;
      throw Error('未声明的模拟接口：'+path);
    };
    assert.deepEqual(await cleanup('failed',{run_id:10},api),[2]);
    assert.deepEqual(removed,['actions/artifacts/20','actions/runs/2']);
  });

  test('GitHub运行序号保证成功历史清理后版本不会回到初始值',()=>{
    assert.equal(nextVersion('1.0.0',[],false,4),'1.0.3');
    assert.equal(nextVersion('1.99.99',[],false,2),'2.0.0');
    assert.equal(nextVersion('1.0.0',['3.0.0'],false,4),'3.0.1');
    assert.throws(()=>nextVersion('1.0.0',[],false,0));
  });

}
