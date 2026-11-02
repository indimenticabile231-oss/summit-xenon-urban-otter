# 落片

把哔哩哔哩视频详情页存成视频文件。粘贴 BV 链接或 b23 短链，解析出标题和清晰度，确认后再下载。多分P（地址里的 `?p=`）可以先选集。

只支持普通视频。番剧、直播，以及需要登录或大会员的清晰度，这里拿不到文件。YouTube 和其它网站也不支持。

## 个人使用与版权

落片用来保存**你有权使用**的视频。请遵守哔哩哔哩的用户协议，以及你所在地的著作权法。

这个项目不会替你登录，也不会绕过地区、付费或大会员限制。下载到的文件不要再公开分发。部署者自己承担带宽和合规责任。页面底部有同样的提示。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm install
cp .env.example .env
npm run dev
```

浏览器打开 <http://localhost:8080>。不填密钥也可以解析和下载。

```bash
npm run typecheck
npm run test
npm run lint
npm run build
```

## 滥用防护

`/api/inspect` 和 `/api/download` **不要求登录**，但按来源 IP 限制次数，避免被当成公开的下载代理：

| 接口 | 默认每天 | 默认每 10 分钟 |
| --- | --- | --- |
| 解析 | 120 | 30 |
| 下载 | 40 | 10 |

额度记在进程内存里。进程重启会清零，多实例各自计数，不能当成分布式限额。

客户端 IP 取 `X-Forwarded-For` 的最后一跳（边缘代理追加的地址），没有再看 `cf-connecting-ip` 和 `x-real-ip`。如果进程被直接访问，这些头可以被伪造。放在 Vercel 这类会在末尾写上真实客户端地址的代理后面，这个取法才有意义。

本机调试被额度挡住时，可以在 `.env` 里设 `LUOPIAN_QUOTA_DISABLED=true`。公网部署不要关。次数也可以用 `.env.example` 里的 `LUOPIAN_*` 变量调整。

## 登录

Better Auth（`BETTER_AUTH_*`、`GROK_AUTH_*`）是平台自带的登录脚手架。落片**默认关掉**，见 `.grok/app-env.json` 的 `VITE_AUTH_ENABLED=false`。

解析和下载不读取会话。把登录打开也不会提高额度，也不会变成下载门槛。防滥用靠的是上面的 IP 额度，而不是账号。

没有 `DATABASE_URL` 时，登录如果被打开，数据落在进程内的 PGLite 里，重启即失。

## 环境变量

完整列表和说明在 [`.env.example`](./.env.example)。不要把真实密钥提交进仓库。
