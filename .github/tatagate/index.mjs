import {fixedWork,withFixedWork,checkFixedWork,assertTargetTopology} from '../../scripts/target.mjs';
import {gateToolInterfaces,gateCleanupAllowed,runResourceProcess,prepareGateResources,verifyGateResourceDelivery} from '../../scripts/resources.mjs';
const {toolEnvironment}=gateToolInterfaces;
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
// 仅排除已核实的上游源码；本仓第一方及自有归档消费者测试均纳入功能清单。
const functionalIgnoredPrefixes=[];

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
    const checked=toolEnvironment();
    return execFileSync(checked.PRODUCT_GIT_BIN, ['-C', root, ...arguments_], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: checked,
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

// 词法扫描保留真实代码与注释位置；字符串、正则及模板正文不作为实现注释。
export function lexicalParts(path, source) {
  const extension=extname(path).toLowerCase(), javascript=['.js','.jsx','.mjs','.ts','.tsx'].includes(extension);
  const comments=[], code=source.split('');let index=0;
  const blank=(begin,end)=>{for(let at=begin;at<end;at++)if(source[at]!=='\n'&&source[at]!=='\r')code[at]=' ';};
  const quote=(delimiter,triple=false,interpolated=false)=>{
    const size=triple?3:1;blank(index,index+size);index+=size;
    while(index<source.length){
      if(source[index]==='\\'){blank(index,index+2);index+=2;continue;}
      if(interpolated&&source.startsWith('${',index)){blank(index,index+2);index+=2;scan(true);continue;}
      if(source.startsWith(delimiter.repeat(size),index)){blank(index,index+size);index+=size;return;}
      blank(index,index+1);index++;
    }
  };
  const scan=(interpolation=false)=>{
    let previous='',word='',depth=1;
    while(index<source.length){
      const value=source[index];
      if(/\s/u.test(value)){index++;continue;}
      if(interpolation&&value==='}'){if(--depth===0){blank(index,index+1);index++;return;}index++;previous='}';continue;}
      if(interpolation&&value==='{')depth++;
      const lineComment=(['.py','.sh'].includes(extension)&&value==='#'&&!source.startsWith('#!',index))
        ||extension==='.sql'&&source.startsWith('--',index)
        ||!['.py','.sh','.sql'].includes(extension)&&source.startsWith('//',index);
      if(lineComment){const begin=index,end=source.indexOf('\n',index);index=end<0?source.length:end;comments.push(source.slice(begin,index));blank(begin,index);continue;}
      if(!['.py','.sh'].includes(extension)&&source.startsWith('/*',index)){
        const begin=index;let nested=1;index+=2;
        while(index<source.length&&nested){if(extension==='.rs'&&source.startsWith('/*',index)){nested++;index+=2;}else if(source.startsWith('*/',index)){nested--;index+=2;}else index++;}
        comments.push(source.slice(begin,index));blank(begin,index);continue;
      }
      if(extension==='.rs'){
        const raw=/^(?:b)?r(#+)?"/u.exec(source.slice(index));
        if(raw){const begin=index,close='"'+(raw[1]||''),end=source.indexOf(close,index+raw[0].length);index=end<0?source.length:end+close.length;blank(begin,index);previous='literal';continue;}
        if(value==="'"&&!/^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.test(source.slice(index))){index++;previous=value;continue;}
      }
      if(value==='"'||value==="'"||value==='`'){
        quote(value,['.dart','.py'].includes(extension)&&source.startsWith(value.repeat(3),index),javascript&&value==='`'||extension==='.dart'&&source[index-1]!=='r');previous='literal';word='';continue;
      }
      if(javascript&&value==='/'&&(!previous||/[=(:,!\[{};?]/u.test(previous)||['return','throw','yield','case'].includes(word))){
        const begin=index++;let bracket=false;
        while(index<source.length){const current=source[index++];if(current==='\\'){index++;continue;}if(current==='[')bracket=true;else if(current===']')bracket=false;else if(current==='/'&&!bracket)break;else if(current==='\n')break;}
        while(/[a-z]/iu.test(source[index]||''))index++;blank(begin,index);previous='literal';word='';continue;
      }
      if(/[A-Za-z_$]/u.test(value)){const begin=index++;while(/[A-Za-z0-9_$]/u.test(source[index]||''))index++;word=source.slice(begin,index);previous='word';continue;}
      previous=value;word='';index++;
    }
  };
  scan();return {comments:comments.join('\n'),code:code.join('')};
}

export function commentText(path, source) { return lexicalParts(path,source).comments; }


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
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size === 0) fail('产品测试代码无效：' + path);
  }
}

function validateSyntax(root, execute, environment, repository) {
  for (const path of trackedFiles(root)) {
    if (ignoredPrefixesFor(repository).some((prefix) => path.startsWith(prefix))) continue;
    const absolute = resolve(root, path);
    let result = null;
    if (path.endsWith('.mjs')) result = execute(process.execPath, ['--check', absolute], { cwd: root, env: environment, stdio: 'inherit' });
    else if (path.endsWith('.sh')) result = execute(environment.PRODUCT_BASH_BIN, ['-n', absolute], { cwd: root, env: environment, stdio: 'inherit' });
    else if (path.endsWith('.json')) {
      try { JSON.parse(readFileSync(absolute, 'utf8')); } catch { fail('JSON语法无效：' + path); }
    }
    if (result && (result.error || result.signal || result.status !== 0)) fail('源码语法无效：' + path);
  }
}

// 逐文件与最终汇总必须对应同一非空清单，拒绝漏文件、重复汇总及伪造总数。
export default async function* reporter(events) {
  async function* checked() {
    let list;
    try{list=JSON.parse(process.env.TATAGATE_NODE_TESTS||'null');}catch{list=null;}
    const validList=Array.isArray(list)&&list.length>0&&list.every(file=>typeof file==='string'&&isAbsolute(file)&&resolve(file)===file)&&new Set(list).size===list.length;
    const expected=new Set(validList?list:[]),seen=new Set(),functionalFiles=[];let cumulative=false,total=0,invalid=!validList;
    for await(const event of events){
      if(event.type==='test:summary'){
        const data=event.data;let valid=successfulTestSummary(data);
        if(data?.file!==undefined){
          if(typeof data.file!=='string'||!data.file)valid=false;
          else{const file=resolve(data.file);if(!expected.has(file)||seen.has(file)||cumulative)valid=false;seen.add(file);total+=data.counts?.tests||0;functionalFiles.push({path:file,counts:data.counts});}
        }else{if(cumulative||seen.size!==expected.size||[...expected].some(file=>!seen.has(file))||data?.counts?.tests!==total)valid=false;cumulative=true;}
        if(!valid)invalid=true;
      }
      yield event;
    }
    if(invalid||!cumulative||seen.size!==expected.size){process.exitCode=1;yield{type:'test:diagnostic',data:{nesting:0,message:'产品门禁缺少逐文件完整成功回执。'}};}
    else if(process.env.TATAGATE_REPOSITORY_ROOT&&process.env.TATAGATE_WORK_DIR){
      const root=process.env.TATAGATE_REPOSITORY_ROOT,actual=[resolve(root,'.github/tatagate/test.mjs'),...contract.node_tests.map(path=>resolve(root,path))];
      if(JSON.stringify(list)===JSON.stringify(actual))writeFunctionalRecord(process.env.TATAGATE_WORK_DIR,'node',root,{files:functionalFiles});
    }
  }
  yield* Readable.from(checked()).pipe(spec());
}

// 扫描准确本仓Git已跟踪的Node测试，不接受漏登记、失效登记或重复入口。
export function validateNodeInventory(paths, registered, repository = contract.repository) {
  if (!Array.isArray(paths) || !Array.isArray(registered)) fail('本仓测试清单类型无效');
  const owned = paths.filter(path => !path.startsWith('.github/tatagate/')
    && !ignoredPrefixesFor(repository).some(prefix => path.startsWith(prefix))
    && /(?:^|\/)(?:test\.mjs|[^/]+[._-](?:test|spec)\.mjs)$/u.test(path)).sort();
  if (!owned.length || new Set(paths).size !== paths.length
    || new Set(registered).size !== registered.length
    || owned.join('\0') !== [...registered].sort().join('\0')) fail('本仓实际测试与门禁登记不闭合');
  return Object.freeze(owned);
}

// 本机与远端检出均独立验证真实Git根、唯一origin及同一个已保存提交。
export function validateRepositoryIdentity(root, { remote = false } = {}) {
  if (git(root, ['rev-parse', '--show-toplevel']).trim() !== root
    || git(root, ['rev-parse', '--is-bare-repository']).trim() !== 'false'
    || resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()) !== resolve(root, '.git')
    || !lstatSync(resolve(root, '.git')).isDirectory() || lstatSync(resolve(root, '.git')).isSymbolicLink()
    || git(root, ['remote', 'get-url', '--all', 'origin']).trim() !== 'https://github.com/' + contract.github_repository + '.git') {
    fail('本仓独立Git根或准确HTTPS来源不符');
  }
  if (!remote && git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() !== 'main') fail('本机门禁只接受本仓main');
  if (remote && (process.env.GITHUB_REPOSITORY !== contract.github_repository
    || process.env.GITHUB_WORKSPACE !== root || process.env.GITHUB_REF !== 'refs/heads/main')) fail('远端所属仓上下文不符');
}

