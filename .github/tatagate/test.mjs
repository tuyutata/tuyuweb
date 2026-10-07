import assert from 'node:assert/strict';
import test from 'node:test';
import { gateContract, validateWorkflowSource, validateVectorGroup, validatePalletRegistry, readPublicChain } from './index.mjs';

// 本仓登记必须准确闭合；路径、重复和未知工具版本不得被默默接受。
test('本仓门禁登记拒绝漂移和重复', () => {
  const contract = structuredClone(gateContract());
  assert.equal(gateContract(contract), contract);
  for (const change of [
    value => { value.schema = 2; },
    value => { value.node_tests.push(value.node_tests[0]); },
    value => { value.node_tests = ['../outside.test.mjs']; },
    value => { value.tools.node = '0.0.0'; },
    value => { value.checks.push('undeclared'); },
    value => { value.workflows.push('other.ios.ci'); },
  ]) {
    const value = structuredClone(contract); change(value);
    assert.throws(() => gateContract(value));
  }
});
test('产品CI与Release仍只接受自己的三维手动入口', () => {
  const { repository } = gateContract();
  const id = repository + '.macos.ci';
  const workflow = 'name: ' + id + '\non:\n  workflow_dispatch:\nconcurrency:\n  group: ' + id
    + '\njobs:\n  flow:\n    steps:\n      - run: allowed=new Set(["' + id + '"])\n';
  assert.equal(validateWorkflowSource(workflow,repository+'-macos-ci.yml'),id);
  for (const invalid of [workflow.replace(repository+'.','other.'),workflow.replace('workflow_dispatch','push'),
    workflow.replace('group: '+id,'group: other'),workflow.replace('  flow:','  other:')]) {
    assert.throws(()=>validateWorkflowSource(invalid,repository+'-macos-ci.yml'));
  }
});
const group={ keys:['name'],values:['hex'],top:['domain'],complete:true };
const vectors={domain:'GMB',vectors:[{name:'a',hex:'AB'},{name:'b',hex:'CD'}]};
test('金标按语义键归一比较并阻断重复、缺项和漂移', () => {
  assert.equal(validateVectorGroup(vectors,{...vectors,vectors:[{name:'b',hex:'cd'},{name:'a',hex:'ab'}]},group),2);
  for (const mirror of [
    {...vectors,domain:'other'}, {...vectors,vectors:[vectors.vectors[0]]},
    {...vectors,vectors:[vectors.vectors[0],vectors.vectors[0]]},
    {...vectors,vectors:[{name:'a',hex:'EE'},vectors.vectors[1]]},
    {...vectors,vectors:[{name:'a'},vectors.vectors[1]]},
    {...vectors,vectors:[]},
  ]) assert.throws(()=>validateVectorGroup(vectors,mirror,group));
  assert.equal(validateVectorGroup(vectors,{...vectors,vectors:[vectors.vectors[0]]},{...group,complete:false}),1);
});
test('Pallet不得错指、为空或重复',()=>{
  const chain='#[runtime::pallet_index(1)]\n pub type Balances = PalletBalances;\n';
  assert.equal(validatePalletRegistry(chain,'static const int balancesPallet = 1;'),1);
  for (const dart of ['', 'static const int balancesPallet = 2;', 'static const int otherPallet = 1;',
    'static const int balancesPallet = 1;\nstatic const int balancesPallet = 1;']) {
    assert.throws(()=>validatePalletRegistry(chain,dart));
  }
  assert.throws(()=>validatePalletRegistry(chain+chain));
});
test('公开链真源只读准确SHA，拒绝网络、重定向、超限及伪造坐标',async()=>{
  const sha='a'.repeat(40);
  const reference={ref:'refs/heads/main',object:{type:'commit',sha,url:'https://api.github.com/repos/crcfrcn/citizenchain/git/commits/'+sha}};
  assert.equal(await readPublicChain(null,null,async(url,options)=>{
    assert.equal(url,'https://api.github.com/repos/crcfrcn/citizenchain/git/ref/heads/main');
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
    assert.equal(options.headers.Authorization,undefined);
    return new Response(JSON.stringify(reference));
  }),sha);
  assert.equal(await readPublicChain('runtime/src/lib.rs',sha,async()=>new Response('source')),'source');
  for (const request of [
    async()=>{throw new Error('private response forbidden');},
    async()=>new Response('',{status:302}), async()=>new Response('',{status:404}),
    async()=>new Response(Buffer.alloc(2*1024*1024+1)),
    async()=>new Response(new Uint8Array([255])),
  ]) await assert.rejects(readPublicChain('runtime/src/lib.rs',sha,request),/准确提交真源读取失败/u);
  for (const value of [
    {...reference,ref:'refs/heads/other'}, {...reference,object:{...reference.object,sha:'main'}},
    {...reference,object:{...reference.object,type:'tag'}},
    {...reference,object:{...reference.object,url:'https://example.org/commit'}},
  ]) await assert.rejects(readPublicChain(null,null,async()=>new Response(JSON.stringify(value))));
  await assert.rejects(readPublicChain('../private',sha,()=>assert.fail('非法路径禁止联网')));
});

