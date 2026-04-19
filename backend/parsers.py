from typing import Dict, Any, List, Tuple, DefaultDict, Optional
from datetime import datetime
import json
from collections import defaultdict
from sqlalchemy.orm import Session
from fastapi import HTTPException
from .models import TestRun, MetricBlob, Project
from .utils import compute_content_hash


def parse_timestamp(value: Any) -> datetime:
    # Accept iso string or epoch seconds/ms
    if value is None:
        return datetime.utcnow()
    if isinstance(value, (int, float)):
        # assume seconds if < 10^12
        if value > 1_000_000_000_000:
            value = value / 1000.0
        return datetime.utcfromtimestamp(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            pass
    return datetime.utcnow()


def normalize_device(payload: Dict[str, Any]) -> str:
    device = payload.get("device") or {}
    if isinstance(device, dict):
        return device.get("name") or ""
    if isinstance(device, str):
        return device
    return ""


def _ensure(cond: bool, field: str, msg: str = "invalid_schema"):
    if not cond:
        raise HTTPException(status_code=400, detail={"code": "invalid_schema", "field": field, "message": msg})


def _avg(values: List[Any]) -> float:
    nums = [v for v in values if isinstance(v, (int, float))]
    return (sum(nums) / len(nums)) if nums else None


def validate_schema_and_get_category(payload: Dict[str, Any]) -> str:
    _ensure(isinstance(payload, dict), "root", "payload must be object")
    device = payload.get("device")
    _ensure(isinstance(device, dict), "device", "device must be object")
    perf = payload.get("perf")
    _ensure(isinstance(perf, list) and len(perf) > 0, "perf", "perf must be non-empty array")
    for i, it in enumerate(perf):
        _ensure(isinstance(it, dict), f"perf[{i}]", "perf item must be object")
        _ensure("timestamp" in it, f"perf[{i}].timestamp", "timestamp is required")
    cat_dev = device.get("category")
    cat_root = payload.get("category")
    category = cat_dev or cat_root
    _ensure(category in ("android", "ios", "ios_gpu", "pc"), "category", "unsupported category")
    if cat_root and cat_dev and cat_root != cat_dev:
        raise HTTPException(status_code=400, detail={"code": "invalid_schema", "field": "category", "message": "category mismatch"})
    return category


def _validate_tag(perf_len: int, tag: Any) -> None:
    """可选：根级 tag，[[start,end], ...] 为 perf 数组下标闭区间，0 起。"""
    if tag is None:
        return
    _ensure(isinstance(tag, list), "tag", "tag must be array")
    for i, pair in enumerate(tag):
        _ensure(isinstance(pair, list) and len(pair) >= 2, f"tag[{i}]", "each item must be [start, end]")
        try:
            s = int(pair[0])
            e = int(pair[1])
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_schema", "field": f"tag[{i}]", "message": "start/end must be integers"},
            )
        _ensure(0 <= s < perf_len, f"tag[{i}].start", "start out of range")
        _ensure(0 <= e < perf_len, f"tag[{i}].end", "end out of range")
        _ensure(s <= e, f"tag[{i}]", "start must be <= end")


