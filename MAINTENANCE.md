# poxy 全链路维护手册

> 适用范围：本仓库搭建的 Vercel + Cloudflare Workers 代理节点（VLESS/Trojan over WS）。
> 本文档记录完整部署配置、协议实现细节、调试历程与运维手册，供后续维护与扩展（流量清洗层、C2 重定向）参考。
> ⚠️ 本仓库必须保持 **private**，文中包含真实凭据。

---

## 一、架构与数据流

```
[xray 客户端 (本机)]
   │  SOCKS5 127.0.0.1:11080 (VLESS) / HTTP  127.0.0.1:11081 (Trojan)
   ▼
[wss://www.jirql.dpdns.org:443/<WSPATH>]        ← CF 橙云域名（SNI 可达、TLS 由 CF 边缘终结）
   │  流量特征: 普通 HTTPS + WebSocket Upgrade
   ▼
[Cloudflare Worker: poxy-edge]                   ← 反代层：域名池负载、订阅鉴权、Cron 保活
   │  改写 host → sve-six.vercel.app，剥离 cf-connecting-ip/x-forwarded-for/cookie
   ▼
[Vercel Serverless (sin1 新加坡, @vercel/node)]   ← 节点核心：VLESS/Trojan over WS 隧道
   │  出口 = AWS Singapore 共享 IP 段 (52.x/13.x/47.84.x 轮换)
   ▼
[DoH 解析 (dns.google → cloudflare-dns 回退)] → [net.connect 目标站:端口] → 双向 pipe 回传
```

各层职责：

| 层 | 载体 | 职责 | 失败表现 |
|---|---|---|---|
| 客户端 | xray-core 26.2.6 | 本地 SOCKS/HTTP 入口、协议封装 | 连接拒绝/无出口 |
| CF Worker | poxy-edge + 自定义域名 | 可达性（vercel.app 被墙）、订阅鉴权前置、保活、隐藏回源 | 502/521 |
| Vercel 节点 | index.js | 协议解析、隧道转发、诱饵页 | WS 握手成功但 502/超时 |
| 目标回源 | Vercel 出口 | DoH 抗污染解析 + TCP 直连 | 特定域名失败 |

---

## 二、组件与文件清单

```
src/index.plain.js         # 明文源码(仅本地维护, 不入库, .gitignore 排除)
index.js                   # 混淆产物(npm run obfuscate 生成, Vercel 构建它)
index.html                 # 诱饵伪装页（所有未授权路径返回 200 此页）
vercel.json              # regions=sin1, maxDuration=300, 全路由→index.js
package.json             # 依赖仅 ws
worker/_worker.js        # CF Worker：反代 + 订阅鉴权 + Cron 保活
worker/wrangler.toml     # SUB_PATH var + crons */5 + secrets 说明
client/xray-config.json  # Linux 客户端配置模板（当前生产使用）
test-live.js             # 单帧模式端到端测试（握手帧带 payload）
test-twoframe.js         # 两帧模式测试（纯握手帧→等响应→数据帧）
```

部署产物对应关系：GitHub `jirql/sve` (private) → Vercel 项目 `sve-six` → `https://sve-six.vercel.app` → CF Worker `poxy-edge` → 域名 `www.jirql.dpdns.org`。

---

## 三、凭据与配置项

> 凭据明文值仅存于本地 `.env`（gitignore）与 Vercel Production env，本文档不再记录。以下为变量名与派生关系：

| 项 | 位置 | 派生关系 |
|---|---|---|
| `UUID` | Vercel env（源码/产物零默认值，缺失即 exit(1)） | VLESS 认证 ID；Trojan 密码=同一 UUID（sha224 hex） |
| WSPATH | 派生：`UUID` 去连字符取前 8 位 | 客户端 wsSettings.path 必须一致 |
| `SUB_PATH` | Vercel env + wrangler.toml `[vars]` 两处一致 | 订阅端点路径 |
| `SUB_TOKEN` | Vercel env + CF secret | 订阅鉴权 key |
| `DOMAIN` | Vercel env | CF Worker 绑定域名；订阅生成里节点 address/sni 用它 |
| `VERCEL_DOMAINS` | CF secret（逗号分隔可多域名池） | Worker 回源目标 |

**改 UUID 的连锁反应**：WSPATH 变 → 客户端 `wsSettings.path` 必须同步改 → 已分发订阅全部失效。改 `DOMAIN` 只需 Vercel 重新部署。

---

## 四、Vercel 侧部署细节