// 用隔离的合成Git提交验证门禁读取真实初始内容；不修改产品仓或调用仓库保存/推送。
test('保留源码不按每文件汉字数量判定，真实第一方临时注释仍拒绝', async () => {
  const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { join }, { testRoot: tmpdir }, { execFileSync }, { validateQuality }] = await Promise.all([
    import('node:fs'), import('node:path'), import('../../scripts/build.mjs'), import('node:child_process'), import('./index.mjs'),
  ]);
  const root = mkdtempSync(join(tmpdir(), 'tatagate-quality-'));
  const env = { HOME: process.env.HOME, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--quiet', '--initial-branch=main');
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'example.test.mjs'), 'export const fixture = true;\n');
    const base = git('hash-object', '-w', '-t', 'tree', '/dev/null');
    for (const [source, rejected] of [
      ['export const value = 1;\n', false],
      ['// Retained implementation explanation.\nexport const value = 1;\n', false],
      ['// Generated file; do not edit.\nexport const value = 1;\n', false],
      ['// HACK: unfinished first-party implementation.\nexport const value = 1;\n', true],
    ]) {
      writeFileSync(join(root, 'source.mjs'), source);
      git('add', '--all');
      const head = git('commit-tree', git('write-tree'), '-m', 'synthetic quality input');
      git('update-ref', 'refs/heads/main', head);
      const run = () => validateQuality(root, base, head, gateContract().repository);
      if (rejected) await assert.rejects(run(), /第一方|产品实现代码保留临时注释/u);
      else await assert.doesNotReject(run());
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 推送只检查本仓提交合同；编译产物和平台服务测试仍由原产品流程实际调用。
test('编译及平台服务验收保持所属产品流程，仓库门禁不借用生成状态', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const read = path => readFileSync(new URL(path, root), 'utf8');
  const excluded = ["tests/release-candidate.test.mjs", "tests/sites-worker.test.mjs"];
  for (const path of excluded) {
    assert.ok(read(path).length > 0);
    assert.ok(!gateContract().node_tests.includes(path));
  }
  const source = read('scripts/ci/web/execute.mjs');
  for (const script of ['test:contracts', 'test:sites', 'test:release']) assert.ok(source.includes(script));
  const packageSource = read('package.json');
  for (const path of excluded) assert.ok(packageSource.includes(path));
});

// 准确坐标、首次提交、唯一无父根和带父覆盖分别验证，防止历史清理扩大强推范围。
test('历史清理仅接受唯一无父新根并完整检查全部内容', async () => {
  const { pushBaseSHA } = await import('./index.mjs');
  const headSHA = 'a'.repeat(40), before = 'b'.repeat(40), empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const reset = { forced: true, before, headSHA, parents: headSHA, commitCount: '1' };
  assert.equal(pushBaseSHA({ forced: false, before, headSHA }), before);
  assert.equal(pushBaseSHA({ forced: false, before: '0'.repeat(40), headSHA }), empty);
  assert.equal(pushBaseSHA(reset), empty);
  for (const invalid of [
    { ...reset, parents: headSHA + ' ' + before }, { ...reset, commitCount: '2' },
    { ...reset, parents: '' }, { ...reset, forced: 'true' },
    { ...reset, before: 'main' }, { ...reset, headSHA: 'main' },
    { ...reset, headSHA: '0'.repeat(40) }, { ...reset, before: '0'.repeat(40) },
  ]) assert.throws(() => pushBaseSHA(invalid));
});