def parse_uploaded_json(
    db: Session,
    project: Project,
    payload: Dict[str, Any],
    *,
    owner_uid: str,
    para1: Optional[str] = None,
    para2: Optional[str] = None,
) -> Tuple[TestRun, List[MetricBlob]]:
    """入库一条测试；owner_uid 为上传方 UID；para1 为可选备用字段；para2 来自上传接口，可为 None。"""
    category = validate_schema_and_get_category(payload)
    perf: List[Dict[str, Any]] = payload["perf"]
    _validate_tag(len(perf), payload.get("tag"))
    started_at = parse_timestamp(perf[0].get("timestamp"))
    ended_at = parse_timestamp(perf[-1].get("timestamp"))
    label = payload.get("label") or payload.get("scenario") or ""
    device = normalize_device(payload)

    test_run = TestRun(
        project_id=project.id,
        category=category,
        content_hash=compute_content_hash(payload),
        owner_uid=owner_uid,
        para1=para1,
        para2=para2,
        started_at=started_at,
        ended_at=ended_at,
        device=device,
        label=label or payload.get("file", ""),
        raw_json=json.dumps(payload, ensure_ascii=False),
    )

    timestamps: List[Any] = []
    series: DefaultDict[str, List[Any]] = defaultdict(list)

    if category == "android":
        for it in perf:
            timestamps.append(it.get("timestamp"))
            cpu = it.get("cpu", {})
            mem = it.get("mem", {})
            net = it.get("net", {})
            battery = it.get("battery", {})
            cores = it.get("cpuCores", {})
            series["cpu.sysCpu"].append(cpu.get("sysCpu"))
            series["cpu.procCpu"].append(cpu.get("procCpu"))
            series["mem.totalPss"].append(mem.get("totalPss"))
            series["mem.nativeHeap"].append(mem.get("nativeHeap"))
            series["mem.javaHeap"].append(mem.get("javaHeap"))
            series["mem.code"].append(mem.get("code"))
            series["mem.stack"].append(mem.get("stack"))
            series["mem.graphics"].append(mem.get("graphics"))
            series["mem.privateOther"].append(mem.get("privateOther"))
            series["mem.system"].append(mem.get("system"))
            series["fps"].append(it.get("fps"))
            series["jank"].append(it.get("jank"))
            series["bigJank"].append(it.get("bigJank"))
            series["net.rxKBps"].append(net.get("rxKBps"))
            series["net.txKBps"].append(net.get("txKBps"))
            series["gpu"].append(it.get("gpu"))
            series["temperature"].append(it.get("temperature") if it.get("temperature") is not None else battery.get("temperature"))
            series["battery.currentNow"].append(battery.get("currentNow"))
            series["battery.power"].append(battery.get("power"))
            usage = cores.get("usage") or []
            for idx, v in enumerate(usage):
                series[f"cpuCores.usage.{idx}"].append(v)
            freq = cores.get("freq") or []
            for idx, v in enumerate(freq):
                series[f"cpuCores.freq.{idx}"].append(v)
        summary = {
            "fpsAvg": _avg(series["fps"]),
            "cpuProcAvg": _avg(series["cpu.procCpu"]),
            "memPssAvg": _avg(series["mem.totalPss"]),
            "tempAvg": _avg(series["temperature"]),
        }
    elif category == "ios":
        # 新采集 JSON 可能使用 big_jank、diskBytes*、ctxSwitch 等字段；统一写入与 chart-config 一致的 series 键。
        # 磁盘/事件若为累计量，按相邻点时间差换算为 KB/s 或 次/s。
        prev_ts_ms = None
        prev_disk_r = prev_disk_w = None
        prev_ctx = prev_wake = prev_vm = None
        for it in perf:
            ts = it.get("timestamp")
            timestamps.append(ts)
            dt_sec = None
            if prev_ts_ms is not None and ts is not None:
                d = (float(ts) - float(prev_ts_ms)) / 1000.0
                if d > 0:
                    dt_sec = d
            prev_ts_ms = ts

            series["cpuUsage"].append(it.get("cpuUsage"))
            series["cpuTotalSystem"].append(it.get("cpuTotalSystem"))
            series["cpuTotalUser"].append(it.get("cpuTotalUser"))
            series["fps"].append(it.get("fps"))
            series["jank"].append(it.get("jank"))
            bj = it.get("big_jank")
            if bj is None:
                bj = it.get("bigjank")
            series["bigjank"].append(bj)
            series["physFootprint"].append(it.get("physFootprint"))
            series["memResidentSize"].append(it.get("memResidentSize"))
            series["memRPrvt"].append(it.get("memRPrvt"))
            series["memRShrd"].append(it.get("memRShrd"))
            series["memAnon"].append(it.get("memAnon"))
            series["memCompressed"].append(it.get("memCompressed"))
            series["memPurgeable"].append(it.get("memPurgeable"))

            dr = it.get("_diskReadKBps")
            dw = it.get("_diskWriteKBps")
            dbr = it.get("diskBytesRead")
            dbw = it.get("diskBytesWritten")
            if dr is None and prev_disk_r is not None and dbr is not None and dt_sec:
                dr = (dbr - prev_disk_r) / 1024.0 / dt_sec
            if dw is None and prev_disk_w is not None and dbw is not None and dt_sec:
                dw = (dbw - prev_disk_w) / 1024.0 / dt_sec
            series["_diskReadKBps"].append(dr)
            series["_diskWriteKBps"].append(dw)
            if dbr is not None:
                prev_disk_r = dbr
            if dbw is not None:
                prev_disk_w = dbw

            cps = it.get("_ctxSwitchPs")
            ips = it.get("_intWakeupsPs")
            vps = it.get("_vmPageInsPs")
            cs = it.get("ctxSwitch")
            iw = it.get("intWakeups")
            vm = it.get("vmPageIns")
            if cps is None and cs is not None and prev_ctx is not None and dt_sec:
                cps = (cs - prev_ctx) / dt_sec
            if ips is None and iw is not None and prev_wake is not None and dt_sec:
                ips = (iw - prev_wake) / dt_sec
            if vps is None and vm is not None and prev_vm is not None and dt_sec:
                vps = (vm - prev_vm) / dt_sec
            series["_ctxSwitchPs"].append(cps)
            series["_intWakeupsPs"].append(ips)
            series["_vmPageInsPs"].append(vps)
            if cs is not None:
                prev_ctx = cs
            if iw is not None:
                prev_wake = iw
            if vm is not None:
                prev_vm = vm
        summary = {
            "fpsAvg": _avg(series["fps"]),
            "cpuProcAvg": _avg(series["cpuUsage"]),
            "memFootprintAvg": _avg(series["physFootprint"]),
        }
    elif category == "ios_gpu":
        numeric_keys = set()
        for it in perf:
            for k, v in it.items():
                if k in ("timestamp", "time"):
                    continue
                if isinstance(v, (int, float)):
                    numeric_keys.add(k)
        for i, it in enumerate(perf):
            ts = it.get("timestamp")
            if isinstance(ts, (int, float)):
                t = float(ts)
                # 整数毫秒：按采样序号拉开为浮点 ms，避免同 ms 多样本在图上重叠；已有小数则保留
                if t.is_integer():
                    t += i * 1e-3
                timestamps.append(t)
            else:
                timestamps.append(ts)
            for k in numeric_keys:
                series[k].append(it.get(k))
        summary = {
            "vertexOccAvg": _avg(series.get("Vertex Occupancy", [])),
            "fragOccAvg": _avg(series.get("Fragment Occupancy", [])),
            "aluUtilAvg": _avg(series.get("ALU Utilization", [])),
        }
    elif category == "pc":
        # 与 json-template/pc_perf.json 一致：Android 式嵌套字段 + pid + pcExtra + jankRate
        for it in perf:
            timestamps.append(it.get("timestamp"))
            cpu = it.get("cpu") or {}
            mem = it.get("mem") or {}
            net = it.get("net") or {}
            battery = it.get("battery") or {}
            cores = it.get("cpuCores") or {}
            pe = it.get("pcExtra") or {}
            series["cpu.sysCpu"].append(cpu.get("sysCpu"))
            series["cpu.procCpu"].append(cpu.get("procCpu"))
            series["mem.totalPss"].append(mem.get("totalPss"))
            series["mem.nativeHeap"].append(mem.get("nativeHeap"))
            series["mem.dalvikHeap"].append(mem.get("dalvikHeap"))
            series["mem.javaHeap"].append(mem.get("javaHeap"))
            series["mem.code"].append(mem.get("code"))
            series["mem.stack"].append(mem.get("stack"))
            series["mem.graphics"].append(mem.get("graphics"))
            series["mem.privateOther"].append(mem.get("privateOther"))
            series["mem.system"].append(mem.get("system"))
            series["fps"].append(it.get("fps"))
            series["jank"].append(it.get("jank"))
            series["bigJank"].append(it.get("bigJank"))
            series["jankRate"].append(it.get("jankRate"))
            series["net.rxKBps"].append(net.get("rxKBps"))
            series["net.txKBps"].append(net.get("txKBps"))
            series["gpu"].append(it.get("gpu"))
            series["temperature"].append(it.get("temperature") if it.get("temperature") is not None else battery.get("temperature"))
            series["battery.currentNow"].append(battery.get("currentNow"))
            series["battery.power"].append(battery.get("power"))
            series["battery.level"].append(battery.get("level"))
            series["pid"].append(it.get("pid"))
            series["pcExtra.diskReadKBps"].append(pe.get("diskReadKBps"))
            series["pcExtra.diskWriteKBps"].append(pe.get("diskWriteKBps"))
            series["pcExtra.fpsFloat"].append(pe.get("fpsFloat"))
            usage = cores.get("usage") or []
            for idx, v in enumerate(usage):
                series[f"cpuCores.usage.{idx}"].append(v)
            freq = cores.get("freq") or []
            for idx, v in enumerate(freq):
                series[f"cpuCores.freq.{idx}"].append(v)
        summary = {
            "fpsAvg": _avg(series["fps"]),
            "cpuProcAvg": _avg(series["cpu.procCpu"]),
            "memPssAvg": _avg(series["mem.totalPss"]),
            "tempAvg": _avg(series["temperature"]),
        }
    else:
        raise HTTPException(status_code=400, detail={"code": "invalid_schema", "message": "unsupported category"})

    content = {"timestamp": timestamps, "series": series, "meta": {"category": category}}
    blob = MetricBlob(test_run=test_run, content=json.dumps(content, ensure_ascii=False))
    # 保留 null，列表页可稳定读到 fpsAvg / cpuProcAvg / memFootprintAvg 等键
    test_run.summary = json.dumps(summary, ensure_ascii=False)
    return test_run, [blob]

