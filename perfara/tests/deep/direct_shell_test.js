'use strict';
/**
 * adb.js 直连层（_adbDirectShell / adbShell 回退语义）的注入式回归测试。
 *
 * 背景：直连层绕过 adb.exe 子进程，用 TCP 直连 adb server 协议（host:transport →
 * shell:）。此前全库没有任何断言 OKAY / FAIL / close / 超时 / 取消 / 输出等价的
 * 测试，全靠手工真机验证兜底 —— 这里用一个进程内假 adb server 把每个分支锁死。
 *
 * 覆盖（每条对应一个真实故障模式）：
 *   A. 正常链路：transport OKAY → shell OKAY → 流式输出 → close = resolve，\r 清洗
 *   B. transport FAIL（设备不存在）→ reject，错误消息含 server 返回的原文
 *   C. ⚠️ 握手完成前连接被关闭（server 挂掉 / 复位）→ 必须 reject 触发回退，
 *      绝不能 resolve('') 静默吞掉（空输出会被上层当「读不到写 null」，污染熔断判定）
 *   D. 握手完成后连接关闭（legacy shell 正常结束）→ resolve 输出，即使零字节
 *   E. 超时 → reject
 *   F. cancel（cancelAllInflight）→ reject，不悬挂
 *   G. 输出等价：多行输出与 execFile 的差异只剩 \r\n→\n（行内容逐行相等）
 *   H. 回退传播：直连 reject 后 adbShell 落到 spawn 路径（fallback 计数递增为证据）
 *
 * 全程不依赖真机 / 真 adb server：假 server 起在 127.0.0.1 随机端口，直连层的
 * 端口在 require 时由 ANDROID_ADB_SERVER_PORT 固化；__setServerRunner 把「server
 * 已就绪」注入进去，避免 spawn 真 adb.exe 与假 server 抢端口。
 * 注意：直连失败回退的 spawn 会打到假 server 端口并报 version/设备错误 —— 只要
 * 它 reject，回退语义断言即成立，错误内容不在断言范围。
 */
const net = require('net');
const path = require('path');

const FAKE_PORT = 51000 + (process.pid % 10000);
process.env.ANDROID_ADB_SERVER_PORT = String(FAKE_PORT);
const ADB = require(path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'src', 'adb.js'));
ADB.__setServerRunner({ probe: () => Promise.resolve(true), kill: (cb) => cb(null) });

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; FAILED.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}

const DEV = 'FAKEDEV001';
const TRANSPORT = 'host:transport:' + DEV;

/**
 * 假 adb server：handler(sock, svc) 对每个完整 service 调用一次（持续分发）。
 * 返回 { close }。
 */
function makeFakeServer(handler) {
  const srv = net.createServer((sock) => {
    sock.on('error', () => {}); // 被测方超时后 destroy 连接会 ECONNRESET，属预期
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 4) return;
        const n = parseInt(buf.slice(0, 4).toString('ascii'), 16);
        if (buf.length < 4 + n) return;
        const svc = buf.slice(4, 4 + n).toString('ascii');
        buf = buf.slice(4 + n);
        handler(sock, svc);
      }
    });
  });
  return new Promise((resolve) => srv.listen(FAKE_PORT, '127.0.0.1', () => resolve({
    close: () => new Promise((r) => srv.close(() => r())),
  })));
}

/** 各组行为脚本 */
const SCRIPTS = {
  // transport OKAY；shell 回 OKAY + 输出 + 关闭（legacy shell 正常结束）
  ok: (output) => (sock, svc) => {
    if (svc === TRANSPORT) { sock.write('OKAY'); return; }
    sock.write('OKAY');
    if (output) sock.write(output);
    sock.end();
  },
  // transport 直接 FAIL（设备不存在）
  fail: (msg) => (sock) => {
    sock.write('FAIL' + msg.length.toString(16).padStart(4, '0') + msg);
    sock.end();
  },
  // transport 一来就关闭，从不回 OKAY（握手前连接关闭 = server 挂了 / 复位）
  preClose: () => (sock) => { sock.end(); },
  // transport OKAY；shell 只回 OKAY 然后挂住（超时场景）
  hang: () => (sock, svc) => {
    if (svc === TRANSPORT) { sock.write('OKAY'); return; }
    sock.write('OKAY'); // 之后永不输出、永不关闭
  },
};

