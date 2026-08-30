/**
 * VLESS-over-WebSocket 服务端（Cloudflare Workers）
 *
 * 干什么用
 * --------
 * 把 Cloudflare Workers 变成你自己的一个网络出口。典型场景：某些在线服务按来源
 * 地区限制访问，而你手上的公共出口（含 Cloudflare WARP 的 104.28.0.0/16、
 * 2a09:bac5::/48 等段）在 GeoIP 库里被判为受限地区，于是请求被拒。
 *
 * 本 Worker 走 cloudflare:sockets 的普通边缘出口（实测判为美国），
 * 因此可以通过这类地区闸门。全部跑在 Workers 免费计划上，零成本。
 *
 * 链路
 * ----
 *   本地客户端 (mihomo / sing-box / Clash)
 *     -> VLESS + WebSocket + TLS
 *     -> 本 Worker
 *     -> cloudflare:sockets connect()
 *     -> 目标站点
 *
 * 改动前必读的三个坑
 * ------------------
 * 1) 必须用 ReadableStream + pipeTo 消费 WebSocket，让整条会话成为一条永不结束的
 *    异步链。若改用 addEventListener 逐帧处理，每个 message 回调都是独立的
 *    invocation，其异步链一结束 socket 就被回收 —— 表现为"能建连、能收到服务端
 *    主动推的数据，但客户端一写数据就断"。
 * 2) 不能 await socket.opened。直接 getWriter().write()，CF 会在握手完成后自动发出。
 * 3) event.data 必须在事件回调的同步阶段深拷贝。CF 会在回调返回后回收其缓冲。
 *
 * 协议范围：VLESS v0，仅 TCP（command = 0x01），无 UDP/XUDP，无 early data。
 */

import { connect } from 'cloudflare:sockets';

function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** 解析 VLESS 请求头，返回目标地址与 payload 起始偏移 */
function parseVlessHeader(buf) {
  if (buf.byteLength < 24) return null;
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let off = 0;

  const version = dv.getUint8(off);
  off += 1;
  if (version !== 0) return null;

  const uuidHex = bytesToHex(u8.subarray(off, off + 16));
  off += 16;

  const addonLen = dv.getUint8(off);
  off += 1 + addonLen; // 不使用 addon，直接跳过

  const command = dv.getUint8(off);
  off += 1;
  if (command !== 0x01) return null; // 只支持 TCP

  if (off + 3 > buf.byteLength) return null;
  const port = dv.getUint16(off);
  off += 2;

  const addrType = dv.getUint8(off);
  off += 1;

  let addr = '';
  if (addrType === 0x01) {
    // IPv4
    if (off + 4 > buf.byteLength) return null;
    addr = `${u8[off]}.${u8[off + 1]}.${u8[off + 2]}.${u8[off + 3]}`;
    off += 4;
  } else if (addrType === 0x02) {
    // 域名
    if (off + 1 > buf.byteLength) return null;
    const len = dv.getUint8(off);
    off += 1;
    if (off + len > buf.byteLength) return null;
    addr = new TextDecoder().decode(u8.subarray(off, off + len));
    off += len;
  } else if (addrType === 0x03) {
    // IPv6
    if (off + 16 > buf.byteLength) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(dv.getUint16(off).toString(16));
      off += 2;
    }
    addr = parts.join(':');
  } else {
    return null;
  }

  return { uuidHex, command, port, addr, payloadOffset: off };
}

/**
 * 把 WebSocket 包装成 ReadableStream。
 * 这是让 socket 存活的关键：外层用 pipeTo 消费它，整条链就不会结束。
 */
function makeReadableWebSocketStream(ws) {
  let controller = null;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    pull() {
      /* 由 WS 事件驱动 enqueue，无需主动拉取 */
    },
    cancel() {
      try {
        ws.close();
      } catch {}
    },
  });

  ws.addEventListener('message', (event) => {
    const raw = event.data;
    if (typeof raw === 'string') return;
    try {
      // 同步深拷贝：CF 会在事件回调返回后回收 event.data 的缓冲
      let bytes;
      if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw.slice(0));
      else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.slice().buffer);
      else return;
      controller.enqueue(bytes);
    } catch (e) {
      /* 流已关闭，忽略 */
    }
  });

  ws.addEventListener('close', () => {
    try {
      controller.close();
    } catch {}
  });
  ws.addEventListener('error', () => {
    try {
      controller.error(new Error('ws error'));
    } catch {}
  });

  return stream;
}

function safeClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wsPath = env.WS_PATH || '/';

    // 路径校验前置：非约定路径一律 404。
    // 否则等于对外广播"这里有个隧道"——健康检查只应在约定路径上应答。
    if (url.pathname !== wsPath) {
      return new Response('Not Found', { status: 404 });
    }

    // 健康检查 / 出口自检：浏览器打开约定路径就能看到出口被判成哪个国家
    if (request.headers.get('Upgrade') !== 'websocket') {
      const info = await fetch('https://ipinfo.io/json', { cf: { cacheTtl: 0 } })
        .then((r) => r.json())
        .catch(() => null);
      return Response.json(
        {
          status: 'alive',
          egress: info
            ? { ip: info.ip, country: info.country, city: info.city, org: info.org }
            : null,
          hint: '用 mihomo / sing-box 的 vless+ws+tls 出站连这个地址',
        },
        null,
        2
      );
    }

    const expected = String(env.UUID || '').replace(/-/g, '').toLowerCase();
    if (!expected) {
      return new Response('server misconfigured: UUID not set', { status: 500 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let remoteSocket = null;
    let firstFrame = true;

    // 注意：这里不 await。pipeTo 的 promise 一直挂着，
    // 整条会话因此保持为一个未结束的异步链，socket 才不会被回收。
    makeReadableWebSocketStream(server)
      .pipeTo(
        new WritableStream({
          async write(chunk) {
            if (!firstFrame && remoteSocket) {
              const w = remoteSocket.writable.getWriter();
              await w.write(chunk);
              w.releaseLock();
              return;
            }

            const info = parseVlessHeader(chunk.buffer);
            if (!info) {
              safeClose(server, 1002, 'bad vless header');
              return;
            }
            if (info.uuidHex !== expected) {
              safeClose(server, 1008, 'auth failed');
              return;
            }

            const socket = connect({ hostname: info.addr, port: info.port });
            remoteSocket = socket;
            firstFrame = false;

            // 不等 opened，直接写：CF 会在握手完成后自动发出
            const w = socket.writable.getWriter();
            if (info.payloadOffset < chunk.byteLength) {
              await w.write(chunk.subarray(info.payloadOffset));
            }
            w.releaseLock();

            // VLESS 响应头：version(0) + addon length(0)
            try {
              server.send(new Uint8Array([0x00, 0x00]).buffer);
            } catch {}

            // socket -> ws
            socket.readable
              .pipeTo(
                new WritableStream({
                  write(c) {
                    try {
                      server.send(c);
                    } catch {}
                  },
                  close() {
                    safeClose(server, 1000);
                  },
                  abort() {
                    safeClose(server, 1000);
                  },
                })
              )
              .catch(() => {});
          },
          close() {
            try {
              if (remoteSocket) remoteSocket.close();
            } catch {}
          },
          abort() {
            try {
              if (remoteSocket) remoteSocket.close();
            } catch {}
          },
        })
      )
      .catch(() => {});

    return new Response(null, { status: 101, webSocket: client });
  },
};
