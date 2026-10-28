#!/usr/bin/env node
// 本产品 Publish 只读验真正式 GitHub Release；不执行上传、部署、商店交易或编译。
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const product="tuyuweb";
const repository="tuyutata/tuyuweb";
const assets=Object.freeze({"web":"tuyuweb.tgz"});
const digestPattern=/^[a-f0-9]{64}$/u;
const shaPattern=/^[a-f0-9]{40}$/u;
const fail=message=>{throw Error(product+' Publish：'+message);};

function ordinary(directory,name,limit){
 if(name!==basename(name)||name==='.'||name==='..')fail('发布资产文件名无效');
 const path=join(directory,name),status=lstatSync(path);
 if(!status.isFile()||status.isSymbolicLink()||status.nlink!==1||status.size<1||status.size>limit||realpathSync(path)!==path)fail('发布资产不是准确普通文件：'+name);
 return {path,size:status.size};
}
function manifestInput(path){
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value))fail('正式清单结构无效');
 return value;
}
async function sha256(path){
 const hash=createHash('sha256');
 for await(const piece of createReadStream(path))hash.update(piece);
 return hash.digest('hex');
}
async function github(path){
 const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
 if(token&&/[\s\u0000-\u001f\u007f]/u.test(token))fail('GitHub只读令牌无效');
 const response=await fetch('https://api.github.com/repos/'+repository+'/'+path,{
  headers:{Accept:'application/vnd.github+json','User-Agent':product,...(token?{Authorization:'Bearer '+token}:{})},
  redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)fail('GitHub正式记录读取失败：'+response.status);
 const bytes=await response.arrayBuffer();if(bytes.byteLength>2*1024*1024)fail('GitHub正式记录超限');
 return JSON.parse(Buffer.from(bytes).toString('utf8'));
}
function coordinate(platform,tag){
 if(!Object.hasOwn(assets,platform))fail('发布平台未声明');
 const prefix=product+'-'+platform+'-v';
 if(typeof tag!=='string'||!tag.startsWith(prefix))fail('正式Tag不属于本产品平台');
 const value=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-r([1-9]\d*)-a([1-9]\d*)$/u.exec(tag.slice(prefix.length));
 if(!value)fail('正式Tag版本与运行坐标无效');
 const run=Number(value[4]),attempt=Number(value[5]);
 if(!Number.isSafeInteger(run)||!Number.isSafeInteger(attempt))fail('正式运行坐标越界');
 return {version:value.slice(1,4).join('.'),run,attempt};
}
function releaseNames(asset){return [asset,'release-manifest.json','SHA256SUMS'];}
function canonicalDirectory(directory){
 if(typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)!==directory)fail('正式资产目录必须是规范绝对路径');
 const status=lstatSync(directory);
 if(!status.isDirectory()||status.isSymbolicLink()||realpathSync(directory)!==directory)fail('正式资产目录身份无效');
 return directory;
}
async function latestTag(platform,tag){
 const prefix=product+'-'+platform+'-v';
 let selected=null;
 for(let page=1;page<=100;page++){
  const rows=await github('releases?per_page=100&page='+page);
  if(!Array.isArray(rows))fail('GitHub Release分页结构无效');
  for(const row of rows){
   if(row.draft||row.prerelease||typeof row.tag_name!=='string'||!row.tag_name.startsWith(prefix))continue;
   const current=coordinate(platform,row.tag_name);
   const order=[...current.version.split('.').map(Number),current.run,current.attempt];
   if(!selected||order.some((number,index)=>number!==selected.order[index]&&order.slice(0,index).every((earlier,i)=>earlier===selected.order[i])&&number>selected.order[index]))selected={tag:row.tag_name,order};
  }
  if(rows.length<100)break;
  if(page===100)fail('GitHub Release列表超过验真上限');
 }
 if(selected?.tag!==tag)fail('所选Tag不是本平台最新正式Release');
}

