#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Metal GPU Counters — USB 直连（适用于 iOS 16 及以下，无需 go-ios / RSD 隧道）。

与 `pyidevice instruments gpu_counters` 使用同一套 Instruments GPU 服务；本脚本在
USB lockdown 下将第三段 configure 参数设为 0（与 demo/instrument_demo/gpu.py 一致），
并持续解码输出，直至超时或 Ctrl+C。

iOS 17+ 请使用隧道 + `collect_ios_gpu.py tunnel ...`，勿用本脚本。

依赖：已安装 py-ios-device（本仓库可将 `psets/pdm` 加入 PYTHONPATH，
或使用 `npm run install-ios-python` 后的自带 Python）。

JSON 输出与 `reports/data.js` 一致：`{ "device": {...}, "perf": [ {...}, ... ] }`，
其中 `perf` 中每一项含 `timestamp`、`time` 与各 GPU counter 字段；`device` 在脚本内写死为
`name=iPhone、category=ios_gpu、bundleId/appName 空串`，无需命令行传应用名。

示例::

    python gpu_counters_pre_ios17.py
    python gpu_counters_pre_ios17.py --udid 00008101-xxxxxxxx
    python gpu_counters_pre_ios17.py --json --duration 60 -o report.json
    python gpu_counters_pre_ios17.py --json-lines          # 仅 perf 对象，每行一条 NDJSON
    python gpu_counters_pre_ios17.py --network