// 汇总必须非空且没有失败、取消、待办或跳过，不能用零用例退出码冒充验收。
export function successfulTestSummary(data) {
  const counts = data?.counts;
  return data?.success === true && counts && Number.isSafeInteger(counts.tests) && counts.tests > 0
    && ['failed', 'skipped', 'todo', 'cancelled'].every(name => counts[name] === 0)
    && Number.isSafeInteger(counts.passed) && counts.passed === counts.tests;
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
 if(root===resolve(import.meta.dirname,'../..'))assertTargetTopology();
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
  const checked=toolEnvironment();
  const result = spawnSync(checked.PRODUCT_GIT_BIN, ['-C', root, 'grep','-l','-I','-E',pattern,'--','.',
    ':!test/release_manifest.test.ts', ':!test/release_manifest.test.mjs', ':!scripts/release/check/release_manifest.test.mjs'],
    { env:checked,encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
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
// 跨产品只按本仓固定SHA读取公开真源，不跟随其它产品的main。
export async function readPublicChain(path,sha,request=fetch){
 const allowed=new Set(['runtime/src/lib.rs',...['signing_domain_vectors','binary_prefix_domain_vectors','account_derive_vectors'].map(name=>'runtime/primitives/tests/fixtures/'+name+'.json')]);
 if(!allowed.has(path)||!commitPattern.test(sha))fail('公开链真源坐标无效');
 const url='https://raw.githubusercontent.com/crcfrcn/citizenchain/'+sha+'/'+path;
 try{const response=await request(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000),headers:{Accept:'text/plain'}});
  if(!response.ok||!response.body||response.url&&response.url!==url)throw Error();const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>2*1024**2)throw Error();chunks.push(Buffer.from(chunk));}
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
 }catch{fail('公开链准确提交真源读取失败');}
}

