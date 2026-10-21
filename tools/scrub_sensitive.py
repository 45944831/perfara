#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公开仓库敏感信息脱敏：机型（Android 13 中端机型 / 中端芯片 中端 SoC）、设备 ID、
真实应用包名（com.example.game / com.example.app 等）。

覆盖：README、docs 报告、产品源码注释、测试脚本默认值、测试夹具、
demo 生成器。幂等，可重复运行。截图另行重生（见 docs/screenshots）。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (文件, 旧, 新) —— 旧串必须唯一或在文件中语义一致
EDITS = [
    # ── README.md（GitHub 主页） ──
    ("README.md",
     "### 真机验证（Android 13 中端机型 / Android 13 / 中端芯片 中端 SoC）",
     "### 真机验证（Android 13 中端机型）"),
    ("README.md",
     "真机回归结果：游戏 `com.example.game` 端到端 **39/39**、",
     "真机回归结果：一款真机游戏端到端 **39/39**、"),
    ("README.md",
     "又用真机（Android 13 中端机型 / Android 13 / 定制 ROM）",
     "又用真机（Android 13 / 定制 ROM）"),

    # ── docs 测试报告 ──
    ("docs/测试报告_20261021_完整测试.md",
     "- **真机**：Android 13 中端机型 / Android 13 / 定制 ROM，设备 ID `设备序列号`",
     "- **真机**：Android 13 / 定制 ROM 中端机型（序列号已脱敏）"),
    ("docs/测试报告_20261021_真机复测.md",
     "- **真机设备**：Android 13 中端机型（Android 13 / 定制 ROM），设备 ID `设备序列号`，USB 连接",
     "- **真机设备**：Android 13 / 定制 ROM 中端机型（序列号已脱敏），USB 连接"),
    ("docs/测试报告_20261021_真机复测.md",
     "### P4 真机（设备 设备序列号）",
     "### P4 真机（中端 Android 机型）"),
    ("docs/测试报告_20261021_真机复测.md",
     "设备发现（model=generic）",
     "设备发现（型号已脱敏）"),
    ("docs/测试报告_20261021_真机复测.md",
     "真游戏（示例游戏）全程命中。",
     "真游戏（名称已脱敏）全程命中。"),

    # ── 产品源码注释（_client_src/app/src/adb.js） ──
    ("_client_src/app/src/adb.js",
     "（真机 generic 实测 ~90ms）",
     "（真机实测 ~90ms）"),
    ("_client_src/app/src/adb.js",
     "定制 ROM / Android 13（真机 generic）上",
     "定制 ROM / Android 13（真机）上"),
    ("_client_src/app/src/adb.js",
     "真机 generic 实测：目标游戏在后台时",
     "真机实测：目标游戏在后台时"),
    ("_client_src/app/src/adb.js",
     "（真机 Android 13 中端机型 / Android 13 实测复现）",
     "（真机 / Android 13 实测复现）"),
    ("_client_src/app/src/adb.js",
     "（真机 generic / Android 13 实测复现）",
     "（真机 / Android 13 实测复现）"),

    # ── 测试脚本默认值 ──
    ("perfara/tests/realdevice/capture_real_fixtures.js",
     "const DEVICE = process.argv[2] || '设备序列号';",
     "const DEVICE = process.argv[2] || '';"),
    ("perfara/tests/realdevice/capture_real_fixtures.js",
     "const PKG = process.argv[3] || 'com.example.game';",
     "const PKG = process.argv[3] || 'com.example.game';"),
    ("perfara/tests/realdevice/capture_real_fixtures.js",
     "name: 'Android 13 中端机型', model: 'generic', brand: '厂商', system: 'Android 13',",
     "name: 'Android 真机', model: 'generic', brand: 'generic', system: 'Android 13',"),
    ("perfara/tests/realdevice/e2e_realdevice.js",
     "const DEVICE = process.argv[2] || '设备序列号';",
     "const DEVICE = process.argv[2] || '';"),
    ("perfara/tests/realdevice/e2e_realdevice.js",
     "const PKG = process.argv[3] || 'com.example.game';",
     "const PKG = process.argv[3] || 'com.example.game';"),
    ("perfara/tests/realdevice/probe_adb.js",
     "const DEVICE = process.argv[2] || '设备序列号';",
     "const DEVICE = process.argv[2] || '';"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s1.js",
     "const DEVICE = process.argv[2] || '设备序列号';",
     "const DEVICE = process.argv[2] || '';"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s2.js",
     "const DEVICE = process.argv[2] || '设备序列号';",
     "const DEVICE = process.argv[2] || '';"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s2.js",
     "const PKG = process.argv[3] || 'com.example.game';",
     "const PKG = process.argv[3] || 'com.example.game';"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s2.js",
     "device: { name: 'Android 13 中端机型', brand: '厂商', system: 'Android 13' },",
     "device: { name: 'Android 真机', brand: 'generic', system: 'Android 13' },"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s3.js",
     "const DEVICE = process.argv[2] || '设备序列号';",
     "const DEVICE = process.argv[2] || '';"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s3.js",
     "const PKG = process.argv[3] || 'com.example.game';",
     "const PKG = process.argv[3] || 'com.example.game';"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s3.js",
     "device: { name: 'Android 13 中端机型', model: 'generic', brand: '厂商', system: 'Android 13', category: 'android', deviceId: DEVICE, appName: PKG },",
     "device: { name: 'Android 真机', model: 'generic', brand: 'generic', system: 'Android 13', category: 'android', deviceId: DEVICE, appName: PKG },"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s3.js",
     "platform: 'android', deviceName: 'Android 13 中端机型', deviceId: DEVICE,",
     "platform: 'android', deviceName: 'Android 真机', deviceId: DEVICE,"),
    ("perfara/tests/realdevice/realdevice_walkthrough_s3.js",
     "hasDeviceName: document.body.innerText.includes('Android 13 中端机型'),",
     "hasDeviceName: document.body.innerText.includes('Android 真机'),"),

    # ── 测试注释与样本数据 ──
    ("perfara/tests/realdevice/jank_algo_test.js",
     "真机（Android 13 中端机型 / Android 13）实测发现",
     "真机（Android 13）实测发现"),
    ("perfara/tests/deep/compare_lanes_test.js",
     "'20261020-093156-厂商_generic'", "'20261020-093156-DEVICE_A'"),
    ("perfara/tests/deep/compare_lanes_test.js",
     "'20261020-143158-厂商_generic'", "'20261020-143158-DEVICE_B'"),
    ("perfara/tests/deep/compare_lanes_test.js",
     "'20261020-145215-厂商_generic'", "'20261020-145215-DEVICE_C'"),
    ("perfara/tests/deep/compare_lanes_test.js",
     "'20261020-145531-厂商_generic'", "'20261020-145531-DEVICE_D'"),

    # ── 测试夹具 ──
    ("perfara/tests/fixtures/sample_payload.json",
     "示例应用（com.example.app）", "示例应用（com.example.app）"),

    # ── demo 生成器 ──
    ("tools/make_demo_history.py",
     'rid = f"{now.strftime(\'%Y%m%d-%H%M%S\')}-厂商_generic"',
     'rid = f"{now.strftime(\'%Y%m%d-%H%M%S\')}-DEMO_DEVICE"'),
    ("tools/make_demo_history.py",
     "'platform': 'android', 'deviceName': 'Android 13 中端机型',",
     "'platform': 'android', 'deviceName': '演示设备',"),
    ("tools/make_demo_history.py",
     "'deviceId': '设备序列号',",
     "'deviceId': 'demo-device-001',"),
    ("tools/make_demo_history.py",
     "'app': 'com.example.game',",
     "'app': 'com.example.game',"),
]

