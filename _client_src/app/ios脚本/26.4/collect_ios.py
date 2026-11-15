#!/usr/bin/env python3
"""
iOS Performance Data Collector
Outputs one JSON line per second to stdout for Electron app.

FPS + jank/big_jank/stutter come from coreprofilesessiontap (same as
'pyidevice instruments display'), supporting up to 120 fps.
Falls back to graphics.opengl for FPS-only if coreprofile unavailable.

Usage:
  python collect_ios.py <bundle_id> <exec_name> direct
  python collect_ios.py <bundle_id> <exec_name> tunnel <host> <port> <us_port>
"""

import sys
import os
import json
import time
import uuid
import threading
import signal
# Debug flags: sysmontap raw dump (verbose)
_DUMP_SYSMON = True
_DUMP_SYSMON_MAX_CHUNK = 6000
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

from ios_device.servers.Instrument import InstrumentServer           # noqa
from ios_device.remote.remote_lockdown import RemoteLockdownClient   # noqa
from ios_device.util.exceptions import InstrumentRPCParseError       # noqa
from ios_device.util.utils import kperf_data                         # noqa
from ios_device.util.kperf_data import kdbg_extract_all              # noqa
from ios_device.util.variables import InstrumentsService             # noqa

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

# Attribute order for process data (must match procAttrs sent to setConfig:)
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
_sys_attrs = None    # from sysmonSystemAttributes (system row in sysmontap)
_match_tokens = None  # process name match tokens (resolved at runtime)

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
        # Require physFootprint (process or system-derived) before emitting.
        if 'physFootprint' not in _state:
            return
        out = dict(_state)
        ds = _display_state
        tc = ds['time_count']
        if tc > 0:
            out['fps'] = round(ds['frame_count'] / tc * _NANO_SECOND, 1)
        elif 'fps' in _state:
            # graphics.opengl fallback stores fps directly in _state
            out['fps'] = _state['fps']
        out['jank']    = ds['jank']
        out['big_jank'] = ds['big_jank']
        out['stutter'] = round(ds['jank_time'] / tc, 4) if tc > 0 else 0.0
        # Require fps (coreprofile needs at least one frame interval, or opengl path)
        if out.get('fps') is None:
            return
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
# sysmontap callback — iOS 17+ new format
# ---------------------------------------------------------------------------
def _make_sysmontap_cb(app_name):
    def on_sysmontap(res):
        try:
            if _DUMP_SYSMON:
                try:
                    raw = res.selector
                    s = json.dumps(raw, ensure_ascii=False)
                    if len(s) <= _DUMP_SYSMON_MAX_CHUNK:
                        _log(f'[sysmon] {s}')
                    else:
                        for i in range(0, len(s), _DUMP_SYSMON_MAX_CHUNK):
                            _log(f'[sysmon:{i // _DUMP_SYSMON_MAX_CHUNK + 1}] {s[i:i + _DUMP_SYSMON_MAX_CHUNK]}')
                except Exception as _:
                    _log('[sysmon] <dump failed>')
            _parse_sysmontap(res, app_name)
        except Exception:
            pass
    return on_sysmontap