export async function checkCrossPlatform(root, { request = fetch, report = console.log } = {}) {
  const own = contract.repository === 'citizenchain';
  if (!own && !['citizenapp','citizenwallet'].includes(contract.repository)) fail('金标检查没有本仓归属');
  const sha = own ? git(root, ['rev-parse','HEAD']).trim() : contract.chain_source.sha;
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
  exactKeys(contract, ['schema','repository','github_repository','workflows','node_tests','checks','tools','platform_forbidden_values','functions'], '本仓塔塔门禁');
  if (contract.github_repository !== "tuyutata/tuyuweb") fail('本仓组织与仓库登记不符');
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
  validateFunctionalContract(contract.functions);
  if(JSON.stringify(contract.functions.filter(item=>item.runner==='node').map(item=>item.path).sort())!==JSON.stringify([...contract.node_tests].sort()))fail('本仓功能Node入口与正式测试集合不一致');
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
        || !source.includes("child.execFileSync(process.execPath, ['.github/tatagate/index.mjs', 'remote'], {stdio:'inherit'});")) fail('GitHub塔塔门禁入口无效');
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
    'GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','PRODUCT_GIT_BIN','PRODUCT_BASH_BIN','PRODUCT_GREP_BIN','PRODUCT_SED_BIN'];
  const result=Object.fromEntries(names.filter(name=>typeof process.env[name]==='string').map(name=>[name,process.env[name]]));
  Object.assign(result,{ TMPDIR:resolve(work,'tmp'),CARGO_HOME:resolve(work,'cargo-home'),
    CARGO_TARGET_DIR:resolve(work,'cargo'),CARGO_INCREMENTAL:'0' });
  result[contract.repository.toUpperCase()+'_ROOT']=root;
  mkdirSync(result.TMPDIR,{recursive:true});
  return result;
}
export async function executeGate({ root, baseSHA, headSHA, work, actionlint, cargo, resourceReceipt, signal }, { execute = spawnSync, report = console.log } = {}) {
  gateContract();
  if(!resourceReceipt)fail('本仓门禁缺少所属资源的完整交付');
  const resourceEnvironment=await verifyGateResourceDelivery(resourceReceipt);
  if(actionlint!==resourceEnvironment.TATAGATE_ACTIONLINT||cargo!==resourceEnvironment.CARGO)fail('本仓检查器或Cargo未绑定准确资源交付');
  Object.assign(process.env,resourceEnvironment);
  if (process.version !== 'v' + contract.tools.node) fail('塔塔门禁必须使用本仓登记的唯一Node版本');
  validateRepositoryIdentity(root, { remote: process.env.GITHUB_ACTIONS === 'true' });
  validateRange({ root, baseSHA, headSHA });
  validateNodeInventory(trackedFiles(root), contract.node_tests);
  validateFunctionalInventory(root);
  if (!isAbsolute(work) || realpathSync(work) !== work || !lstatSync(work).isDirectory()
    || lstatSync(work).isSymbolicLink() || work === root || !work.startsWith(resolve(root,'target') + '/')
    || root.startsWith(work + '/') || readdirSync(work).length !== 0) fail('门禁独占临时目录边界无效');
  const before = git(root, ['status','--porcelain=v1','--untracked-files=all']);
  if (before.trim()) fail('本仓门禁只接受干净的已保存提交');
  const env = {...environment(root, work),...resourceEnvironment};
  env.TMPDIR=resolve(work,'tmp');mkdirSync(env.TMPDIR,{recursive:true});
  env.BASE_SHA = baseSHA; env.BASE_REF = baseSHA;
  env.TATAGATE_WORK_DIR = work;
  env.TATAGATE_REPOSITORY_ROOT = root;

  const run = async (command, args, label, cwd=root) => {
    signal?.throwIfAborted();
    if(execute===spawnSync){return runResourceProcess(command,args,{cwd,env,signal,timeout:3_600_000,maxBuffer:64*1024**2});}
    else{const result=execute(command,args,{cwd,env,stdio:'inherit'});if(result.error||result.signal||result.status!==0)fail('本仓塔塔门禁失败：'+label);return result;}
    signal?.throwIfAborted();
  };
  assertNoProductOutputDirectories(root, contract.repository);
  validateProductDocuments(root);
  checkChangeEvidence(root,baseSHA,headSHA);
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
  await run(resourceEnvironment.TATAGATE_ACTIONLINT, ['-shellcheck=', '-pyflakes=', ...workflowFiles], 'Workflow语法');
  validateSyntax(root, execute, env, contract.repository);
  for (const relative of contract.node_tests) {
    const path = resolve(root, relative), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) fail('本仓真实测试文件缺失');
  }
  report(contract.repository + ' · 本机/GitHub共用塔塔门禁');
  const languageView=ownedLanguageTests(root).length||contract.repository==='tuyuweb'?await (await import('../../scripts/resources.mjs')).gateLanguageView(resolve(resourceReceipt.work,'language-source'),resourceReceipt,{signal}):null;
  await prepareNodeDependencyViews(root,work,env,run);
  if(contract.repository==='tuyuweb'){
    const project=languageView.view,npm=resolve(dirname(env.PRODUCT_NODE_BIN),'npm');
    await run(env.PRODUCT_NODE_BIN,[npm,'ci','--prefix',project,'--offline','--ignore-scripts','--no-audit','--no-fund'],'官网测试原锁安装',project);
    env.TUYUWEB_DIST=resolve(project,'target/test/tatagate-dist');mkdirSync(dirname(env.TUYUWEB_DIST),{recursive:true});env.NPM_CLI=npm;env.platform='web';
    await run(env.PRODUCT_BASH_BIN,[resolve(project,'scripts/build-local.sh'),'web',project,env.TUYUWEB_DIST],'官网现有Build测试前置',project);
  }
  env.TATAGATE_NODE_TESTS = JSON.stringify([resolve(gateDirectory, 'test.mjs'), ...contract.node_tests.map(path => resolve(root, path))]);
  await run(process.execPath, ['--test', '--test-reporter=' + resolve(gateDirectory, 'index.mjs'),
    resolve(gateDirectory, 'test.mjs'), ...contract.node_tests.map(path => resolve(root, path))], '所属仓真实合同测试');
  await executeLanguageTests(root,work,resourceReceipt,env,run,languageView,signal);
  if (contract.checks.includes('dependency-contracts')) await checkDependencies(root, { execute, report, env });
  if (contract.checks.includes('cross-platform-contracts')) await checkCrossPlatform(root, { report });
  if (contract.checks.includes('shared-contracts')) {
    if (!isAbsolute(String(cargo || '')) || !lstatSync(cargo).isFile()) fail('链门禁缺少登记的准确Cargo');
    const cargoVersion = execute(cargo, ['--version'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    if (cargoVersion.error || cargoVersion.signal || cargoVersion.status !== 0
      || !/^cargo 1\.97\.1(?:\s|$)/u.test(cargoVersion.stdout)) fail('链门禁Cargo版本不符');
    env.PATH = dirname(cargo) + ':' + env.PATH;
    await run(cargo, ['fmt','--all','--','--check'], 'Rust格式');
    await run(cargo, ['clippy','--workspace','--all-targets','--locked','--','-D','warnings'], 'RustClippy');
    await run(cargo, ['test','--workspace','--all-targets','--locked'], 'Rust工作区测试');
  }

  assertNoProductOutputDirectories(root, contract.repository);
  if (git(root, ['status','--porcelain=v1','--untracked-files=all']) !== before) fail('门禁执行改动了所属提交源码');
  validateFunctionalCompletion(root,headSHA,work);
  return Object.freeze({ repository: contract.repository, base_sha: baseSHA, head_sha: headSHA });
}

// Npm实际安装位于独占门禁视图；根源码、原始锁与任何邻仓保持只读。
async function prepareNodeDependencyViews(root,work,env,run){
 const declaration=JSON.parse(readFileSync(resolve(root,'scripts/flows.json'),'utf8'));
 const locks=[...new Set([...Object.values(declaration.platforms).flatMap(platform=>platform.locks).filter(lock=>lock.ecosystem==='npm'&&!lock.source_package).map(lock=>lock.path),...contract.functions.filter(item=>['vitest','node-entry'].includes(item.runner)).map(item=>item.target==='.'?'package-lock.json':item.target+'/package-lock.json')])];
 if(!locks.length)return;
 const {writeFileSync,symlinkSync}=await import('node:fs'),views=[];
 for(const [index,relative]of locks.entries()){
  const packageRoot=dirname(resolve(root,relative)),view=resolve(work,'node-dependencies',String(index));mkdirSync(view,{recursive:true});
  for(const name of ['package.json','package-lock.json']){const input=resolve(packageRoot,name);if(!lstatSync(input).isFile()||lstatSync(input).isSymbolicLink())fail('本仓Node锁定输入不完整');symlinkSync(input,resolve(view,name));}
  const npm=resolve(dirname(env.PRODUCT_NODE_BIN),'npm');
  await run(env.PRODUCT_NODE_BIN,[npm,'ci','--prefix',view,'--offline','--ignore-scripts','--no-audit','--no-fund'],'本仓Node锁定依赖');
  views.push({source:pathToFileURL(packageRoot+'/').href,project:pathToFileURL(resolve(view,'package.json')).href});
 }
 const hook=resolve(work,'node-resolve.mjs');
 writeFileSync(hook,'import {registerHooks,isBuiltin} from "node:module";\nconst views='+JSON.stringify(views)+';\nregisterHooks({resolve(specifier,context,next){const view=views.filter(view=>context.parentURL?.startsWith(view.source)).sort((a,b)=>b.source.length-a.source.length)[0];if(view&&!context.parentURL.includes("/node_modules/")&&!isBuiltin(specifier)&&!/^(?:[./]|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(specifier))return next(specifier,{...context,parentURL:view.project});return next(specifier,context);}});\n',{flag:'wx'});
 env.NODE_OPTIONS='--import='+hook;
}


async function repositoryGateDispatch(args,signal) {
  const [mode, root, baseSHA, headSHA, work] = args;
  if (mode === 'physical' && args.length === 2) {
    if (realpathSync(root) !== root) fail('本仓物理根必须真实');
    assertNoProductOutputDirectories(root, contract.repository);
    return;
  }
  if (mode === 'local' && args.length === 5) {
    const resourceWork=fixedWork('test');
    validateGateRequestWork(root,work);
    const resourceReceipt=await prepareGateResources(resourceWork,{signal});
    const executionWork=resourceWork;
    return executeGate({root,baseSHA,headSHA,work:executionWork,resourceReceipt,signal,
      actionlint:resourceReceipt.environment.TATAGATE_ACTIONLINT,cargo:resourceReceipt.environment.CARGO});
  }
  if (mode === 'remote' && args.length === 1 && process.env.GITHUB_ACTIONS === 'true') {
    const root = process.env.GITHUB_WORKSPACE, headSHA = process.env.GITHUB_SHA;
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main'
      || process.env.GITHUB_WORKFLOW !== 'tatagate' || process.env.GITHUB_JOB !== 'gate'
      || event.ref !== 'refs/heads/main' || event.after !== headSHA
      || event.repository?.full_name !== contract.github_repository
      || process.env.GITHUB_REPOSITORY !== contract.github_repository || event.deleted) fail('远端push门禁身份无效');
    const resourceReceipt=await prepareGateResources(fixedWork('test'),{signal});
    Object.assign(process.env,await verifyGateResourceDelivery(resourceReceipt));
    const baseSHA = pushBaseSHA({ forced: event.forced, before: event.before, headSHA,
      parents: event.forced === true ? git(root, ['rev-list', '--parents', '-n', '1', headSHA]).trim() : undefined,
      commitCount: event.forced === true ? git(root, ['rev-list', '--count', headSHA]).trim() : undefined });
    if (baseSHA === emptyTreeSHA) git(root, ['hash-object','-w','-t','tree','/dev/null']);
    const work = resolve(resourceReceipt.work,'gate-execution');
    try { return await executeGate({ root, baseSHA, headSHA, work,
      resourceReceipt,signal,actionlint: resourceReceipt.environment.TATAGATE_ACTIONLINT, cargo: resourceReceipt.environment.CARGO }); }
    finally { if(!gateCleanupAllowed(resourceReceipt,work))fail('资源工具退出未确认，禁止清场'); }
  }
  fail('本仓塔塔门禁参数或身份无效');
}