// 本仓target是唯一源码内生成边界；嵌套或链接旁路仍必须拒绝。
test('产品门禁允许自有根target并拒绝嵌套与链接输出', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { testRoot } = await import('../../scripts/build.mjs');
  const { assertNoProductOutputDirectories, gateContract } = await import('./index.mjs');
  const fixture = mkdtempSync(join(testRoot(), 'target-boundary-'));
  const root = join(fixture, 'source'), target = join(root, 'target');
  mkdirSync(root);
  try {
    mkdirSync(join(target, 'test', 'build'), { recursive: true });
    writeFileSync(join(target, 'test', 'build', 'generated.txt'), 'generated fixture');
    assert.doesNotThrow(() => assertNoProductOutputDirectories(root, gateContract().repository));
    const nested = join(root, 'source', 'target');
    mkdirSync(nested, { recursive: true });
    assert.throws(() => assertNoProductOutputDirectories(root, gateContract().repository), /生成状态目录/u);
    rmSync(join(root, 'source'), { recursive: true });
    rmSync(target, { recursive: true });
    const outside = join(fixture, 'outside'); mkdirSync(outside);
    symlinkSync(outside, target, 'dir');
    assert.throws(() => assertNoProductOutputDirectories(root, gateContract().repository), /生成状态目录/u);
    rmSync(target);
    writeFileSync(target, 'ordinary file');
    assert.throws(() => assertNoProductOutputDirectories(root, gateContract().repository), /生成状态目录/u);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

// 所属根文档验收只读本仓，负向夹具在本产品target内，不借其它仓库资料。
test('所属根技术文档拒绝缺失、空文件、链接、副本与错误文件类型', async () => {
  const { validateProductDocuments } = await import('./index.mjs');
  const { mkdtempSync, writeFileSync, unlinkSync, symlinkSync, mkdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { testRoot } = await import('../../scripts/build.mjs');
  const root = mkdtempSync(join(testRoot(), 'product-documents-'));
  const names = ["TuyuWeb.md"];
  try {
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    for (const name of names) writeFileSync(join(root, name), '产品技术文档\n');
    writeFileSync(join(root, 'README.md'), '产品简介\n');
    assert.equal(validateProductDocuments(root), true);
    const file = join(root, names[0]);
    writeFileSync(file, '');
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    unlinkSync(file); symlinkSync(join(root, 'README.md'), file);
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    unlinkSync(file); mkdirSync(file);
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    rmSync(file, { recursive: true }); writeFileSync(file, '产品技术文档\n');
    writeFileSync(join(root, 'Extra.md'), '第二技术文档\n');
    assert.throws(() => validateProductDocuments(root), /额外技术文档/u);
    unlinkSync(join(root, 'Extra.md'));
    const readme = join(root, 'README.md'); unlinkSync(readme); symlinkSync(file, readme);
    assert.throws(() => validateProductDocuments(root), /非空普通原件/u);
    unlinkSync(readme); writeFileSync(readme, '产品简介\n');
    assert.equal(validateProductDocuments(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 文档迁出后保留同等资料扫描，测试只使用合成材料。
test('根技术文档机密扫描保留正文、令牌和转义快照拒绝', async () => {
  const { hasSecretMaterial } = await import('./index.mjs');
  const header = type => '-----BEGIN ' + type + 'PRIVATE KEY-----';
  const footer = type => '-----END ' + type + 'PRIVATE KEY-----';
  for (const type of ['', 'RSA ', 'EC ', 'OPENSSH ']) {
    const begin = header(type), end = footer(type);
    assert.equal(hasSecretMaterial('识别格式 ' + JSON.stringify(begin)), false);
    assert.equal(hasSecretMaterial(begin + '\\n\\(fixtureData.base64EncodedString())\\n' + end), false);
    const shaped = begin + '\n' + 'A'.repeat(96) + '\n' + end;
    assert.equal(hasSecretMaterial(shaped), true);
    assert.equal(hasSecretMaterial(shaped.replaceAll('\n', '\\n')), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ original: shaped })), true);
    const escaped = JSON.stringify({ original: shaped }).replace('BEGIN', '\\u0042EGIN');
    assert.equal(hasSecretMaterial(escaped), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ original: JSON.stringify(shaped).replace('BEGIN', '\\u0042EGIN') })), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ [shaped]: '合成键名' }).replace('BEGIN', '\\u0042EGIN')), true);
    const snapshot = '<!-- PATCH_DATA\n' + escaped + '\nPATCH_DATA -->';
    assert.equal(hasSecretMaterial(snapshot), true);
    assert.equal(hasSecretMaterial(begin + '\n' + 'A'.repeat(32)), true);
  }
  for (const [prefix, length] of [['AKIA', 16], ['github_pat_', 20], ['ghp_', 30], ['sk_live_', 16]]) {
    assert.equal(hasSecretMaterial(prefix + 'A'.repeat(length)), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ example: prefix + 'A'.repeat(length) })), true);
  }
  assert.equal(hasSecretMaterial('格式说明，没有凭据正文'), false);
  assert.equal(hasSecretMaterial(header('') + '\nfixture-only\n' + footer('')), false);
  assert.throws(() => hasSecretMaterial('<!-- PATCH_DATA\n{}'), /快照结构/u);
  assert.throws(() => hasSecretMaterial('<!-- PATCH_DATA\ninvalid\nPATCH_DATA -->'), /快照结构/u);
  assert.throws(() => hasSecretMaterial(null), /输入必须/u);
});
