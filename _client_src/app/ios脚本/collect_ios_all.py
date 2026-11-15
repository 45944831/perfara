#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unified iOS collectors entry (code merged; no subprocess; no importing the old scripts).

SECURITY NOTE:
- 本脚本必须带入参数 `wonder` 才允许执行；否则仅输出 "error" 并退出。
- 禁用所有 help/usage（不暴露命令行用法）。用法只写在 README。
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import time
import uuid
import traceback
import types


_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def _ensure_optparse():
    """
    Python 3.13 removed stdlib `optparse`, but some vendored dependencies still
    import it (e.g. py-ios-device). We only need the import to succeed.
    """
    try:
        import optparse as _  # noqa: F401
        return
    except Exception:
        pass
    try:
        m = types.ModuleType('optparse')

        class _Options:
            pass

        class OptionParser:
            def __init__(self, *args, **kwargs):
                self._options = []

            def add_option(self, *args, **kwargs):
                self._options.append((args, kwargs))

            def parse_args(self, args=None, values=None):
                if args is None:
                    args = []
                return _Options(), list(args)

        class Option:
            def __init__(self, *args, **kwargs):
                self.args = args
                self.kwargs = kwargs

        m.OptionParser = OptionParser
        m.Option = Option
        sys.modules.setdefault('optparse', m)
    except Exception:
        # stay silent; worst case, import will still fail and we will print error
        # (when gate has passed).
        pass

def _ensure_wintun_dll_search_path():
    """
    If wintun dlls are bundled (PyInstaller onefile), add their folder to DLL search path.
    This prevents runtime failures for components that rely on wintun (e.g., tun/tunnel stacks).
    No output, no exceptions (security requirement).
    """
    try:
        if os.name != 'nt':
            return
        base = getattr(sys, '_MEIPASS', None) or _SCRIPT_DIR
        candidates = []
        # common layouts:
        # - wintun/bin/amd64/wintun.dll
        # - wintun/bin/arm64/wintun.dll
        # - wintun/bin/arm/wintun.dll
        bin_root = os.path.join(base, 'wintun', 'bin')
        if os.path.isdir(bin_root):
            for arch in ('amd64', 'x64', 'arm64', 'arm'):
                d = os.path.join(bin_root, arch)
                if os.path.isfile(os.path.join(d, 'wintun.dll')):
                    candidates.append(d)
        # fallback: wintun at root
        if os.path.isfile(os.path.join(base, 'wintun.dll')):
            candidates.append(base)
        for d in candidates:
            try:
                os.add_dll_directory(d)
            except Exception:
                pass
    except Exception:
        pass


def _ensure_py_ios_device_on_path():
    # PyInstaller onefile: resources are extracted under sys._MEIPASS
    meipass = getattr(sys, '_MEIPASS', None)
    bases = [b for b in (meipass, _SCRIPT_DIR, os.path.dirname(sys.executable)) if b]
    for base in bases:
        for _p in [
            os.path.join(base, 'psets', 'pdm'),
            os.path.join(base, 'Scripts', 'psets', 'pdm'),
            os.path.join(base, 'python', 'Scripts', 'psets', 'pdm'),
            os.path.join(base, 'ios-tools', 'python', 'python', 'Scripts', 'psets', 'pdm'),
        ]:
            if os.path.isdir(_p):
                if _p not in sys.path:
                    sys.path.insert(0, _p)
                return


def _force_utf8_stdio():
    # Windows: prevent GBK issues
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    elif hasattr(sys.stdout, 'buffer'):
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


def _suppress_ios_device_logs():
    logging.basicConfig(level=logging.CRITICAL + 1, format='', handlers=[])
    for _name in ['ios_device', 'Instrument', 'LockDown', 'USBMux', 'Mobile',
                  'DTXMsg', 'base', 'dvt', 'remote']:
        _lg = logging.getLogger(_name)
        _lg.setLevel(logging.CRITICAL + 1)
        _lg.disabled = True
        _lg.propagate = False


def _private_log(text: str):
    """
    Write debug info to a local file ONLY.
    Must not print anything (security requirement).
    """
    try:
        d = os.environ.get('TEMP') or os.environ.get('TMP') or os.getcwd()
        p = os.path.join(d, 'collect_ios_all.private.log')
        with open(p, 'a', encoding='utf-8', errors='replace') as f:
            f.write(text)
            if not text.endswith('\n'):
                f.write('\n')
    except Exception:
        pass