// 取消只产生失败；长进程交由所属产品确认整个进程组退出后才允许清理。
export async function repositoryGateMain(args){
 const controller=new AbortController(),cancel=()=>controller.abort(Error('门禁取消即失败'));
 for(const name of ['SIGTERM','SIGINT'])process.once(name,cancel);
 try{const result=await (args[0]==='physical'?repositoryGateDispatch(args,controller.signal):withFixedWork('test',()=>repositoryGateDispatch(args,controller.signal)));controller.signal.throwIfAborted();return result;}
 finally{for(const name of ['SIGTERM','SIGINT'])process.removeListener(name,cancel);}
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

// 完整语言执行结果单独验收，声明了入口或零退出码不足以证明实际非空执行。
export function validateLanguageResult(kind,source){
 if(kind==='vitest'){
  const data=JSON.parse(source);if(data.success!==true||!Number.isSafeInteger(data.numTotalTests)||data.numTotalTests<=0||data.numPassedTests!==data.numTotalTests||data.numFailedTests!==0||data.numPendingTests!==0||data.numTodoTests!==0)fail('本仓Vitest测试未完整执行成功');return true;
 }
 if(kind==='flutter'){
  let done=false,passed=0;
  for(const line of source.split(/\r?\n/u)){if(!line.startsWith('{'))continue;let event;try{event=JSON.parse(line);}catch{continue;}
   if(event.type==='error')fail('本仓Flutter测试失败');
   if(event.type==='testDone'){if(event.result!=='success'||event.skipped)fail('本仓Flutter测试失败或跳过');if(!event.hidden)passed++;}
   if(event.type==='done'){if(done||event.success!==true)fail('本仓Flutter最终回执无效');done=true;}
  }if(!done||passed===0)fail('本仓Flutter缺少非空完整执行结果');return true;
 }
 if(kind==='cargo'){
  const results=[...source.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/gu)];
  if(!results.length||results.some(row=>Number(row[2])!==0||Number(row[3])!==0)||results.reduce((sum,row)=>sum+Number(row[1]),0)===0)fail('本仓Rust测试空执行或存在跳过');return true;
 }
 fail('本仓语言测试类型无效');
}