def _apply_system_values(sys_vals, attr_names):
    """Map sysmontap System[] row to state; fills physFootprint from system memory/footprint fields."""
    global _state
    if not isinstance(sys_vals, list) or not attr_names:
        return
    best_key = None
    best_val = None
    best_score = -1
    with _lock:
        for i, name in enumerate(attr_names):
            if i >= len(sys_vals):
                break
            val = sys_vals[i]
            if val is None or str(val) in ('None', ''):
                continue
            key = str(name)
            kl = key.lower()
            try:
                fval = float(val) if isinstance(val, (int, float)) else float(str(val).strip())
            except (ValueError, TypeError):
                continue
            score = 0
            if 'footprint' in kl:
                score += 100
            if kl.startswith('phys'):
                score += 40
            if 'mem' in kl or 'memory' in kl:
                score += 25
            if fval > 0:
                score += min(int(fval // (1024 * 1024)), 150)
            if score > best_score:
                best_score = score
                best_key = key
                best_val = fval
        if 'physFootprint' not in _state and best_val is not None:
            _state['physFootprint'] = float(best_val)


def _parse_sysmontap(res, app_name):
    global _proc_attrs, _sys_attrs

    sel = res.selector
    if not isinstance(sel, list):
        return

    for item in sel:
        if not isinstance(item, dict):
            continue

        # System-wide metrics (memory/disk/network when sysAttrs is configured)
        if 'System' in item and isinstance(item.get('System'), list):
            names = _sys_attrs if isinstance(_sys_attrs, list) and _sys_attrs else None
            if names:
                _apply_system_values(item['System'], names)

        item_type = item.get('Type')

        if item_type in (5, 7):
            attrs = item.get('ProcessesAttributes')
            if attrs is not None:
                _proc_attrs = list(attrs)
                try:
                    _log('--------------- attrs----------------')
                    _log('[sysmon] ProcessesAttributes=' + json.dumps(_proc_attrs, ensure_ascii=False))
                except Exception:
                    pass
            use_attrs = _proc_attrs if _proc_attrs is not None else PROC_ATTRS

            processes = item.get('Processes')
            if isinstance(processes, dict):
                # Type=7 is the initial snapshot: dump all PIDs once for debugging.
                _parse_processes(processes, use_attrs, app_name, dump_all_pids=(item_type == 7))

        elif 'SystemCPUUsage' in item:
            cpu = item.get('SystemCPUUsage')
            if isinstance(cpu, dict):
                total = cpu.get('CPU_TotalLoad')
                user  = cpu.get('CPU_UserLoad')
                if total is not None:
                    try:
                        with _lock:
                            _state['cpuTotalSystem'] = float(total)
                    except (ValueError, TypeError):
                        pass
                if user is not None:
                    try:
                        v = float(user)
                        if v >= 0:
                            with _lock:
                                _state['cpuTotalUser'] = v
                    except (ValueError, TypeError):
                        pass


def _norm(s):
    try:
        return str(s or '').strip().lower()
    except Exception:
        return ''


def _make_match_tokens(bundle_id, exec_name, exe_name, fallback_app_name):
    toks = []
    for x in (bundle_id, exec_name, exe_name, fallback_app_name):
        if x:
            toks.append(str(x))
    try:
        if bundle_id and '.' in bundle_id:
            toks.append(bundle_id.split('.')[-1])
    except Exception:
        pass
    out = []
    seen = set()
    for t in toks:
        nt = _norm(t)
        if not nt or nt in seen:
            continue
        seen.add(nt)
        out.append(nt)
    return out


def _get_executable_name(rpc, bundle_id):
    try:
        applist = rpc.call(
            InstrumentsService.ApplicationListing,
            'installedApplicationsMatching:registerUpdateToken:',
            {},
            '',
        ).selector
        for a in applist or []:
            if a.get('CFBundleIdentifier') == bundle_id:
                exe = a.get('ExecutableName') or a.get('CFBundleExecutable')
                if exe:
                    return str(exe)
    except Exception:
        pass
    return None


def _parse_processes(processes, attrs, app_name, dump_all_pids=False):
    name_idx = -1
    try:
        name_idx = attrs.index('name')
    except ValueError:
        pass

    if dump_all_pids:
        try:
            # 1) Print a quick pid->name list
            all_items = []
            for pid, values in processes.items():
                nm = None
                if isinstance(values, list) and 0 <= name_idx < len(values):
                    nm = values[name_idx]
                if nm is None or str(nm) in ('None', ''):
                    nm = ''
                all_items.append({'pid': pid, 'name': str(nm)})
            s = json.dumps(all_items, ensure_ascii=False)
            _log('PID---------------------------------------')
            if len(s) <= _DUMP_SYSMON_MAX_CHUNK:
                _log('[sysmon-pids] ' + s)
            else:
                _log('[sysmon-pids] (chunked)')
                for i in range(0, len(s), _DUMP_SYSMON_MAX_CHUNK):
                    _log(f'[sysmon-pids:{i // _DUMP_SYSMON_MAX_CHUNK + 1}] {s[i:i + _DUMP_SYSMON_MAX_CHUNK]}')

            # 2) Print raw (unparsed) process values for ALL pids (debug)
            #    This is the original sysmontap "Processes" payload before we map attrs->values.
            for pid, values in processes.items():
                try:
                    nm = None
                    if isinstance(values, list) and 0 <= name_idx < len(values):
                        nm = values[name_idx]
                    if nm is None or str(nm) in ('None', ''):
                        nm = ''
                    raw = json.dumps(values, ensure_ascii=False)
                    _log('PID---------------------------------------')
                    if len(raw) <= _DUMP_SYSMON_MAX_CHUNK:
                        _log(f'[sysmon-raw] pid={pid} name={nm} values={raw}')
                    else:
                        _log(f'[sysmon-raw] pid={pid} name={nm} values(chunked)')
                        for i in range(0, len(raw), _DUMP_SYSMON_MAX_CHUNK):
                            _log(f'[sysmon-raw:{pid}:{i // _DUMP_SYSMON_MAX_CHUNK + 1}] {raw[i:i + _DUMP_SYSMON_MAX_CHUNK]}')

                    # Also print footprint-related fields for EVERY pid using attrs indices
                    try:
                        fp = {}
                        if isinstance(values, list):
                            for i, k in enumerate(attrs):
                                if i >= len(values):
                                    break
                                if isinstance(k, str) and ('footprint' in k.lower()):
                                    fp[k] = values[i]
                        if fp:
                            _log(f'[sysmon-raw-footprint] pid={pid} name={nm} ' + json.dumps(fp, ensure_ascii=False))
                    except Exception:
                        _log(f'[sysmon-raw-footprint] pid={pid} <dump failed>')
                except Exception:
                    _log(f'[sysmon-raw] pid={pid} <dump failed>')
        except Exception:
            _log('[sysmon-pids] <dump failed>')

    applied_first = False
    for pid, values in processes.items():
        if not isinstance(values, list):
            continue
        if name_idx < 0 or name_idx >= len(values):
            continue

        name = values[name_idx]
        if name is None or str(name) in ('None', ''):
            continue
        name = str(name)

        nname = _norm(name)
        hit = False
        try:
            toks = _match_tokens
        except Exception:
            toks = None
        if toks:
            for t in toks:
                if t and (t in nname or nname in t):
                    hit = True
                    break
        else:
            hit = (app_name.lower() in name.lower() or name.lower() in app_name.lower())

        if hit:
            _log('PID---------------------------------------')
            try:
                full = {}
                for i, k in enumerate(attrs):
                    if i >= len(values):
                        break
                    full[k] = values[i]
                s = json.dumps(full, ensure_ascii=False)
                if len(s) <= _DUMP_SYSMON_MAX_CHUNK:
                    _log(f'[sysmon-proc] pid={pid} name={name} fields={s}')
                else:
                    _log(f'[sysmon-proc] pid={pid} name={name} fields(chunked)')
                    for i in range(0, len(s), _DUMP_SYSMON_MAX_CHUNK):
                        _log(f'[sysmon-proc:{i // _DUMP_SYSMON_MAX_CHUNK + 1}] {s[i:i + _DUMP_SYSMON_MAX_CHUNK]}')
            except Exception:
                _log('[sysmon-proc] <dump failed>')
            # Print footprint-related fields separately for quick debugging
            try:
                fp = {}
                for i, k in enumerate(attrs):
                    if i >= len(values):
                        break
                    if isinstance(k, str) and ('footprint' in k.lower()):
                        fp[k] = values[i]
                if fp:
                    _log('[sysmon-footprint] pid=' + str(pid) + ' name=' + str(name) + ' ' + json.dumps(fp, ensure_ascii=False))
                else:
                    _log('[sysmon-footprint] pid=' + str(pid) + ' name=' + str(name) + ' <none>')
            except Exception:
                _log('[sysmon-footprint] <dump failed>')
            # If the memory field name changed, print a broad set of memory-like candidates.
            try:
                cand = {}
                for i, k in enumerate(attrs):
                    if i >= len(values):
                        break
                    if not isinstance(k, str):
                        continue
                    kl = k.lower()
                    if ('footprint' in kl) or kl.startswith('mem') or ('resident' in kl) or ('phys' in kl) or ('rprvt' in kl) or ('rshrd' in kl) or ('compressed' in kl) or ('anon' in kl):
                        cand[k] = values[i]
                if cand:
                    _log('[mem-candidates] pid=' + str(pid) + ' name=' + str(name) + ' ' + json.dumps(cand, ensure_ascii=False))
                else:
                    _log('[mem-candidates] pid=' + str(pid) + ' name=' + str(name) + ' <none>')
            except Exception:
                _log('[mem-candidates] <dump failed>')
            # Keep collector output stable: apply only the first matched process to _state,
            # but still print all matched PIDs for debugging.
            if not applied_first:
                _apply_proc_values(values, attrs)
                applied_first = True


def _apply_proc_values(values, attrs):
    with _lock:
        # Auto-detect a "memory footprint" metric when field names change.
        # We will try to populate physFootprint if missing, based on best-effort candidates.
        has_phys_footprint = False
        best_mem_key = None
        best_mem_val = None
        best_mem_score = -1

        for i, attr in enumerate(attrs):
            if i >= len(values):
                break
            if attr in _SKIP_PROC_KEYS:
                continue
            val = values[i]
            if val is None or str(val) in ('None', ''):
                continue
            # Heuristic: sysmontap proc fields may change across iOS versions.
            # Try to keep memory/footprint metrics even if not listed in _NUMERIC_KEYS.
            attr_l = str(attr).lower() if isinstance(attr, str) else ''
            if attr_l == 'physfootprint':
                has_phys_footprint = True
            want_numeric = (
                attr in _NUMERIC_KEYS
                or ('footprint' in attr_l)
                or attr_l.startswith('mem')
                or attr_l.endswith('size')
                or attr_l.endswith('bytes')
            )
            if want_numeric:
                try:
                    if isinstance(val, (int, float)):
                        fval = float(val)
                        _state[attr] = fval
                    else:
                        s = str(val).strip()
                        # tolerate "123", "123.45", "1e6"
                        fval = float(s)
                        _state[attr] = fval

                    # Track best memory candidate for auto-mapping.
                    try:
                        if isinstance(attr, str):
                            kl = attr_l
                            score = 0
                            if 'footprint' in kl:
                                score += 100
                            if kl.startswith('phys'):
                                score += 30
                            if kl.startswith('mem'):
                                score += 20
                            if 'resident' in kl:
                                score += 15
                            if 'compressed' in kl:
                                score += 10
                            # prefer larger positive values (memory bytes are usually large)
                            if fval is not None and fval > 0:
                                score += min(int(fval // (1024 * 1024)), 200)  # + up to 200 by MB
                            if score > best_mem_score:
                                best_mem_score = score
                                best_mem_key = str(attr)
                                best_mem_val = fval
                    except Exception:
                        pass
                except Exception:
                    # Keep raw value for debugging if it's memory/footprint related
                    try:
                        if ('footprint' in attr_l) or attr_l.startswith('mem'):
                            _state[attr] = str(val)
                            _log(f'[mem-parse-failed] {attr} type={type(val).__name__} val={str(val)[:200]}')
                    except Exception:
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
            else:
                # Keep other non-numeric fields as strings (best-effort) so we don't lose data.
                try:
                    _state[attr] = str(val)
                except Exception:
                    pass

        # If iOS no longer provides physFootprint directly, map our best candidate to it.
        if not has_phys_footprint and best_mem_key is not None and best_mem_val is not None:
            try:
                _state['physFootprint'] = float(best_mem_val)
            except Exception:
                _state['physFootprint'] = best_mem_val
            try:
                _log(f'[physFootprint:auto] key={best_mem_key} val={best_mem_val}')
            except Exception:
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
        if not isinstance(data, dict):
            return
        fps_raw = data.get('CoreAnimationFramesPerSecond')
        if fps_raw is not None:
            with _lock:
                _state['fps'] = fps_raw
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main collect
# ---------------------------------------------------------------------------
def collect(bundle_id, exec_name, host=None, port=None, us_port=None):
    global _running, _match_tokens
    app_name = exec_name if exec_name else bundle_id.split('.')[-1]

    _log(f'Starting: {bundle_id} (matching process: {app_name}), mode={"tunnel" if host else "direct"}')

    rpc = None
    rsd = None
    _coreprofile_started = False
    try:
        if host and port:
            rsd = RemoteLockdownClient((host, int(port)), userspace_port=int(us_port))
            rsd.__enter__()
            rpc = InstrumentServer(rsd).init()
        else:
            rpc = InstrumentServer().init()

        _log('InstrumentServer connected')

        # Fetch sysmon process attributes as early as possible (before sysmontap start)
        # so we can see the full field list even if later matching fails.
        try:
            _log('[sysmon] fetching sysmonProcessAttributes…')
            attrs = rpc.call(DEVINFO_CHANNEL, 'sysmonProcessAttributes').selector
            if isinstance(attrs, list) and attrs:
                # cache for later use in parser
                global _proc_attrs
                _proc_attrs = list(attrs)
                _log('--------------- attrs----------------')
                _log('[sysmon] sysmonProcessAttributes=' + json.dumps(_proc_attrs, ensure_ascii=False))
        except Exception as e:
            try:
                _log(f'[sysmon] sysmonProcessAttributes failed: {e}')
            except Exception:
                pass

        # System attributes for sysmontap System[] row (memory/disk/network when Process is absent)
        try:
            _log('[sysmon] fetching sysmonSystemAttributes…')
            sa = rpc.call(DEVINFO_CHANNEL, 'sysmonSystemAttributes').selector
            if isinstance(sa, list) and sa:
                global _sys_attrs
                _sys_attrs = list(sa)
                _log('[sysmon] sysmonSystemAttributes=' + json.dumps(_sys_attrs, ensure_ascii=False))
        except Exception as e:
            try:
                _log(f'[sysmon] sysmonSystemAttributes failed: {e}')
            except Exception:
                pass

        exe_name = _get_executable_name(rpc, bundle_id)
        if exe_name:
            _log(f'ExecutableName: {exe_name}')
        _match_tokens = _make_match_tokens(bundle_id, exec_name, exe_name, app_name)
        _log('[match_tokens] ' + json.dumps(_match_tokens, ensure_ascii=False))

        # ── Mach time factor for jank timing ─────────────────────────────────
        mach_info = rpc.call(DEVINFO_CHANNEL, 'machTimeInfo').selector
        mach_time_factor = mach_info[1] / mach_info[2]
        _log(f'machTimeInfo factor={mach_time_factor:.4f}')

        # ── sysmontap ────────────────────────────────────────────────────────
        sysmon_cfg = {
            'ur': 1000,
            'bm': 0,
            'procUsage': True,
            'cpuUsage':  True,
            # 3s sampling interval (ns)
            'sampleInterval': 3000000000,
        }
        # IMPORTANT:
        # On some iOS versions, sysmontap will only include per-process "Processes" payload
        # if procAttrs is explicitly provided. Use sysmonProcessAttributes (if available)
        # to request the full set; otherwise fall back to our known minimal PROC_ATTRS.
        # sysAttrs enables the System[] row (see pdm instruments.sysmontap).
        try:
            if _proc_attrs and isinstance(_proc_attrs, list):
                sysmon_cfg['procAttrs'] = _proc_attrs
            else:
                sysmon_cfg['procAttrs'] = PROC_ATTRS
        except Exception:
            sysmon_cfg['procAttrs'] = PROC_ATTRS
        try:
            if _sys_attrs and isinstance(_sys_attrs, list):
                sysmon_cfg['sysAttrs'] = list(_sys_attrs)
        except Exception:
            pass
        rpc.call(SYSMONTAP_CHANNEL, 'setConfig:', sysmon_cfg)
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
        if rpc is not None:
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
        if rsd:
            try:
                rsd.__exit__(None, None, None)
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
    if len(rest) < 3:
        print('error')
        sys.exit(1)

    bundle_id = rest[0]
    exec_name = rest[1]
    mode      = rest[2]

    if mode == 'tunnel':
        if len(rest) < 6:
            print('error')
            sys.exit(1)
        collect(bundle_id, exec_name, host=rest[3], port=rest[4], us_port=rest[5])
    else:
        collect(bundle_id, exec_name)