# ---------------------------------------------------------------------------
# collect_ios (iOS17+ tunnel / direct) — merged from collect_ios.py
# ---------------------------------------------------------------------------
def _run_collect_ios(bundle_id: str, exec_name: str, host: str | None = None, port: str | None = None, us_port: str | None = None):
    _ensure_py_ios_device_on_path()

    from ios_device.servers.Instrument import InstrumentServer  # noqa
    from ios_device.remote.remote_lockdown import RemoteLockdownClient  # noqa
    from ios_device.util.exceptions import InstrumentRPCParseError  # noqa
    from ios_device.util.utils import kperf_data  # noqa
    from ios_device.util.kperf_data import kdbg_extract_all  # noqa

    SYSMONTAP_CHANNEL = 'com.apple.instruments.server.services.sysmontap'
    GRAPHICS_CHANNEL = 'com.apple.instruments.server.services.graphics.opengl'
    COREPROFILE_CHANNEL = 'com.apple.instruments.server.services.coreprofilesessiontap'
    DEVINFO_CHANNEL = 'com.apple.instruments.server.services.deviceinfo'

    _NANO_SECOND = 1e9
    _MOVIE_FRAME_COST = 1 / 24

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
    _SKIP_PROC_KEYS = {'cpuTotalSystem', 'cpuTotalUser'}

    _ARCH_MAP = {
        16777228: 'arm64',
        16777223: 'x86_64',
        12: 'arm',
        7: 'x86',
    }

    state = {}
    lock = threading.Lock()
    running = {'v': True}
    proc_attrs = {'v': None}

    display_state = {
        'last_frame': None,
        'last_1_cost': 0,
        'last_2_cost': 0,
        'last_3_cost': 0,
        'frame_count': 0,
        'time_count': 0,
        'jank': 0,
        'big_jank': 0,
        'jank_time': 0,
    }

    def stop(*_):
        running['v'] = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def _log(msg: str):
        try:
            print(json.dumps({'__log': msg}), flush=True)
        except Exception:
            pass

    def emit():
        with lock:
            if not state:
                return
            out = dict(state)
            ds = display_state
            tc = ds['time_count']
            if tc > 0:
                out['fps'] = round(ds['frame_count'] / tc * _NANO_SECOND, 1)
            out['jank'] = ds['jank']
            out['big_jank'] = ds['big_jank']
            out['stutter'] = round(ds['jank_time'] / tc, 4) if tc > 0 else 0.0
            ds['frame_count'] = 0
            ds['time_count'] = 0
            ds['jank'] = 0
            ds['big_jank'] = 0
            ds['jank_time'] = 0
        out['timestamp'] = int(time.time() * 1000)
        out['time'] = time.strftime('%H:%M:%S')
        try:
            print(json.dumps(out), flush=True)
        except Exception:
            pass

    def emit_loop():
        if not running['v']:
            return
        emit()
        t = threading.Timer(1.0, emit_loop)
        t.daemon = True
        t.start()

    def apply_proc_values(values, attrs):
        with lock:
            for i, attr in enumerate(attrs):
                if i >= len(values):
                    break
                if attr in _SKIP_PROC_KEYS:
                    continue
                val = values[i]
                if val is None or str(val) in ('None', ''):
                    continue
                if attr in _NUMERIC_KEYS:
                    try:
                        state[attr] = float(val)
                    except (ValueError, TypeError):
                        pass
                elif attr == '__arch':
                    try:
                        arch_int = int(float(str(val)))
                        state['__arch'] = _ARCH_MAP.get(arch_int, str(val))
                    except (ValueError, TypeError):
                        state['__arch'] = str(val)
                elif attr == 'procStatus':
                    try:
                        state['procStatus'] = int(float(str(val)))
                    except (ValueError, TypeError):
                        pass

    def parse_processes(processes, attrs, app_name):
        try:
            name_idx = attrs.index('name')
        except ValueError:
            return
        for _pid, values in processes.items():
            if not isinstance(values, list):
                continue
            if name_idx >= len(values):
                continue
            name = values[name_idx]
            if name is None or str(name) in ('None', ''):
                continue
            name = str(name)
            if app_name.lower() in name.lower() or name.lower() in app_name.lower():
                apply_proc_values(values, attrs)
                return

    def parse_sysmontap(res, app_name):
        sel = res.selector
        if not isinstance(sel, list):
            return
        for item in sel:
            if not isinstance(item, dict):
                continue
            item_type = item.get('Type')
            if item_type in (5, 7):
                attrs = item.get('ProcessesAttributes')
                if attrs is not None:
                    proc_attrs['v'] = list(attrs)
                use_attrs = proc_attrs['v'] if proc_attrs['v'] is not None else PROC_ATTRS
                processes = item.get('Processes')
                if isinstance(processes, dict):
                    parse_processes(processes, use_attrs, app_name)
            elif 'SystemCPUUsage' in item:
                cpu = item.get('SystemCPUUsage')
                if isinstance(cpu, dict):
                    total = cpu.get('CPU_TotalLoad')
                    user = cpu.get('CPU_UserLoad')
                    if total is not None:
                        try:
                            with lock:
                                state['cpuTotalSystem'] = float(total)
                        except (ValueError, TypeError):
                            pass
                    if user is not None:
                        try:
                            v = float(user)
                            if v >= 0:
                                with lock:
                                    state['cpuTotalUser'] = v
                        except (ValueError, TypeError):
                            pass

    def make_sysmontap_cb(app_name):
        def on_sysmontap(res):
            try:
                parse_sysmontap(res, app_name)
            except Exception:
                pass
        return on_sysmontap

    def make_display_cb(mach_time_factor):
        def on_display(res):
            try:
                if not isinstance(res.selector, InstrumentRPCParseError):
                    return
                for args in kperf_data(res.selector.data):
                    _time = args[0]
                    code = args[7]
                    if kdbg_extract_all(code) != (0x31, 0x80, 0xc6):
                        continue
                    with lock:
                        ds = display_state
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
                        ds['time_count'] += this_cost
                        ds['frame_count'] += 1
                        ds['last_frame'] = _time
            except Exception:
                pass
        return on_display

    def on_fps(res):
        try:
            data = res.selector
            if not isinstance(data, dict):
                return
            fps_raw = data.get('CoreAnimationFramesPerSecond')
            if fps_raw is not None:
                with lock:
                    state['fps'] = fps_raw
        except Exception:
            pass

    app_name = exec_name if exec_name else bundle_id.split('.')[-1]
    _log(f'Starting: {bundle_id} (matching process: {app_name}), mode={"tunnel" if host else "direct"}')

    rpc = None
    rsd = None
    coreprofile_started = False
    try:
        if host and port:
            rsd = RemoteLockdownClient((host, int(port)), userspace_port=int(us_port))
            rsd.__enter__()
            rpc = InstrumentServer(rsd).init()
        else:
            rpc = InstrumentServer().init()

        _log('InstrumentServer connected')

        mach_info = rpc.call(DEVINFO_CHANNEL, 'machTimeInfo').selector
        mach_time_factor = mach_info[1] / mach_info[2]
        _log(f'machTimeInfo factor={mach_time_factor:.4f}')

        rpc.call(SYSMONTAP_CHANNEL, 'setConfig:', {
            'ur': 1000,
            'bm': 0,
            'procAttrs': PROC_ATTRS,
            'cpuUsage': True,
            'sampleInterval': 1000000000,
        })
        rpc.register_channel_callback(SYSMONTAP_CHANNEL, make_sysmontap_cb(app_name))
        rpc.call(SYSMONTAP_CHANNEL, 'start')
        _log('sysmontap started')

        try:
            rpc.register_channel_callback(COREPROFILE_CHANNEL, make_display_cb(mach_time_factor))
            rpc.call(COREPROFILE_CHANNEL, 'setConfig:', {
                'rp': 10,
                'tc': [{'kdf2': {630784000, 833617920, 830472456},
                        'tk': 3,
                        'uuid': str(uuid.uuid4()).upper()}],
                'ur': 500,
            })
            rpc.call(COREPROFILE_CHANNEL, 'start')
            coreprofile_started = True
            _log('coreprofilesessiontap started (FPS ≤120 + jank)')
        except Exception as e:
            _log(f'coreprofilesessiontap unavailable: {e} — falling back to graphics.opengl for FPS')
            try:
                rpc.register_channel_callback(GRAPHICS_CHANNEL, on_fps)
                rpc.call(GRAPHICS_CHANNEL, 'startSamplingAtTimeInterval:', 0.0)
                _log('FPS fallback (graphics.opengl) started')
            except Exception as e2:
                _log(f'FPS unavailable: {e2}')

        _log('Emitting every 1s — running until terminated')
        emit_loop()

        while running['v']:
            time.sleep(0.5)

    except Exception as e:
        _log(f'ERROR: {e}')
        _log(traceback.format_exc())
    finally:
        running['v'] = False
        if rpc:
            stops = [(rpc.call, (SYSMONTAP_CHANNEL, 'stop'))]
            if coreprofile_started:
                stops.append((rpc.call, (COREPROFILE_CHANNEL, 'stop')))
            else:
                stops.append((rpc.call, (GRAPHICS_CHANNEL, 'stopSampling')))
            stops.append((rpc.stop, ()))
            for fn, args in stops:
                try:
                    fn(*args)
                except Exception:
                    pass
        if rsd:
            try:
                rsd.__exit__(None, None, None)
            except Exception:
                pass
        _log('Collector stopped')