// 计划消费本仓现有原锁与公开入口，不读取其它产品的当前工作树或main。
export function ownedLanguageTests(root){
 validateFunctionalInventory(root);
 const groups=new Map();
 for(const item of contract.functions){if(['node','swift'].includes(item.runner))continue;const key=item.runner+'@'+item.target;if(groups.has(key))continue;
  const plan=item.runner==='cargo'?{kind:'cargo',manifest:item.target}:item.runner==='flutter'?{kind:'flutter',entry:contract.repository==='citizenapp'?'scripts/citizenapp-test.sh':contract.repository==='citizensdk'?'scripts/test.sh':'flutter'}
   :item.runner==='python'?{kind:'python',file:item.path}:item.runner==='node-entry'?{kind:'node-entry',project:item.target,script:'test:local-doc'}
   :{kind:'vitest',project:item.target,config:contract.repository==='citizenserve'?'scripts/ci/vitest.config.ts':null};
  groups.set(item.runner==='python'?key+'@'+item.path:key,plan);
 }
 return [...groups.values()];
}

async function executeLanguageTests(root,work,receipt,env,run,languageView,signal){
 const plans=ownedLanguageTests(root);if(!plans.length)return;
 if(!languageView)fail('本仓语言测试缺少本轮准确工程视图');
 const {view,project}=languageView;
 const originalWork=receipt.work;
 Object.assign(env,await (await import('../../scripts/resources.mjs')).prepareGateFunctionalHost(receipt,languageView,{signal,native:false}));
 const call=async(command,args,cwd,label)=>{const result=await run(command,args,label,cwd);if(!result?.stdout&&result?.stdout!=='')fail('本仓语言执行缺少真实输出');return result;};
 for(const plan of plans){
  if(plan.kind==='cargo'){
   const manifest=resolve(view,plan.manifest);if(!existsSync(manifest))fail('本仓Rust测试清单缺少原始manifest');
   const expected=contract.functions.filter(item=>item.runner==='cargo'&&item.target===plan.manifest),files=[];
   for(const name of [...new Set(expected.map(item=>item.package))]){
    const result=await call(env.CARGO,['test','--manifest-path',manifest,'-p',name,'--all-targets','--locked','--offline','--','--color','never'],view,'Rust真实包完整目标测试');
    files.push(...functionalRustCases(result.stdout,expected.filter(item=>item.package===name)));
    await call(env.CARGO,['test','--manifest-path',manifest,'-p',name,'--doc','--locked','--offline'],view,'Rust真实包文档测试');
   }
   writeFunctionalRecord(work,'cargo-'+plan.manifest.replaceAll('/','_'),root,{files});
  }else if(plan.kind==='flutter'){
   Object.assign(env,await (await import('../../scripts/resources.mjs')).prepareGateFunctionalHost(receipt,languageView,{signal}));
   env.TMPDIR=resolve(originalWork,'tmp');env.XDG_CONFIG_HOME=resolve(originalWork,'flutter-config');mkdirSync(env.XDG_CONFIG_HOME,{recursive:true});
   let result;
   if(contract.repository==='citizenapp'){
    env.CITIZENAPP_TEST_WORK_DIR=originalWork;env.CITIZENAPP_OFFLINE='true';env.CITIZENCHAIN_ROOT=resolve(originalWork,'git-sources/citizenchain');
    const zxing=receipt.inputs.archives.find(item=>item.name==='zxing-cpp');if(!zxing)fail('本仓App测试缺少已验真ZXing输入');env.CITIZENSDK_ZXING_SOURCE_DIR=zxing.path;
    // 使用产品正式测试入口；固定Git输入已由本仓资源准备，入口不读取滚动main。
    result=await call(env.PRODUCT_BASH_BIN,[resolve(root,plan.entry),'--machine'],root,'App完整Flutter测试');
   }else if(contract.repository==='citizensdk'){
    env.CITIZENSDK_TEST_WORK_DIR=originalWork;env.CITIZENSDK_OFFLINE='true';
    result=await call(env.PRODUCT_BASH_BIN,[resolve(root,plan.entry),'flutter','--machine'],root,'SDK完整Flutter测试');
   }else{
    await call(env.FLUTTER,['pub','get','--offline','--enforce-lockfile'],project,'Flutter原锁依赖解析');
    await call(env.FLUTTER,['analyze','--no-pub'],project,'Flutter实际静态检查');
    result=await call(env.FLUTTER,['test','--no-pub','--machine'],project,'Flutter完整测试');
   }
   validateLanguageResult('flutter',result.stdout);
   const expected=contract.functions.filter(item=>item.runner==='flutter');
   const files=functionalFiles('flutter',result.stdout,expected.map(item=>item.path),[root,originalWork]);
   writeFunctionalRecord(work,'flutter-flutter',root,{files});
  }else if(plan.kind==='python'){
   const python=env.PRODUCT_PYTHON_BIN;if(!isAbsolute(python||''))fail('本仓Python功能测试缺少验真工具');
   const file=resolve(view,plan.file),pythonWork=resolve(view,'target',...(['tuyufactory','tuyubooking'].includes(contract.repository)?[process.platform==='darwin'?'host-macos':'host-linux-amd']:['cloudflare']),'test');mkdirSync(pythonWork,{recursive:true});
   const script=['import importlib.util,json,pathlib,sys,unittest','file=pathlib.Path(sys.argv[1])','sys.path.insert(0,str(file.parent))','spec=importlib.util.spec_from_file_location("owned_function_tests",file)','module=importlib.util.module_from_spec(spec)','spec.loader.exec_module(module)','suite=unittest.defaultTestLoader.loadTestsFromModule(module)','result=unittest.TextTestRunner(verbosity=2).run(suite)','data={"tests":result.testsRun,"failures":len(result.failures),"errors":len(result.errors),"skipped":len(result.skipped),"expected_failures":len(result.expectedFailures),"unexpected_successes":len(result.unexpectedSuccesses)}','print("PRODUCT_FUNCTION_TEST_RESULT:"+json.dumps(data))','sys.exit(0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped and not result.expectedFailures and not result.unexpectedSuccesses else 1)'].join('\n');
   const previous={TMPDIR:env.TMPDIR,TUYUFACTORY_TEST_DIR:env.TUYUFACTORY_TEST_DIR,PYTHONDONTWRITEBYTECODE:env.PYTHONDONTWRITEBYTECODE};Object.assign(env,{TMPDIR:pythonWork,TUYUFACTORY_TEST_DIR:pythonWork,PYTHONDONTWRITEBYTECODE:'1'});
   let result;try{result=await call(python,['-c',script,file],view,'本仓Python真实功能测试');}finally{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete env[name];else env[name]=value;}}
   const rows=result.stdout.split(/\r?\n/u).filter(line=>line.startsWith('PRODUCT_FUNCTION_TEST_RESULT:'));if(rows.length!==1)fail('本仓Python功能回执不唯一');const value=JSON.parse(rows[0].slice('PRODUCT_FUNCTION_TEST_RESULT:'.length));
   if(!Number.isSafeInteger(value.tests)||value.tests<=0||['failures','errors','skipped','expected_failures','unexpected_successes'].some(name=>value[name]!==0))fail('本仓Python功能用例未完整成功');
   writeFunctionalRecord(work,'python-unittest-'+plan.file.replaceAll('/','_'),root,{files:[{path:plan.file,tests:value.tests}]});
  }else if(plan.kind==='node-entry'){
   const project=resolve(view,plan.project),npm=resolve(dirname(env.PRODUCT_NODE_BIN),'npm');
   await call(env.PRODUCT_NODE_BIN,[npm,'ci','--prefix',project,'--offline','--ignore-scripts','--no-audit','--no-fund'],project,'TypeScript原锁依赖视图');
   const result=await call(env.PRODUCT_NODE_BIN,[npm,'run',plan.script,'--prefix',project],project,'本仓公开TypeScript回归');
   const value=name=>{const rows=[...result.stdout.matchAll(new RegExp('^# '+name+' (\\d+)$','gm'))];return rows.length===1?Number(rows[0][1]):null;};
   const counts=Object.fromEntries(['tests','pass','fail','skipped','todo','cancelled'].map(name=>[name,value(name)]));if(!counts.tests||counts.pass!==counts.tests||['fail','skipped','todo','cancelled'].some(name=>counts[name]!==0))fail('本仓TypeScript测试缺少完整非空结果');
   const expected=contract.functions.filter(item=>item.runner==='node-entry'&&item.target===plan.project);
   if(expected.length!==1)fail('本仓TypeScript公开入口不能替代多个未知套件');
   writeFunctionalRecord(work,'node-entry-'+plan.project.replaceAll('/','_'),root,{files:[{path:expected[0].path,tests:counts.tests}]});
  }else if(plan.kind==='vitest'){
   const project=resolve(view,plan.project),npm=resolve(dirname(env.PRODUCT_NODE_BIN),'npm'),output=resolve(originalWork,'vitest-'+plan.project.replaceAll('/','-')+'.json');
   await call(env.PRODUCT_NODE_BIN,[npm,'ci','--prefix',project,'--offline','--ignore-scripts','--no-audit','--no-fund'],project,'Vitest原锁依赖视图');
   // 原配置的工作根归所属产品；源码视图只消费同提交输入。
   if(contract.repository==='citizenserve')env.CITIZENSERVE_TEST_WORK_DIR=resolve(project,'target/cloudflare/test');
   const args=[resolve(project,'node_modules/vitest/vitest.mjs'),'run',...(plan.config?['--config',plan.config]:[]),...(contract.repository==='citizenserve'?['--configLoader','native']:[]),'--reporter=json','--outputFile='+output];
   await call(env.PRODUCT_NODE_BIN,args,project,'Vitest完整业务测试');validateLanguageResult('vitest',readFileSync(output,'utf8'));
   const expected=contract.functions.filter(item=>item.runner==='vitest'&&item.target===plan.project);
   const files=functionalFiles('vitest',readFileSync(output,'utf8'),expected.map(item=>item.path),[view]);
   writeFunctionalRecord(work,'vitest-'+plan.project.replaceAll('/','_'),root,{files});
  }
 }
}

