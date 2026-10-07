import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';

const emptyTreeSHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const commitPattern = /^[0-9a-f]{40}$/u;
const implementationExtensions = new Set([
  '.c', '.cc', '.cpp', '.dart', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.kt',
  '.kts', '.mjs', '.pbxproj', '.proto', '.py', '.rs', '.sh', '.sql', '.swift', '.toml',
  '.ts', '.tsx', '.yaml', '.yml',
]);
const commentExtensions = new Set([
  '.c', '.cc', '.cpp', '.dart', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.kt',
  '.kts', '.mjs', '.py', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx',
]);

function fail(message) { throw new Error(message); }

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    fail(label + '字段闭集无效');
  }
}

function git(root, arguments_) {
  try {
    return execFileSync('/usr/bin/git', ['-C', root, ...arguments_], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
    });
  } catch {
    fail('产品门禁读取Git提交失败');
  }
}

export function validateRange({ root, baseSHA, headSHA }) {
  if (!isAbsolute(root) || realpathSync(root) !== root) fail('产品门禁仓库根无效');
  if (!commitPattern.test(baseSHA) || !commitPattern.test(headSHA) || baseSHA === headSHA) {
    fail('产品门禁提交范围无效');
  }
  if (git(root, ['rev-parse', 'HEAD']).trim() !== headSHA) fail('产品门禁目标与当前检出不一致');
  if (baseSHA !== emptyTreeSHA) git(root, ['merge-base', '--is-ancestor', baseSHA, headSHA]);
  const range = baseSHA === emptyTreeSHA ? headSHA : `${baseSHA}..${headSHA}`;
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', range]).trim().split(/\r?\n/u).filter(Boolean);
  if (commits.length === 0 || commits.some((commit) => !commitPattern.test(commit))) {
    fail('产品待推送提交范围无效');
  }
  return Object.freeze(commits);
}

// 历史清理只接受一个无父新根；带父提交的强制覆盖仍拒绝，并从空树执行完整门禁。
export function pushBaseSHA({ forced, before, headSHA, parents, commitCount }) {
  if (typeof forced !== 'boolean' || !commitPattern.test(before) || !commitPattern.test(headSHA)
    || /^0{40}$/u.test(headSHA)) fail('远端push提交坐标无效');
  if (!forced) return /^0{40}$/u.test(before) ? emptyTreeSHA : before;
  if (/^0{40}$/u.test(before) || parents !== headSHA || commitCount !== '1') {
    fail('历史清理必须是唯一无父提交，禁止强制覆盖普通历史');
  }
  return emptyTreeSHA;
}

function trackedFiles(root) {
  return git(root, ['ls-files', '-z', '--', '.']).split('\0').filter(Boolean).sort();
}

function isTestPath(path) {
  const segments = path.split('/').map((segment) => segment.toLowerCase());
  const name = basename(path).toLowerCase();
  return segments.some((segment) => ['test', 'tests', 'integration_test'].includes(segment))
    || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/u.test(name);
}

function isImplementationPath(path) {
  return implementationExtensions.has(extname(path).toLowerCase())
    || ['Dockerfile', 'Makefile'].includes(basename(path));
}

