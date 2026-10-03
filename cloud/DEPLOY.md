# 行迹：Cloudflare 单人在线版

在线版与本地版共用界面，但数据相互独立。本地 `node server.mjs`、桌面启动器和 `data/` 文件不变。在线版运行在 Cloudflare Workers，使用 D1 保存数据，默认地址为 `https://xingji-flights.<你的子域名>.workers.dev`。

## 专属密码登录（默认，不需要 Zero Trust）

`AUTH_MODE=password` 支持系统生成的随机访问密码或本人设置的 8–128 字符密码。密码保存在本机 `cloud-private/网站登录密码.txt`；这是本应用的独立登录密码。

- 新密码保存为带随机盐的 PBKDF2-SHA256 验证信息；兼容原有高熵随机密码的旧摘要格式。服务器不保存密码原文。
- 登录成功设置 Secure、HttpOnly、SameSite=Strict 的 24 小时 Cookie；会话保存在 D1，退出会删除服务器会话。密码或 SESSION_SECRET 变更会使原会话失效。
- 登录接口校验同源请求，并在 D1 中限制单个来源和全站登录次数。浏览器首页未登录时跳转登录页；接口及其余资源拒绝访问。登录页及其两个专用资源不包含私人数据。
- `LOGIN_PASSWORD_HASH`、`SESSION_SECRET` 和 `AI_API_KEY` 均保存在 Cloudflare Secrets，不写入前端或数据备份。

已有本项目的 D1 与个人配置时执行：

```powershell
node scripts/cloud-config.mjs --auth-mode password --origin https://xingji-flights.你的子域名.workers.dev
node node_modules/wrangler/bin/wrangler.js d1 migrations apply xingji-flights --remote --config wrangler.local.jsonc
node scripts/cloud-password-setup.mjs generate
node scripts/cloud-password-setup.mjs upload --include-local-ai
pnpm run cloud:check
pnpm run cloud:password-test
pnpm run cloud:deploy
```

生成步骤采用独占新建，已有密码文件时不会覆盖；上传失败可直接重试 upload。`--include-local-ai` 读取本机现有 API Key 并通过标准输入交给 Wrangler，不显示密钥。没有本地密钥时省略此参数，随后用 `wrangler secret put AI_API_KEY` 单独设置。

需要修改密码时，向 `node scripts/cloud-password-setup.mjs set` 的标准输入传入新密码，再执行 `node scripts/cloud-password-setup.mjs upload`。设置工具会备份旧凭据、更新本机密码文件；上传后新密码生效，旧会话失效。不要把密码写进命令参数或源码。退出登录不会清除已经下载到设备上的导出文件。

## Cloudflare Access 登录（可选旧方案）

仅在能够启用 Zero Trust 且设置 `AUTH_MODE=access` 时使用本节；密码模式不需要填写团队域名或 AUD。

- 唯一允许邮箱：`you@example.com`。使用 Cloudflare Access 邮箱验证码或你选择的身份提供商登录。
- 所有网页、资源和接口先经过 Worker 的 Access JWT 签名校验，检查签发者、应用受众、有效期及邮箱。未配置完整时拒绝访问，不存在开发绕过开关。
- API Key 只放在名为 `AI_API_KEY` 的 Worker Secret，网页设置与备份不返回密钥。
- `data/`、`cloud-private/`、个人部署配置及密钥文件不会被当成静态资源上传。静态目录只有 `dist/`；关闭 Workers 预览地址。
- 本地地图瓦片缓存仍是每台设备自己的浏览器缓存。飞机资料缓存改存 D1；照片仍从 Planespotters 在线加载并显示作者署名。

## 首次部署与可选 Access 配置

下面命令在项目根目录执行。需要 Node.js 22 或更新版本及 pnpm；Cloudflare 的登录和邮箱验证码由本人完成。无需把 Cloudflare 密码交给任何人。

1. 安装依赖并登录：

   ```powershell
   pnpm install
   pnpm exec wrangler login
   pnpm exec wrangler whoami
   ```

2. 创建 D1（只创建一次，已有同名数据库请直接使用其 ID）：

   ```powershell
   pnpm exec wrangler d1 create xingji-flights
   node scripts/cloud-config.mjs --database-id 返回的数据库ID
   pnpm exec wrangler d1 migrations apply xingji-flights --remote --config wrangler.local.jsonc
   ```