// 同一提交范围必须包含所属资料和真实回归变化；空白调整不能作为同步证据。
export function validateChangeEvidence(paths,documents,{changed=()=>true}={}){
 if(!Array.isArray(paths)||!Array.isArray(documents))fail('本仓资料同步清单无效');
 const implementation=paths.filter(path=>isImplementationPath(path)&&!isTestPath(path)&&!path.startsWith('.github/workflows/'));
 if(!implementation.length)return true;
 if(!documents.some(path=>paths.includes(path)&&changed(path)))fail('本仓实现变化未同步所属根技术文档');
 if(!paths.some(path=>isTestPath(path)&&changed(path)))fail('本仓实现变化缺少同步真实回归');
 return true;
}
function checkChangeEvidence(root,baseSHA,headSHA){
 const paths=git(root,['diff','--name-only','-z',baseSHA,headSHA]).split('\0').filter(Boolean);
 const changed=path=>{const now=resolve(root,path);if(!existsSync(now)||!lstatSync(now).isFile())return false;let old='';const existed=baseSHA!=='4b825dc642cb6eb9a060e54bf8d69288fbee4904'&&git(root,['ls-tree','--name-only',baseSHA,'--',path]).trim();if(existed)old=git(root,['show',baseSHA+':'+path]);return old.replace(/\s/gu,'')!==readFileSync(now,'utf8').replace(/\s/gu,'');};
 return validateChangeEvidence(paths,productDocumentNames,{changed});
}

