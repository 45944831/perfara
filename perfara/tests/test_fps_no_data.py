"""iOS / PC 侧「无帧数据」语义测试（离线，不需要真机）。

背景：
  安卓采集早就约定「取不到帧 ≠ 0 帧」——method 命中 FPS_NO_DATA_METHODS 时写 null，
  报告页断线、统计跳过。iOS / PC 侧原来没有这条约定：
    · iOS  collect_ios.py 在 fps 缺失时**整条样本 return**，连 CPU/内存一起丢，
           用户看到的是「一条数据都没有」，会误判成采集卡死；
    · PC   collect_pc_perf.py 在 PresentMon 不可用（无管理员权限）时写 fps=0，
           报告页画成一条零线，把均值拖低。
  本测试锁定修复后的行为：样本照常上报，fps 写 None，并带 fps_source 标记。

用法: python perfara/tests/test_fps_no_data.py
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPTS = os.path.join(ROOT, 'perfara', 'collector', 'resources', 'ios-tools',
                       'python', 'python', 'Scripts')
BUNDLED_PY = os.path.join(ROOT, 'perfara', 'collector', 'resources', 'ios-tools',
                          'python', 'python', 'python.exe')
PC_SRC = os.path.join(ROOT, '_client_src', 'app', 'ios脚本', '进程管理', 'collect_pc_perf.py')

pass_n = 0
fail_n = 0
fails = []


def check(name, cond, detail=None):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  PASS  %s' % name)
    else:
        fail_n += 1
        fails.append(name)
        print('  FAIL  %s  %s' % (name, json.dumps(detail, ensure_ascii=False) if detail is not None else ''))


def load_ios():
    """导入 collect_ios.py（模块级只注册信号处理，不会连设备）。"""
    path = os.path.join(SCRIPTS, 'collect_ios.py')
    spec = importlib.util.spec_from_file_location('collect_ios_under_test', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def emit_once(mod, state, display):
    """把模块状态置成给定值后调一次 _emit，返回解析出的 JSON（无输出则 None）。"""
    mod._state.clear()
    mod._state.update(state)
    mod._display_state.update(display)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod._emit()
    text = buf.getvalue().strip()
    if not text:
        return None
    return json.loads(text.splitlines()[-1])


def zero_display():
    return {
        'last_frame': None, 'last_1_cost': 0, 'last_2_cost': 0, 'last_3_cost': 0,
        'frame_count': 0, 'time_count': 0, 'jank': 0, 'big_jank': 0,
        'small_jank': 0, 'tiny_jank': 0, 'jank_time': 0,
    }


def test_ios():
    print('\n-- iOS：无帧数据时仍上报样本，fps 写 null --')
    mod = load_ios()

    # 1. 通道没给任何帧（tc==0、opengl 也没给）→ 样本必须在，fps 必须 null
    out = emit_once(mod, {'physFootprint': 123456, 'cpuUsage': 12.5}, zero_display())
    check('无帧数据时样本未被丢弃', out is not None, out)
    if out:
        check('fps 写 None（不是 0）', out.get('fps') is None, out.get('fps'))
        check('fps_source 标记为 none', out.get('fps_source') == 'none', out.get('fps_source'))
        check('CPU 指标照常上报', out.get('cpuUsage') == 12.5, out.get('cpuUsage'))
        check('内存指标照常上报', out.get('physFootprint') == 123456, out.get('physFootprint'))

    # 2. coreprofile 有帧 → 正常算 fps
    ds = zero_display()
    ds['frame_count'] = 60
    ds['time_count'] = 1_000_000_000
    out = emit_once(mod, {'physFootprint': 1}, ds)
    check('有帧时 fps 正常计算（60）', out and abs(out['fps'] - 60.0) < 0.1, out and out.get('fps'))
    check('有帧时 fps_source=coreprofile', out and out.get('fps_source') == 'coreprofile',
          out and out.get('fps_source'))

    # 3. opengl 兜底路径
    out = emit_once(mod, {'physFootprint': 1, 'fps': 45}, zero_display())
    check('opengl 兜底 fps=45', out and out.get('fps') == 45, out and out.get('fps'))
    check('opengl 兜底 fps_source=opengl', out and out.get('fps_source') == 'opengl',
          out and out.get('fps_source'))

    # 4. 没有 physFootprint（连内存都取不到）→ 仍然不发，保持原行为
    out = emit_once(mod, {'cpuUsage': 3}, zero_display())
    check('缺 physFootprint 时不发样本（原行为保持）', out is None, out)

    # 5. 计数器每轮清零
    ds = zero_display()
    ds['frame_count'] = 10
    ds['time_count'] = 1_000_000_000
    emit_once(mod, {'physFootprint': 1}, ds)
    check('发完之后帧计数清零', mod._display_state['frame_count'] == 0, mod._display_state['frame_count'])


def test_pc():
    print('\n-- PC：PresentMon 不可用时 fps 写 null --')
    if not os.path.isfile(PC_SRC):
        print('  SKIP  未找到 PC 采集脚本源码')
        return
    src = open(PC_SRC, encoding='utf-8').read()
    check('源码里 fps 走 fps_out 变量', '"fps": fps_out' in src, None)
    check('fps_src == none 时置 None', "fps_out = None if fps_src == 'none'" in src, None)
    check('fpsFloat 同样置 None', '"fpsFloat": None if fps_src' in src, None)

    pyc = os.path.join(SCRIPTS, 'collect_pc_perf.pyc')
    if not os.path.isfile(pyc):
        print('  SKIP  未找到编译产物 collect_pc_perf.pyc')
        return
    # 与源码时间对比：pyc 旧于源码说明忘了重编（发布包只带 pyc，改源码不重编等于没改）
    check('pyc 不旧于源码（已重新编译）', os.path.getmtime(pyc) >= os.path.getmtime(PC_SRC),
          {'pyc': int(os.path.getmtime(pyc)), 'py': int(os.path.getmtime(PC_SRC))})

    if not (sys.platform == 'win32' and os.path.isfile(BUNDLED_PY)):
        print('  SKIP  非 Windows 或无内置 python，跳过实跑')
        return
    target = r'C:\Windows\explorer.exe'
    if not os.path.isfile(target):
        print('  SKIP  无 explorer.exe 可采')
        return
    try:
        r = subprocess.run([BUNDLED_PY, pyc, target], capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired as e:
        r = e
    lines = [l for l in (r.stdout or '').splitlines() if l.strip().startswith('{')]
    if not lines:
        print('  SKIP  实跑未产出样本（可能被沙箱限制）')
        return
    d = json.loads(lines[0])
    print('   实测首条: fps=%r fpsSource=%r jank=%r' % (
        d.get('fps'), (d.get('pcExtra') or {}).get('fpsSource'), d.get('jank')))
    check('实跑 fps 为 null', d.get('fps') is None, d.get('fps'))
    check('实跑 jank 为 null（未测量）', d.get('jank') is None, d.get('jank'))
    check('实跑 pcExtra.fpsSource 仍保留', isinstance((d.get('pcExtra') or {}).get('fpsSource'), str),
          (d.get('pcExtra') or {}).get('fpsSource'))


def main():
    print('\n===== iOS / PC 无帧数据语义 =====')
    try:
        test_ios()
    except ModuleNotFoundError as e:
        # collect_ios.py 依赖内置 python 的 ios_device 包；用系统 python 跑会缺依赖
        print('  SKIP  iOS 部分需要内置 python（缺依赖 %s）' % e.name)
        print('        请用 perfara/collector/resources/ios-tools/python/python/python.exe 运行')
    test_pc()
    print('\n===== 结果: %d PASS / %d FAIL =====' % (pass_n, fail_n))
    if fails:
        print('失败项:\n  - ' + '\n  - '.join(fails))
    return 1 if fail_n else 0


if __name__ == '__main__':
    sys.exit(main())
