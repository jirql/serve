# poxy — Vercel + Cloudflare 代理节点

基于 [vvxw/deploy-vercel](https://github.com/vvxw/deploy-vercel) 重构：移除哪吒 Agent 与重依赖（仅 `ws` 一个依赖），增加订阅鉴权、DoH 缓存、280s 连接寿命管理，保活改由自有 CF Worker Cron 承担。

```
[客户端 xray] → [CF Worker 域名(橙云)] → [xxx.vercel.app 回源] → [Vercel 出口 sin1] → 目标站
```

## 目录结构

```
index.js            # Vercel 节点: VLESS/Trojan over WS + 订阅端点 + 诱饵页
index.html          # 诱饵伪装页(根路径返回), 建议自行替换为真实内容站
vercel.json         # Vercel 部署配置(regions/maxDuration=300)
worker/_worker.js   # CF Worker: 反代 + 订阅鉴权 + Cron 保活
worker/wrangler.toml
client/xray-config.json  # Linux 客户端配置模板(xray-core, 替代 V2rayN/mihomo)
```

## 一、部署 Vercel 节点

1. 本仓库推送到 GitHub **私有**仓库，Vercel → New Project → Import
2. Install Command 设 `npm install`，`vercel.json` 中 `regions` 按需改（`sin1`/`hnd1`/`iad1`…）
3. Settings → Environment Variables：

| 变量 | 说明 | 生成方式 |
|---|---|---|
| `UUID` | 节点 ID | `node -e "console.log(require('crypto').randomUUID())"` |
| `SUB_PATH` | 订阅路径 token | `openssl rand -hex 6` |
| `SUB_TOKEN` | 订阅鉴权 key | `openssl rand -hex 16` |
| `DOMAIN` | CF Worker 绑定域名(不含 https://) | 第二步完成后回填 |
| `NAME` | 节点显示名 | 可选 |

4. Deploy 后拿到 `xxx.vercel.app` 域名

> **凭据已全部外置**：源码与混淆产物均无默认值，凭据仅存 Vercel Production env（缺失则节点启动即 `exit(1)`）。本地测试：`node --env-file=.env index.js`。

### 代码混淆（产物入库方案）

仓库中 `index.js` 是**混淆产物**（被 Vercel 直接构建）。明文源码 `src/index.plain.js` **仅保留本地、不入库**（src/ 已 gitignore），避免远端历史泄露明文：

```bash
# 修改本地 src/index.plain.js 后重新生成产物
npm run obfuscate        # javascript-obfuscator: src/index.plain.js → index.js
# 本地验证后只 commit index.js (产物)
```

⚠️ 明文源码是单点：请立即在别处备份 `src/`（如加密网盘），本机丢失则无法再维护混淆产物。

- 参数刻意关闭 `string-array`：保住 `require('ws')` 等字面量，否则 Vercel `@vercel/node` 依赖追踪失败、线上 MODULE_NOT_FOUND（构建时混淆方案即因 legacy builds 忽略 Build Command + 此依赖追踪问题被弃用）
- 保留 `--compact --identifier-names-generator hexadecimal`：变量/函数名十六进制化 + 压行
- 曾验证的 Vercel 面板 Build Command 方案不可靠（`vercel.json` 含 legacy `builds` 时面板 Build Command 被忽略），勿再尝试

## 二、部署 CF Worker

```bash
cd worker
# 编辑 wrangler.toml: 改 SUB_PATH 与 Vercel 端一致
wrangler secret put VERCEL_DOMAINS   # 填 xxx.vercel.app (逗号分隔可多域名池)
wrangler secret put SUB_TOKEN        # 与 Vercel 端一致
wrangler deploy
```

然后在 CF 控制台给 Worker 绑定你的托管域名（Settings → Domains），该域名即 `DOMAIN` 回填 Vercel 环境变量并 Redeploy。

订阅地址：`https://你的CF域名/{SUB_PATH}?key={SUB_TOKEN}`（无 key 访问返回诱饵页，不留 403 指纹）。

## 三、Linux 客户端（xray-core）

```bash
# 安装 (版本号到 XTLS/Xray-core Releases 取最新)
bash <(curl -Ls https://github.com/XTLS/Xray-install/raw/main/install-release.sh) @ install
# 配置
sudo mkdir -p /usr/local/etc/xray && sudo cp client/xray-config.json /usr/local/etc/xray/config.json
# 编辑替换 address/serverName/host 为你的 CF 域名，并将 UUID 与 WSPATH 替换为 `.env` 中对应值
sudo systemctl enable --now xray
# 使用
export http_proxy=http://127.0.0.1:11081 https_proxy=http://127.0.0.1:11081 all_proxy=socks5h://127.0.0.1:11080
curl -s https://ip.sb   # 验证出口为新加坡
```

xray-core 是 VLESS/Trojan 协议的参考实现，纯命令行 + systemd 常驻，Linux 下比 V2rayN(Electron) 流畅；本节点帧格式已对齐 xray 26.x（VLESS 官方头布局 + Trojan 零响应隧道）。

## 四、DCDeploy（Docker 部署，替代 Vercel 数据面）

平台：`dash.dcdeploy.com`（法兰克福单区域，per-minute 计费，免费 DCD-1：250MB RAM/1CPU/5GB 盘，1TB/月出站）。

```
[客户端] → [CF Worker(橙云)] → [xxx.dcdeploy.cloud] → [DCDeploy 边缘(TLS终结)] → [容器 :3000]
```

镜像由本仓库 GitHub Actions（`.github/workflows/docker.yml`）构建推送至 `ghcr.io/jirql/eooce:latest`。DCDeploy 添加 Service：

- **Source**: Docker Registry，Image 填 `ghcr.io/jirql/eooce:latest`（私有包需配 pull secret；public 仓库的 GHCR 包默认 public 可免密）
- **Port**: `3000`，Protocol HTTPS；容器已绑定 `0.0.0.0`，无需改代码
- **Env**: 直接粘贴 `.env`（`UUID/SUB_PATH/SUB_TOKEN/NAME`；`DOMAIN` 填 CF Worker 域名）
- **Scaling**: 保持常驻，勿启用 scale-to-zero（代理需长连接）
- 免费档无自定义域名、不支持 GitHub 源 Dockerfile 构建 → 走 GHCR 预构建镜像路径
- 拿到 `*.dcdeploy.cloud` 域名后回填 CF Worker secret：`VERCEL_DOMAINS=<该域名>` + `wrangler deploy`
- 节点无 300s 执行硬顶，`CONN_LIFETIME=280s` 可保留（无害）或调大

⚠️ DCDeploy Fair Use 条款明确将 "Proxy services" 列为禁止项，账号有封停风险；建议仅作测试/备用出口，控制面（CF）与数据面分离，封号仅需换平台。出口 IP 为德国（DE），与 Vercel sin1 新加坡不同。

## 已知边界

- 单 WS 连接 ≤280s 主动重连（Vercel 300s 硬顶），长下载会周期掐线，浏览无感
- 不支持 UDP/QUIC；出口为 Vercel 共享 IP 段，敏感账号登录慎用
- Vercel Hobby ToS 禁止代理用途：控制面（CF）与数据面（Vercel）分离，封号仅需重建项目
- 沙箱环境 DoH 不可达时自动回退系统 DNS，Vercel 生产环境 DoH 正常

## 下一步（流量清洗层）

节点跑通后在 `worker/_worker.js` 叠加：扫描器 ASN/Bot Score 过滤、订阅端点速率限制、诱饵内容升级、KV 流量计数。规划见对话方案「模块 1/2」。