1. New Project → Import GitHub 私有仓库 `jirql/sve`
2. Install Command：`npm install`；框架无（Node serverless）
3. Environment Variables（**Production + Preview 都要加**，改完必须 Redeploy 生效）：
   `UUID` / `SUB_PATH` / `SUB_TOKEN` / `DOMAIN` /（可选 `NAME`）
4. `vercel.json`：`regions: ["sin1"]` 决定出口地理；`maxDuration: 300`（Hobby 硬顶）
5. 验证：`curl https://sve-six.vercel.app/` 应返回诱饵页 HTML；`curl "https://sve-six.vercel.app/{SUB_PATH}?key={SUB_TOKEN}"` 返回 base64 订阅

### 代码混淆（产物入库，当前生效方案）

- 仓库中 `index.js` = 混淆产物；明文 `src/index.plain.js` **仅本地保留（gitignore, 不入远端历史）**。改代码 → 本地 `npm run obfuscate`（src→index.js）→ 验证 → 只 commit 产物
- ⚠️ 明文源码单点风险：`src/` 需异地备份（加密网盘/第二块盘），丢失即失去维护能力
- 参数：`--compact --identifier-names-generator hexadecimal --string-array false`。**string-array 必须关**：保住 `require('ws')` 字面量，否则 `@vercel/node` 依赖追踪不到 ws，线上 MODULE_NOT_FOUND
- 已弃用方案：Vercel 面板 Build Command 构建时混淆——legacy `builds` 配置下面板 Build Command 被忽略（实测构建产物仍明文），且即便生效也有上述依赖追踪问题
- 诱饵页路径已做双查找（`__dirname` 根/src 均可），本地跑明文源码不依赖部署位置
- 已验证：混淆版协议/订阅/诱饵本地+生产全通（2026-09-27）

### 节点核心行为（index.js）

- **路由**：`/` 与所有未知路径 → 诱饵页（无 404 指纹）；`/{SUB_PATH}` 带 key → base64 订阅（VLESS+Trojan 两节点）
- **WS 升级**：仅接受 `/{WSPATH}` 路径，其余 close
- **首包分发**：`msg[0]===0 且 UUID 匹配` → VLESS；`长度≥58 且 sha224 前缀匹配` → Trojan；否则 close。**分发器整体 try/catch，畸形包不得杀进程**
- **280s 主动 `ws.close(1001)`**：Vercel 300s 硬顶前主动断开，客户端自动重连无感（长下载会周期掐线）
- **DoH**：dns.google 主、cloudflare-dns 备，LRU 缓存 1000 条 / TTL 5min，双源失败回退系统解析
- **测速域名拦截**：`BLOCKED_DOMAINS`（speedtest/fast.com 等）直接 close，防白嫖带宽画像
- **ISP 探测**：首次拉订阅时打 api.ip.sb/geoip 取 `国家-运营商` 拼节点名

---

## 五、Cloudflare Worker 侧部署细节

```bash
cd worker
wrangler secret put VERCEL_DOMAINS   # sve-six.vercel.app
wrangler secret put SUB_TOKEN
wrangler deploy
```

- 控制台 Settings → Domains 绑定 `www.jirql.dpdns.org`（要求 dpdns.org 区域已托管在 CF、nameserver 指向 CF、**橙云开启**）
- `[triggers] crons = ["*/5 * * * *"]`：每 5 分钟带 `x-sub-key` 打一次订阅端点，维持 Vercel 实例温态（免费层无 Cron 会冷启动 2-3s）
- 请求改写：`host` 换成 vercel.app、删 `cf-connecting-ip`/`x-forwarded-for`/`cookie`（防用户身份回源、防 Vercel 日志留客户端 IP）
- WS Upgrade 头透传即可工作（fetch 对 upgrade 请求返回 pair 流）
- **注意**：默认 `*.workers.dev` 域名在国内被 SNI 阻断，必须绑自定义域名；`jirql.dpdns.org` 裸域与 `www` 子域要统一（Vercel `DOMAIN` 与客户端 address/host/sni 三处必须完全一致，含 www）

---

## 六、客户端（xray-core）配置细节

生产配置：`client/xray-config.json`，运行副本 `~/.config/poxy-client/config.json`。

```
入口:  socks 127.0.0.1:11080 (udp:true)   → outbound poxy-vless
       http   127.0.0.1:11081              → outbound poxy-trojan
出口:  vnext address=www.jirql.dpdns.org:443, id=UUID, encryption=none
       servers address 同上, password=UUID (Trojan 用 sha224(UUID) hex 认证)
传输:  network=ws, security=tls, serverName=www.jirql.dpdns.org,
       path=/<WSPATH>, host=www.jirql.dpdns.org
路由:  私网 CIDR 直连 + keyword:jirql.dpdns.org 直连(防回环), 其余全走代理
```