// 功能执行映射只索引本仓真实用例；业务字段仍由正式实现定义，不在门禁复刻算法。
export function validateFunctionalContract(functions) {
  if(!Array.isArray(functions)||!functions.length)fail('本仓功能测试映射为空');
  const paths=new Set();
  for(const item of functions){
    const fields=['function','path','runner','target',...(item.runner==='cargo'?['package','cases']:item.runner==='swift'?['cases']:[])];
    exactKeys(item,fields,'本仓功能测试映射');
    if(typeof item.function!=='string'||!item.function||typeof item.path!=='string'
      ||!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(item.path)
      ||item.path.split('/').some(part=>['','.','..'].includes(part))||paths.has(item.path)
      ||typeof item.target!=='string'||!item.target||item.target!=='.'&&(!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(item.target)||item.target.split('/').some(part=>['.','..'].includes(part)))||!['node','node-entry','flutter','cargo','vitest','python','swift'].includes(item.runner))fail('本仓功能测试映射无效');
    paths.add(item.path);
    if(['cargo','swift'].includes(item.runner)&&(!Array.isArray(item.cases)||!item.cases.length
      ||item.cases.some(name=>typeof name!=='string'||!/^\w+$/u.test(name))||new Set(item.cases).size!==item.cases.length))fail('本仓功能真实用例集合无效');
    if(item.runner==='cargo'&&(!/^[A-Za-z0-9_-]+$/u.test(item.package)||!item.target.endsWith('Cargo.toml')))fail('本仓功能Rust包映射无效');
  }
  return true;
}

