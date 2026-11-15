#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iOS GPU Performance Data Collector (iOS 17+ tunnel / iOS ≤16 direct)
Based on ios_lowgpucounters.py pattern using InstrumentsBase.
Outputs JSON lines to stdout (max MAX_SAMPLES_PER_SEC data points per second).

GPU counters are device-wide (tracingPID=-1); no bundle_id needed.

Usage:
  python collect_ios_gpu.py direct
  python collect_ios_gpu.py tunnel <host> <port> <us_port>
"""

import sys
import os
import json
import time
import threading
import signal

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

# ── UTF-8 stdout/stderr (Windows GBK prevention) ─────────────────────────────
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
elif hasattr(sys.stdout, 'buffer'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ── Suppress ios_device internal logging ─────────────────────────────────────
import logging
logging.basicConfig(level=logging.CRITICAL + 1, format='', handlers=[])
for _name in ['ios_device', 'Instrument', 'LockDown', 'USBMux', 'Mobile',
               'DTXMsg', 'base', 'dvt', 'remote']:
    _logger = logging.getLogger(_name)
    _logger.setLevel(logging.CRITICAL + 1)
    _logger.disabled = True
    _logger.propagate = False

# ── Resolve py-ios-device library path ───────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for _p in [
    os.path.join(_SCRIPT_DIR, 'psets', 'pdm'),
    os.path.join(_SCRIPT_DIR, '..', 'ios-tools', 'psets', 'pdm'),
]:
    if os.path.isdir(_p):
        sys.path.insert(0, _p)
        break

from ios_device.cli.base import InstrumentsBase               # noqa
from ios_device.remote.remote_lockdown import RemoteLockdownClient  # noqa
from ios_device.util.dtx_msg import RawInt64sl, RawInt32sl    # noqa
from ios_device.util.gpu_decode import (                       # noqa
    GRCDecodeOrder, GRCDisplayOrder, JSEvn, TraceData
)

# ── Constants ─────────────────────────────────────────────────────────────────
GPU_CHANNEL         = 'com.apple.instruments.server.services.gpu'
# Device often reports min-collection-interval=2000ms; cap at 1000ms for ~1 Hz batches.
MAX_SAMPLES_PER_FLUSH = 40

# ── Shared state ─────────────────────────────────────────────────────────────
_running    = True
_error_code = [None]


def _stop(*_):
    global _running
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT,  _stop)


def _log(msg):
    try:
        print(json.dumps({'__log': msg}), flush=True)
    except Exception:
        pass


# ── Emit helpers ──────────────────────────────────────────────────────────────
def _emit_samples(display_key_list, counter_result, counter_list):
    n = len(counter_list)
    if n == 0:
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
    t_str  = time.strftime('%H:%M:%S')
    for row in samples:
        out = {'timestamp': now_ms, 'time': t_str, **row}
        try:
            print(json.dumps(out), flush=True)
        except Exception:
            pass


# ── GPU callback (mirrors dropped_message from ios_lowgpucounters.py) ─────────
def make_gpu_callback(mach_time_factor):
    js_env_holder    = [None]
    display_key_list = [None]

    def on_gpu(res):
        try:
            sel = res.selector

            if isinstance(sel, dict):
                code  = sel.get('code', 0)
                desc  = sel.get('userinfo', {}).get('NSLocalizedDescription', str(sel))
                cls   = sel.get('$class', '')
                _error_code[0] = code
                if code not in (1,):
                    _log(f'[gpu] service error [{cls}] {desc} (code={code})')
                    if code == 4:
                        _log('[gpu] Hint: disconnect/reconnect USB to clear GPU collection state')
                return

            if not isinstance(sel, (list, tuple)) or len(sel) < 1:
                return

            msg_type = sel[0]

            if msg_type == 0:
                _data = sel[4] if len(sel) > 4 else {}
                if not isinstance(_data, dict):
                    return
                dk     = GRCDecodeOrder.decode(_data.get(1, []))
                disp_k = GRCDisplayOrder.decode(_data.get(0, []))
                js_str = _data.get(2, '')
                display_key_list[0] = disp_k
                try:
                    js_env_holder[0] = JSEvn(js_str, disp_k, dk, mach_time_factor)
                    names = [k.display for k in disp_k]
                    _log(f'[gpu] counters ready ({len(names)}): {names[:8]}{"…" if len(names) > 8 else ""}')
                except Exception as e:
                    _log(f'[gpu] JSEvn init error: {e}')

            elif msg_type == 1:
                js_env = js_env_holder[0]
                if js_env is None or len(sel) < 6:
                    return
                try:
                    td = TraceData(*sel[:6])
                    counter_result, counter_list = js_env.ex_js(td)
                    _emit_samples(display_key_list[0], counter_result, counter_list)
                except Exception as e:
                    _log(f'[gpu] trace decode error: {e}')

        except Exception as e:
            _log(f'[gpu] callback error: {e}')

    return on_gpu, js_env_holder, display_key_list


# ── Main collect ──────────────────────────────────────────────────────────────
def collect(host=None, port=None, us_port=None):
    global _running

    _log(f'GPU collector starting: mode={"tunnel" if host else "direct"}')

    rsd  = None
    base = None
    try:
        if host and port:
            rsd = RemoteLockdownClient((host, int(port)), userspace_port=int(us_port))
            rsd.__enter__()
            base = InstrumentsBase(lockdown=rsd)
        else:
            base = InstrumentsBase()

        with base:
            rpc = base.instruments
            _log('InstrumentServer connected')

            mach_info = base.device_info.machTimeInfo()
            mach_time_factor = mach_info[1] / mach_info[2]
            _log(f'machTimeInfo factor={mach_time_factor}')

            on_gpu, js_env_holder, display_key_list = make_gpu_callback(mach_time_factor)
            rpc.register_undefined_callback(on_gpu)

            gpu_info = rpc.call(GPU_CHANNEL, 'requestDeviceGPUInfo').selector
            device_name = gpu_info[0].get('device-name',  '?') if gpu_info else '?'
            family_name = gpu_info[0].get('family-name',  '?') if gpu_info else '?'
            _log(f'GPU device: {device_name} family={family_name}')

            raw_min = gpu_info[0].get('min-collection-interval', 1000) if gpu_info else 1000
            min_interval = min(int(raw_min), 1000)
            if raw_min != min_interval:
                _log(f'min-collection-interval device={raw_min}ms → using {min_interval}ms (1Hz cap)')
            else:
                _log(f'min-collection-interval={min_interval}')

            # interval=0 → iOS ≤16 direct; interval=1 → iOS 17+ tunnel
            cfg_interval    = 0 if not host else 1
            MAX_CFG_RETRIES = 60
            CFG_RETRY_WAIT  = 2.0

            configured = False
            for attempt in range(1, MAX_CFG_RETRIES + 1):
                _error_code[0] = None
                try:
                    rpc.call(
                        GPU_CHANNEL,
                        'configureCounters:counterProfile:interval:windowLimit:tracingPID:',
                        RawInt64sl(min_interval, 3, cfg_interval, 0),
                        RawInt32sl(-1),
                    )
                except Exception as e:
                    _log(f'configureCounters exception: {e}')
                    time.sleep(CFG_RETRY_WAIT)
                    continue

                time.sleep(0.4)

                code = _error_code[0]
                if code is None:
                    _log(f'configureCounters OK (attempt {attempt})')
                    configured = True
                    break
                elif code == 1:
                    if attempt == 1:
                        _log('等待游戏启动 (code=1 — Metal 渲染器未运行，请在设备上进入游戏场景)…')
                    elif attempt % 5 == 0:
                        _log(f'仍在等待游戏… ({attempt * CFG_RETRY_WAIT:.0f}s)')
                elif code == 4:
                    _log('code=4 (already collecting) — 重置状态…')
                    try: rpc.call(GPU_CHANNEL, 'stopCollectingCounters')
                    except Exception: pass
                    time.sleep(1.0)
                else:
                    _log(f'configureCounters error code={code}，重试中…')
                    time.sleep(CFG_RETRY_WAIT)

            if not configured:
                raise RuntimeError(
                    f'configureCounters failed after {MAX_CFG_RETRIES} attempts — '
                    'ensure Metal game is running'
                )

            _log('GPU collection started — running until terminated')

            try:
                rpc.call(GPU_CHANNEL, 'startCollectingCounters')
                while _running:
                    time.sleep(0.5)

            finally:
                _running = False
                try: rpc.call(GPU_CHANNEL, 'stopCollectingCounters')
                except Exception: pass
                try:
                    data = rpc.call(GPU_CHANNEL, 'flushRemainingData').selector
                    if (data and js_env_holder[0] and display_key_list[0]
                            and data[0] and len(data[0]) >= 6):
                        counter_result, counter_list = js_env_holder[0].ex_js(
                            TraceData(*data[0][:6])
                        )
                        _emit_samples(display_key_list[0], counter_result, counter_list)
                except Exception: pass

    except Exception as e:
        import traceback
        _log(f'ERROR: {e}')
        _log(traceback.format_exc())
    finally:
        _running = False
        if rsd:
            try: rsd.__exit__(None, None, None)
            except Exception: pass
        _log('GPU collector stopped')


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    rest = _gate_args_or_error(sys.argv[1:])
    if rest is None:
        sys.exit(1)
    if len(rest) < 1:
        print('error')
        sys.exit(1)

    mode = rest[0]
    if mode == 'tunnel':
        if len(rest) < 4:
            print('error')
            sys.exit(1)
        collect(host=rest[1], port=rest[2], us_port=rest[3])
    else:
        collect()