# ---------------------------------------------------------------------------
# collect_ios_legacy (iOS ≤16 direct USB) — merged from collect_ios_legacy.py
# ---------------------------------------------------------------------------
def _run_collect_ios_legacy(bundle_id: str, exec_name: str):
    _ensure_py_ios_device_on_path()

    # Patch bpylist2 BEFORE importing InstrumentServer (kept from legacy script)
    from ios_device.util import bpylist2  # noqa
    bpylist2.UNARCHIVE_CLASS_MAP['DTTapStatusMessage'] = bpylist2.DTTapMessageArchive

    from ios_device.servers.Instrument import InstrumentServer  # noqa
    from ios_device.util.exceptions import InstrumentRPCParseError  # noqa
    from ios_device.util.utils import kperf_data  # noqa
    from ios_device.util.kperf_data import kdbg_extract_all  # noqa

    SYSMONTAP_CHANNEL = 'com.apple.instruments.server.services.sysmontap'
    GRAPHICS_CHANNEL = 'com.apple.instruments.server.services.graphics.opengl'
    COREPROFILE_CHANNEL = 'com.apple.instruments.server.services.coreprofilesessiontap'
    DEVINFO_CHANNEL = 'com.apple.instruments.server.services.deviceinfo'

    _NANO_SECOND = 1e9
    _MOVIE_FRAME_COST = 1 / 24

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
    _SKIP_PROC_KEYS = {'cpuTotalSystem', 'cpuTotalUser'}

    _ARCH_MAP = {
        16777228: 'arm64',
        16777223: 'x86_64',
        12: 'arm',
        7: 'x86',
    }

    state = {}
    lock = threading.Lock()
    running = {'v': True}
    proc_attrs = {'v': None}

    display_state = {
        'last_frame': None,
        'last_1_cost': 0,
        'last_2_cost': 0,
        'last_3_cost': 0,
        'frame_count': 0,
        'time_count': 0,
        'jank': 0,
        'big_jank': 0,
        'jank_time': 0,
    }

    def stop(*_):
        running['v'] = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def _log(msg: str):
        try:
            print(json.dumps({'__log': msg}), flush=True)
        except Exception:
            pass

    def emit():
        with lock:
            if not state:
                return
            out = dict(state)
            ds = display_state
            tc = ds['time_count']
            if tc > 0:
                out['fps'] = round(ds['frame_count'] / tc * _NANO_SECOND, 1)
            out['jank'] = ds['jank']
            out['big_jank'] = ds['big_jank']
            out['stutter'] = round(ds['jank_time'] / tc, 4) if tc > 0 else 0.0
            ds['frame_count'] = 0
            ds['time_count'] = 0
            ds['jank'] = 0
            ds['big_jank'] = 0
            ds['jank_time'] = 0
        out['timestamp'] = int(time.time() * 1000)
        out['time'] = time.strftime('%H:%M:%S')
        try:
            print(json.dumps(out), flush=True)
        except Exception:
            pass

    def emit_loop():
        if not running['v']:
            return
        emit()
        t = threading.Timer(1.0, emit_loop)
        t.daemon = True
        t.start()

    def apply_proc_values(values, attrs):
        with lock:
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
                        state[attr] = float(val)
                    except (ValueError, TypeError):
                        pass
                elif attr == '__arch':
                    try:
                        arch_int = int(float(str(val)))
                        state['__arch'] = _ARCH_MAP.get(arch_int, str(val))
                    except (ValueError, TypeError):
                        state['__arch'] = str(val)
                elif attr == 'procStatus':
                    try:
                        state['procStatus'] = int(float(str(val)))
                    except (ValueError, TypeError):
                        pass

    def parse_processes(processes, attrs, app_name):
        try:
            name_idx = attrs.index('name')
        except ValueError:
            return
        for _pid, values in processes.items():
            if not isinstance(values, list):
                continue
            if name_idx >= len(values):
                continue
            name = values[name_idx]
            if name is None or str(name) in ('None', ''):
                continue
            name = str(name)
            if app_name.lower() in name.lower() or name.lower() in app_name.lower():
                apply_proc_values(values, attrs)
                return

    def parse_sysmontap(res, app_name):
        sel = res.selector
        if not isinstance(sel, list):
            return
        for item in sel:
            if not isinstance(item, dict):
                continue
            item_type = item.get('Type')
            if item_type in (5, 7):
                attrs = item.get('ProcessesAttributes')
                if attrs is not None:
                    proc_attrs['v'] = list(attrs)
                use_attrs = proc_attrs['v'] if proc_attrs['v'] is not None else PROC_ATTRS
                processes = item.get('Processes')
                if isinstance(processes, dict):
                    parse_processes(processes, use_attrs, app_name)
            elif item_type == 33:
                cpu = item.get('SystemCPUUsage', {})
                cpu_count = item.get('CPUCount') or item.get('EnabledCPUs') or len(item.get('PerCPUUsage', [1]))
                if not cpu_count:
                    cpu_count = 1
                total_raw = cpu.get('CPU_TotalLoad')
                user_raw = cpu.get('CPU_UserLoad')
                if total_raw is not None:
                    try:
                        normalised = float(total_raw) / cpu_count
                        with lock:
                            state['cpuTotalSystem'] = round(normalised, 2)
                    except (ValueError, TypeError):
                        pass
                if user_raw is not None:
                    try:
                        if float(user_raw) >= 0:
                            normalised = float(user_raw) / cpu_count
                            with lock:
                                state['cpuTotalUser'] = round(normalised, 2)
                    except (ValueError, TypeError):
                        pass

    def make_sysmontap_cb(app_name):
        def on_sysmontap(res):
            try:
                parse_sysmontap(res, app_name)
            except Exception:
                pass
        return on_sysmontap

    def make_display_cb(mach_time_factor):
        def on_display(res):
            try:
                if not isinstance(res.selector, InstrumentRPCParseError):
                    return
                for args in kperf_data(res.selector.data):
                    _time = args[0]
                    code = args[7]
                    if kdbg_extract_all(code) != (0x31, 0x80, 0xc6):
                        continue
                    with lock:
                        ds = display_state
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
                        ds['time_count'] += this_cost
                        ds['frame_count'] += 1
                        ds['last_frame'] = _time
            except Exception:
                pass
        return on_display

    def on_fps(res):
        try:
            data = res.selector
            if isinstance(data, dict) and 'CoreAnimationFramesPerSecond' in data:
                with lock:
                    state['fps'] = data['CoreAnimationFramesPerSecond']
        except Exception:
            pass

    app_name = exec_name if exec_name else bundle_id.split('.')[-1]
    _log(f'Starting (legacy/direct): {bundle_id} (matching: {app_name})')

    rpc = None
    coreprofile_started = False
    try:
        rpc = InstrumentServer().init()
        _log('InstrumentServer connected')

        mach_info = rpc.call(DEVINFO_CHANNEL, 'machTimeInfo').selector
        mach_time_factor = mach_info[1] / mach_info[2]
        _log(f'machTimeInfo factor={mach_time_factor:.4f}')

        rpc.call(SYSMONTAP_CHANNEL, 'setConfig:', {
            'ur': 1000,
            'bm': 0,
            'procAttrs': PROC_ATTRS,
            'cpuUsage': True,
            'sampleInterval': 1000000000,
        })
        rpc.register_channel_callback(SYSMONTAP_CHANNEL, make_sysmontap_cb(app_name))
        rpc.call(SYSMONTAP_CHANNEL, 'start')
        _log('sysmontap started')

        try:
            rpc.register_channel_callback(COREPROFILE_CHANNEL, make_display_cb(mach_time_factor))
            rpc.call(COREPROFILE_CHANNEL, 'setConfig:', {
                'rp': 10,
                'tc': [{'kdf2': {630784000, 833617920, 830472456},
                        'tk': 3,
                        'uuid': str(uuid.uuid4()).upper()}],
                'ur': 500,
            })
            rpc.call(COREPROFILE_CHANNEL, 'start')
            coreprofile_started = True
            _log('coreprofilesessiontap started (FPS ≤120 + jank)')
        except Exception as e:
            _log(f'coreprofilesessiontap unavailable: {e} — falling back to graphics.opengl for FPS')
            try:
                rpc.register_channel_callback(GRAPHICS_CHANNEL, on_fps)
                rpc.call(GRAPHICS_CHANNEL, 'startSamplingAtTimeInterval:', 0.0)
                _log('FPS fallback (graphics.opengl) started')
            except Exception as e2:
                _log(f'FPS unavailable: {e2}')

        _log('Emitting every 1s — running until terminated')
        emit_loop()

        while running['v']:
            time.sleep(0.5)

    except Exception as e:
        _log(f'ERROR: {e}')
        _log(traceback.format_exc())
    finally:
        running['v'] = False
        if rpc:
            stops = [(rpc.call, (SYSMONTAP_CHANNEL, 'stop'))]
            if coreprofile_started:
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


