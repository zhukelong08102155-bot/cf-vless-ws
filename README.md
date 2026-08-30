# cf-vless-ws

在 **Cloudflare Workers 免费计划**上跑一个 VLESS-over-WebSocket 服务端，把它变成你自己的网络出口。

不到 300 行 JavaScript，不需要服务器、不需要信用卡、不花一分钱。

## 为什么需要这个

有些在线服务按来源地区限制访问。你可能已经有一个能出网的工具，但它的出口 IP 段在 GeoIP 库里被判为受限地区，请求照样被拒。

换个出口节点往往没用 —— 因为问题不在"能不能连上"，而在"对方认为你从哪来"。

Cloudflare Workers 的 `cloudflare:sockets` 走的是普通边缘出口，和 WARP 这类产品的出口段完全不同，GeoIP 判定也不同。实测：

```
$ curl https://<你的 worker 域名>/<WS_PATH>
{
  "status": "alive",
  "egress": {
    "ip": "162.158.186.239",
    "country": "US",
    "city": "Los Angeles",
    "org": "AS13335 Cloudflare, Inc."
  }
}
```

## 快速开始

### 1. 准备

```bash
npm install -g wrangler
wrangler login
wrangler whoami      # 记下 account_id
```

生成两个随机值：

```bash
python -c "import uuid,secrets,string; print(uuid.uuid4()); print('/' + ''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(18)))"
```

### 2. 部署

```bash
git clone https://github.com/wujunjr/cf-vless-ws.git
cd cf-vless-ws
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml，填 account_id / UUID / WS_PATH
wrangler deploy
```

### 3. 验证出口

```bash
curl https://<你的域名>/<WS_PATH>
```

看到 `country` 是预期国家就成了。**别用 `api.ipify.org` 验证** —— 它对 Cloudflare 出口会超时，会让你误判为失败。

### 4. 挂自定义域名（推荐）

`workers.dev` 偶尔会被干扰。挂个自己的子域名更稳，免费计划就支持。

前置条件：域名 DNS 托管在 Cloudflare；必须是**子域**（不支持裸域）。

Dashboard 路径：`Workers & Pages` → 你的 Worker → `Settings` → `Domains & Routes` → `Custom Domains` → `Add`。会自动建 DNS 记录并签发证书，1-3 分钟变 Active。

### 5. 配客户端

复制 `examples/mihomo.yaml`，替换 `YOUR_DOMAIN` / `YOUR_UUID` / `YOUR_WS_PATH` 三处。

```bash
mihomo -f config.yaml -d .     # 先跑 -t 做配置校验也行
curl -x socks5h://127.0.0.1:7897 https://cloudflare.com/cdn-cgi/trace
```

## 客户端怎么接

这个 Worker 只是一个**出口**。你的应用怎么把流量送进来，是另一件事，取决于它是什么程序。

| 应用类型 | 怎么接 |
|---|---|
| 读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量的命令行程序 | 直接设环境变量 |
| 走系统代理的浏览器和多数 GUI 应用 | 系统设置里指向 `127.0.0.1:7897` |
| VS Code 系的编辑器（Cursor、Windsurf 等） | 设置里的 `http.proxy` |
| **不读环境变量、不读系统设置的独立应用** | 见下 |

最后一类最麻烦，也最常见：很多现代编辑器是 Electron 应用，真正发请求的后台服务是独立的编译型二进制，它既不看环境变量也不看图形界面的代理设置。

这类情况的通用解法是**进程级代理**：在目标进程里注入一个钩子，接管它的 socket 调用。Windows 上的典型做法是放一个 `version.dll` 到目标 exe 同目录（Windows 的 DLL 搜索顺序会优先查这里），配 MinHook 钩住 `WS2_32.dll`。

几个要点，踩过：

- **放哪比放不放更重要**。放到主程序目录，它可能连前端和后台之间的本地通信一起劫持，界面直接黑屏。放到后台服务那个子目录，作用域才精确。
- **DNS 要走代理**（`dns_mode = proxy`）。走本地直连的话，被污染的 DNS 会把你带回去。
- **没有可用 IPv6 就把 IPv6 关掉**（`ipv6_mode = block`）。
- **应用自动更新会清空那个目录**。更新之后记得重新放。

## 三个实现上的坑（改代码前必读）

这三个坑都在 `src/index.js` 顶部注释里，改代码前务必看一眼。简要版：

1. **必须用 `ReadableStream` + `pipeTo` 消费 WebSocket**。用 `addEventListener` 逐帧处理的话，每个 message 回调都是独立的 invocation，异步链一结束 socket 就被回收 —— 表现为"能建连、能收数据，但一写数据就断"。
2. **不能 `await socket.opened`**。直接 `getWriter().write()`，CF 会在握手完成后自动发出。
3. **`event.data` 必须在同步阶段深拷贝**。CF 会在回调返回后回收其缓冲。

## 限制

- Workers 免费计划：每次请求 **10ms CPU**，每天 10 万次请求。大文件传输可能超时。
- 协议范围：VLESS v0，仅 TCP，**无 UDP / XUDP，无 early data**。
- Durable Objects 解决不了 socket 被回收的问题 —— 根因是 invocation 生命周期，不是实例生命周期。

## 风险与合规

用 Workers 做代理处于 Cloudflare ToS 的灰区。自用、小流量一般没问题，但请不要大规模分发或商用。

本项目仅用于技术研究和学习。请遵守你所在地以及服务提供方所在地的法律法规，以及 Cloudflare 和各目标服务的服务条款。作者不对任何滥用行为负责。

## 目录

```
src/index.js               Worker 源码
wrangler.toml.example      配置模板（复制为 wrangler.toml 后填值）
examples/mihomo.yaml       客户端配置示例
docs/troubleshooting.md    排障手册：五个反直觉的坑
```

## License

MIT