// 源码清单与受检提交直接回读；新增测试必须进入本仓门禁，声明本身不能证明执行成功。
export function validateFunctionalInventory(root,functions=contract.functions) {
  validateFunctionalContract(functions);
  const owned=trackedFiles(root).filter(path=>!path.startsWith('.github/')&&!functionalIgnoredPrefixes.some(prefix=>path.startsWith(prefix)));
  const expected=new Set();
  for(const path of owned){
    if(/(?:^|\/)(?:test\.mjs|[^/]+[._-](?:test|spec)\.mjs)$/u.test(path)
      ||/(?:^|\/)test\/.*_test\.dart$/u.test(path)||/[._](?:test|spec)\.tsx?$/u.test(path)
      ||/(?:^|\/)test_[^/]+\.py$/u.test(path)||path.startsWith('app/Tests/')&&path.endsWith('.swift'))expected.add(path);
    else if(path.endsWith('.rs')&&/#\[(?:test|(?:tokio|async_std)::test(?:\([^\]]*\))?|rstest)\]\s*(?:#\[[\s\S]*?\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*\(/u.test(lexicalParts(path,readFileSync(resolve(root,path),'utf8')).code))expected.add(path);
  }
  if(functions.length!==expected.size||functions.some(item=>!expected.has(item.path)))fail('本仓功能测试存在遗漏、失效或重复登记');
  for(const item of functions){
    const file=resolve(root,item.path),info=lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||!info.size||realpathSync(file)!==file)fail('本仓功能用例不是准确源码文件');
    if(item.runner==='cargo'){
      const source=lexicalParts(item.path,readFileSync(file,'utf8')).code;
      const cases=[...source.matchAll(/#\[(?:test|(?:tokio|async_std)::test(?:\([^\]]*\))?|rstest)\]\s*(?:#\[[\s\S]*?\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/gu)].map(row=>row[1]);
      if(JSON.stringify(cases)!==JSON.stringify(item.cases))fail('本仓Rust功能用例变动未同步登记');
      let directory=dirname(file),text='';while(directory.startsWith(root+'/')){const manifest=resolve(directory,'Cargo.toml');if(existsSync(manifest)){text=readFileSync(manifest,'utf8');break;}directory=dirname(directory);}if(!text&&existsSync(resolve(root,'Cargo.toml')))text=readFileSync(resolve(root,'Cargo.toml'),'utf8');
      if(!new RegExp('^name\\s*=\\s*"'+item.package+'"','m').test(text))fail('本仓Rust功能用例与所属包不符');
    }
  }
  return functions;
}

// 证据只接受本次门禁工作根中的独占普通文件；同仓同SHA绑定，不接受历史成功回执。
export function writeFunctionalRecord(work,kind,root,detail) {
  if(!isAbsolute(work)||realpathSync(work)!==work||!lstatSync(work).isDirectory())fail('本仓功能回执工作目录无效');
  exactKeys(detail,['files'],'本仓功能回执明细');
  const name=kind.replaceAll('/','_');
  if(!/^[A-Za-z0-9_.-]+$/u.test(name))fail('本仓功能回执类型无效');
  const file=resolve(work,'functions-'+name+'.json');
  const value={schema:1,repository:contract.repository,head_sha:git(root,['rev-parse','HEAD']).trim(),kind,...detail};
  const fs=process.getBuiltinModule('node:fs');fs.writeFileSync(file,JSON.stringify(value),{flag:'wx',mode:0o600});
  return value;
}
export function functionalRecord(work,kind,root,headSHA) {
  const file=resolve(work,'functions-'+kind.replaceAll('/','_')+'.json'),info=lstatSync(file,{throwIfNoEntry:false});
  if(!info?.isFile()||info.isSymbolicLink()||realpathSync(file)!==file||info.size>64*1024**2)fail('本仓功能执行回执缺失或越界');
  const value=JSON.parse(readFileSync(file,'utf8'));
  exactKeys(value,['schema','repository','head_sha','kind','files'],'本仓功能执行回执');
  if(value.schema!==1||value.repository!==contract.repository||value.head_sha!==headSHA||value.kind!==kind||git(root,['rev-parse','HEAD']).trim()!==headSHA)fail('本仓功能执行回执身份不符');
  return value;
}

// Flutter/Vitest从实际套件路径回读逐文件完成情况；零退出码、总数非空或加载事件都不足以放行。
export function functionalFiles(kind,source,expected,roots) {
  const counts=new Map(expected.map(path=>[path,0]));
  const own=path=>{
    if(typeof path!=='string')fail('本仓功能运行缺少真实套件路径');
    const actual=path.startsWith('file:')?fileURLToPath(path):path;
    if(!isAbsolute(actual)||!roots.some(root=>actual.startsWith(resolve(root)+'/')))fail('本仓功能套件来源越界');
    const matching=expected.filter(path=>actual.endsWith('/'+path));
    if(matching.length!==1)fail('本仓功能运行出现未登记或歧义套件');return matching[0];
  };
  if(kind==='vitest'){
    const value=JSON.parse(source);validateLanguageResult('vitest',source);
    if(!Array.isArray(value.testResults))fail('本仓Vitest缺少逐文件结果');
    for(const suite of value.testResults){const path=own(suite.name);
      if(counts.get(path)!==0||!Array.isArray(suite.assertionResults)||!suite.assertionResults.length||suite.assertionResults.some(test=>test.status!=='passed'))fail('本仓Vitest套件为空、重复或未成功');counts.set(path,suite.assertionResults.length);}
  }else if(kind==='flutter'){
    validateLanguageResult('flutter',source);const suites=new Map(),tests=new Map(),done=new Set();
    for(const line of source.split(/\r?\n/u)){if(!line.startsWith('{'))continue;let event;try{event=JSON.parse(line);}catch{continue;}
      if(event.type==='suite'){if(suites.has(event.suite.id))fail('本仓Flutter套件重复');suites.set(event.suite.id,event.suite.path);}
      if(event.type==='testStart'){if(tests.has(event.test.id))fail('本仓Flutter用例重复');tests.set(event.test.id,event.test);}
      if(event.type==='testDone'){const test=tests.get(event.testID);if(event.hidden||test?.hidden)continue;if(!test||done.has(event.testID))fail('本仓Flutter用例回执不完整');done.add(event.testID);const path=own(suites.get(test.suiteID));counts.set(path,counts.get(path)+1);}
    }
  }else fail('本仓功能逐文件结果类型无效');
  if(!expected.length||[...counts.values()].some(count=>count===0))fail('本仓功能用例文件漏执行');
  return [...counts].map(([path,tests])=>({path,tests}));
}
// 每次结果只绑定一个准确包；同名用例按真实出现次数核对，不能由别包的成功代替。
export function functionalRustCases(source,items) {
 validateLanguageResult('cargo',source);
 if(!items.length||new Set(items.map(item=>item.package)).size!==1)fail('本仓Rust结果须绑定一个准确包');
 const actual=new Map();for(const row of source.matchAll(/^test\s+(\S+)\s+\.\.\.\s+ok\s*$/gmu)){const name=row[1].split('::').at(-1);actual.set(name,(actual.get(name)||0)+1);}
 const required=new Map();for(const item of items)for(const name of item.cases)required.set(name,(required.get(name)||0)+1);
 if([...required].some(([name,count])=>(actual.get(name)||0)<count))fail('本仓Rust功能用例漏执行');
 return items.map(item=>({path:item.path,cases:item.cases}));
}

export function validateFunctionalCompletion(root,headSHA,work) {
 const groups=new Map();for(const item of contract.functions){const key=item.runner==='node'?'node':item.runner+'-'+item.target.replaceAll('/','_')+(item.runner==='python'?'-'+item.path.replaceAll('/','_'):'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 for(const [key,items]of groups){const result=functionalRecord(work,key,root,headSHA);
  if(!Array.isArray(result.files)||new Set(result.files.map(file=>file.path)).size!==result.files.length)fail('本仓功能文件结果为空或重复');
  if(key==='node'){
   const expected=[resolve(root,'.github/tatagate/test.mjs'),...items.map(item=>resolve(root,item.path))];
   if(result.files.length!==expected.length||result.files.some(file=>!expected.includes(file.path)||!successfulTestSummary({success:true,counts:file.counts})))fail('本仓功能Node文件漏执行或不完整');
  }else if(result.files.length!==items.length||items.some(item=>!result.files.some(file=>file.path===item.path&&(Number.isSafeInteger(file.tests)&&file.tests>0||Array.isArray(file.cases)&&JSON.stringify(file.cases)===JSON.stringify(item.cases)))))fail('本仓功能缺少真实逐项完成证据');
 }
 return true;
}

// 保留固定调用参数，只验真调用方协调目录；产品测试不向该目录写入临时状态。
export function validateGateRequestWork(root,work){
 if(root!==resolve(import.meta.dirname,'../..')||work!==fixedWork('test'))fail('本仓门禁只接受本产品target/test固定目录');
 return checkFixedWork(work);
}