# ---------------------------------------------------------------------------
# collect_ios_gpu (iOS 17+ tunnel / direct) — merged from collect_ios_gpu.py
# ---------------------------------------------------------------------------
def _run_collect_ios_gpu(host: str | None = None, port: str | None = None, us_port: str | None = None):
    _force_utf8_stdio()
    _suppress_ios_device_logs()
    _ensure_py_ios_device_on_path()

    from ios_device.cli.base import InstrumentsBase  # noqa
    from ios_device.remote.remote_lockdown import RemoteLockdownClient  # noqa
    from ios_device.util.dtx_msg import RawInt64sl, RawInt32sl  # noqa
    from ios_device.util.gpu_decode import (  # noqa
        GRCDecodeOrder, GRCDisplayOrder, JSEvn, TraceData
    )

    GPU_CHANNEL = 'com.apple.instruments.server.services.gpu'
    MAX_SAMPLES_PER_FLUSH = 40

    running = {'v': True}
    error_code = {'v': None}

    def stop(*_):
        running['v'] = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def _log(msg: str):
        try:
            print(json.dumps({'__log': msg}), flush=True)
        except Exception:
            pass

    def emit_samples(display_key_list, counter_result, counter_list):
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
        t_str = time.strftime('%H:%M:%S')
        for row in samples:
            out = {'timestamp': now_ms, 'time': t_str, **row}
            try:
                print(json.dumps(out), flush=True)
            except Exception:
                pass

    def make_gpu_callback(mach_time_factor):
        js_env_holder = [None]
        display_key_list = [None]

        def on_gpu(res):
            try:
                sel = res.selector
                if isinstance(sel, dict):
                    code = sel.get('code', 0)
                    desc = sel.get('userinfo', {}).get('NSLocalizedDescription', str(sel))
                    cls = sel.get('$class', '')
                    error_code['v'] = code
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
                    dk = GRCDecodeOrder.decode(_data.get(1, []))
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
                        emit_samples(display_key_list[0], counter_result, counter_list)
                    except Exception as e:
                        _log(f'[gpu] trace decode error: {e}')
            except Exception as e:
                _log(f'[gpu] callback error: {e}')

        return on_gpu, js_env_holder, display_key_list

    _log(f'GPU collector starting: mode={"tunnel" if host else "direct"}')

    rsd = None
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
            device_name = gpu_info[0].get('device-name', '?') if gpu_info else '?'
            family_name = gpu_info[0].get('family-name', '?') if gpu_info else '?'
            _log(f'GPU device: {device_name} family={family_name}')

            raw_min = gpu_info[0].get('min-collection-interval', 1000) if gpu_info else 1000
            min_interval = min(int(raw_min), 1000)
            if raw_min != min_interval:
                _log(f'min-collection-interval device={raw_min}ms → using {min_interval}ms (1Hz cap)')
            else:
                _log(f'min-collection-interval={min_interval}')

            cfg_interval = 0 if not host else 1
            MAX_CFG_RETRIES = 60
            CFG_RETRY_WAIT = 2.0

            configured = False
            for attempt in range(1, MAX_CFG_RETRIES + 1):
                error_code['v'] = None
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
                code = error_code['v']
                if code is None:
                    _log(f'configureCounters OK (attempt {attempt})')
                    configured = True
                    break
                if code == 1:
                    if attempt == 1:
                        _log('等待游戏启动 (code=1 — Metal 渲染器未运行，请在设备上进入游戏场景)…')
                    elif attempt % 5 == 0:
                        _log(f'仍在等待游戏… ({attempt * CFG_RETRY_WAIT:.0f}s)')
                elif code == 4:
                    _log('code=4 (already collecting) — 重置状态…')
                    try:
                        rpc.call(GPU_CHANNEL, 'stopCollectingCounters')
                    except Exception:
                        pass
                    time.sleep(1.0)
                else:
                    _log(f'configureCounters error code={code}，重试中…')
                    time.sleep(CFG_RETRY_WAIT)

            if not configured:
                raise RuntimeError(
                    f'configureCounters failed after {MAX_CFG_RETRIES} attempts — ensure Metal game is running'
                )

            _log('GPU collection started — running until terminated')
            try:
                rpc.call(GPU_CHANNEL, 'startCollectingCounters')
                while running['v']:
                    time.sleep(0.5)
            finally:
                running['v'] = False
                try:
                    rpc.call(GPU_CHANNEL, 'stopCollectingCounters')
                except Exception:
                    pass
                try:
                    data = rpc.call(GPU_CHANNEL, 'flushRemainingData').selector
                    if (data and js_env_holder[0] and display_key_list[0]
                            and data[0] and len(data[0]) >= 6):
                        counter_result, counter_list = js_env_holder[0].ex_js(TraceData(*data[0][:6]))
                        emit_samples(display_key_list[0], counter_result, counter_list)
                except Exception:
                    pass
    except Exception as e:
        import traceback
        _log(f'ERROR: {e}')
        _log(traceback.format_exc())
    finally:
        running['v'] = False
        if rsd:
            try:
                rsd.__exit__(None, None, None)
            except Exception:
                pass
        _log('GPU collector stopped')


