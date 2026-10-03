import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('../wrangler.local.jsonc',import.meta.url),'utf8').catch(()=>{throw new Error('请先运行 cloud-config.mjs 生成个人部署配置');}));
const mode=config.vars?.AUTH_MODE || 'access';
if(!['access','password'].includes(mode))throw new Error('登录方式不正确');
const required=mode==='password'?['OWNER_EMAIL','APP_ORIGIN']:['ACCESS_TEAM_DOMAIN','ACCESS_AUD','OWNER_EMAIL','APP_ORIGIN'];
for(const key of required)if(!config.vars?.[key])throw new Error(`尚未配置 ${key}`);
if(!config.d1_databases?.[0]?.database_id||config.d1_databases[0].database_id==='00000000-0000-0000-0000-000000000000')throw new Error('请先创建并绑定 D1');
if(config.assets?.directory!=='./dist'||config.assets?.run_worker_first!==true||config.preview_urls!==false)throw new Error('部署必须只包含 dist 网页资源、先验证登录，并关闭预览链接');
console.log(`部署配置检查通过（${mode}）。还需配置对应 Secrets，并验证登录、未授权拒绝和数据导入。`);