# JSON 夹具单独结构化处理（避免误伤数值）
JSON_EDITS = {
    "perfara/tests/realdevice/_real_android.json": [
        ('"name": "Android 13 中端机型"', '"name": "Android 真机"'),
        ('"model": "generic"', '"model": "generic"'),
        ('"brand": "generic"', '"brand": "generic"'),
        ('"deviceId": "设备序列号"', '"deviceId": "demo-device-001"'),
        ('"appName": "com.example.game"', '"appName": "com.example.game"'),
        ('"appLabel": "com.example.game"', '"appLabel": "com.example.game"'),
    ],
}


def main():
    failed = []
    for rel, old, new in EDITS:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            failed.append((rel, "文件不存在"))
            continue
        with io.open(p, encoding="utf-8") as f:
            text = f.read()
        if old not in text:
            if new in text:
                continue  # 已脱敏（幂等）
            failed.append((rel, f"未找到: {old[:50]}"))
            continue
        with io.open(p, "w", encoding="utf-8", newline="") as f:
            f.write(text.replace(old, new))
        print(f"[ok] {rel}: {old[:40]!r} -> {new[:40]!r}")
    for rel, pairs in JSON_EDITS.items():
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            failed.append((rel, "文件不存在"))
            continue
        with io.open(p, encoding="utf-8") as f:
            text = f.read()
        n = 0
        for old, new in pairs:
            if old in text:
                text = text.replace(old, new)
                n += 1
            elif new in text:
                continue
            else:
                failed.append((rel, f"未找到: {old}"))
        if n:
            with io.open(p, "w", encoding="utf-8", newline="") as f:
                f.write(text)
            print(f"[ok] {rel}: {n} 处 JSON 字段脱敏")
    if failed:
        print("\n[FAILED]")
        for rel, why in failed:
            print(f"  {rel}: {why}")
        sys.exit(1)
    print("\n全部完成")


if __name__ == "__main__":
    main()