# ---------------------------------------------------------------------------
# gpu_counters_pre_ios17 (iOS ≤16 USB) — merged from gpu_counters_pre_ios17.py
# ---------------------------------------------------------------------------
def _run_gpu_counters_pre_ios17(argv: list[str]) -> int:
    _force_utf8_stdio()
    _suppress_ios_device_logs()
    _ensure_py_ios_device_on_path()

    from ios_device.cli.base import InstrumentsBase  # noqa: E402
    from ios_device.util.dtx_msg import RawInt64sl, RawInt32sl  # noqa: E402
    from ios_device.util.gpu_decode import (  # noqa: E402
        GRCDecodeOrder, GRCDisplayOrder, JSEvn, TraceData,
    )

    GPU_CHANNEL = 'com.apple.instruments.server.services.gpu'
    MAX_SAMPLES_PER_FLUSH = 40
    CFG_INTERVAL_USB = 0

    DEFAULT_DEVICE_META = {
        'name': 'iPhone',
        'bundleId': '',
        'appName': '',
        'category': 'ios_gpu',
    }

    running = {'v': True}
    error_code = {'v': None}

    def stop(*_):
        running['v'] = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def log_stderr(msg, verbose):
        if verbose:
            print(msg, file=sys.stderr, flush=True)

    def emit_rows(display_key_list, counter_result, counter_list, output, perf_buffer, verbose):
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
                    error_code['v'] = code
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
                        log_stderr(
                            f'[gpu] counters ready ({len(names)}): {names[:8]}{"…" if len(names) > 8 else ""}',
                            verbose,
                        )
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
        running['v'] = True
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
            log_stderr(
                f'[gpu] min-collection-interval using {min_interval} ms (device reported {raw_min})',
                verbose,
            )

            MAX_CFG_RETRIES = 60
            CFG_RETRY_WAIT = 2.0
            configured = False
            for attempt in range(1, MAX_CFG_RETRIES + 1):
                error_code['v'] = None
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
                code = error_code['v']
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
                raise RuntimeError('configureCounters 失败 — 请确认设备已连接、信任本机，且前台有 Metal/GPU 负载')

            try:
                rpc.call(GPU_CHANNEL, 'startCollectingCounters')
                log_stderr('[gpu] collecting… Ctrl+C 结束', verbose)
                while running['v'] and (deadline is None or time.time() < deadline):
                    time.sleep(0.2)
            finally:
                running['v'] = False
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
                        counter_result, counter_list = js_env_holder[0].ex_js(TraceData(*data[0][:6]))
                        emit_rows(display_key_list[0], counter_result, counter_list, output, perf_buffer, verbose)
                except Exception:
                    pass
                log_stderr('[gpu] stopped.', verbose)

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

    # 手写解析：禁用 argparse help/usage 输出
    udid = None
    network = False
    json_report = False
    json_lines = False
    outfile = None
    var_data = False
    duration = 0.0
    verbose = False

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--udid' and i + 1 < len(argv):
            udid = argv[i + 1]
            i += 2
            continue
        if a == '--network':
            network = True
            i += 1
            continue
        if a == '--json':
            json_report = True
            i += 1
            continue
        if a == '--json-lines':
            json_lines = True
            i += 1
            continue
        if a in ('-o', '--output') and i + 1 < len(argv):
            outfile = argv[i + 1]
            i += 2
            continue
        if a == '--var-data':
            var_data = True
            i += 1
            continue
        if a == '--duration' and i + 1 < len(argv):
            try:
                duration = float(argv[i + 1])
            except Exception:
                return 2
            i += 2
            continue
        if a in ('-v', '--verbose'):
            verbose = True
            i += 1
            continue
        return 2

    if json_report and json_lines:
        return 2
    if var_data and not json_report:
        return 2

    out_mode = 'json-report' if json_report else ('json-lines' if json_lines else 'text')
    try:
        run_usb(
            udid=udid,
            network=network,
            output=out_mode,
            duration_sec=duration,
            verbose=verbose,
            outfile=outfile,
            var_data=var_data,
        )
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        return 1


