import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const stats=await readFile(new URL('../dist/stats.js',import.meta.url),'utf8');
const login=await readFile(new URL('../dist/login.js',import.meta.url),'utf8');
const loginHtml=await readFile(new URL('../dist/login.html',import.meta.url),'utf8');

test('云端模式不回显或提交 API Key，本地设置仍保留 API Key 行为',()=>{
  assert.match(app,/\$\('#api-key'\)\.value=state\.cloud\?'':\(c\.apiKey\|\|''\)/,'云端设置打开时密钥输入框保持空白');
  assert.match(app,/if\(!state\.cloud\)body\.apiKey=\$\('#api-key'\)\.value/,'仅本地设置请求包含 apiKey');
  assert.match(app,/\$\('#api-key-field'\)\.hidden=state\.cloud/,'云端界面隐藏密钥输入框');
  assert.match(html,/id="cloud-key-notice"[^>]*hidden/,'云端界面说明密钥由服务端管理');
  assert.match(html,/id="local-key-notice"[^>]*>/,'本地密钥说明继续保留');
});

test('本地 JSON 导出逻辑保留，云端使用完整备份接口',()=>{
  assert.match(app,/if\(!state\.cloud\)\{downloadJson\(\{version:2,exportedAt:new Date\(\)\.toISOString\(\),trips:state\.trips\.map/,'本地仍导出原有 version 2 行程文件');
  assert.match(app,/api\('\/api\/export'/,'云端从备份接口下载完整数据');
});

test('迁移导入只转发允许的配置字段并要求用户确认',()=>{
  assert.match(app,/for\(const key of \['endpoint','model','temperature'\]\)/,'导入时过滤配置，只保留非密钥字段');
  assert.match(app,/window\.confirm\(/,'导入前要求用户确认');
  assert.match(app,/api\('\/api\/import',\{method:'POST',body:\{confirmed:true,snapshot\}\}\)/,'确认后才提交迁移快照');
});

test('统计页为本机接口发送本地标记，并对云端会话过期给出安全提示',()=>{
  assert.match(stats,/headers:\{'X-Trip-Local':'1'\}/,'统计页请求继续满足本地服务接口要求');
  assert.match(stats,/response\.status===401/,'处理未登录或会话失效');
  assert.match(stats,/response\.status===403/,'处理账号无访问权限');
  assert.match(stats,/location\.hostname\.endsWith\('\.workers\.dev'\)/,'workers.dev 页面显示云端名称');
  assert.match(stats,/response\.redirected\|\|!response\.headers\.get\('content-type'\)\?\.includes\('application\/json'\)/,'Access 登录 HTML 不误显示成空统计');
  assert.match(stats,/if\(cloud&&error\.authExpired\)\{location\.replace\('\/login'\)/,'云端统计页会话失效时回登录页');
});

test('云端设置提供历史备份下载、登出入口和准确的云端说明',()=>{
  assert.match(html,/href="\/cdn-cgi\/access\/logout" hidden/,'登出链接默认只在云端模式显示');
  assert.match(app,/api\('\/api\/backups'\)/,'读取每日备份列表');
  assert.match(app,/api\(`\/api\/backups\/\$\{encodeURIComponent\(id\)\}`/,'使用编码后的备份日期下载快照');
  assert.match(html,/id="cloud-backup-select"/,'备份历史可选择');
  assert.match(app,/每日自动备份仍可在设置中下载/,'云端删除说明不提本地 .bak');
  assert.match(app,/校准结果会保存在云端行程中/,'云端校准说明与存储位置一致');
  assert.doesNotMatch(html,/style="/,'避免 Cloudflare CSP 拦截行内样式');
  assert.match(html,/cloud-import-action/,'导入按钮使用样式类而非行内样式');
  assert.match(app,/TextEncoder\(\).*byteLength>12\*1024\*1024/,'云端识别发送前按 UTF-8 请求体大小限制在 12 MB');
  assert.match(app,/请求总量上限 12 MB/,'超限时显示压缩/减图说明');
  assert.match(app,/单次请求最多 12 MB（含图片编码）/,'云端上传提示提前说明大小限制');
});

test('应用内密码登录支持安全提交、失败提示、会话退出且不保存凭据',()=>{
  assert.match(loginHtml,/type="password" autocomplete="current-password" required/,'密码框采用当前密码自动填充语义');
  assert.match(loginHtml,/rel="stylesheet" href="\/login\.css"/,'登录页使用 CSP 允许的外部样式');
  assert.match(loginHtml,/type="module" src="\/login\.js"/,'登录页使用 CSP 允许的外部脚本');
  assert.doesNotMatch(loginHtml,/favicon\.svg/,'登录页不依赖未公开的静态图标资源');
  assert.match(login,/fetch\('\/auth\/login',\{method:'POST',headers:\{'Content-Type':'application\/json','X-Trip-Local':'1'\},body:JSON\.stringify\(\{password:password\.value\}\)\}\)/,'登录密码只提交给同源鉴权接口');
  assert.match(login,/response\.status===401/,'密码错误有明确反馈');
  assert.match(login,/response\.status===429/,'登录限流有明确反馈');
  assert.match(login,/response\.status===503/,'鉴权服务不可用有明确反馈');
  assert.match(login,/location\.replace\('\/'\)/,'登录成功只进入固定首页，不接受外部跳转地址');
  assert.match(login,/fetch\('\/auth\/logout'/,'退出登录调用服务端清除会话');
  assert.match(loginHtml,/id="logout-panel" hidden/,'退出失败时状态面板不会随密码表单一起隐藏');
  assert.match(loginHtml,/id="logout-retry"/,'退出失败可以重试');
  assert.match(loginHtml,/class="back-to-login" href="\/login"/,'退出失败时可返回登录页面');
  assert.match(login,/logoutRetry\.addEventListener\('click',logout\)/,'重试按钮重新请求服务端清除会话');
  assert.doesNotMatch(login,/localStorage|sessionStorage|document\.cookie/,'浏览器不保存密码或操作会话 cookie');
  assert.match(app,/state\.authMode==='password'\?'\/login\?logout=1':'\/cdn-cgi\/access\/logout'/,'按鉴权模式选择正确退出流程');
  assert.match(app,/if\(response\.status===401\)\{if\(state\.cloud\|\|location\.hostname\.endsWith\('\.workers\.dev'\)\)location\.replace\('\/login'\)/,'仅云端 API 会话失效时跳转登录，避免改变本地版');
});