要点：
- 二进制当前借用 V2rayN 自带：`/home/song/.local/share/v2rayN/bin/xray/xray`（版本 26.2.6）。**若卸载 V2rayN 需先把二进制独立出来**（见 §十 TODO）
- routing 用 IP CIDR 而非 geoip 文件，避免 geosite/geoip.dat 版本兼容坑（mihomo 时代踩过）
- 启动方式（当前手动）：`xray run -c ~/.config/poxy-client/config.json`

### 系统代理接线（本机 Ubuntu GNOME）

- GNOME：`gsettings set org.gnome.system.proxy mode manual`；http/https → `127.0.0.1:11081`；socks → `127.0.0.1:11080`；ignore-hosts 含 `localhost,127.0.0.1,10/8,192.168/16,172.16/12`
- 终端：`~/.bashrc` 与 `~/.zshrc` 均已追加：
  `http_proxy/https_proxy=http://127.0.0.1:11081`、`all_proxy=socks5h://127.0.0.1:11080`（**socks5h 远程解析 DNS**，防本地 DNS 污染泄漏）、`no_proxy` 豁免 `.cn/.edu.cn/gitee/内网`
- 临时全局关闭：`gsettings set org.gnome.system.proxy mode none` + 新开 shell（或 `unset http_proxy https_proxy all_proxy`）

---

## 七、协议帧格式规范（本节点实现 ↔ xray 26.x 参考实现）

> 这是本项目踩坑最密集的层。两套 atyp 编码**不同**，不要混用。

### VLESS 请求帧（官方布局，index.js `handleVless`）

```
偏移  长度  字段
0     1    version (=0)
1     16   UUID (二进制)
17    1    addon_len (N, xray 无 extension 时 =0)
18    N    addons (protobuf)
18+N  1    command (0x01=TCP, 0x02=UDP)
19+N  2    port (big-endian)          ← 注意 port 在 atyp 之前
21+N  1    atyp: 0x01=IPv4, 0x02=Domain, 0x03=IPv6   ← Domain 是 0x02!
22+N  ...  addr (IPv4=4B / Domain=len(1B)+str / IPv6=16B)
      ...  payload (可为空, 两帧模式)
```

### VLESS 响应帧

```
[0x00, 0x00]   ← version(0) + addon_len(0) = 成功
```
**不能发旧版 `[0,10,0,0,0,0]`**：xray 把第二字节读作 addon_len=10，吞掉后续 10 字节隧道数据（表现为响应错乱/超时）。

### Trojan 请求帧（xray `proxy/trojan/protocol.go`）

```
0     56   sha224(UUID) 的 hex 字符串 (ASCII)
56    2    \r\n
58    1    command (0x01=TCP, 0x03=UDP)     ← 很多自研实现漏掉这个字节!
59    1    atyp: 0x01=IPv4, 0x03=Domain, 0x04=IPv6   ← 与 VLESS 编码不同!
      ...  addr
      2    port (big-endian)
      2    \r\n
      ...  payload (单帧模式直接跟在后面)
```

### Trojan 响应：**零字节**

xray 客户端 `getResponse` 不读任何握手响应，直接把连接管道进隧道。服务端发 `0x01` 会泄漏成隧道首字节（curl 报 `Received HTTP/0.9 when not allowed`，响应体开头多一个 `01`）。旧 Trojan 规范（原 Trojan 项目）要求 `0x01`，xray 已不遵循——**以 xray 为准**。

### 已确认的 xray 抓包样本（SHOW_LOG=1 时 `first packet` 日志；UUID 已打码为 `7375…` 前缀示意）

```
VLESS (108B): 00 <UUID 16字节> 00 01 0050 02 0b "example.com" "GET /..."
              ver               alen cmd port atyp len
Trojan(150B): <sha224(UUID) 56B hex ASCII> 0d0a 01 03 0b "example.com" 0050 0d0a "GET..."
                                            CRLF cmd atyp len         port  CRLF
```

---

## 八、调试历程（时间线）

### 阶段 1：协议解析错位（mihomo 时代）