# ---------------------------------------------------------------------------
# CLI dispatch (no argparse; no help; require `wonder`)
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    # Gate: must pass "user wonder" to run
    if len(args) < 2 or args[0] != 'user' or args[1] != 'wonder':
        print('error')
        return 1

    # drop gate tokens
    args = args[2:]
    if not args:
        print('error')
        return 1

    _ensure_wintun_dll_search_path()
    _ensure_optparse()

    cmd = args[0]
    rest = args[1:]

    try:
        if cmd == 'collect_ios':
            if len(rest) < 3:
                print('error')
                return 1
            bundle_id, exec_name, mode = rest[0], rest[1], rest[2]
            if mode == 'tunnel':
                if len(rest) < 6:
                    print('error')
                    return 1
                host, port, us_port = rest[3], rest[4], rest[5]
                _run_collect_ios(bundle_id, exec_name, host=host, port=port, us_port=us_port)
            else:
                _run_collect_ios(bundle_id, exec_name)
            return 0

        if cmd == 'collect_ios_legacy':
            if len(rest) < 2:
                print('error')
                return 1
            _run_collect_ios_legacy(rest[0], rest[1])
            return 0

        if cmd == 'collect_ios_gpu':
            if len(rest) < 1:
                print('error')
                return 1
            mode = rest[0]
            if mode == 'tunnel':
                if len(rest) < 4:
                    print('error')
                    return 1
                host, port, us_port = rest[1], rest[2], rest[3]
                _run_collect_ios_gpu(host=host, port=port, us_port=us_port)
            else:
                _run_collect_ios_gpu()
            return 0

        if cmd == 'gpu_counters_pre_ios17':
            # 余下参数全部透传给手写解析器
            rc = _run_gpu_counters_pre_ios17(rest)
            if rc == 0:
                return 0
            print('error')
            return 1

        print('error')
        return 1

    except SystemExit as e:
        # 禁止 argparse 等意外退出带出 usage
        try:
            code = int(getattr(e, 'code', 1) or 1)
        except Exception:
            code = 1
        if code == 0:
            return 0
        print('error')
        return 1
    except Exception:
        print('error')
        # Gate has passed; allow printing the exception for debugging.
        # Still no help/usage output anywhere.
        try:
            print(traceback.format_exc(), flush=True)
        except Exception:
            pass
        _private_log('[main] unhandled exception')
        _private_log(traceback.format_exc())
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