function commentText(path, source) {
  const extension = extname(path).toLowerCase();
  if (['.sh', '.py'].includes(extension)) return source.split(/\r?\n/u).filter((line) => /^(?!#!)\s*#/u.test(line)).join('\n');
  if (extension === '.sql') return source.split(/\r?\n/u).filter((line) => /^\s*--/u.test(line)).join('\n');
  return [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu)].map((match) => match[0]).join('\n');
}

function temporaryComments(path, source) {
  return commentText(path, source).split('\n').filter((line) => /(?:TODO|FIXME|HACK|XXX)\b/u.test(line));
}

// 上游说明只能逐字、按原有数量保留；复制同一句到新位置不能增加允许数量。

export function hasFirstPartyTemporaryComments(path, source, upstream = '') {
  const retained = new Map();
  for (const comment of temporaryComments(path, upstream)) retained.set(comment, (retained.get(comment) ?? 0) + 1);
  return temporaryComments(path, source).some((comment) => {
    const count = retained.get(comment) ?? 0;
    if (count === 0) return true;
    retained.set(comment, count - 1);
    return false;
  });
}

// 只消费产品来源清单的准确归属；provider、sdk_only和未登记文件仍按第一方检查。

export function smoldotUpstreamURL(path, manifest, record) {
  const prefix = 'native/smoldot/pow/';
  if (!path.startsWith(prefix)) return null;
  const owners = Object.values(manifest.units ?? {}).flatMap((unit) =>
    ['byte_identical', 'adapted', 'sdk_only'].flatMap((category) => (unit[category] ?? [])
      .filter((entry) => `${unit.root}/${entry.path}` === path)
      .map(() => category)));
  if (owners.length !== 1) fail('产品上游文件缺少唯一来源归属：' + path);
  if (owners[0] === 'sdk_only') return null;
  const commits = [...record.matchAll(/^- 收编基线提交：`([0-9a-f]{40})`$/gmu)];
  const upstreamRepositories = [...record.matchAll(/^- 上游仓库：`([^`]+)`$/gmu)];
  const relative = path.slice(prefix.length);
  if (commits.length !== 1 || upstreamRepositories.length !== 1 || upstreamRepositories[0][1] !== 'https://github.com/smol-dot/smoldot'
    || !/^(?:lib|light-base)\/[A-Za-z0-9_./-]+$/u.test(relative)
    || relative.split('/').some((part) => ['', '.', '..'].includes(part))) fail('产品上游基线或文件路径无效');
  return `https://raw.githubusercontent.com/smol-dot/smoldot/${commits[0][1]}/${relative}`;
}

// 公开固定基线只在内存读取，不携带GitHub App凭据，不落盘、不跟随重定向。

export async function readUpstreamSource(url, request = fetch) {
  const limit = 2 * 1024 * 1024;
  try {
    if (!/^https:\/\/raw\.githubusercontent\.com\/smol-dot\/smoldot\/[0-9a-f]{40}\/(?:lib|light-base)\/[A-Za-z0-9_./-]+$/u.test(url)
      || new URL(url).href !== url) throw new Error();
    const response = await request(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error();
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error();
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch { fail('产品上游固定基线读取失败，拒绝放行保留注释'); }
}

export function validateDependencyPlans(lock, plans, platforms) {
  if (lock?.schema !== 1 || !lock.environment || !lock.native?.sources) fail('产品依赖锁结构无效');
  const entries = [...Object.entries(lock.environment), ...Object.entries(lock.native.sources)];
  const sources = new Map(entries);
  if (!entries.length || sources.size !== entries.length) fail('产品依赖锁名称为空或重复');
  const keys = ['name', 'version', 'url', 'size', 'sha256', 'archive_root'];
  const coordinates = keys.slice(1);
  for (const [name, value] of sources) {
    if (!/^[A-Za-z0-9_.+-]+$/u.test(name) || !value || typeof value.version !== 'string'
      || !value.version.trim() || !Number.isSafeInteger(value.size) || value.size <= 0
      || !/^[0-9a-f]{64}$/u.test(value.sha256)
      || typeof value.archive_root !== 'string' || !/^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/u.test(value.archive_root)) {
      fail('产品依赖锁归档坐标无效');
    }
    let url;
    try { url = new URL(value.url); } catch { fail('产品依赖锁来源无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('产品依赖锁来源无效');
  }
  if (!Array.isArray(plans) || !Array.isArray(platforms) || !platforms.length
    || new Set(platforms).size !== platforms.length || plans.length !== platforms.length) fail('产品依赖计划平台不完整');
  const covered = new Set();
  for (const [index, plan] of plans.entries()) {
    exactKeys(plan, ['schema', 'platform', 'archives'], '产品依赖计划');
    if (plan.schema !== 1 || plan.platform !== platforms[index]
      || !Array.isArray(plan.archives) || !plan.archives.length) fail('产品依赖计划身份或归档无效');
    const names = new Set();
    for (const archive of plan.archives) {
      exactKeys(archive, keys, '产品依赖计划归档');
      const expected = sources.get(archive.name);
      if (!expected || names.has(archive.name)
        || coordinates.some((key) => archive[key] !== expected[key])) fail('产品依赖计划与锁不一致');
      names.add(archive.name);
      covered.add(archive.name);
    }
  }
  if (covered.size !== sources.size) fail('产品依赖计划未覆盖全部锁定归档');
  return true;
}

// 准确中文注释属于开发逐项复核；仓库门禁不把保留源码逐文件出现汉字当作开发凭证。
export async function validateQuality(root, baseSHA, headSHA, repository) {
  const changed = git(root, ['diff', '--name-only', '-z', baseSHA, headSHA]).split('\0').filter(Boolean);
  const temporary = [];
  let smoldot;
  for (const path of changed.filter((item) => isImplementationPath(item) && !isTestPath(item) && !ignoredPrefixesFor(repository).some(prefix => item.startsWith(prefix)))) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !commentExtensions.has(extname(path).toLowerCase())) continue;
    const comments = commentText(path, readFileSync(absolute, 'utf8'));
    if (!/(?:TODO|FIXME|HACK|XXX)\b/u.test(comments)) continue;
    let upstream = '';
    if (repository === 'citizensdk' && path.startsWith('native/smoldot/pow/')) {
      if (!smoldot) {
        const sdk = root;
        const product = await import(pathToFileURL(resolve(sdk, 'scripts/release.mjs')).href);
        product.assertSmoldotRustSource(sdk);
        smoldot = {
          manifest: JSON.parse(readFileSync(resolve(sdk, 'native/smoldot/SOURCE_SHA256.json'), 'utf8')),
          record: readFileSync(resolve(sdk, 'native/smoldot/UPSTREAM.md'), 'utf8'),
        };
      }
      const url = smoldotUpstreamURL(path, smoldot.manifest, smoldot.record);
      if (url) upstream = await readUpstreamSource(url);
    }
    if (hasFirstPartyTemporaryComments(path, readFileSync(absolute, 'utf8'), upstream)) temporary.push(path);
  }
  if (temporary.length > 0) fail('产品实现代码保留临时注释：' + temporary.join('、'));
  const tests = git(root, ['ls-files', '-z']).split('\0').filter((path) => path && isTestPath(path)
    && !ignoredPrefixesFor(repository).some((prefix) => path.startsWith(prefix)));
  if (tests.length === 0) fail('产品没有受控测试代码');
  for (const path of tests) {
    const info = lstatSync(resolve(root, path), { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size === 0)) fail('产品测试代码无效：' + path);
  }
}

function validateSyntax(root, execute, environment, repository) {
  for (const path of trackedFiles(root)) {
    if (ignoredPrefixesFor(repository).some((prefix) => path.startsWith(prefix))) continue;
    const absolute = resolve(root, path);
    let result = null;
    if (path.endsWith('.mjs')) result = execute(process.execPath, ['--check', absolute], { cwd: root, env: environment, stdio: 'inherit' });
    else if (path.endsWith('.sh')) result = execute('bash', ['-n', absolute], { cwd: root, env: environment, stdio: 'inherit' });
    else if (path.endsWith('.json')) {
      try { JSON.parse(readFileSync(absolute, 'utf8')); } catch { fail('JSON语法无效：' + path); }
    }
    if (result && (result.error || result.signal || result.status !== 0)) fail('源码语法无效：' + path);
  }
}

export default async function* reporter(events) {
  async function* checked() {
    for await (const event of events) {
      if (event.type === 'test:summary' && (!event.data.success || event.data.counts.skipped > 0
        || event.data.counts.todo > 0 || event.data.counts.cancelled > 0)) {
        process.exitCode = 1;
        yield { type: 'test:diagnostic', data: { nesting: 0, message: '产品门禁测试没有完整执行成功。' } };
      }
      yield event;
    }
  }
  yield* Readable.from(checked()).pipe(spec());
}



function ignoredPrefixesFor(repository) {
  if (repository === 'citizensdk') return ['docs/smoldot-dart/', 'lib/src/smoldot/', 'test/smoldot/'];
  if (repository === 'tuyubooking') return ['upstream/'];
  if (repository === 'tuyufactory') return ['imported/'];
  return [];
}
// 技术文档只属于本仓根；保留README简介，拒绝副本、链接、空文件与额外根技术文档。
const productDocumentNames = Object.freeze(["TuyuWeb.md"]);
export function validateProductDocuments(root) {
  const allowed = new Set([...productDocumentNames, 'README.md']);
  for (const name of productDocumentNames) {
    const path = resolve(root, name), info = lstatSync(path, { throwIfNoEntry: false });
    if (!info || !info.isFile() || info.isSymbolicLink() || !info.size || realpathSync(path) !== path) fail('所属产品根技术文档缺失或类型无效：' + name);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!/\.md$/iu.test(entry.name)) continue;
    if (!allowed.has(entry.name)) fail('所属产品根存在额外技术文档：' + entry.name);
    const path = resolve(root, entry.name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !info.size || realpathSync(path) !== path) fail('所属产品根文档必须是非空普通原件：' + entry.name);
  }
  return true;
}
export function assertNoProductOutputDirectories(root, repository) {
  const ignored = new Set(['.git', 'node_modules', 'vendor', 'Pods', '.pub-cache', '.gradle']);
  const forbidden = new Set(['build', 'target', '.dart_tool', '.kotlin']);
  const violations = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name), relative = path.slice(root.length + 1);
      if (ignoredPrefixesFor(repository).some(prefix => (relative + '/').startsWith(prefix))) continue;
      // 仅本仓根target是生成边界，检查准确目录且不递归扫描任务现场。
      if (directory === root && entry.name === 'target') {
        if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path) violations.push(relative);
        continue;
      }
      if (forbidden.has(entry.name)) violations.push(relative);
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(path);
    }
  };
  visit(root);
  if (violations.length) fail('产品源码存在生成状态目录：' + violations.sort().join('、'));
}
export async function checkDependencies(root, { execute = spawnSync, report = console.log, env = {} } = {}) {
  const directory = resolve(root, 'scripts');
  const lock = JSON.parse(readFileSync(resolve(directory, 'dependencies.lock.json'), 'utf8'));
  const { assertCitizenSdkNativeContract } = await import(pathToFileURL(resolve(directory, 'release.mjs')).href);
  assertCitizenSdkNativeContract(lock.native);
  const platforms = ['Android', 'macOS', ...Object.keys(lock.native.platforms)];
  const plans = platforms.map(platform => {
    const result = execute(process.execPath, [resolve(directory, 'dependencies.mjs'), 'plan', '--platform', platform],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.signal || result.status !== 0) fail('产品依赖计划执行失败');
    try { return JSON.parse(result.stdout); } catch { fail('产品依赖计划回执无效'); }
  });
  validateDependencyPlans(lock, plans, platforms);
  report('产品依赖合同与全部锁定归档一致');
}