| # | 症状 | 根因 | 修复 | 教训 |
|---|---|---|---|---|
| 1 | 真机连上即断，`wrong version number` | 重构时把 VLESS 头写成 `cmd@17/olen@18` 自定义布局；**本地测试脚本用同样错误的帧自证**，互相掩盖 | 对齐参考实现布局 | 测试帧必须从真实客户端抓包，不能服务端+自研测试同错 |
| 2 | Trojan 域名目标被拒 | atyp 硬编码只放行 `0x01` | 放行 0x01/0x03/0x04 | — |
| 3 | 畸形包打挂 Node 进程（`ERR_OUT_OF_RANGE`） | 首包分发无保护 | 分发器整体 try/catch + close | serverless 进程崩溃=冷启动+断连 |
| 4 | `parseTarget` 前多 `offset+=1` | atyp 被跳过导致解析起点错位 | parseTarget 内部从 atyp 起读 | — |

### 阶段 2：mihomo 玄学 502 → 决策换客户端

- 症状：mihomo WS 连接建立（CF 日志 101），但**节点收不到任何 connection 事件**，客户端 502。排查了 fake-ip-filter 语法、回环（节点域名未直连→无限套娃）、geoip.dat 与 mihomo 1.19 版本不兼容（换 geoip.metadb）、节点名含点导致 mihomo API 路径无法定位、`fp=chrome` uTLS 对 CF 握手超时（去掉用原生 TLS）——部分修复后仍不稳定。
- **决策**：mihomo 与自研服务端兼容性存疑，弃用。用户原话："server 端完全没问题，问题出在 client 上，不用这个。" 换 xray-core（协议参考实现，服务端向它对齐）。
- 现已彻底清理：deb 包删除、`dpkg -P mihomo`、`/etc/mihomo` 移除、服务 disable。

### 阶段 3：xray 26.x 兼容性（本轮核心）

| # | 症状 | 抓包证据 | 根因 | 修复 |
|---|---|---|---|---|
| 5 | xray 报 `failed to read response version > websocket: close 1005` | 108B 帧 `...e4 00 01 0050 02 0b example.com` | 服务端按旧布局读 cmd@17=0x00 判非法直接 close | `handleVless` 重写为官方布局（addon_len@17, port@19+N, atyp@21+N, **Domain=0x02**），拆出 `parseVlessAddr` 与 Trojan 的 `parseHost` 分离两套 atyp 编码 |
| 6 | VLESS 通了但响应错乱 | — | 响应 `[0,10,0,0,0,0]` 被 xray 读作 addon_len=10 吞数据 | 响应改 `[0x00,0x00]` |
| 7 | xray Trojan 隧道建立但内容错位（curl `HTTP/0.9`） | 150B 帧 hash+CRLF 后多一字节 `01` | xray Trojan 有 **command 字节**（0x01=TCP/0x03=UDP），旧解析把它当 atyp | `handleTrojan` 增加 cmd 字节读取 |
| 8 | curl 经 Trojan 出口响应首字节多 `0x01` | `xxd` 显示 `0148 5454...` | xray 客户端**不读握手响应**（源码 `getResponse` 直接管道），服务端发的 `0x01` 泄漏进数据流 | Trojan 分支删除响应发送，零字节隧道 |
| 9 | 本地测试"通过"但生产失败 | — | 旧 node 实例占 3997 端口未死，xray 连的是旧代码（EADDRINUSE 静默） | 按端口 `ss -tlnp` 提取 PID 精确 kill 再重启 |

### 阶段 4：部署与客户端接线

- Vercel env 只在 Production 加导致 Preview 行为不一致 → **两环境都加 + Redeploy**
- CF 域名绑定要求 dpdns.org zone nameserver 已指向 CF
- `DOMAIN`（www.jirql.dpdns.org）与 Worker 绑定域名、客户端 address/sni/host 四处必须逐字符一致
- 系统代理：GNOME gsettings + bashrc/zshrc 双写；曾残留 mihomo 的 socks:1080 配置，已改指 xray 11080/11081
- **pkill/pgrep 自伤两次**：模式匹配到自身命令行把 shell 杀了 → 一律改 `ss -tlnp | grep -oP 'pid=\K[0-9]+'` 精确 kill

### 验证终态（2026-09-27）

- 单帧/两帧 × VLESS/Trojan × 本地/生产 全绿
- `curl -x socks5h://127.0.0.1:11080 https://ip.sb` → 新加坡 AWS IP（13.x/52.x/47.84.x 轮换，Vercel 共享段）
- HTTPS CONNECT 经 11081 正常

---

## 九、测试与排障手册

### 端到端测试

