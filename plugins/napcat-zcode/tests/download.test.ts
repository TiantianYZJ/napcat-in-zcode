/**
 * M3 Task 1：制品下载器（直连 + HTTP 代理 CONNECT 隧道）+ sha256 校验。
 *
 * **全程不联网**：假源站 / 假代理都用 `node:http` / `node:net` 在 127.0.0.1 上现起，
 * 端口取 0（随机），避免与本机真实 NapCat（3000/6099）或真实代理（7897）撞车。
 *
 * 覆盖五层：
 * ① **出网红线**：资源地址 / 代理地址的准入判定（含各种 IP 字面量写法、userinfo、unicode 主机名）；
 * ② **下载链路**：直连 / 代理 CONNECT 隧道 / 重定向（含跳数上限）/ 进度 / 超时 / sha256 校验；
 * ③ **失败清理**：校验不过、超时、被中止、长度不符时都不能留下半成品文件；
 * ④ **连接阶段也要能超时**：代理连上了却不回 CONNECT —— 不许把后台作业挂死；
 * ⑤ **测试入口的闸门**：运行时（非 VITEST 直接失败）+ 静态（`src/` 里不许出现）。
 *
 * 关于 `downloadVerifiedForTest`：
 * 产品路径 `downloadVerified` **必须**拒绝回环/内网资源地址（出网红线），
 * 而单测的假服务器只能跑在回环地址上——两者直接冲突。
 * 故测试入口只放宽**一个方向**：它**只允许回环**资源地址，
 * 也就是说它永远不可能被用来从公网拉东西（与产品路径的方向正好相反）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tcpConnect, createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDownloadUrlAllowed,
  assertProxyUrlAllowed,
  classifyHost,
  downloadVerified,
  downloadVerifiedForTest,
  type DownloadProgress,
} from '../src/server/host/download.js';

// ── 测试用自签证书（仅本机回环，TLS 校验在该用例里被显式关闭） ──────

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUFA/ybNz/k7TJuHYB3RWjAEw4CU4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMTA2MTc0NloYDzIxMjYx
MDI4MDYxNzQ2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDB3eZtuK61D+3v1mLmIRuTKeXCY8p5GWrSfLomBvhh
YtC8HOdSrFgtGkmOMx4o2TXnCC2HdI5oe0rfnkLVWBwKOPYScbEbdAQGZFpJofOI
pF3WlYE6Hrm/eJTybzaIhi7EFUpUKyKPSvCknspwC5kI7U7Ie3x1PNRdpuc2iuP7
N8AjlkKH0IdfWd8NEBfSElV/SFHHp3zX9VpGt4Nkbz5+UCR+oVMVv+Ai0k4SgvOu
9ZGV5LQQk9ew2yOULNQn6LkV49qYZ7toJi9Ip8D0gASh8ABESkoQsU4xC1uUT+8q
9T7J8rCx/GoJqnwBifzk23ZNAvww6dbRkiQVx+fD4AObAgMBAAGjbzBtMB0GA1Ud
DgQWBBSPGFS5hxBSbnHPi7QEcHbSY9ntPjAfBgNVHSMEGDAWgBSPGFS5hxBSbnHP
i7QEcHbSY9ntPjAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAns/P3nLbUCS2ntS0Hbvq8yNXUkq9
en7+pHHSNHhT52tX8hSR1bBy2f1Js+pkFHAB7mP+qcq+mQaep03JwzcLIDahXEIw
a73rX/fkT21WnGJTmrbpPZPjQEm+31SD5v7YT8XiBii2B4mj2O6FF9uK3co5xLsG
kaZ6Ix3rlNBX7qq65DKAZJwwqFTSSY8j98tch3BTFCIiNztUN+JyHzkSeZhn2XA1
tg74yuRyNOfuFmSODuJ95g+mlOpQAYCJgQBQsoiN3qPMRCyMGGpE6MXu66aau5l+
hoznkXDXNWSuWy2LYPaSJTfLs+r/oYgMjLik52xRWD55Xs9ll9uB1XYg2A==
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDB3eZtuK61D+3v
1mLmIRuTKeXCY8p5GWrSfLomBvhhYtC8HOdSrFgtGkmOMx4o2TXnCC2HdI5oe0rf
nkLVWBwKOPYScbEbdAQGZFpJofOIpF3WlYE6Hrm/eJTybzaIhi7EFUpUKyKPSvCk
nspwC5kI7U7Ie3x1PNRdpuc2iuP7N8AjlkKH0IdfWd8NEBfSElV/SFHHp3zX9VpG
t4Nkbz5+UCR+oVMVv+Ai0k4SgvOu9ZGV5LQQk9ew2yOULNQn6LkV49qYZ7toJi9I
p8D0gASh8ABESkoQsU4xC1uUT+8q9T7J8rCx/GoJqnwBifzk23ZNAvww6dbRkiQV
x+fD4AObAgMBAAECggEAPtPiFJbwj5889igdXwVFwXinjEr42CwjkVl4nlBN+Imk
qgIX+ZP+84b8ZYgtcwGJ1XiyAJ8Gc9fZGQVaFXf7hliVbr7HreT4VPX6yLgii5rx
ClTjT2mbuvCiHLtsCeyqhUN9Fi/wgE3CFSec5ZjsnJcDnDdgy0HOdRddATEb11LW
huSDn/sC/DajaXy5jAByL8OTZ7QAefRI8StbTGvyTmSvvuwiCAL09alpgNZblKGv
9LByEcIOJlcc8lwH+O0PgsvjawVshYHFYmQntsdPBiR0L55MBzysB4ljzlLwZh6c
BR+tuI8nqqyzLWzWrf0AZVTRgk/P1HlI2NczI06kSQKBgQDmtWw0pZCE8wsw7lEO
jUl2YjMva6hZiiI3H9UwnsXCyw6V8x+qTagDakXEnFOEmrJF7BYAHNQwBasUaAsq
sx6CqKPRFDF5m5xCET+iBp0+HMRBmfhSmdqxvtbZisoiBLRczGFnDH9pDzu2UzC4
6ZXQlY9qwRInKjV5U+suhDJFxQKBgQDXHo0/I8CFqzGl9WCuvVqX+PYw/RuwpDnF
u70b8cADm+7bgo1mV5Noqg5yBuxHqj0kLBMbuoShjYumGRyVYD0WWsqvBXkxywQ7
lcP3NuR0CLb+Gdfxfcvz6hUIXNN55YbyaQnSkayWZ7EBwNBsVoshRV1IkriM/0DV
A762D4EZ3wKBgAUCZXITMjsgx9ptIkdtm+29Hh1megZPsIR/5XIj0Gl1XUC2QbbB
7ub8FL27Izka3soT4TppZdYRGXDc/XkU4JG3ta7hgF2Cmnb4xufuutVRbJV8EV9B
xfTcDvA0SkVI0t289lR1egK++O3xinpJYB5iUPXhcVJ2YSjcQJwG9Mx9AoGASUUc
su7Iej7PEEm9fob8PlsL76+mKMom61SAmu4Cirgn6RhUdRFLIhEaDniRLe+sF4/z
ijRDTItbj11qQO6gn+aYtnhUyULu1CS0tJU7xtHZEj9XL+e6+f823rxPQ2uMRTDF
qbT4Zdo3jfNQijYH+XMYzMk8lrmyKVu3L2ekf10CgYEA2YqEUABY1+i5davGkj1L
z99b8LTEKunLkfWBDvDevy1HCXCb+MwB4jlg/vavXRqdwOqu+EajJAsbDGSdiaYn
GNZgPCMcphViXLKQbz1e/TDjMT63+D06YEHCSdUV4MDahWnTvtIR2DstRWES+x++
a+FU1YJt4DRiqXh0meaMiIA=
-----END PRIVATE KEY-----`;

// ── 假源站 / 假代理 ────────────────────────────────────────────────

interface FakeServer {
  port: number;
  /** 服务端收到的请求路径（用来断言重定向是否被跟随）。 */
  requests: string[];
  close(): Promise<void>;
}