(async () => {
  console.log('\n===== 直连层注入式回归（假 adb server）=====\n');

  // ── A. 正常链路：双 OKAY + 流式输出 + \r 清洗 ─────────────────────────────
  {
    const okBefore = ADB.getDirectStats().ok;
    const h = await makeFakeServer(SCRIPTS.ok('line1\r\nline2\r\n'));
    const out = await ADB.shell(DEV, 'echo test');
    check('A1 正常链路 resolve 输出', out === 'line1\nline2\n', JSON.stringify(out));
    check('A2 \\r 清洗（与 execFile 输出等价）', out.indexOf('\r') < 0 && out.includes('line2'), out);
    check('A3 直连计数递增（没有走回退）', ADB.getDirectStats().ok === okBefore + 1
      && ADB.getDirectStats().fallback === 0, ADB.getDirectStats());
    await h.close();
  }

  // ── B. transport FAIL：设备不存在 ────────────────────────────────────────
  {
    const h = await makeFakeServer(SCRIPTS.fail('device not found'));
    let err = null;
    try { await ADB.shell(DEV, 'echo x'); } catch (e) { err = e; }
    check('B1 transport FAIL → reject（不静默空输出）', err instanceof Error, err && err.message);
    check('B2 错误消息含 server 原文', !!err && err.message.indexOf('device not found') >= 0,
      err && err.message);
    await h.close();
  }

  // ── C. ⚠️ 握手完成前连接关闭：必须 reject 触发回退（复核修复的缺陷）──────
  {
    const okBefore = ADB.getDirectStats().ok;
    const fbBefore = ADB.getDirectStats().fallback;
    const h = await makeFakeServer(SCRIPTS.preClose());
    let err = null;
    try { await ADB.shell(DEV, 'echo x'); } catch (e) { err = e; }
    check('C1 握手前 close → reject（绝不 resolve 空输出）', err instanceof Error, err && err.message);
    check('C2 ok 计数未递增（没有假成功）', ADB.getDirectStats().ok === okBefore,
      ADB.getDirectStats());
    check('C3 fallback 计数递增（走了回退）', ADB.getDirectStats().fallback === fbBefore + 1,
      ADB.getDirectStats());
    await h.close();
  }

  // ── D. 握手完成后立即关闭（无输出命令）→ resolve 空串 ────────────────────
  {
    const h = await makeFakeServer(SCRIPTS.ok(''));
    const out = await ADB.shell(DEV, 'true');
    check('D1 握手完成后的 close = 正常结束（resolve 空串）', out === '', JSON.stringify(out));
    await h.close();
  }

  // ── E. 超时 → reject ─────────────────────────────────────────────────────
  {
    const h = await makeFakeServer(SCRIPTS.hang());
    const t0 = Date.now();
    const fb0 = ADB.getDirectStats().fallback;
    let err = null;
    try { await ADB.shell(DEV, 'echo slow', 700); } catch (e) { err = e; }
    const wall = Date.now() - t0;
    check('E1 超时 → reject', err instanceof Error, err && err.message);
    // adbShell 超时后会回退 spawn，端到端耗时 = 直连超时 + 回退进程的超时/启动，
    // 实测约 1.5s。断言应验证「等够了直连超时 + 确实触发回退」，而不是给端到端
    // 时间卡一个紧上界（旧断言 <1500ms 在慢机器上必然假 FAIL）。
    // 保留宽松上界 5s 防止真悬挂时假通过。
    check('E2 直连超时触发回退（≥700ms 且 fallback+1）',
      !!err && wall >= 600 && wall < 5000
        && ADB.getDirectStats().fallback === fb0 + 1, wall);
    await h.close();
  }

  // ── F. cancel：cancelAllInflight → reject，不悬挂 ─────────────────────────
  {
    const h = await makeFakeServer(SCRIPTS.hang());
    let err = null;
    const p = ADB.shell(DEV, 'echo hang', 8000).catch((e) => { err = e; });
    await new Promise((r) => setTimeout(r, 150));
    ADB.cancelAllInflight();
    await p;
    check('F1 cancel → reject（不悬挂）', err instanceof Error, err && err.message);
    await h.close();
  }

  // ── G. 输出等价：多行 + 空行，行级与 execFile 语义一致 ────────────────────
  {
    const lines = ['Total frames rendered: 100', '', 'displayRefreshRate=120', 'jankyFrames=3'];
    const h = await makeFakeServer(SCRIPTS.ok(lines.join('\r\n') + '\r\n'));
    const out = await ADB.shell(DEV, 'dumpsys fake');
    const got = out.split('\n').map((l) => l.replace(/\r$/, ''));
    check('G1 行级输出等价（仅换行风格差异）',
      JSON.stringify(got) === JSON.stringify(['Total frames rendered: 100', '', 'displayRefreshRate=120', 'jankyFrames=3', '']),
      JSON.stringify(got));
    await h.close();
  }

  // ── H. 回退传播证据 ────────────────────────────────────────────────────────
  check('H1 直连失败已触发 spawn 回退（C3 的 fallback>0 即证据）',
    ADB.getDirectStats().fallback > 0, ADB.getDirectStats());

  console.log(`\n===== 直连层测试结果: ${passed} PASS / ${failed} FAIL =====`);
  if (FAILED.length) console.log('失败项: ' + FAILED.join(' | '));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常: ' + (e && e.stack || e));
  process.exit(1);
});