export async function verifyRelease({platform,tag,directory}){
 const point=coordinate(platform,tag),asset=assets[platform],root=canonicalDirectory(directory),names=releaseNames(asset);
 const actual=readdirSync(root).sort();if(JSON.stringify(actual)!==JSON.stringify([...names].sort()))fail('正式资产集合不匹配');
 const input=Object.fromEntries(names.map(name=>[name,ordinary(root,name,name===asset?8*1024**3:1024*1024)]));
 const manifest=manifestInput(input['release-manifest.json'].path);
 if(manifest.product_id!==product||manifest.platform!==platform||manifest.software_version!==point.version
   ||manifest.producer_run_id!==point.run||manifest.producer_run_attempt!==point.attempt
   ||!shaPattern.test(manifest.git_commit_sha||'')
   ||!Array.isArray(manifest.assets)||manifest.assets.length!==1||manifest.assets[0]?.name!==asset
   ||!digestPattern.test(manifest.assets[0]?.sha256||''))fail('正式清单身份或资产声明不符');
 const sums=readFileSync(input.SHA256SUMS.path,'utf8');
 const records=sums.trimEnd().split('\n').map(line=>/^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line));
 if(records.length!==2||records.some(value=>!value)||records[0][2]!==asset||records[1][2]!=='release-manifest.json')fail('SHA256SUMS集合或格式无效');
 const assetHash=await sha256(input[asset].path),manifestHash=await sha256(input['release-manifest.json'].path);
 if(records[0][1]!==assetHash||records[1][1]!==manifestHash||manifest.assets[0].sha256!==assetHash)fail('本地正式资产摘要不一致');
 const release=await github('releases/tags/'+encodeURIComponent(tag));
 if(release.tag_name!==tag||release.draft||release.prerelease||!Array.isArray(release.assets)||release.assets.length!==3)fail('GitHub正式Release身份无效');
 const remote=Object.fromEntries(release.assets.map(item=>[item.name,item]));
 if(JSON.stringify(Object.keys(remote).sort())!==JSON.stringify([...names].sort()))fail('GitHub正式资产集合不符');
 for(const name of names){const hash=name===asset?assetHash:name==='release-manifest.json'?manifestHash:await sha256(input.SHA256SUMS.path);
  if(remote[name]?.digest!=='sha256:'+hash||remote[name]?.size!==input[name].size||remote[name]?.state!=='uploaded')fail('GitHub资产摘要、尺寸或状态不符：'+name);}
 const ref=await github('git/ref/tags/'+encodeURIComponent(tag));
 if(ref.ref!=='refs/tags/'+tag||ref.object?.type!=='commit'||ref.object.sha!==manifest.git_commit_sha)fail('Tag与源码提交不符');
 const run=await github('actions/runs/'+point.run);
 if(run.id!==point.run||run.run_attempt!==point.attempt||run.status!=='completed'||run.conclusion!=='success'
    ||run.head_sha!==manifest.git_commit_sha||run.path!=='.github/workflows/web.yml')fail('正式构建运行身份或结果不符');
 await latestTag(platform,tag);
 return {schema:1,product_id:product,platform,tag,source_sha:manifest.git_commit_sha,asset,sha256:assetHash,verified:true};
}

const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct&&!process.env.NODE_TEST_CONTEXT){
 void (async()=>{
  const args=process.argv.slice(2);if(args.length!==7||args[0]!=='verify'||args[1]!=='--platform'||args[3]!=='--tag'||args[5]!=='--directory')fail('用法：publish.mjs verify --platform 平台 --tag 正式Tag --directory 绝对资产目录');
  process.stdout.write(JSON.stringify(await verifyRelease({platform:args[2],tag:args[4],directory:args[6]}))+'\n');
 })().catch(error=>{process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;});
}

