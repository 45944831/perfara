#!/usr/bin/env python3
"""
iOS ≤16 Performance Data Collector (direct USB connection, no tunnel)
Outputs one JSON line per second to stdout for Electron app.

FPS + jank/big_jank/stutter come from coreprofilesessiontap (same as
'pyidevice instruments display'), supporting up to 120 fps.
Falls back to graphics.opengl for FPS-only if coreprofile unavailable.

Key differences from collect_ios.py (iOS 17+):
  - Direct connection only (no RSD / RemoteLockdownClient)
  - System CPU comes from Type=33 item:
      CPU_TotalLoad = SUM of all per-core loads → divide by CPUCount for 0-100%
  - DTTapStatusMessage must be registered in bpylist2 class map
  - Values in process attrs are already numeric (not strings)

Usage:
  python collect_ios_legacy.py <bundle_id> <exec_name>
"""

import sys
import os
import json
import time
import uuid
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

# ---------------------------------------------------------------------------
# Resolve py-ios-device library path
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for _p in [
    os.path.join(_SCRIPT_DIR, 'psets', 'pdm'),
    os.path.join(_SCRIPT_DIR, '..', 'ios-tools', 'psets', 'pdm'),
]:
    if os.path.isdir(_p):
        sys.path.insert(0, _p)
        break

# Patch bpylist2 BEFORE importing InstrumentServer
from ios_device.util import bpylist2                                  # noqa
bpylist2.UNARCHIVE_CLASS_MAP['DTTapStatusMessage'] = bpylist2.DTTapMessageArchive

from ios_device.servers.Instrument import InstrumentServer            # noqa
from ios_device.util.exceptions import InstrumentRPCParseError        # noqa
from ios_device.util.utils import kperf_data                          # noqa
from ios_device.util.kperf_data import kdbg_extract_all               # noqa

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SYSMONTAP_CHANNEL   = 'com.apple.instruments.server.services.sysmontap'
GRAPHICS_CHANNEL    = 'com.apple.instruments.server.services.graphics.opengl'
COREPROFILE_CHANNEL = 'com.apple.instruments.server.services.coreprofilesessiontap'
DEVINFO_CHANNEL     = 'com.apple.instruments.server.services.deviceinfo'

# Jank thresholds — same constants used by 'pyidevice instruments display'
_NANO_SECOND      = 1e9
_MOVIE_FRAME_COST = 1 / 24   # ~41.7 ms; jank fires when frame cost > 2× this

PROC_ATTRS = [
    'memVirtualSize', 'cpuUsage', 'procStatus', 'vmPageIns',
    'memRShrd', 'ctxSwitch', 'memCompressed', 'intWakeups',
    'cpuTotalSystem', 'physFootprint', 'cpuTotalUser', 'memResidentSize',
    'sysCallsMach', 'memPurgeable', 'diskBytesRead', 'machPortCount',
    '__arch', 'memRPrvt', 'msgSent', 'threadCount', 'memAnon',
    'diskBytesWritten', 'msgRecv', 'pid', 'name',
]

_NUMERIC_KEYS = {
    'cpuUsage', 'physFootprint', 'memVirtualSize', 'memResidentSize',
    'memRPrvt', 'memRShrd', 'memAnon', 'memCompressed', 'memPurgeable',
    'threadCount', 'diskBytesRead', 'diskBytesWritten', 'vmPageIns',
    'ctxSwitch', 'intWakeups', 'sysCallsMach', 'machPortCount',
    'msgSent', 'msgRecv',
}
# cpuTotalSystem/User from process attrs are Mach abs time (not %) — skip them
_SKIP_PROC_KEYS = {'cpuTotalSystem', 'cpuTotalUser'}

_ARCH_MAP = {
    16777228: 'arm64',
    16777223: 'x86_64',
    12:       'arm',
    7:        'x86',
}

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
_state      = {}
_lock       = threading.Lock()
_running    = True
_proc_attrs = None   # learned from first Type-7 callback

# Per-second display state — updated by kperf callback, reset by _emit()
_display_state = {
    'last_frame':  None,  # last mach timestamp of CA render commit
    'last_1_cost': 0,
    'last_2_cost': 0,
    'last_3_cost': 0,
    'frame_count': 0,
    'time_count':  0,     # accumulated ns since last _emit
    'jank':        0,
    'big_jank':    0,
    'jank_time':   0,     # accumulated ns of janky frames
}


def _stop(*_):
    global _running
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT,  _stop)


def _emit():
    with _lock:
        if not _state:
            return
        out = dict(_state)
        ds = _display_state
        tc = ds['time_count']
        if tc > 0:
            out['fps'] = round(ds['frame_count'] / tc * _NANO_SECOND, 1)
        out['jank']     = ds['jank']
        out['big_jank'] = ds['big_jank']
        out['stutter']  = round(ds['jank_time'] / tc, 4) if tc > 0 else 0.0
        # Reset per-second counters
        ds['frame_count'] = 0
        ds['time_count']  = 0
        ds['jank']        = 0
        ds['big_jank']    = 0
        ds['jank_time']   = 0
    out['timestamp'] = int(time.time() * 1000)
    out['time']      = time.strftime('%H:%M:%S')
    try:
        print(json.dumps(out), flush=True)
    except Exception:
        pass


