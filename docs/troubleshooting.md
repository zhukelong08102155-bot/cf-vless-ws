# 排障手册

这篇记的是"看起来配置没错，但就是不通"的那类问题。每一条都是实测踩出来的，
按踩坑的痛苦程度排序。

---

## 坑 -1：两个接管网络的工具不能共存，而且输赢不看 metric

**现象**：开了客户端的虚拟网卡（TUN），`route print` 里确实有规则，但流量还是走老路，
目标服务依旧拒绝。

**根因**：Windows 选路由时，**最长前缀匹配优先于 metric**。

一个虚拟网卡工具会推送上千条具体路由：

```
1.0.0.0/24        ...   metric 261
142.250.0.0/15    ...   metric 261
```

而你的 TUN 客户端推的是两条 halves：

```
0.0.0.0/1         ...   metric 0
128.0.0.0/1       ...   metric 0
```

metric 0 看起来"更强"，但 `142.250.0.0/15` 是 /15，比 /1 **长得多**。最长前缀匹配
先被评估，于是具体路由直接胜出，你的 TUN 被完全绕过。

**诊断**：

```powershell
route print | findstr /i "0.0.0.0"
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object Name, ifIndex
```

**对策**：二选一。

| 方案 | 代价 |
|---|---|
| 关掉另一个工具，只用 TUN | 需要管理员；那个工具负责的其他能力（比如登录、干净 DNS）会一起没 |
| **不用 TUN，只开普通本地代理，再单独把目标进程接进来** | 不用管理员；两个工具可以共存 |

第二个方案通常是更好的那个：只在需要的地方生效，不去动全局路由表。

---

## 坑 0：境内 DNS 对境外域名是被污染的

**现象**：域名一会儿通一会儿不通；同一个域名查两次，返回两个完全不同的 IP。

**实测**（2026-08-30，某境内公共 DNS）：

| 查询 | 返回 |
|---|---|
| `www.google.com` | `2001::1`（Teredo 占位地址） |
| `*.workers.dev` 第一次 | `98.159.108.58` |
| `*.workers.dev` 第二次 | `2a03:2880:...`（Facebook 的地址段） |
| `www.qq.com`（对照） | 正常 |

**注意别拿国内域名当对照组** —— 它正常反而是最有迷惑性的地方。

**对策**：

- 客户端的 DNS 填公共 DNS（`1.1.1.1` / `8.8.8.8`），别填本地运营商的。
- UDP 53 也被干扰的话，换 DoH：`https://1.1.1.1/dns-query`。
- **推论**："关掉某个工具走直连"这类方案，会连干净 DNS 一起丢掉。评估方案时别漏算这一层。

---

## 坑 1：IPv6 会让你的测试假阴性

**现象**：命令行直连能通，走代理就不通。日志里却显示连接确实被接住了。

**根因**：本地解析器会返回 AAAA 记录，客户端优先走 IPv6，于是请求代理去连一个
IPv6 字面量；而代理配置里 `ipv6: false`，直接丢掉。

日志铁证：

```
[TCP] 127.0.0.1:55861 --> [2001:4860:4828:7700::]:443 match Match using TUNNEL[cf-egress]
```

**对策**：

- 代理配置里关掉 IPv6（`ipv6: false`，DNS 段也设 `ipv6: false`）。
- 进程级代理组件里设 `ipv6_mode = block`。
- 测试时用**远端 DNS** 复刻真实路径：`curl -x socks5h://...`（注意是 `socks5h`，
  `h` 表示主机名交给代理解析）。用 `socks5://` 会先在本地解析，复现不出真实行为。
- PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，行为不一样。用 `curl.exe`。

---

## 坑 2：验证工具本身也会骗你

**现象**：出口检测网站超时，你以为隧道挂了，其实是那个网站不理 Cloudflare 的出口。

- `api.ipify.org` —— 对 Cloudflare 出口会超时（代理日志里能看到连接已被接住并转发，
  是对方不回）。**别用它验证。**
- 改用 `https://cloudflare.com/cdn-cgi/trace`（返回 `ip=` / `colo=` / `loc=`）
  或 `https://domains.google.com/checkip`。

**更重要的推论**：判断依据要选"有区分度"的那个。

比如验证某个 AI 服务是否已经放行：

| 状态码 | 含义 |
|---|---|
| **401** | 请求到了，只是没带凭证 —— **地区闸门已开** |
| **400** | `User location is not supported` —— 仍然被拦 |

401 和 400 的区别是 100% 有区分度的，比"能不能 ping 通"可靠得多。

---

## 坑 3：载体域名必须直连，而且要放在规则最前面

**现象**：Cloudflare 返回 `400 Bad Request`。

**根因**：隧道流量绕回了自己。客户端要去连载体域名，结果规则把它也送进了隧道，
于是隧道请求隧道，成环。

**对策**：规则第一条就写

```yaml
- DOMAIN-SUFFIX,<你的载体域名>,DIRECT-OUT
```

配套：如果开了 `fake-ip` 模式，还要把载体域名加进 `fake-ip-filter`。
否则它会拿到 `198.18.x` 的假 IP，一样成环。

**换域名时要改 5 处**，漏一处就翻车：

| 位置 | 漏了的后果 |
|---|---|
| `server:` | 连错地方 |
| `servername:` | TLS SNI 不对 |
| WS 的 `Host:` 头 | 自定义域场景下 404 / 400 |
| `dns.fake-ip-filter` | 成环，400 |
| 规则里的 `DIRECT-OUT` | 成环，400 |

---

## 坑 4：`fake-ip` 模式下，`GEOIP` 规则会失效

**现象**：明明配了国内直连，国内网站也走了隧道。

**根因**：`fake-ip` 模式下，连接目标是 `198.18.x` 的假 IP。`GEOIP` 规则按 IP 匹配，
匹配到的是假 IP，判断全错。

**对策**：用按域名匹配的规则 —— `GEOSITE` 或 `DOMAIN-SUFFIX`。

```bash
# geosite.dat
https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat
```

---

## 坑 5：Windows 上，非 ASCII 字符能静默破坏你的脚本

**现象**：PowerShell 报"缺少右花括号""意外的标记"，而且**行号是错的**。

**根因**：PowerShell 5.1 读取**无 BOM 的 UTF-8** `.ps1` 时，按 ANSI/GBK 解码。

中文句号 `。` 是 `E3 80 82`。如果它后面紧跟一个引号 `"`（0x22）——
0x22 不在 GBK 合法尾字节范围（0x40–0x7E / 0x80–0xFE）内 —— 解码器会把引号一起吞掉，
字符串就此不闭合，后面的报错全部错位。

**对策**：交给 Windows 的 `.ps1` / `.bat` **一律纯 ASCII**。

自检：

```powershell
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  "$PWD\x.ps1", [ref]$null, [ref]$errs) | Out-Null
$errs.Count
```

```bash
# 非 ASCII 字节数，应为 0
python -c "print(sum(1 for b in open('x.ps1','rb').read() if b > 127))"
```

---

## 一条排查顺序

卡住的时候按这个走，别跳步：

1. **先证明隧道本身是活的**：`curl https://<域名>/<WS_PATH>`，看 `country` 字段。
2. **再证明 WebSocket 能升级**：

   ```bash
   curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        https://<域名>/<WS_PATH>
   ```

   期望 `HTTP/1.1 101 Switching Protocols`。这两步过了，服务端就没问题。
3. **然后证明客户端规则对**：看日志里的 `match ... using ...`，确认目标走了对的出站。
4. **最后才怀疑应用**：那个进程到底有没有被接进来。

每一步都有独立判据，就不会在错误的层上找问题。
