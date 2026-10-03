import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'wrangler.local.jsonc');
const fields={'database-id':'databaseId','team-domain':'ACCESS_TEAM_DOMAIN','aud':'ACCESS_AUD','owner-email':'OWNER_EMAIL','origin':'APP_ORIGIN','auth-mode':'AUTH_MODE'};
const args=process.argv.slice(2), values={};
for(let i=0;i<args.length;i+=2){
  const key=fields[args[i]?.replace(/^--/,'')];
  if(!key||!args[i+1]||args[i+1].startsWith('--'))throw new Error('参数应为 --database-id、--team-domain、--aud、--owner-email 或 --origin，后跟对应值');
  values[key]=args[i+1].trim();
}
let config;
try{config=JSON.parse(await readFile(target,'utf8'));}
catch(e){if(e.code!=='ENOENT')throw e;config=JSON.parse(await readFile(path.join(root,'wrangler.jsonc'),'utf8'));}
if(values.databaseId){
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(values.databaseId))throw new Error('D1 database ID 格式不正确');
  config.d1_databases[0].database_id=values.databaseId;
}
for(const key of ['ACCESS_TEAM_DOMAIN','ACCESS_AUD','OWNER_EMAIL','APP_ORIGIN','AUTH_MODE'])if(values[key])config.vars[key]=values[key];
if(config.vars.AUTH_MODE && !['password','access'].includes(config.vars.AUTH_MODE))throw new Error('登录方式应为 password 或 access');
if(config.vars.ACCESS_TEAM_DOMAIN&&!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(config.vars.ACCESS_TEAM_DOMAIN))throw new Error('团队域名应为 xxx.cloudflareaccess.com（不含 https://）');
if(config.vars.OWNER_EMAIL&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.vars.OWNER_EMAIL))throw new Error('邮箱格式不正确');
if(config.vars.APP_ORIGIN){const u=new URL(config.vars.APP_ORIGIN);if(u.protocol!=='https:'||u.origin!==config.vars.APP_ORIGIN)throw new Error('项目地址应为 HTTPS origin，不含路径或末尾斜杠');}
await writeFile(target,JSON.stringify(config,null,2)+'\n',{mode:0o600});
console.log('已保存个人部署配置 wrangler.local.jsonc（不含 API Key）。');
const pending=(config.vars.AUTH_MODE==='password'?['OWNER_EMAIL','APP_ORIGIN']:['ACCESS_TEAM_DOMAIN','ACCESS_AUD','OWNER_EMAIL','APP_ORIGIN']).filter(key=>!config.vars[key]);
if(pending.length)console.log(`尚待配置：${pending.join('、')}。未配置完整时，网站拒绝访问，不会公开航班数据。`);