// 同文件测试仅模拟GitHub读取，绝不上传、部署或访问正式发布记录。
if(process.env.NODE_TEST_CONTEXT && process.argv.length===2 && direct){
 const {test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync}=await import('node:fs');
 const {testRoot}=await import('./build.mjs');
 function fixture(t,platform){
  const directory=mkdtempSync(join(realpathSync(testRoot()),product+'-publish-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const tag=product+'-'+platform+'-v1.2.3-r17-a2',asset=assets[platform],commit='a'.repeat(40);
  writeFileSync(join(directory,asset),'public fixture candidate');
  const hash=name=>createHash('sha256').update(readFileSync(join(directory,name))).digest('hex');
  const manifest={product_id:product,platform,software_version:'1.2.3',producer_run_id:17,producer_run_attempt:2,
   git_commit_sha:commit,assets:[{name:asset,sha256:hash(asset)}]};
  writeFileSync(join(directory,'release-manifest.json'),JSON.stringify(manifest));
  writeFileSync(join(directory,'SHA256SUMS'),hash(asset)+'  '+asset+'\n'+hash('release-manifest.json')+'  release-manifest.json\n');
  const names=releaseNames(asset),release={tag_name:tag,draft:false,prerelease:false,
   assets:names.map(name=>({name,digest:'sha256:'+hash(name),size:lstatSync(join(directory,name)).size,state:'uploaded'}))};
  const ref={ref:'refs/tags/'+tag,object:{type:'commit',sha:commit}};
  const path=product==='tuyuweb'?'web.yml':({cloudflare:'cloudflare.yml','linux-arm':'linuxarm.yml'})[platform];
  const run={id:17,run_attempt:2,status:'completed',conclusion:'success',head_sha:commit,path:'.github/workflows/'+path};
  let releases=[release],calls=0;
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,options)=>{
   calls++;assert.equal(options.redirect,'error');assert.ok(!options.method||options.method==='GET');
   const prefix='https://api.github.com/repos/'+repository+'/';assert.ok(url.startsWith(prefix));
   const route=url.slice(prefix.length);
   const body=route.startsWith('releases/tags/')?release:route.startsWith('git/ref/tags/')?ref:
    route==='actions/runs/17'?run:route==='releases?per_page=100&page=1'?releases:undefined;
   assert.notEqual(body,undefined,'unexpected network route');return Response.json(body);
  };
  return {directory,tag,asset,release,ref,run,request:{directory,tag,platform},
   later:()=>{releases=[...releases,{...release,tag_name:product+'-'+platform+'-v1.2.4-r18-a1'}];},calls:()=>calls};
 }
 for(const platform of Object.keys(assets)){
  test('正式发布校验完整通过：'+platform,async t=>{
   const f=fixture(t,platform),result=await verifyRelease(f.request);assert.equal(result.verified,true);
   assert.equal(result.product_id,product);assert.equal(result.platform,platform);assert.equal(f.calls(),4);
  });
  for(const [kind,expected]of [['digest',/摘要不一致/u],['commit',/Tag与源码提交不符/u],['run',/运行身份或结果不符/u],['latest',/不是本平台最新/u],['extra',/资产集合不匹配/u],['link',/准确普通文件/u]]){
   test('正式发布拒绝'+kind+'：'+platform,async t=>{
    const f=fixture(t,platform);
    if(kind==='digest')writeFileSync(join(f.directory,f.asset),'changed');
    if(kind==='commit')f.ref.object.sha='b'.repeat(40);
    if(kind==='run')f.run.run_attempt=3;
    if(kind==='latest')f.later();
    if(kind==='extra')writeFileSync(join(f.directory,'extra'),'unexpected');
    if(kind==='link'){rmSync(join(f.directory,f.asset));symlinkSync('release-manifest.json',join(f.directory,f.asset));}
    await assert.rejects(verifyRelease(f.request),expected);
    if(['digest','extra','link'].includes(kind))assert.equal(f.calls(),0);
   });
  }
 }
 test('发布坐标错误在任何网络读取前拒绝',async()=>{
  assert.throws(()=>coordinate('unknown','bad'),/平台未声明/u);
  const platform=Object.keys(assets)[0];
  for(const tag of ['other-v1.0.0',product+'-'+platform+'-v01.0.0-r1-a1',product+'-'+platform+'-v1.0.0-r0-a1'])
   await assert.rejects(verifyRelease({platform,tag,directory:'/missing'}),/Tag|坐标/u);
 });
}