async function startFakeServer(
  kind: 'http' | 'https',
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FakeServer> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    requests.push(req.url ?? '');
    try {
      handler(req, res);
    } catch {
      /* 客户端已断开 */
    }
  };
  const server =
    kind === 'https'
      ? createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, onRequest)
      : createHttpServer(onRequest);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

interface FakeProxy {
  port: number;
  /** 代理收到的 CONNECT 请求行（用来断言隧道握手）。 */
  connects: string[];
  close(): Promise<void>;
}

/** 假 HTTP 代理：只实现 CONNECT 隧道（把隧道里的字节原样转发到目标）。 */
async function startConnectProxy(): Promise<FakeProxy> {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {
      /* 客户端断开 */
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      sock.off('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const leftover = buf.subarray(idx + 4);
      const line = head.split('\r\n')[0] ?? '';
      connects.push(line);
      const m = /^CONNECT\s+(\S+):(\d+)\s+HTTP/i.exec(line);
      if (!m) {
        sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const upstream = tcpConnect(Number(m[2]), m[1]);
      upstream.on('error', () => sock.destroy());
      upstream.on('connect', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (leftover.length > 0) upstream.write(leftover);
        sock.pipe(upstream);
        upstream.pipe(sock);
      });
    };
    sock.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connects,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** 假代理：接受 TCP 连接但**永远不回应 CONNECT**（半死代理）。 */
async function startSilentProxy(): Promise<FakeProxy> {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {
      /* 客户端断开 */
    });
    sock.on('data', (chunk: Buffer) => {
      connects.push(chunk.toString('latin1').split('\r\n')[0] ?? '');
      // 什么都不回：连接挂着但不回应
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connects,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** 递归列出目录下的 .ts 文件。 */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) collectTsFiles(full, out);
    else if (item.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 去掉注释（只保留真正的代码）——用来判断「有没有真的用到某个符号」。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ── 用例 ────────────────────────────────────────────────────────────

const PAYLOAD = Buffer.from('NapCat artifact payload — 制品字节流 '.repeat(64));
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/**
 * https 用例用的是测试自签证书：整个文件里临时关掉证书校验（用完还原）。
 *
 * Node 在**建连时**读这个环境变量，所以必须在任何 TLS 连接发生之前设好。
 */
const savedTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
beforeAll(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});
afterAll(() => {
  if (savedTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsSetting;
});

describe('M3 Task 1：下载器', () => {
  let workDir: string;
  const servers: FakeServer[] = [];
  const proxies: FakeProxy[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'napcat-download-'));
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const p of proxies.splice(0)) await p.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  const track = async (server: FakeServer): Promise<FakeServer> => {
    servers.push(server);
    return server;
  };
  const trackProxy = async (proxy: FakeProxy): Promise<FakeProxy> => {
    proxies.push(proxy);
    return proxy;
  };

  // ── ① 出网红线：资源地址 ────────────────────────────────────────

  describe('资源地址校验', () => {
    it('只放行 http/https', () => {
      expect(() => assertDownloadUrlAllowed('ftp://github.com/x.zip', ['github.com'])).toThrow(/http/);
      expect(() => assertDownloadUrlAllowed('file:///C:/x.zip', ['github.com'])).toThrow(/http/);
      expect(() => assertDownloadUrlAllowed('not-a-url', ['github.com'])).toThrow();
    });

    it('拒绝回环地址', () => {
      expect(() => assertDownloadUrlAllowed('http://127.0.0.1/x.zip', ['127.0.0.1'])).toThrow(/回环/);
      expect(() => assertDownloadUrlAllowed('http://127.5.6.7/x.zip', ['127.0.0.1'])).toThrow(/回环/);
      expect(() => assertDownloadUrlAllowed('http://localhost/x.zip', ['localhost'])).toThrow(/回环/);
      expect(() => assertDownloadUrlAllowed('http://[::1]/x.zip', ['::1'])).toThrow(/回环/);
    });

    it('拒绝 IPv4-mapped IPv6 回环（::ffff:127.0.0.1）', () => {
      // URL 解析器会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1
      // → 字符串匹配认不出来，必须展开成 8 组再判
      expect(() => assertDownloadUrlAllowed('http://[::ffff:127.0.0.1]/x.zip', ['::ffff:127.0.0.1'])).toThrow(
        /回环/,
      );
      expect(classifyHost('::ffff:7f00:1')).toBe('loopback');
      expect(classifyHost('::ffff:127.0.0.1')).toBe('loopback');
    });

    it('拒绝 IPv4-mapped IPv6 内网（::ffff:10.0.0.1）', () => {
      expect(() => assertDownloadUrlAllowed('http://[::ffff:10.0.0.1]/x.zip', ['::ffff:10.0.0.1'])).toThrow(
        /内网/,
      );
      expect(classifyHost('::ffff:a00:1')).toBe('private');
    });

    it('拒绝各种 IP 字面量写法（十进制 / 十六进制 / 八进制 / 省略写法）', () => {
      // WHATWG URL 解析器会把这些都规范化成 127.0.0.1
      expect(() => assertDownloadUrlAllowed('http://2130706433/x.zip', ['2130706433'])).toThrow(/回环/);
      expect(() => assertDownloadUrlAllowed('http://0x7f000001/x.zip', ['0x7f000001'])).toThrow(/回环/);
      expect(() => assertDownloadUrlAllowed('http://0177.0.0.1/x.zip', ['0177.0.0.1'])).toThrow(/回环/);
      expect(() => assertDownloadUrlAllowed('http://127.1/x.zip', ['127.1'])).toThrow(/回环/);
    });

    it('拒绝地址里带账号密码（userinfo）', () => {
      expect(() => assertDownloadUrlAllowed('http://user:pass@github.com/x.zip', ['github.com'])).toThrow(
        /账号密码/,
      );
      // 「evil.com@127.0.0.1」看起来像 evil.com，实际主机是 127.0.0.1
      expect(() => assertDownloadUrlAllowed('http://evil.com@127.0.0.1/x.zip', ['127.0.0.1'])).toThrow(
        /回环|账号密码/,
      );
    });

    it('unicode 主机名转 punycode 后不在清单内 → 拒绝', () => {
      expect(() => assertDownloadUrlAllowed('http://例え.テスト/x.zip', ['github.com'])).toThrow(/不在允许/);
      // 清单里写 punycode 形式则可以匹配（清单是代码侧写死的公网域名）
      expect(assertDownloadUrlAllowed('http://例え.テスト/x.zip', ['xn--r8jz45g.xn--zckzah']).hostname).toBe(
        'xn--r8jz45g.xn--zckzah',
      );
    });

    it('拒绝内网地址', () => {
      expect(() => assertDownloadUrlAllowed('http://10.0.0.1/x.zip', ['10.0.0.1'])).toThrow(/内网/);
      expect(() => assertDownloadUrlAllowed('http://172.16.0.1/x.zip', ['172.16.0.1'])).toThrow(/内网/);
      expect(() => assertDownloadUrlAllowed('http://172.31.255.1/x.zip', ['172.16.0.1'])).toThrow(/内网/);
      expect(() => assertDownloadUrlAllowed('http://192.168.1.1/x.zip', ['192.168.1.1'])).toThrow(/内网/);
      expect(() => assertDownloadUrlAllowed('http://169.254.1.1/x.zip', ['169.254.1.1'])).toThrow(/内网/);
      expect(() => assertDownloadUrlAllowed('http://[fc00::1]/x.zip', ['fc00::1'])).toThrow(/内网/);
    });

    it('拒绝保留地址', () => {
      expect(() => assertDownloadUrlAllowed('http://0.0.0.0/x.zip', ['0.0.0.0'])).toThrow(/保留/);
    });

    it('host 不在允许清单内 → 拒绝', () => {
      expect(() => assertDownloadUrlAllowed('https://evil.example.com/x.zip', ['github.com'])).toThrow(/允许/);
    });

    it('允许清单大小写不敏感；放行清单内的公网地址', () => {
      const url = assertDownloadUrlAllowed('https://GitHub.com/org/repo/releases/x.zip', ['github.com']);
      expect(url.hostname).toBe('github.com');
      expect(url.protocol).toBe('https:');
      expect(
        assertDownloadUrlAllowed('https://objects.githubusercontent.com/x.zip', ['objects.githubusercontent.com']).hostname,
      ).toBe('objects.githubusercontent.com');
    });
  });

  // ── ② host 分类 ────────────────────────────────────────────────

  describe('host 分类', () => {
    it('分清公网 / 回环 / 内网 / 保留', () => {
      expect(classifyHost('github.com')).toBe('public');
      expect(classifyHost('objects.githubusercontent.com')).toBe('public');
      expect(classifyHost('127.0.0.1')).toBe('loopback');
      expect(classifyHost('127.255.255.254')).toBe('loopback');
      expect(classifyHost('localhost')).toBe('loopback');
      expect(classifyHost('::1')).toBe('loopback');
      expect(classifyHost('10.0.0.1')).toBe('private');
      expect(classifyHost('172.16.0.1')).toBe('private');
      expect(classifyHost('172.32.0.1')).toBe('public');
      expect(classifyHost('192.168.1.1')).toBe('private');
      expect(classifyHost('169.254.1.1')).toBe('private');
      expect(classifyHost('fc00::1')).toBe('private');
      expect(classifyHost('fe80::1')).toBe('private');
      expect(classifyHost('0.0.0.0')).toBe('reserved');
      expect(classifyHost('224.0.0.1')).toBe('reserved');
      expect(classifyHost('::')).toBe('reserved');
    });
  });

  // ── ③ 出网红线：代理地址 ────────────────────────────────────────

  describe('代理地址校验', () => {
    it('放行本机回环代理', () => {
      expect(assertProxyUrlAllowed('http://127.0.0.1:7897').port).toBe('7897');
      expect(assertProxyUrlAllowed('http://localhost:7897').hostname).toBe('localhost');
      expect(assertProxyUrlAllowed('http://[::1]:7897').protocol).toBe('http:');
      expect(assertProxyUrlAllowed('https://127.0.0.1:7897').protocol).toBe('https:');
    });

    it('拒绝 socks5 等非 http/https 代理', () => {
      expect(() => assertProxyUrlAllowed('socks5://127.0.0.1:1080')).toThrow(/http/);
      expect(() => assertProxyUrlAllowed('socks5h://127.0.0.1:1080')).toThrow(/http/);
    });

    it('拒绝非回环代理', () => {
      expect(() => assertProxyUrlAllowed('http://example.com:7897')).toThrow(/回环/);
      expect(() => assertProxyUrlAllowed('http://10.0.0.5:7897')).toThrow(/回环/);
    });
  });

  // ── ④ 测试入口的闸门 ────────────────────────────────────────────

  describe('测试专用入口的闸门', () => {
    it('运行时闸门：非测试环境直接失败（fail closed）', async () => {
      expect(process.env.VITEST).toBeTruthy();
      const saved = process.env.VITEST;
      delete process.env.VITEST;
      try {
        await expect(
          downloadVerifiedForTest({
            url: 'http://127.0.0.1:1/x.zip',
            destFile: join(workDir, 'x.zip'),
            sha256: PAYLOAD_SHA,
            allowedHosts: ['127.0.0.1'],
          }),
        ).rejects.toThrow(/非测试环境/);
      } finally {
        process.env.VITEST = saved;
      }
    });

    it('静态闸门：src/ 里除 download.ts 自身外不许「使用」downloadVerifiedForTest', () => {
      const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
      const offenders = collectTsFiles(srcRoot).filter(
        (file) => !file.endsWith('host\\download.ts') && !file.endsWith('host/download.ts'),
      );
      // ⚠️ 只查**真实使用**（import / 调用），不查注释里的提及：
      // 文档里写「产品代码不得用 downloadVerifiedForTest」是**正确用法**，
      // 按字符串一刀切会逼着别人把警告注释也删掉。
      const hits = offenders.filter((file) => stripComments(readFileSync(file, 'utf8')).includes('downloadVerifiedForTest'));
      expect(hits).toEqual([]);
    });
  });

  // ── ⑤ 产品路径的准入 ────────────────────────────────────────────

  describe('产品路径准入', () => {
    it('产品下载入口拒绝回环资源地址', async () => {
      await expect(
        downloadVerified({
          url: 'http://127.0.0.1:1/x.zip',
          destFile: join(workDir, 'x.zip'),
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
        }),
      ).rejects.toThrow(/回环/);
    });

    it('产品下载入口拒绝非回环代理', async () => {
      await expect(
        downloadVerified({
          url: 'https://github.com/x.zip',
          destFile: join(workDir, 'x.zip'),
          sha256: PAYLOAD_SHA,
          allowedHosts: ['github.com'],
          proxy: 'http://example.com:7897',
        }),
      ).rejects.toThrow(/回环/);
    });

    it('sha256 期望值格式非法时直接报错', async () => {
      await expect(
        downloadVerified({
          url: 'https://github.com/x.zip',
          destFile: join(workDir, 'x.zip'),
          sha256: 'not-a-sha',
          allowedHosts: ['github.com'],
        }),
      ).rejects.toThrow(/sha256/);
    });
  });

  // ── ⑥ 直连下载 ──────────────────────────────────────────────────

  describe('直连下载', () => {
    it('校验通过后落盘，且不留 .part 临时文件', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const dest = join(workDir, 'artifact.zip');

      const result = await downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        destFile: dest,
        sha256: PAYLOAD_SHA,
        allowedHosts: ['127.0.0.1'],
      });

      expect(result.path).toBe(dest);
      expect(result.bytes).toBe(PAYLOAD.length);
      expect(result.sha256).toBe(PAYLOAD_SHA);
      expect(readFileSync(dest)).toEqual(PAYLOAD);
      expect(existsSync(`${dest}.part`)).toBe(false);
    });

    it('下载前会清掉上一次残留的 .part 半成品', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const dest = join(workDir, 'artifact.zip');
      writeFileSync(`${dest}.part`, '上一次没下完的半成品');

      await downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        destFile: dest,
        sha256: PAYLOAD_SHA,
        allowedHosts: ['127.0.0.1'],
      });

      expect(existsSync(`${dest}.part`)).toBe(false);
      expect(readFileSync(dest)).toEqual(PAYLOAD);
    });

    it('sha256 不匹配：报错说清「校验失败 / 已丢弃」，且临时文件被删', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const dest = join(workDir, 'artifact.zip');

      const promise = downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        destFile: dest,
        sha256: 'a'.repeat(64),
        allowedHosts: ['127.0.0.1'],
      });

      await expect(promise).rejects.toThrow(/校验失败/);
      await expect(promise).rejects.toThrow(/已丢弃/);
      expect(existsSync(`${dest}.part`)).toBe(false);
      expect(existsSync(dest)).toBe(false);
    });

    it('总大小未知时 percent 为 undefined（不许伪造 0 / 100）', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          // 不给 content-length → 走 chunked，总大小未知
          res.writeHead(200);
          res.write(PAYLOAD.subarray(0, 100));
          res.end(PAYLOAD.subarray(100));
        }),
      );
      const events: DownloadProgress[] = [];

      await downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        destFile: join(workDir, 'artifact.zip'),
        sha256: PAYLOAD_SHA,
        allowedHosts: ['127.0.0.1'],
        onProgress: (p) => events.push(p),
      });

      const downloading = events.filter((e) => e.phase === 'downloading');
      expect(downloading.length).toBeGreaterThan(0);
      for (const e of downloading) expect(e.percent).toBeUndefined();
      expect(events[events.length - 1].phase).toBe('done');
      expect(events[events.length - 1].percent).toBeUndefined();
    });

    it('总大小已知时给出百分比，并在完成时到 100', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const events: DownloadProgress[] = [];

      await downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        destFile: join(workDir, 'artifact.zip'),
        sha256: PAYLOAD_SHA,
        allowedHosts: ['127.0.0.1'],
        onProgress: (p) => events.push(p),
      });

      expect(events[0].phase).toBe('connecting');
      expect(events.some((e) => e.phase === 'downloading')).toBe(true);
      expect(events.some((e) => e.phase === 'verifying')).toBe(true);
      const last = events[events.length - 1];
      expect(last.phase).toBe('done');
      expect(last.percent).toBe(100);
      expect(last.totalBytes).toBe(PAYLOAD.length);
    });

    it('跟随重定向（每跳都重新校验地址）', async () => {
      const server = await track(
        await startFakeServer('http', (req, res) => {
          if ((req.url ?? '').startsWith('/start')) {
            res.writeHead(302, { location: '/final/artifact.zip' });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const dest = join(workDir, 'artifact.zip');

      const result = await downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/start`,
        destFile: dest,
        sha256: PAYLOAD_SHA,
        allowedHosts: ['127.0.0.1'],
      });

      expect(result.bytes).toBe(PAYLOAD.length);
      expect(server.requests).toContain('/final/artifact.zip');
    });

    it('重定向跳数超过上限 → 明确报错', async () => {
      const server = await track(
        await startFakeServer('http', (req, res) => {
          const current = Number((req.url ?? '/0').replace(/[^0-9]/g, '')) || 0;
          res.writeHead(302, { location: `/hop${current + 1}` });
          res.end();
        }),
      );

      await expect(
        downloadVerifiedForTest({
          url: `http://127.0.0.1:${server.port}/hop0`,
          destFile: join(workDir, 'artifact.zip'),
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
        }),
      ).rejects.toThrow(/重定向/);
      expect(existsSync(join(workDir, 'artifact.zip.part'))).toBe(false);
    });

    it('重定向到内网地址 → 拒绝下载', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(302, { location: 'http://10.0.0.1/evil.zip' });
          res.end();
        }),
      );

      await expect(
        downloadVerifiedForTest({
          url: `http://127.0.0.1:${server.port}/start`,
          destFile: join(workDir, 'artifact.zip'),
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
        }),
      ).rejects.toThrow(/回环|内网|允许/);
    });

    it('超时 → 中止并清理临时文件', async () => {
      const server = await track(
        await startFakeServer('http', () => {
          /* 故意不响应 */
        }),
      );
      const dest = join(workDir, 'artifact.zip');

      await expect(
        downloadVerifiedForTest({
          url: `http://127.0.0.1:${server.port}/artifact.zip`,
          destFile: dest,
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/超时/);
      expect(existsSync(`${dest}.part`)).toBe(false);
      expect(existsSync(dest)).toBe(false);
    });

    it('外部 signal 中止 → 报「下载已取消」并清理临时文件', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(200);
          res.write(PAYLOAD.subarray(0, 100));
          // 故意不结束：等测试来中止
        }),
      );
      const dest = join(workDir, 'artifact.zip');
      const controller = new AbortController();

      const promise = downloadVerifiedForTest({
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        destFile: dest,
        sha256: PAYLOAD_SHA,
        allowedHosts: ['127.0.0.1'],
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 120);

      await expect(promise).rejects.toThrow(/下载已取消/);
      expect(existsSync(`${dest}.part`)).toBe(false);
      expect(existsSync(dest)).toBe(false);
    });

    it('Content-Length 与实际长度不符 → 中文报错并清理临时文件', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          // 声明 999999 字节，实际只发一小段就断
          res.writeHead(200, { 'content-length': '999999' });
          res.write(PAYLOAD.subarray(0, 1000));
          res.end();
        }),
      );
      const dest = join(workDir, 'artifact.zip');

      await expect(
        downloadVerifiedForTest({
          url: `http://127.0.0.1:${server.port}/artifact.zip`,
          destFile: dest,
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
        }),
      ).rejects.toThrow(/连接在传输过程中被断开|不一致/);
      expect(existsSync(`${dest}.part`)).toBe(false);
      expect(existsSync(dest)).toBe(false);
    });

    it('HTTP 错误状态 → 明确报错', async () => {
      const server = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(404);
          res.end('not found');
        }),
      );

      await expect(
        downloadVerifiedForTest({
          url: `http://127.0.0.1:${server.port}/missing.zip`,
          destFile: join(workDir, 'artifact.zip'),
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
        }),
      ).rejects.toThrow(/404/);
    });
  });

  // ── ⑦ 代理 CONNECT 隧道 ─────────────────────────────────────────

  describe('代理 CONNECT 隧道', () => {
    it('经本机代理隧道下载：CONNECT 握手 + 隧道内传输', async () => {
      const origin = await track(
        await startFakeServer('http', (_req, res) => {
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const proxy = await trackProxy(await startConnectProxy());
      const dest = join(workDir, 'artifact.zip');

      const result = await downloadVerifiedForTest({
        url: `http://127.0.0.1:${origin.port}/artifact.zip`,
        destFile: dest,
        sha256: PAYLOAD_SHA,
        proxy: `http://127.0.0.1:${proxy.port}`,
        allowedHosts: ['127.0.0.1'],
      });

      expect(result.bytes).toBe(PAYLOAD.length);
      expect(readFileSync(dest)).toEqual(PAYLOAD);
      expect(proxy.connects.length).toBe(1);
      expect(proxy.connects[0]).toMatch(/^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.[01]$/);
    });

    it('经代理时资源地址仍要走允许清单与内网拒绝（一次连接都不能发）', async () => {
      const proxy = await trackProxy(await startConnectProxy());

      await expect(
        downloadVerifiedForTest({
          url: 'http://10.0.0.1/evil.zip',
          destFile: join(workDir, 'artifact.zip'),
          sha256: PAYLOAD_SHA,
          proxy: `http://127.0.0.1:${proxy.port}`,
          allowedHosts: ['10.0.0.1'],
        }),
      ).rejects.toThrow(/内网/);
      expect(proxy.connects.length).toBe(0);
    });

    it('代理连上了却不回应 CONNECT → 必须在 timeoutMs 内返回（不许挂死）', async () => {
      const proxy = await trackProxy(await startSilentProxy());
      const dest = join(workDir, 'artifact.zip');
      const started = Date.now();

      await expect(
        downloadVerifiedForTest({
          url: 'http://127.0.0.1:1/artifact.zip',
          destFile: dest,
          sha256: PAYLOAD_SHA,
          proxy: `http://127.0.0.1:${proxy.port}`,
          allowedHosts: ['127.0.0.1'],
          timeoutMs: 800,
        }),
      ).rejects.toThrow(/超时/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(existsSync(`${dest}.part`)).toBe(false);
    });

    it('https 资源经代理隧道：CONNECT 之后在隧道内再套 TLS', async () => {
      const origin = await track(
        await startFakeServer('https', (_req, res) => {
          res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
          res.end(PAYLOAD);
        }),
      );
      const proxy = await trackProxy(await startConnectProxy());
      const dest = join(workDir, 'artifact.zip');

      const result = await downloadVerifiedForTest({
        url: `https://127.0.0.1:${origin.port}/artifact.zip`,
        destFile: dest,
        sha256: PAYLOAD_SHA,
        proxy: `http://127.0.0.1:${proxy.port}`,
        allowedHosts: ['127.0.0.1'],
      });

      expect(result.bytes).toBe(PAYLOAD.length);
      expect(readFileSync(dest)).toEqual(PAYLOAD);
      expect(proxy.connects[0]).toContain(`127.0.0.1:${origin.port}`);
    });

    it('代理拒绝 CONNECT（返回非 200）→ 明确报错', async () => {
      // 一个「拒绝 CONNECT」的代理：收到请求头就回 403
      const rejecting = createTcpServer((sock) => {
        sock.on('error', () => {
          /* ignore */
        });
        sock.once('data', () => {
          sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        });
      });
      await new Promise<void>((r) => rejecting.listen(0, '127.0.0.1', r));
      const rejectingPort = (rejecting.address() as { port: number }).port;

      try {
        await expect(
          downloadVerifiedForTest({
            url: `http://127.0.0.1:${rejectingPort}/artifact.zip`,
            destFile: join(workDir, 'artifact.zip'),
            sha256: PAYLOAD_SHA,
            proxy: `http://127.0.0.1:${rejectingPort}`,
            allowedHosts: ['127.0.0.1'],
          }),
        ).rejects.toThrow(/代理/);
      } finally {
        await new Promise<void>((r) => rejecting.close(() => r()));
      }
    });
  });
});

describe('M3 Task 1：下载器（TLS 证书校验）', () => {
  it('https 直连（自签证书，校验开启）必须连接失败', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'napcat-download-tls-'));
    const origin = await startFakeServer('https', (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    // 关键：这里**恢复证书校验**（文件级默认关掉了）
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      await expect(
        downloadVerifiedForTest({
          url: `https://127.0.0.1:${origin.port}/artifact.zip`,
          destFile: join(workDir, 'artifact.zip'),
          sha256: PAYLOAD_SHA,
          allowedHosts: ['127.0.0.1'],
        }),
      ).rejects.toThrow(/自签证书|TLS 握手失败/);
      expect(existsSync(join(workDir, 'artifact.zip.part'))).toBe(false);
    } finally {
      if (saved !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
      await origin.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
