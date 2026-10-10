#!/usr/bin/env node
// 塔塔门禁只读检查本仓源码、声明和流程边界；不准备资源、不运行产品流程。
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const product='tuyuweb';
const fail=message=>{throw Error('途遇官网门禁：'+message);};
const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:1024*1024}).trim();
function ordinary(relative){
 const path=join(root,relative),value=lstatSync(path);
 if(!value.isFile()||value.isSymbolicLink()||!value.size||realpathSync(path)!==path)fail('源码文件不是非空普通原件：'+relative);
 return readFileSync(path,'utf8');
}
function exactDirectory(relative,names){
 const path=join(root,relative),value=lstatSync(path);
 if(!value.isDirectory()||value.isSymbolicLink()||realpathSync(path)!==path)fail('目录身份无效：'+relative);
 if(JSON.stringify(readdirSync(path).sort())!==JSON.stringify([...names].sort()))fail('目录文件集合不符：'+relative);
}
function syntax(relative){
 const result=spawnSync(process.execPath,['--check',join(root,relative)],{encoding:'utf8',maxBuffer:1024*1024});
 if(result.status!==0||result.signal)fail('Node语法无效：'+relative);
}
// 本仓只读扫描自有源码；上游原件与测试夹具不成为第一方网络规则例外。
function checkPublicSource(){
 const forbidden=Buffer.from('f09f87a8f09f87b3','hex');
 for(const name of git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean)){
  if(name.split('/').some(part=>!part||part==='.'||part==='..'))fail('受检路径越界');
  const path=join(root,name);if(!existsSync(path))continue;
  const info=lstatSync(path);
  if(info.isSymbolicLink()){if(name.startsWith('upstream/'))continue;fail('第一方受检文件经过链接：'+name);}
  if(!info.isFile())continue;
  const bytes=readFileSync(path);if(bytes.includes(forbidden))fail('文件含禁用字符：'+name);
  if(name.startsWith('upstream/')||name.startsWith('imported/')||bytes.includes(0))continue;
  const source=bytes.toString('utf8');
  if(/AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}/u.test(source)
   ||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]{32,})/u.test(source))fail('文件疑似含机密：'+name);
  if((name.startsWith('scripts/')||name.startsWith('.github/workflows/'))&&/\.(?:mjs|js|sh|yml)$/u.test(name)){
   for(const match of source.matchAll(/(?:http|ws):\/\/[^\s'"]+/gu))
    if(!/\.invalid(?:[/?#]|$)/u.test(match[0]))fail('第一方脚本含明文网络地址：'+name);
  }
 }
}
export function checkRepository(){
 if(realpathSync(root)!==root||git(['rev-parse','--show-toplevel'])!==root||git(['branch','--show-current'])!=='main'
   ||git(['remote','get-url','origin'])!=='https://github.com/tuyutata/tuyuweb.git')fail('正式主检出或HTTPS来源不符');
 const declaration=JSON.parse(ordinary('.github/tatagate/tatagate.json'));
 if(declaration.schema!==1||declaration.repository!==product||declaration.github_repository!=='tuyutata/tuyuweb'
   ||JSON.stringify(declaration.checks)!==JSON.stringify(['repository-contracts','flow-isolation','syntax']))fail('本仓门禁声明无效');
 if(!Array.isArray(declaration.workflows)||!declaration.workflows.length
   ||new Set(declaration.workflows).size!==declaration.workflows.length
   ||declaration.workflows.some(name=>typeof name!=='string'||!/^release-[a-z0-9-]+\.yml$/u.test(name)))fail('本仓自动化声明无效');
 exactDirectory('scripts',['build.mjs','publish.mjs']);
 exactDirectory('.github/workflows',declaration.workflows.flatMap(name=>[name,name.slice(0,-4)+'.mjs']));
 exactDirectory('.github/tatagate',['tatagate.json','tatagate.mjs']);
 const build=ordinary('scripts/build.mjs'),publish=ordinary('scripts/publish.mjs');
 ordinary('TuyuWeb.md');ordinary('README.md');ordinary('package.json');ordinary('package-lock.json');
 if(/(?:from|import\()\s*['"][^'"]*(?:publish\.mjs|\.github\/workflows|tatagate)/u.test(build))fail('Build调用其它流程');
 if(/(?:from|import\()\s*['"][^'"]*(?:build\.mjs|\.github\/workflows|tatagate)/u.test(publish))fail('Publish调用其它流程');
 for(const name of declaration.workflows){
  const entry='.github/workflows/'+name.slice(0,-4)+'.mjs',workflow=ordinary(entry),yaml=ordinary('.github/workflows/'+name);
  if(!yaml.includes('workflow_dispatch:')||/^\s*push\s*:/mu.test(yaml))fail('自动化只允许显式派发');
  if(/scripts\/(?:build|publish|resources|target)\.mjs|scripts\/flows\.json|\.github\/tatagate/u.test(workflow+yaml))fail('自动化调用其它流程或旧脚本');
  syntax(entry);
 }
 checkPublicSource();
 for(const path of ['scripts/build.mjs','scripts/publish.mjs','.github/tatagate/tatagate.mjs'])syntax(path);
 return {schema:1,product_id:product,checks:declaration.checks,status:'passed'};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{if(process.argv.length!==3||process.argv[2]!=='check')fail('用法：tatagate.mjs check');process.stdout.write(JSON.stringify(checkRepository())+'\n');}
 catch(error){process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;}
}