def _emit_loop():
    if not _running:
        return
    _emit()
    t = threading.Timer(1.0, _emit_loop)
    t.daemon = True
    t.start()


# ---------------------------------------------------------------------------
# sysmontap callback — iOS ≤16 format
#
# Type=7  initial snapshot: ProcessesAttributes + Processes (pid → [vals])
# Type=5  periodic update:  Processes (pid → [vals])
# Type=33 system CPU:       SystemCPUUsage (CPU_TotalLoad = SUM of cores)
#                           CPUCount → use to normalise to 0-100%
# ---------------------------------------------------------------------------
def _make_sysmontap_cb(app_name):
    def on_sysmontap(res):
        try:
            _parse_sysmontap(res, app_name)
        except Exception:
            pass
    return on_sysmontap


def _parse_sysmontap(res, app_name):
    global _proc_attrs

    sel = res.selector
    if not isinstance(sel, list):
        return

    for item in sel:
        if not isinstance(item, dict):
            continue

        item_type = item.get('Type')

        # ── Process data (Type 5 = periodic, Type 7 = initial snapshot) ──
        if item_type in (5, 7):
            attrs = item.get('ProcessesAttributes')
            if attrs is not None:
                _proc_attrs = list(attrs)
            use_attrs = _proc_attrs if _proc_attrs is not None else PROC_ATTRS

            processes = item.get('Processes')
            if isinstance(processes, dict):
                _parse_processes(processes, use_attrs, app_name)

        # ── System CPU (Type=33, iOS ≤16 specific) ──
        # CPU_TotalLoad = SUM of all per-core loads → normalise by CPUCount
        elif item_type == 33:
            cpu = item.get('SystemCPUUsage', {})
            cpu_count = item.get('CPUCount') or item.get('EnabledCPUs') or len(item.get('PerCPUUsage', [1]))
            if not cpu_count:
                cpu_count = 1

            total_raw = cpu.get('CPU_TotalLoad')
            user_raw  = cpu.get('CPU_UserLoad')

            if total_raw is not None:
                try:
                    normalised = float(total_raw) / cpu_count
                    with _lock:
                        _state['cpuTotalSystem'] = round(normalised, 2)
                except (ValueError, TypeError):
                    pass

            if user_raw is not None and float(user_raw) >= 0:
                try:
                    normalised = float(user_raw) / cpu_count
                    with _lock:
                        _state['cpuTotalUser'] = round(normalised, 2)
                except (ValueError, TypeError):
                    pass


def _parse_processes(processes, attrs, app_name):
    name_idx = -1
    try:
        name_idx = attrs.index('name')
    except ValueError:
        pass

    for pid, values in processes.items():
        if not isinstance(values, list):
            continue
        if name_idx < 0 or name_idx >= len(values):
            continue

        name = values[name_idx]
        if name is None or str(name) in ('None', ''):
            continue
        name = str(name)

        if app_name.lower() in name.lower() or name.lower() in app_name.lower():
            _apply_proc_values(values, attrs)
            return


def _apply_proc_values(values, attrs):
    with _lock:
        for i, attr in enumerate(attrs):
            if i >= len(values):
                break
            if attr in _SKIP_PROC_KEYS:
                continue
            val = values[i]
            if val is None:
                continue
            if attr in _NUMERIC_KEYS:
                try:
                    _state[attr] = float(val)
                except (ValueError, TypeError):
                    pass
            elif attr == '__arch':
                try:
                    arch_int = int(float(str(val)))
                    _state['__arch'] = _ARCH_MAP.get(arch_int, str(val))
                except (ValueError, TypeError):
                    _state['__arch'] = str(val)
            elif attr == 'procStatus':
                try:
                    _state['procStatus'] = int(float(str(val)))
                except (ValueError, TypeError):
                    pass