3. 首次发布用于获得项目地址：

   ```powershell
   pnpm exec wrangler deploy --config wrangler.local.jsonc
   ```

   此时尚未配置 Access，Worker 会返回 503 并拒绝访问；这是预期状态，不上传个人数据。

4. 密码模式直接按前面的「专属密码登录」步骤操作。选择 Access 时，在 Workers & Pages 中打开该 Worker → Access → Protect this Worker behind Access，选择 All traffic。进入 Zero Trust 的 Access 应用，设置 **Allow → Emails → `you@example.com`**，不要使用 Everyone 或 Bypass。记录团队域名 `xxx.cloudflareaccess.com` 与该应用的 AUD。

5. 填入正式配置并部署：

   ```powershell
   node scripts/cloud-config.mjs --auth-mode access --team-domain xxx.cloudflareaccess.com --aud 应用的AUD --origin https://xingji-flights.你的子域名.workers.dev
   pnpm exec wrangler secret put AI_API_KEY --config wrangler.local.jsonc
   pnpm run cloud:deploy
   ```

   Secret 命令提示时输入现有 AI API Key；不要把密钥写入命令参数、源码、截图或备份。模型和接口地址可在网页登录后设置。默认配置为 DeepSeek 官方接口和 `deepseek-flash`，迁移文件可带入原来的接口与模型设置。显式设置 `AI_ENDPOINT` / `AI_MODEL` 环境变量时，它们优先于网页设置。

## 迁移现有数据

```powershell
pnpm run cloud:snapshot
```

生成的 `cloud-private/` 快照只读取本地数据，不修改原文件，也不包含 API Key。快照包含航班、机场校准、飞机资料缓存及非敏感 API 配置，但仍是私人行程文件，请妥善保管。

用已授权邮箱登录在线版，打开「API 设置」→「云端数据迁移」，选择快照并确认。导入采用合并：完全相同的记录跳过；同 ID 内容不同、同航班号和日期重复时整批拒绝，不会覆盖已有行程。最多一次导入 1000 条。导入后核对条数、地图、统计和随机几条航班。

网页「下载完整云端备份」可随时导出 JSON。不要把本地普通「导出 JSON」的 version 2 文件当成迁移快照；请使用上述专用工具。

## 自动备份与飞机资料

地图请求必须保留真实网站来源。在线响应及 Leaflet 瓦片均使用 `strict-origin-when-cross-origin`，跨站仅发送网站 origin，不发送私人路径或查询参数。不要改成 `same-origin` / `no-referrer`，否则 OSM 可能返回 403 的 Access blocked 提示。只按当前视野请求瓦片，不批量下载、不改用代理掩盖来源、不添加随机参数绕过缓存；瓦片缓存遵守上游有效期，不缓存错误响应。若地图仍失败，先核对浏览器请求的 Referer、状态码及网络，不关闭登录保护。

- 每日 UTC 00:00 将完整数据快照保存在 D1，保留最近 7 个日期；设置中可下载历史备份。定时任务生效取决于 Cloudflare Cron 配置成功。
- 这些备份与主数据在同一个 D1 中，不是异地灾难备份。建议不定期下载 JSON 到自己电脑。删除整个 D1 会同时删除内置备份。
- 新增或编辑航班后，后台最多立即查询 5 个不同注册号；其余缺失资料由每小时定时任务继续补充，点击详情也会即时查询。
- Airport-Data 和 Planespotters 的限流、访问限制或缺少记录可能导致资料为空；不会阻止保存航班。云端不使用本地 Windows 专用备用请求方式，不保证资料源在每个节点都可用。

## 更新和验收

```powershell
pnpm test
pnpm run cloud:check
pnpm run cloud:deploy
```

上线后必须核验：无痕窗口先要求登录、未授权邮箱不能进入；自己登录后新增/编辑/删除/重复校验正常；AI 识别先确认再保存；导出不含 Key；重新登录和更换设备后数据仍在。先用一条人工测试记录完成增删检查，再导入正式行程。

默认域名在不同网络的访问体验需要实测；请在自己的电脑和手机网络分别打开。若后台需要额外付费资源，先确认费用再启用；本方案没有启用 R2、Containers 或付费外部数据库。

官方参考：[Workers 默认域名](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) · [静态资源先经过 Worker](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first) · [D1](https://developers.cloudflare.com/d1/) · [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