"""

import argparse
import json
import os
import signal
import sys
import time

# UTF-8 stdout/stderr on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
elif hasattr(sys.stdout, 'buffer'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import logging
logging.basicConfig(level=logging.CRITICAL + 1, format='', handlers=[])
for _name in ['ios_device', 'Instrument', 'LockDown', 'USBMux', 'Mobile',
              'DTXMsg', 'base', 'dvt', 'remote']:
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL + 1)
    _lg.disabled = True
    _lg.propagate = False

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for _p in (
    os.path.join(_SCRIPT_DIR, 'psets', 'pdm'),
    os.path.join(_SCRIPT_DIR, '..', 'ios-tools', 'psets', 'pdm'),
):
    if os.path.isdir(_p):
        sys.path.insert(0, _p)
        break

from ios_device.cli.base import InstrumentsBase  # noqa: E402
from ios_device.util.dtx_msg import RawInt64sl, RawInt32sl  # noqa: E402
from ios_device.util.gpu_decode import (  # noqa: E402
    GRCDecodeOrder, GRCDisplayOrder, JSEvn, TraceData,
)

GPU_CHANNEL = 'com.apple.instruments.server.services.gpu'
MAX_SAMPLES_PER_FLUSH = 40
# USB 直连：configure 第三参数为 0（见 py-ios-device demo/instrument_demo/gpu.py）
CFG_INTERVAL_USB = 0


def _gate_args_or_error(argv):
    # No help/usage output; require "user xdlj" prefix.
    if len(argv) < 2 or argv[0] != 'user' or argv[1] != 'xdlj':
        try:
            print('error', flush=True)
        except Exception:
            pass
        return None
    rest = argv[2:]
    if any(x in ('-h', '--help') for x in rest):
        try:
            print('error', flush=True)
        except Exception:
            pass
        return None
    return rest

# 与 reports/data.js 中 device 字段一致；无需命令行填写
DEFAULT_DEVICE_META = {
    'name': 'iPhone',
    'bundleId': '',
    'appName': '',
    'category': 'ios_gpu',
}

_running = True
_error_code = [None]


def _stop(*_):
    global _running
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def log_stderr(msg, verbose):
    if verbose:
        print(msg, file=sys.stderr, flush=True)


def emit_rows(display_key_list, counter_result, counter_list, output, perf_buffer, verbose):
    """output: 'text' | 'json-lines' | 'json-report'（json-report 写入 perf_buffer）"""
    n = len(counter_list)
    if n == 0 or not display_key_list:
        return
    num_keys = len(display_key_list)
    samples = []
    for i in range(n):
        start = i * num_keys
        row = {}
        for ki, k in enumerate(display_key_list):
            try:
                val = round(counter_result[start + ki] * k.mix, 4)
                row[k.display] = val
            except Exception:
                pass
        samples.append(row)
    if len(samples) > MAX_SAMPLES_PER_FLUSH:
        step = len(samples) / MAX_SAMPLES_PER_FLUSH
        samples = [samples[int(i * step)] for i in range(MAX_SAMPLES_PER_FLUSH)]

    now_ms = int(time.time() * 1000)
    t_str = time.strftime('%H:%M:%S')
    for row in samples:
        obj = {'timestamp': now_ms, 'time': t_str, **row}
        if output == 'json-lines':
            print(json.dumps(obj, ensure_ascii=False), flush=True)
        elif output == 'json-report':
            perf_buffer.append(obj)
        else:
            for name, val in row.items():
                print(f'{t_str}\t{name}\t{val}', flush=True)


def make_gpu_callback(mach_time_factor, output, perf_buffer, verbose):
    js_env_holder = [None]
    display_key_list = [None]

    def on_gpu(res):
        try:
            sel = res.selector
            if isinstance(sel, dict):
                code = sel.get('code', 0)
                desc = sel.get('userinfo', {}).get('NSLocalizedDescription', str(sel))
                cls = sel.get('$class', '')
                _error_code[0] = code
                if code not in (1,):
                    log_stderr(f'[gpu] service error [{cls}] {desc} (code={code})', verbose)
                return
            if not isinstance(sel, (list, tuple)) or len(sel) < 1:
                return
            msg_type = sel[0]
            if msg_type == 0:
                _data = sel[4] if len(sel) > 4 else {}
                if not isinstance(_data, dict):
                    return
                dk = GRCDecodeOrder.decode(_data.get(1, []))
                disp_k = GRCDisplayOrder.decode(_data.get(0, []))
                js_str = _data.get(2, '')
                display_key_list[0] = disp_k
                try:
                    js_env_holder[0] = JSEvn(js_str, disp_k, dk, mach_time_factor)
                    names = [k.display for k in disp_k]
                    log_stderr(f'[gpu] counters ready ({len(names)}): {names[:8]}{"…" if len(names) > 8 else ""}', verbose)
                except Exception as e:
                    log_stderr(f'[gpu] JSEvn init error: {e}', verbose)
            elif msg_type == 1:
                js_env = js_env_holder[0]
                if js_env is None or len(sel) < 6:
                    return
                try:
                    td = TraceData(*sel[:6])
                    counter_result, counter_list = js_env.ex_js(td)
                    emit_rows(display_key_list[0], counter_result, counter_list, output, perf_buffer, verbose)
                except Exception as e:
                    log_stderr(f'[gpu] trace decode error: {e}', verbose)
        except Exception as e:
            log_stderr(f'[gpu] callback error: {e}', verbose)

    return on_gpu, js_env_holder, display_key_list


def run_usb(udid, network, output, duration_sec, verbose, outfile, var_data):
    global _running
    _running = True
    deadline = None if duration_sec <= 0 else time.time() + duration_sec

    base = InstrumentsBase(udid=udid, network=network)
    perf_buffer = []

    with base:
        rpc = base.instruments
        log_stderr('[gpu] InstrumentServer connected (USB / pre-iOS17)', verbose)

        mach_info = base.device_info.machTimeInfo()
        mach_time_factor = mach_info[1] / mach_info[2]
        log_stderr(f'[gpu] machTimeInfo factor={mach_time_factor}', verbose)

        on_gpu, js_env_holder, display_key_list = make_gpu_callback(
            mach_time_factor, output, perf_buffer, verbose
        )
        rpc.register_undefined_callback(on_gpu)

        gpu_info = rpc.call(GPU_CHANNEL, 'requestDeviceGPUInfo').selector
        if gpu_info:
            log_stderr(
                f"[gpu] device={gpu_info[0].get('device-name', '?')} "
                f"family={gpu_info[0].get('family-name', '?')}",
                verbose,
            )
        raw_min = gpu_info[0].get('min-collection-interval', 1000) if gpu_info else 1000
        min_interval = min(int(raw_min), 1000)
        log_stderr(f'[gpu] min-collection-interval using {min_interval} ms (device reported {raw_min})', verbose)

        MAX_CFG_RETRIES = 60
        CFG_RETRY_WAIT = 2.0
        configured = False
        for attempt in range(1, MAX_CFG_RETRIES + 1):
            _error_code[0] = None
            try:
                rpc.call(
                    GPU_CHANNEL,
                    'configureCounters:counterProfile:interval:windowLimit:tracingPID:',
                    RawInt64sl(min_interval, 3, CFG_INTERVAL_USB, 0),
                    RawInt32sl(-1),
                )
            except Exception as e:
                log_stderr(f'configureCounters exception: {e}', verbose)
                time.sleep(CFG_RETRY_WAIT)
                continue
            time.sleep(0.4)
            code = _error_code[0]
            if code is None:
                log_stderr(f'configureCounters OK (attempt {attempt})', verbose)
                configured = True
                break
            if code == 1:
                if attempt == 1:
                    log_stderr('等待 Metal 渲染（code=1）— 请在设备上打开占用 GPU 的应用场景…', verbose)
                elif attempt % 5 == 0:
                    log_stderr(f'仍在等待… ({attempt * CFG_RETRY_WAIT:.0f}s)', verbose)
            elif code == 4:
                log_stderr('code=4 — 尝试 stop 后重试', verbose)
                try:
                    rpc.call(GPU_CHANNEL, 'stopCollectingCounters')
                except Exception:
                    pass
                time.sleep(1.0)
            else:
                log_stderr(f'configureCounters error code={code}，重试中…', verbose)
                time.sleep(CFG_RETRY_WAIT)

        if not configured:
            raise RuntimeError(
                'configureCounters 失败 — 请确认设备已连接、信任本机，且前台有 Metal/GPU 负载'
            )

        try:
            rpc.call(GPU_CHANNEL, 'startCollectingCounters')
            log_stderr('[gpu] collecting… Ctrl+C 结束', verbose)

            while _running and (deadline is None or time.time() < deadline):
                time.sleep(0.2)
        finally:
            _running = False
            try:
                rpc.call(GPU_CHANNEL, 'stopCollectingCounters')
            except Exception:
                pass
            try:
                data = rpc.call(GPU_CHANNEL, 'flushRemainingData').selector
                if (
                    data and js_env_holder[0] and display_key_list[0]
                    and data[0] and len(data[0]) >= 6
                ):
                    counter_result, counter_list = js_env_holder[0].ex_js(
                        TraceData(*data[0][:6])
                    )
                    emit_rows(
                        display_key_list[0], counter_result, counter_list,
                        output, perf_buffer, verbose,
                    )
            except Exception:
                pass
            log_stderr('[gpu] stopped.', verbose)

    # 与 reports/data.js 相同顶层结构（仅 JSON 报告模式）
    if output == 'json-report':
        report = {'device': dict(DEFAULT_DEVICE_META), 'perf': perf_buffer}
        text = json.dumps(report, ensure_ascii=False, indent=2)
        if var_data:
            text = f'var data={text};'
        if outfile:
            with open(outfile, 'w', encoding='utf-8') as f:
                f.write(text)
                if not text.endswith('\n'):
                    f.write('\n')
            log_stderr(f'[gpu] wrote {outfile}', verbose)
        else:
            print(text)


def main():
    rest = _gate_args_or_error(sys.argv[1:])
    if rest is None:
        return 1

    # Temporarily replace argv so argparse can't see our gate tokens.
    old_argv = sys.argv
    sys.argv = [old_argv[0], *rest]

    class _NoHelpParser(argparse.ArgumentParser):
        def print_help(self, *args, **kwargs):  # noqa: D401
            return
        def print_usage(self, *args, **kwargs):
            return
        def error(self, message):
            raise SystemExit(2)

    ap = _NoHelpParser(add_help=False)
    ap.add_argument('--udid', default=None, help='设备 UDID（多设备时指定）')
    ap.add_argument('--network', action='store_true', help='使用网络/无线连接的设备')
    ap.add_argument(
        '--json', action='store_true',
        help='结束后输出与 reports/data.js 相同的 { device, perf } JSON（perf 数组元素为各采样点）',
    )
    ap.add_argument(
        '--json-lines', action='store_true',
        help='采集过程中每行一条 JSON，仅单个 perf 对象（NDJSON），不与 --json 同时使用',
    )
    ap.add_argument('-o', '--output', dest='outfile', default=None, metavar='FILE',
                    help='将 JSON 写入文件（默认仅 --json 时写到 stdout）')
    ap.add_argument(
        '--var-data', action='store_true',
        help='输出为 var data=<JSON>; 便于粘贴进 data.js',
    )
    ap.add_argument('--duration', type=float, default=0, metavar='SEC', help='运行秒数，0 表示直到 Ctrl+C')
    ap.add_argument('--verbose', '-v', action='store_true', help='向 stderr 打印状态日志')
    try:
        args = ap.parse_args()
    except SystemExit:
        # No help/usage output.
        print('error')
        return 1
    finally:
        sys.argv = old_argv

    if args.json and args.json_lines:
        print('error')
        return 1

    if args.var_data and not args.json:
        print('error')
        return 1

    if args.json:
        out_mode = 'json-report'
    elif args.json_lines:
        out_mode = 'json-lines'
    else:
        out_mode = 'text'

    try:
        run_usb(
            udid=args.udid,
            network=args.network,
            output=out_mode,
            duration_sec=args.duration,
            verbose=args.verbose,
            outfile=args.outfile,
            var_data=args.var_data,
        )
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print('error')
        return 1

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
