// Credentials are generated at runtime, never embedded in source or CLI arguments.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createPasswordVerifier,verifyPassword} from '../cloud/password-verifier.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'cloud-private/login-credentials.json');
const action=process.argv[2];
if(!['generate','set','upload'].includes(action))throw new Error('用法：cloud-password-setup.mjs generate、set（从标准输入读取密码）或 upload [--include-local-ai]');
const config=JSON.parse(await readFile(path.join(root,'wrangler.local.jsonc'),'utf8'));
if(config.vars?.AUTH_MODE!=='password')throw new Error('请先选择 password 登录方式');
const origin=config.vars.APP_ORIGIN;
if(!origin || new URL(origin).protocol!=='https:')throw new Error('缺少 HTTPS 网站地址');
if(action==='generate'||action==='set'){
  await mkdir(path.dirname(target),{recursive:true});
  let password=randomBytes(32).toString('base64url');
  if(action==='set'){
    // Pipe input instead of putting passwords in a shell argument or command history.
    if(process.stdin.isTTY)throw new Error('请通过标准输入传入密码，避免终端回显。');
    console.log('等待标准输入中的新密码；不会回显。');
    const input=createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
    password='';
    for await(const line of input){password=line;input.close();break;}
    process.stdin.pause();
    if(password.length<8||password.length>128)throw new Error('密码长度应为 8 至 128 个字符');
  }
  const credentials={url:origin,password,passwordVerifier:await createPasswordVerifier(password),sessionSecret:randomBytes(32).toString('base64url'),createdAt:new Date().toISOString()};
  if(action==='set'){
    await copyFile(target,path.join(root,`cloud-private/login-credentials-before-${Date.now()}.json`));
  }
  const flag=action==='set'?'w':'wx';
  await writeFile(target,JSON.stringify(credentials,null,2)+'\n',{flag,mode:0o600});
  await writeFile(path.join(root,'cloud-private/网站登录密码.txt'),`行迹在线版\n网址：${origin}\n登录只需输入以下专属密码（请保密）：\n${credentials.password}\n\n请将密码保存至密码管理器；不要把本文件发送给他人。\n`,{flag,mode:0o600});
  console.log('本机登录密码文件已更新；运行 upload 后在线密码才会生效。');
}else{
  const credentials=JSON.parse(await readFile(target,'utf8'));
  if(credentials.url!==origin || typeof credentials.password!=='string' || credentials.password.length<8 || credentials.password.length>128 || !/^[A-Za-z0-9_-]{43}$/.test(credentials.sessionSecret))throw new Error('本地凭据不匹配');
  const verifier=credentials.passwordVerifier || (/^[A-Za-z0-9_-]{43}$/.test(credentials.password)?createHash('sha256').update(credentials.password).digest('hex'):null);
  if(!verifier || !await verifyPassword(credentials.password,verifier))throw new Error('密码验证信息不匹配');
  const secrets={LOGIN_PASSWORD_HASH:verifier,SESSION_SECRET:credentials.sessionSecret};
  if(process.argv.includes('--include-local-ai')){
    const local=JSON.parse(await readFile(path.join(root,'data/config.json'),'utf8'));
    if(typeof local.apiKey==='string' && local.apiKey.trim())secrets.AI_API_KEY=local.apiKey.trim();
    else throw new Error('本地未配置 API Key，未上传任何 Secrets');
  }
  const child=spawn(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'secret','bulk','--config','wrangler.local.jsonc'],{cwd:root,stdio:['pipe','inherit','inherit'],windowsHide:true});
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(secrets));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(code!==0)throw new Error('Secrets 上传未完成，本地凭据保留以供重试');
  console.log('登录验证信息已上传至 Cloudflare Secrets；密码原文未上传。');
}