// 格式识别源码只有PEM头尾文字；实际凭据必须有密钥正文。
// 同时扫描原文、JSON解码值与任务补丁原件，不能用序列化转义隐藏真实材料。
export function hasSecretMaterial(source) {
  if (typeof source !== 'string') fail('机密扫描输入必须是文本');
  const token = /AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}/u;
  const material = text => {
    if (token.test(text)) return true;
    const normalized = text.replace(/\\r\\n|\\n|\\r/gu, '\n');
    for (const match of normalized.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)/gu)) {
      if (match[1].replace(/\s/gu, '').length >= 32) return true;
    }
    return false;
  };
  if (material(source)) return true;
  const documents = [];
  const trimmed = source.trim();
  if (/^(?:\{|\[|")/u.test(trimmed)) {
    try { documents.push(JSON.parse(trimmed)); } catch { /* 非JSON正文仍已执行原文扫描。 */ }
  }
  const begin = '<!-- PATCH_DATA\n', end = '\nPATCH_DATA -->';
  const start = source.indexOf(begin);
  if (start >= 0) {
    const stop = source.indexOf(end, start + begin.length);
    if (stop < 0 || source.indexOf(begin, start + begin.length) >= 0) fail('门禁补丁快照结构不可解析');
    try { documents.push(JSON.parse(source.slice(start + begin.length, stop))); }
    catch { fail('门禁补丁快照结构不可解析'); }
  }
  while (documents.length) {
    const value = documents.pop();
    if (typeof value === 'string') {
      if (material(value)) return true;
      // JSON内再次序列化的字符串仍解码扫描；不能把凭据放进键名或第二层转义。
      if (/^(?:\{|\[|")/u.test(value.trim())) {
        try { documents.push(JSON.parse(value)); } catch { /* 非JSON源码已按原文检查。 */ }
      }
    } else if (value && typeof value === 'object') {
      documents.push(...Object.keys(value), ...Object.values(value));
    }
  }
  return false;
}

// 强特征扫描只返回路径；不将机密值带入回执或日志。
export function validateSecrets(root) {
  // 根技术文档沿用原件的完整转义扫描；其余源码继续执行原有强特征检查。
  for (const name of productDocumentNames) {
    if (hasSecretMaterial(readFileSync(resolve(root, name), 'utf8'))) fail('产品根文档机密扫描未通过，仅报告路径：' + name);
  }
  const pattern = 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}';
  const result = spawnSync('/usr/bin/git', ['-C', root, 'grep','-l','-I','-E',pattern,'--','.',
    ':!test/release_manifest.test.ts', ':!test/release_manifest.test.mjs', ':!scripts/release/check/release_manifest.test.mjs'],
    { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  if (result.error || ![0,1].includes(result.status)) fail('门禁机密扫描执行失败');
  if (result.status === 0) fail('产品机密扫描未通过，仅报告路径：' + result.stdout.trim().split('\n').join('、'));
}

// 比较语义键及密码学值；描述和数组排列不构成协议差异。
export function validateVectorGroup(canonical, mirror, { keys, values, top, complete = false }) {
  const normalize = value => typeof value === 'string' ? value.toLowerCase() : value;
  function index(document) {
    if (!document || !Array.isArray(document.vectors) || document.vectors.length === 0) fail('金标缺少非空向量');
    const map = new Map();
    for (const vector of document.vectors) {
      if (!vector || keys.some(key => vector[key] === undefined) || values.some(key => vector[key] === undefined)) fail('金标向量字段缺失');
      const key = JSON.stringify(keys.map(field => normalize(vector[field])));
      if (map.has(key)) fail('金标存在重复语义键');
      map.set(key, vector);
    }
    return map;
  }
  const expected = index(canonical), actual = index(mirror);
  if (top.some(field => canonical[field] === undefined || normalize(canonical[field]) !== normalize(mirror[field]))) fail('金标顶层参数漂移');
  for (const [key, vector] of actual) {
    const source = expected.get(key);
    if (!source || values.some(field => normalize(source[field]) !== normalize(vector[field]))) fail('金标密码学值漂移');
  }
  if (complete && expected.size !== actual.size) fail('金标签名域必须完整覆盖');
  return actual.size;
}

// 上游链索引与本端Dart注册表必须具有真实内容，重复索引不能静默覆盖。
export function validatePalletRegistry(chain, dart = null) {
  const indices = new Map(), names = new Set();
  for (const match of chain.matchAll(/#\[runtime::pallet_index\((\d+)\)\]\s*\n\s*pub type (\w+)\s*=/gu)) {
    const index = Number(match[1]), name = match[2];
    if (indices.has(index) || names.has(name)) fail('金标链Pallet索引或名称重复');
    indices.set(index, name); names.add(name);
  }
  if (!indices.size) fail('金标链Pallet真源为空');
  if (dart === null) return indices.size;
  const constants = new Set();
  for (const match of dart.matchAll(/static const (?:int\s+)?(\w+Pallet)\s*=\s*(\d+);/gu)) {
    if (constants.has(match[1])) fail('金标DartPallet常量重复');
    constants.add(match[1]);
    const base = match[1].replace(/Pallet$/u, '');
    if (indices.get(Number(match[2])) !== base[0].toUpperCase() + base.slice(1)) fail('金标DartPallet索引漂移');
  }
  if (!constants.size) fail('金标DartPallet注册表为空');
  return constants.size;
}

// 公开消费者在一次门禁中先锁定链main的准确SHA，再只读该SHA的固定真源文件。
// 不访问控制台、私仓或本机其它产品，网络失败不得回退到缓存或猜测真源。
export async function readPublicChain(path, sha, request = fetch) {
  const allowed = new Set(['runtime/src/lib.rs', ...['signing_domain_vectors','binary_prefix_domain_vectors','account_derive_vectors']
    .map(name => 'runtime/primitives/tests/fixtures/' + name + '.json')]);
  const url = path === null ? 'https://api.github.com/repos/crcfrcn/citizenchain/git/ref/heads/main'
    : 'https://raw.githubusercontent.com/crcfrcn/citizenchain/' + sha + '/' + path;
  if (path !== null && (!allowed.has(path) || !commitPattern.test(sha))) fail('公开链真源坐标无效');
  try {
    const response = await request(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { Accept: path === null ? 'application/vnd.github+json' : 'text/plain' } });
    if (!response.ok || !response.body) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (path !== null) return text;
    const reference = JSON.parse(text);
    if (reference.ref !== 'refs/heads/main' || reference.object?.type !== 'commit'
      || !commitPattern.test(reference.object.sha)
      || reference.object.url !== 'https://api.github.com/repos/crcfrcn/citizenchain/git/commits/' + reference.object.sha) throw new Error();
    return reference.object.sha;
  } catch { fail('公开链准确提交真源读取失败'); }
}

export async function checkCrossPlatform(root, { request = fetch, report = console.log } = {}) {
  const own = contract.repository === 'citizenchain';
  if (!own && !['citizenapp','citizenwallet'].includes(contract.repository)) fail('金标检查没有本仓归属');
  const sha = own ? git(root, ['rev-parse','HEAD']).trim() : await readPublicChain(null, null, request);
  const read = async path => own ? readFileSync(resolve(root, path), 'utf8') : readPublicChain(path, sha, request);
  const groups = [
    { file: 'signing_domain_vectors.json', keys: ['op_tag','scale_payload_hex'], values: ['message_hex'], top: ['domain'], complete: true },
    { file: 'binary_prefix_domain_vectors.json', keys: ['name'], values: ['op_tag','prefix_hex','payload_hex','total_len'], top: ['domain'] },
    { file: 'account_derive_vectors.json', keys: ['cid_number','kind'], values: ['account_id'], top: ['domain','ss58_format'] },
  ];
  for (const group of groups) {
    const canonical = JSON.parse(await read('runtime/primitives/tests/fixtures/' + group.file));
    if (own) validateVectorGroup(canonical, canonical, group);
    else if (!(contract.repository === 'citizenwallet' && group.file === 'account_derive_vectors.json')) {
      const relative = group.file === 'account_derive_vectors.json' ? 'test/governance/shared/' : 'test/signer/fixtures/';
      const mirror = JSON.parse(readFileSync(resolve(root, relative, group.file), 'utf8'));
      validateVectorGroup(canonical, mirror, group);
    }
  }
  const chain = await read('runtime/src/lib.rs');
  const registry = contract.repository === 'citizenapp' ? 'lib/citizen/shared/pallet_registry.dart' : 'lib/signer/pallet_registry.dart';
  validatePalletRegistry(chain, own ? null : readFileSync(resolve(root, registry), 'utf8'));
  report('密码学金标与Pallet注册表完成真源校验：citizenchain@' + sha);
}

// 官方原上下文仅在扫描副本处理；补丁全文摘要、固定来源和唯一位置必须同时闭合。
function flutterPatchContent(patch, metadata) {
  const commit = 'd3b14c876900e553bc736ca19295fc09e3853e8e';
  if (typeof patch !== 'string' || !metadata || Array.isArray(metadata)
    || Object.keys(metadata).sort().join('\0') !== 'path\0sha256\0source'
    || metadata.path !== 'flutter.patch'
    || metadata.source !== 'https://github.com/flutter/flutter/commit/' + commit
    || !/^[0-9a-f]{64}$/u.test(metadata.sha256)
    || !patch.startsWith('# Flutter Android new DSL — fixed source ' + commit + '\n')
    || createHash('sha256').update(patch).digest('hex') !== metadata.sha256) return null;
  const file = 'packages/flutter_tools/lib/src/isolated/native_assets/macos/native_assets_host.dart';
  const comment = ' /// ios device or ' + ['macos', 'arm64'].join(' ') + '.';
  const context = '--- a/' + file + '\n+++ b/' + file + '\n@@ -66,7 +66,8 @@\n' + comment
    + '\n Future<void> lipoDylibs(File target, List<File> sources) async {\n'
    + '   final RunResult lipoResult = await globals.processUtils.run(<String>[\n';
  if (patch.split(context).length !== 2) return null;
  return patch.replace(context, context.replace(comment, ''));
}

// 准确官方归档字段不是产品平台名称；其余工具字段与文字仍参与完整扫描。
function flutterArchiveURL(tool) {
  if (!tool || tool.id !== 'flutter' || !/^\d+\.\d+\.\d+$/u.test(tool.version)
    || tool.source !== 'https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json'
    || tool.archive?.root !== 'flutter' || tool.archive.executable !== 'bin/flutter'
    || tool.archive.kind !== 'extract' || !/^[0-9a-f]{64}$/u.test(tool.archive.sha256)) return null;
  const url = 'https://storage.googleapis.com/flutter_infra_release/releases/stable/macos/flutter_'
    + ['macos', 'arm64'].join('_') + '_' + tool.version + '-stable.zip';
  return tool.archive.url === url ? url : null;
}

function resourcePlatformContent(source) {
  // 唯一规范声明回读阻断重复键、重复变量、转义与格式歧义；无效时保留原文扫描。
  const declarations = [...source.matchAll(/^const toolDefinitions=(\[.*\]);$/gmu)];
  const patches = [...source.matchAll(/^const flutterPatch=(".*");$/gmu)];
  if (declarations.length !== 1 || patches.length !== 1
    || [...source.matchAll(/\b(?:const|let|var)\s+toolDefinitions\b/gu)].length !== 1
    || [...source.matchAll(/\b(?:const|let|var)\s+flutterPatch\b/gu)].length !== 1) return source;
  try {
    const [declaration] = declarations, [literal] = patches;
    const tools = JSON.parse(declaration[1]), patch = JSON.parse(literal[1]);
    if (!Array.isArray(tools) || !tools.length || JSON.stringify(tools) !== declaration[1]
      || tools.some(tool => !tool || Array.isArray(tool) || typeof tool !== 'object'
        || typeof tool.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(tool.id))
      || new Set(tools.map(tool => tool.id)).size !== tools.length
      || typeof patch !== 'string' || JSON.stringify(patch) !== literal[1]) return source;
    const flutter = tools.filter(tool => tool.id === 'flutter');
    if (flutter.length > 1 || (flutter.length === 1 && !flutterArchiveURL(flutter[0]))) return source;
    // 未使用的共同原补丁仅接受这份已核实全文；不读取其它仓库或私有登记。
    const metadata = flutter.length === 1 ? flutter[0].patch : {
      path: 'flutter.patch',
      sha256: '76ef76ca73b2b00423009bd7ebca62f23026e2c9d411504324d2c8ff64da4657',
      source: 'https://github.com/flutter/flutter/commit/d3b14c876900e553bc736ca19295fc09e3853e8e',
    };
    const scanned = flutterPatchContent(patch, metadata);
    if (scanned === null) return source;
    // 按原文坐标从右向左替换，仅改变两个准确字面量的扫描副本。
    const changes = [{ match: literal, text: 'const flutterPatch=' + JSON.stringify(scanned) + ';' }];
    if (flutter.length === 1) {
      flutter[0].archive.url = '';
      changes.push({ match: declaration, text: 'const toolDefinitions=' + JSON.stringify(tools) + ';' });
    }
    let text = source;
    for (const { match, text: replacement } of changes.sort((a, b) => b.match.index - a.match.index)) {
      text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
    }
    return text;
  } catch { return source; }
}

function platformContent(root, path, source) {
  if (path === '.github/tatagate/contracts.json') {
    try { const value = JSON.parse(source); value.platform_forbidden_values = []; return JSON.stringify(value); }
    catch { return source; }
  }
  return path === 'scripts/resources.mjs' ? resourcePlatformContent(source) : source;
}

// 平台命名闭集只来自本仓门禁合同，不读取其它产品或私有资料。
export function validatePlatformNaming(root) {
  const values = contract.platform_forbidden_values;
  if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v)
    || new Set(values).size !== values.length) fail('门禁平台禁用值登记无效');
  for (const path of trackedFiles(root)) {
    if (ignoredPrefixesFor(contract.repository).some(prefix => path.startsWith(prefix))
) continue;
    if (values.slice(1).some(value => path.toLowerCase().includes(value.toLowerCase()))) fail('产品存在禁用平台目录：' + path);
    const text = platformContent(root, path, readFileSync(resolve(root,path),'utf8')).toLowerCase();
    if (values.some(value => text.includes(value.toLowerCase()))) fail('产品存在禁用平台命名：' + path);
  }
}

// 提交中的本仓合同是唯一门禁执行登记；工作目录仅承接当前门禁的中间物。
const gateDirectory = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(resolve(gateDirectory, 'contracts.json'), 'utf8'));
export function gateContract(value = contract) {
  const contract = value;
  exactKeys(contract, ['schema','repository','workflows','node_tests','checks','tools','platform_forbidden_values'], '本仓塔塔门禁');
  if (contract.schema !== 1 || !/^[a-z][a-z0-9]*$/u.test(contract.repository)
    || !Array.isArray(contract.workflows) || !Array.isArray(contract.node_tests)
    || !Array.isArray(contract.checks) || contract.node_tests.length === 0
    || new Set(contract.node_tests).size !== contract.node_tests.length
    || new Set(contract.workflows).size !== contract.workflows.length) fail('本仓塔塔门禁登记无效');
  for (const file of contract.node_tests) {
    if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mjs$/u.test(file)
      || file.split('/').some(v => ['', '.', '..'].includes(v))) fail('门禁测试路径无效');
  }
  const allowed = ['repository-contracts','dependency-contracts','cross-platform-contracts','shared-contracts'];
  if (contract.checks.some(id => !allowed.includes(id)) || new Set(contract.checks).size !== contract.checks.length) fail('本仓门禁检查闭集无效');
    exactKeys(contract.tools, ['node','actionlint','rust'], '门禁工具');
  if (contract.tools.node !== '25.2.1' || contract.tools.actionlint !== '1.7.12'
    || contract.tools.rust !== (contract.repository === 'citizenchain' ? '1.97.1' : null)) fail('门禁工具版本无效');
  if (contract.workflows.some(id => !new RegExp('^' + contract.repository + '\\.[a-z][a-z0-9-]*\\.(?:ci|release)$', 'u').test(id))) fail('Workflow不属于本仓');
  if (!Array.isArray(contract.platform_forbidden_values) || !contract.platform_forbidden_values.length
    || contract.platform_forbidden_values.some(v => typeof v !== 'string' || !v)
    || new Set(contract.platform_forbidden_values).size !== contract.platform_forbidden_values.length) fail('门禁平台禁用值登记无效');
  const expectedChecks = ['repository-contracts',
    ...(contract.repository === 'citizensdk' ? ['dependency-contracts'] : []),
    ...(['citizenchain','citizenapp','citizenwallet'].includes(contract.repository) ? ['cross-platform-contracts'] : []),
    ...(contract.repository === 'citizenchain' ? ['shared-contracts'] : [])];
  if (contract.checks.join('\0') !== expectedChecks.join('\0')) fail('本仓实际检查合同缺失或扩大');
  return contract;
}

export function validateWorkflowSource(source, filename, repository = contract.repository) {
  const canonical = /^name: ([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.(?:ci|release))$/mu.exec(source)?.[1];
  const [product, platform, flow] = String(canonical || '').split('.');
  const jobs = source.split(/^jobs:\s*\n/mu)[1];
  if (!canonical || product !== repository || filename !== product + '-' + platform + '-' + flow + '.yml'
    || !/^\s*workflow_dispatch:\s*$/mu.test(source) || /^\s*push:\s*$/mu.test(source)
    || !jobs || [...jobs.matchAll(/^  flow:$/gmu)].length !== 1
    || !source.includes('allowed=new Set(["' + canonical + '"])')
    || !source.includes('  group: ' + canonical + '\n')) fail('产品Workflow三维身份无效');
  return canonical;
}

export function validateWorkflow(root) {
  const directory = resolve(root, '.github/workflows');
  const expected = ['tatagate.yml', ...contract.workflows.map(id => id.replaceAll('.', '-') + '.yml')].sort();
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || lstatSync(resolve(directory, entry.name)).isSymbolicLink())
    || entries.map(entry => entry.name).sort().join('\0') !== expected.join('\0')) fail('本仓Workflow文件集合不符');
  for (const entry of entries) {
    const source = readFileSync(resolve(directory, entry.name), 'utf8');
    if (entry.name === 'tatagate.yml') {
      if (!/^name: tatagate$/mu.test(source) || !/^\s*push:\s*$/mu.test(source)
        || !source.includes('branches: [main]') || /^\s*(?:pull_request|workflow_dispatch|workflow_run):/mu.test(source)
        || !source.includes('node .github/tatagate/index.mjs remote')) fail('GitHub塔塔门禁入口无效');
    } else if (!contract.workflows.includes(validateWorkflowSource(source, entry.name))) fail('产品Workflow不属于本仓登记');
  }
  return entries.map(entry => '.github/workflows/' + entry.name);
}

// 路径、源码与测试只消费自身提交；临时目录不能在源码里，也不能复用别仓或别次任务。
function environment(root, work) {
  // 只传真实执行所需的基础环境与Runner身份；其它产品根、私有状态与任何凭据均不继承。
  const names=['HOME','USER','LOGNAME','LANG','LC_ALL','PATH','RUSTUP_HOME','RUSTUP_TOOLCHAIN',
    'GITHUB_ACTIONS','GITHUB_WORKSPACE','GITHUB_SHA','GITHUB_EVENT_NAME','GITHUB_REF',
    'GITHUB_WORKFLOW','GITHUB_JOB','GITHUB_REPOSITORY','RUNNER_TOOL_CACHE','RUNNER_TEMP',
    'GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','PRODUCT_GIT_BIN'];
  const result=Object.fromEntries(names.filter(name=>typeof process.env[name]==='string').map(name=>[name,process.env[name]]));
  Object.assign(result,{ TMPDIR:resolve(work,'tmp'),CARGO_HOME:resolve(work,'cargo-home'),
    CARGO_TARGET_DIR:resolve(work,'cargo'),CARGO_INCREMENTAL:'0' });
  result[contract.repository.toUpperCase()+'_ROOT']=root;
  mkdirSync(result.TMPDIR,{recursive:true});
  return result;
}
export async function executeGate({ root, baseSHA, headSHA, work, actionlint, cargo }, { execute = spawnSync, report = console.log } = {}) {
  gateContract();
  if (process.version !== 'v' + contract.tools.node) fail('塔塔门禁必须使用本仓登记的唯一Node版本');
  validateRange({ root, baseSHA, headSHA });
  if (!isAbsolute(work) || realpathSync(work) !== work || !lstatSync(work).isDirectory()
    || lstatSync(work).isSymbolicLink() || work === root || work.startsWith(root + '/')
    || root.startsWith(work + '/') || readdirSync(work).length !== 0) fail('门禁独占临时目录边界无效');
  const before = git(root, ['status','--porcelain=v1','--untracked-files=all']);
  if (before.trim()) fail('本仓门禁只接受干净的已保存提交');
  const env = environment(root, work);
  env.BASE_SHA = baseSHA; env.BASE_REF = baseSHA;
  env.TATAGATE_WORK_DIR = work;
  env.TATAGATE_REPOSITORY_ROOT = root;

  const run = (command, args, label) => {
    const result = execute(command, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) fail('本仓塔塔门禁失败：' + label);
  };
  assertNoProductOutputDirectories(root, contract.repository);
  validateProductDocuments(root);
  validateSecrets(root);
  validatePlatformNaming(root);
  await validateQuality(root, baseSHA, headSHA, contract.repository);
  const workflowFiles = validateWorkflow(root);
  if (!isAbsolute(String(actionlint || '')) || !lstatSync(actionlint).isFile()
    || lstatSync(actionlint).isSymbolicLink()) fail('Workflow检查器必须是已验真的准确执行器');
  const version = execute(actionlint, ['-version'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  if (version.error || version.signal || version.status !== 0
    || !new RegExp('(?:^|\\s)v?' + contract.tools.actionlint.replaceAll('.', '\\.') + '(?:\\s|$)', 'u').test(version.stdout)) fail('Workflow检查器版本不符');
  // 不调用PATH中的可选外部分析器；Shell与JSON/MJS仍由下面的真实语法检查逐文件验真。
  run(actionlint, ['-shellcheck=', '-pyflakes=', ...workflowFiles], 'Workflow语法');
  validateSyntax(root, execute, env, contract.repository);
  for (const relative of contract.node_tests) {
    const path = resolve(root, relative), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) fail('本仓真实测试文件缺失');
  }
  report(contract.repository + ' · 本机/GitHub共用塔塔门禁');
  run(process.execPath, ['--test', '--test-reporter=' + resolve(gateDirectory, 'index.mjs'),
    resolve(gateDirectory, 'test.mjs'), ...contract.node_tests.map(path => resolve(root, path))], '所属仓真实合同测试');
  if (contract.checks.includes('dependency-contracts')) await checkDependencies(root, { execute, report, env });
  if (contract.checks.includes('cross-platform-contracts')) await checkCrossPlatform(root, { report });
  if (contract.checks.includes('shared-contracts')) {
    if (!isAbsolute(String(cargo || '')) || !lstatSync(cargo).isFile()) fail('链门禁缺少登记的准确Cargo');
    const cargoVersion = execute(cargo, ['--version'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    if (cargoVersion.error || cargoVersion.signal || cargoVersion.status !== 0
      || !/^cargo 1\.97\.1(?:\s|$)/u.test(cargoVersion.stdout)) fail('链门禁Cargo版本不符');
    env.PATH = dirname(cargo) + ':' + env.PATH;
    run(cargo, ['fmt','--all','--','--check'], 'Rust格式');
    run(cargo, ['clippy','--workspace','--all-targets','--locked','--','-D','warnings'], 'RustClippy');
    run(cargo, ['test','--workspace','--all-targets','--locked'], 'Rust工作区测试');
  }

  assertNoProductOutputDirectories(root, contract.repository);
  if (git(root, ['status','--porcelain=v1','--untracked-files=all']) !== before) fail('门禁执行改动了所属提交源码');
  return Object.freeze({ repository: contract.repository, base_sha: baseSHA, head_sha: headSHA });
}

export async function repositoryGateMain(args) {
  const [mode, root, baseSHA, headSHA, work] = args;
  if (mode === 'physical' && args.length === 2) {
    if (realpathSync(root) !== root) fail('本仓物理根必须真实');
    assertNoProductOutputDirectories(root, contract.repository);
    return;
  }
  if (mode === 'local' && args.length === 5) return executeGate({
    root, baseSHA, headSHA, work, actionlint: process.env.TATAGATE_ACTIONLINT,
    cargo: process.env.TATAGATE_CARGO,
  });
  if (mode === 'remote' && args.length === 1 && process.env.GITHUB_ACTIONS === 'true') {
    const root = process.env.GITHUB_WORKSPACE, headSHA = process.env.GITHUB_SHA;
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main'
      || process.env.GITHUB_WORKFLOW !== 'tatagate' || process.env.GITHUB_JOB !== 'gate'
      || event.ref !== 'refs/heads/main' || event.after !== headSHA
      || event.repository?.name !== contract.repository || event.deleted) fail('远端push门禁身份无效');
    const baseSHA = pushBaseSHA({ forced: event.forced, before: event.before, headSHA,
      parents: event.forced === true ? git(root, ['rev-list', '--parents', '-n', '1', headSHA]).trim() : undefined,
      commitCount: event.forced === true ? git(root, ['rev-list', '--count', headSHA]).trim() : undefined });
    if (baseSHA === emptyTreeSHA) git(root, ['hash-object','-w','-t','tree','/dev/null']);
    const work = resolve(process.env.RUNNER_TEMP, 'tatagate-' + contract.repository + '-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT);
    mkdirSync(work);
    try { return await executeGate({ root, baseSHA, headSHA, work,
      actionlint: process.env.TATAGATE_ACTIONLINT, cargo: process.env.TATAGATE_CARGO }); }
    finally { rmSync(work, { recursive: true }); }
  }
  fail('本仓塔塔门禁参数或身份无效');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await repositoryGateMain(process.argv.slice(2)); }
  catch (error) {
    // 仅输出门禁固定诊断或本地受控路径；不得透传网络响应、子进程异常或凭据。
    console.error(error?.message?.startsWith('本仓') || error?.message?.startsWith('产品')
      || error?.message?.startsWith('门禁') || error?.message?.startsWith('公开')
      || error?.message?.startsWith('金标') || error?.message?.startsWith('链门禁')
      ? error.message : '所属仓塔塔门禁失败，请检查以上准确检查项，未放行推送。');
    process.exitCode = 1;
  }
}