```bash
cd /home/song/Pictures/poxy
export $(grep -v '^#' .env | xargs)   # 载入本地凭据 env (测试脚本已改为读 env)
node test-live.js                    # 生产: 单帧模式 VLESS+Trojan
node test-live.js localhost:3997     # 本地
node test-twoframe.js www.jirql.dpdns.org vless    # 两帧模式
node test-twoframe.js www.jirql.dpdns.org trojan
# 本地节点: SHOW_LOG=1 PORT=3997 node --env-file=.env index.js   (日志含 first packet hex, 排障关键)
# 客户端侧: curl -x socks5h://127.0.0.1:11080 http://example.com -o /dev/null -w '%{http_code}\n'
```

### 分层定位表

| 现象 | 定位层 | 动作 |
|---|---|---|
| WS 连不上/502 且节点无 `WS conn` 日志 | CF Worker 或域名 | `curl -I https://域名/`（应 200 诱饵页）；CF 控制台看 worker 日志 |
| `WS conn` 有、`first packet` 无 | 客户端未发包/路径不对 | 核对 wsSettings.path=WSPATH（UUID 前 8 位） |
| `first packet` 有、随即 close | 帧格式不匹配 | 把 hex 对照 §七 样本逐字节比对 |
| 握手通但数据错乱 | 响应格式 | VLESS 必须 `[00 00]`；Trojan 必须零响应 |
| 特定域名失败 | DoH | Vercel 日志看 resolveHost；测速域名是被 BLOCKED_DOMAINS 拦截属预期 |
| 冷启动慢 | Cron 保活 | CF 控制台确认 `*/5` cron 在跑、SUB_TOKEN secret 存在 |

### 变更流程（改任何服务端逻辑）

0. 编辑本地 `src/index.plain.js`（不入库）→ `npm run obfuscate` 重新生成 `index.js`（**只改明文，产物由脚本生成，勿手改 index.js，勿 commit src**）
1. 本地 `SHOW_LOG=1 PORT=3997 node --env-file=.env index.js` + `node test-live.js localhost:3997` + xray 本地实例（socks 12080→本地）双验证
2. `git push origin main` → Vercel 自动重新部署（等 ~60-90s）
3. 生产 `node test-live.js` 回归
4. **旧实例清理**：本地重启前先按 3997 端口 kill，防 EADDRINUSE 静默连旧代码

---

## 十、已知边界与 TODO

**边界**
- 单 WS 连接 ≤280s 主动重连（Vercel 300s 硬顶），长下载周期掐线
- 不支持 UDP/QUIC（cmd=0x02 的 UDP 帧当前按 TCP 处理，未实现完整 UDP 中继）
- 出口为 Vercel 共享 IP 段，敏感账号登录慎用；Vercel Hobby ToS 禁代理用途——控制面(CF)/数据面(Vercel)分离，封号仅需重建项目换域名
- SS-over-WS 死代码已删除（服务端仅有地址解析、无 v2ray-plugin 握手解密层，订阅从未分发；保留会成为零鉴权开放中继）

**TODO（按优先级）**
1. **xray 独立化 + systemd 用户服务**：复制二进制到 `~/.local/bin/xray`，建 `~/.config/systemd/user/poxy-xray.service`（ExecStart 指向 `~/.config/poxy-client/config.json`，Restart=always），`systemctl --user enable`。之后可完全移除 V2rayN
2. **流量清洗层**（既定下一步）：`worker/_worker.js` 叠加扫描器 ASN/Bot Score 过滤、订阅端点速率限制、KV 流量计数、诱饵内容升级
3. C2 方向改造：CF Worker 规则引擎按 header/path 特征分流到不同 Vercel 项目或 cloudflared Access 后端（现有 `ssh.eamonsong.de5.net` 链路）
4. 协议演进：xray 已弃用 WS（启动日志警告 "migrate to XHTTP"），后续节点可加 XHTTP over CF 支持
5. **凭据轮换**（外置已完成，轮换待做）：
   - 2026-09-27 已完成外置：源码/混淆产物零凭据，仅存 Vercel Production env（UUID/SUB_PATH/SUB_TOKEN/DOMAIN/NAME）
   - 遗留：旧值仍在 git 历史 commit `fe19b3b`~`1c8b449` 明文可查（仓库 private 风险有限）。彻底安全：生成新 UUID/SUB_TOKEN/SUB_PATH → 更新 Vercel env(Production) + CF secret(SUB_TOKEN) + wrangler var(SUB_PATH) + 客户端 config → Redeploy → 验证 → `git filter-repo` 清历史或重建仓库。另：sudo 密码曾在对话暴露，建议修改