# ---------------------------------------------------------------------------
# coreprofilesessiontap callback — FPS + jank
# Mirrors the 'pyidevice instruments display' algorithm exactly.
# kperf tuple layout from kperf_data(): struct '<QLLQQQQLLQ'
#   args[0] = mach timestamp (uint64)
#   args[7] = debug code (uint32)
# CA render commit event: kdbg_extract_all(code) == (0x31, 0x80, 0xc6)
# ---------------------------------------------------------------------------
def _make_display_cb(mach_time_factor):
    def on_display(res):
        try:
            if not isinstance(res.selector, InstrumentRPCParseError):
                return
            for args in kperf_data(res.selector.data):
                _time = args[0]
                code  = args[7]
                if kdbg_extract_all(code) != (0x31, 0x80, 0xc6):
                    continue
                with _lock:
                    ds = _display_state
                    if ds['last_frame'] is None:
                        ds['last_frame'] = _time
                        continue
                    this_cost = (_time - ds['last_frame']) * mach_time_factor
                    c1, c2, c3 = ds['last_1_cost'], ds['last_2_cost'], ds['last_3_cost']
                    if c1 and c2 and c3:
                        avg = (c1 + c2 + c3) / 3.0
                        if this_cost > avg * 2 and this_cost > _MOVIE_FRAME_COST * _NANO_SECOND * 2:
                            ds['jank'] += 1
                            ds['jank_time'] += this_cost
                            if this_cost > avg * 3 and this_cost > _MOVIE_FRAME_COST * _NANO_SECOND * 3:
                                ds['big_jank'] += 1
                    ds['last_3_cost'] = ds['last_2_cost']
                    ds['last_2_cost'] = ds['last_1_cost']
                    ds['last_1_cost'] = this_cost
                    ds['time_count']  += this_cost
                    ds['frame_count'] += 1
                    ds['last_frame']  = _time
        except Exception:
            pass
    return on_display


# ---------------------------------------------------------------------------
# FPS fallback callback (graphics.opengl) — only used if coreprofile fails
# ---------------------------------------------------------------------------
def _on_fps(res):
    try:
        data = res.selector
        if isinstance(data, dict) and 'CoreAnimationFramesPerSecond' in data:
            with _lock:
                _state['fps'] = data['CoreAnimationFramesPerSecond']
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main collect (direct connection only)
# ---------------------------------------------------------------------------
def collect(bundle_id, exec_name):
    global _running

    app_name = exec_name if exec_name else bundle_id.split('.')[-1]
    _log(f'Starting (legacy/direct): {bundle_id} (matching: {app_name})')

    rpc = None
    _coreprofile_started = False
    try:
        rpc = InstrumentServer().init()
        _log('InstrumentServer connected')

        # ── Mach time factor for jank timing ─────────────────────────────────
        mach_info = rpc.call(DEVINFO_CHANNEL, 'machTimeInfo').selector
        mach_time_factor = mach_info[1] / mach_info[2]
        _log(f'machTimeInfo factor={mach_time_factor:.4f}')

        # ── sysmontap ────────────────────────────────────────────────────────
        rpc.call(SYSMONTAP_CHANNEL, 'setConfig:', {
            'ur': 1000,
            'bm': 0,
            'procAttrs': PROC_ATTRS,
            'cpuUsage':  True,
            'sampleInterval': 1000000000,
        })
        rpc.register_channel_callback(SYSMONTAP_CHANNEL, _make_sysmontap_cb(app_name))
        rpc.call(SYSMONTAP_CHANNEL, 'start')
        _log('sysmontap started')

        # ── coreprofilesessiontap: FPS + jank/big_jank/stutter ───────────────
        try:
            rpc.register_channel_callback(COREPROFILE_CHANNEL, _make_display_cb(mach_time_factor))
            rpc.call(COREPROFILE_CHANNEL, 'setConfig:', {
                'rp': 10,
                'tc': [{'kdf2': {630784000, 833617920, 830472456},
                        'tk': 3,
                        'uuid': str(uuid.uuid4()).upper()}],
                'ur': 500,
            })
            rpc.call(COREPROFILE_CHANNEL, 'start')
            _coreprofile_started = True
            _log('coreprofilesessiontap started (FPS ≤120 + jank)')
        except Exception as e:
            _log(f'coreprofilesessiontap unavailable: {e} — falling back to graphics.opengl for FPS')
            try:
                rpc.register_channel_callback(GRAPHICS_CHANNEL, _on_fps)
                rpc.call(GRAPHICS_CHANNEL, 'startSamplingAtTimeInterval:', 0.0)
                _log('FPS fallback (graphics.opengl) started')
            except Exception as e2:
                _log(f'FPS unavailable: {e2}')

        _log('Emitting every 1s — running until terminated')
        _emit_loop()

        while _running:
            time.sleep(0.5)

    except Exception as e:
        import traceback
        _log(f'ERROR: {e}')
        _log(traceback.format_exc())
    finally:
        _running = False
        stops = [(rpc.call, (SYSMONTAP_CHANNEL, 'stop'))]
        if _coreprofile_started:
            stops.append((rpc.call, (COREPROFILE_CHANNEL, 'stop')))
        else:
            stops.append((rpc.call, (GRAPHICS_CHANNEL, 'stopSampling')))
        stops.append((rpc.stop, ()))
        for fn, args in stops:
            try:
                fn(*args)
            except Exception:
                pass
        _log('Collector stopped')


def _log(msg):
    try:
        print(json.dumps({'__log': msg}), flush=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    rest = _gate_args_or_error(sys.argv[1:])
    if rest is None:
        sys.exit(1)
    if len(rest) < 2:
        print('error')
        sys.exit(1)
    collect(rest[0], rest[1])
