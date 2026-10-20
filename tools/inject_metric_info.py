# -*- coding: utf-8 -*-
"""
给报告页（perf.html / library.html）注入「参数说明」能力：
  1) 每条参数（指标卡、图表标题、统计表指标、对比表指标、卡片 KPI）后面加一个淡色「!」标记；
  2) 点击标记弹出说明弹窗（含义 / 来源与算法 / 怎么看）；
  3) 全部内容内联在 HTML 里，不新增外部文件依赖（随报告一起复制即可用）。

脚本幂等：检测到 __METRIC_INFO_V1__ 就跳过对应文件（除非指定 --force）。

用法：
  python tools/inject_metric_info.py            # 注入 perf.html + library.html + 便携包副本
  python tools/inject_metric_info.py --dry      # 只预览改动点数量
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = os.path.join(ROOT, 'perfara', 'collector', 'resources', 'reports')
PORTABLE = os.path.join(ROOT, 'Perfara-Portable', 'collector', 'resources', 'reports')

MARK = '__METRIC_INFO_V1__'

# ══════════════════════════════════════════════════════════════════════════
# CSS
# ══════════════════════════════════════════════════════════════════════════
CSS = """
/* ═══ 参数说明「!」标记（(__METRIC_INFO_V1__)) ═══════════════════════════════ */
.info-dot {
  display: inline-flex; align-items: center; justify-content: center;
  width: 13px; height: 13px; margin-left: 4px; flex: none;
  border: 1px solid var(--border); border-radius: 50%;
  background: var(--bg3); color: var(--text2);
  font: 700 9px/1 var(--font); font-style: normal;
  vertical-align: middle; cursor: help; opacity: .55;
  transition: opacity .15s ease, color .15s ease, border-color .15s ease;
  user-select: none; -webkit-user-select: none;
}
.info-dot:hover, .info-dot:focus {
  opacity: 1; color: var(--accent); border-color: var(--accent); outline: none;
}
.kpi-label .info-dot, .card-label .info-dot { width: 12px; height: 12px; margin-left: 3px; }
.kpis-extra .info-dot { width: 11px; height: 11px; }
.mi-mask {
  position: fixed; inset: 0; z-index: 9999; padding: 20px;
  background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center;
}
.mi-mask[hidden] { display: none; }
.mi-modal {
  width: 100%; max-width: 560px; max-height: 82vh; overflow: auto;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: 0 14px 44px rgba(0, 0, 0, .5);
  animation: mi-pop .16s ease-out;
}
@keyframes mi-pop { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
.mi-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--border);
}
.mi-title { flex: 1; font-size: 14px; font-weight: 600; color: var(--text); }
.mi-unit { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--text2); }
.mi-close {
  border: none; background: transparent; color: var(--text2);
  font-size: 14px; line-height: 1; padding: 3px 6px; border-radius: 4px; cursor: pointer;
}
.mi-close:hover { color: var(--text); background: var(--bg3); }
.mi-body { padding: 12px 14px 14px; }
.mi-row { margin-bottom: 10px; }
.mi-row:last-child { margin-bottom: 0; }
.mi-row > i {
  display: block; margin-bottom: 3px;
  font-size: 11px; font-style: normal; font-weight: 600; color: var(--accent);
}
.mi-row > p { font-size: 12px; line-height: 1.8; color: var(--text2); }
"""

# ══════════════════════════════════════════════════════════════════════════
# JS：说明数据 + 弹窗 + 标记注入
# ══════════════════════════════════════════════════════════════════════════
JS_HEAD = '<script>\n/* %s 参数说明：点击指标旁的「!」查看该参数含义 */\n' % MARK

JS_BODY = r"""
(function () {
  'use strict';
  if (window.MetricInfo) return;

  var INFO = {
    fps: { t: 'FPS 帧率', u: '帧/s',
      d: '每秒实际渲染并投递到屏幕的画面帧数，是衡量流畅度最直观的指标。',
      h: '每个采样周期内统计 SurfaceFlinger / 显示管线提交的帧数，再折算到每秒；iOS 与 PC 按帧时间戳折算。',
      g: '需结合目标帧率（常见 30 / 60 / 90 / 120）判断；均值达标但曲线抖动大，用户依然能感知到不流畅。' },
    fpsTarget: { t: '目标帧率', u: '帧/s',
      d: '本次测试的参考帧率基准，其余帧率派生指标都以它为分母。',
      h: '取整段 FPS 的 P95 值后吸附到常见刷新率档位（24 / 30 / 60 / 90 / 120 / 144）。',
      g: '由数据推断得出；若实际是锁帧场景（如锁 30 帧）请按真实目标值理解。' },
    fpsMin: { t: 'FPS 最低', u: '帧/s',
      d: '整段测试中的最小帧率值。',
      h: '取所有采样点 FPS 的最小值。',
      g: '看最差时刻跌到多少；单点极低值通常与加载、切换、GC 等瞬时事件相关。' },
    fpsstd: { t: '帧率标准差', u: '帧/s',
      d: 'FPS 相对自身均值的离散程度。',
      h: '对整段 FPS 求标准差。',
      g: '越小越稳；均值相同但标准差大，说明画面节奏忽快忽慢。' },
    reach: { t: '达帧率', u: '%',
      d: '平均帧率相对目标帧率的达成比例。',
      h: '平均 FPS ÷ 目标帧率 × 100%。',
      g: '≥95% 优秀，80%~95% 一般，低于 80% 需要优化渲染或主线程。' },
    frametime: { t: '均帧 Avg(FTime)', u: 'ms',
      d: '平均每帧耗时，即每一帧从开始到呈现在屏幕上的平均时间。',
      h: '对 FPS > 0 的采样点计算 1000 / FPS，再取算术平均。',
      g: '比 FPS 均值更线性：目标间隔 = 1000 ÷ 目标帧率（60 帧即 16.7ms），越接近说明越流畅。' },
    ftimestd: { t: '帧耗时标准差 Std(FTime)', u: 'ms',
      d: '帧耗时的波动幅度，反映卡顿的稳定性。',
      h: '对每帧耗时（1000 / FPS）求标准差。',
      g: '越小越稳；和均帧一起看可判断是「普遍偏慢」还是「偶发尖刺」。' },
    ftimevar: { t: '帧耗时方差 Var(FTime)', u: 'ms²',
      d: '帧耗时离散程度的平方度量，与标准差同源。',
      h: '对每帧耗时求方差。',
      g: '用于更细的统计建模，日常看标准差更直观。' },
    lowpct: { t: '低帧占比', u: '%',
      d: '帧率低于目标帧率 80% 的采样点占比。',
      h: '统计 FPS < 目标帧率 × 0.8 的采样点数 ÷ 总采样点数。',
      g: '超过 10% 表示明显不达标；可在曲线上框选这些区间定位具体场景。' },
    onelow: { t: '1%Low', u: '帧/s',
      d: '最慢的 1% 帧的平均帧率，代表场景中最差时刻的流畅度。',
      h: '取帧耗时最长的 1% 采样点，求平均帧耗时后用 1000 折算回帧率。',
      g: '比平均 FPS 更贴近主观卡顿感受，一般要求 ≥ 目标帧率的 85%。' },
    drop: { t: 'Drop', u: '帧/时',
      d: '折算到每小时的帧率骤降次数。',
      h: 'PerfDog 口径：相邻采样点 FPS 下降超过 8 帧计一次，再按测试时长折算到每小时。',
      g: '衡量突发掉帧的频繁程度，与卡顿次数互补。' },
    getarget: { t: 'FPS≥目标', u: '%',
      d: '达到目标帧率的采样点占比。',
      h: '统计 FPS ≥ 目标帧率的采样点数 ÷ 总采样点数。',
      g: '与达帧率的区别：这是「样本口径」，分子看的是采样点而非均值。' },
    medrange: { t: '稳帧范围 MedRange', u: '%',
      d: '帧率落在中位数 ±20% 区间内的采样点占比，衡量画面节奏的一致性。',
      h: '先取 FPS 中位数，再统计落在 ±20% 范围内的采样点占比。',
      g: '越高说明帧率越集中；低但均值高，通常是「大部分时间满帧、偶尔大掉帧」。' },
    stutter: { t: 'Stutter 卡顿时长占比', u: '%',
      d: '卡顿持续时间占整段测试时长的比例。',
      h: '帧间隔超过 2 倍目标帧间隔的帧，累计其耗时 ÷ 总耗时 × 100%。',
      g: '比卡顿「次数」更能体现卡了多久，一般要求低于 5%。' },

    jank: { t: 'Jank 卡顿帧', u: '次/s',
      d: '明显超出正常耗时的一次掉帧，是肉眼可察觉的「顿一下」。',
      h: 'PerfDog 口径：当前帧耗时 > 前三帧平均耗时 2 倍，且 > 2 个电影帧（约 83ms）判定为 1 次 Jank。',
      g: '关键场景（战斗、切图、加载）中的 Jank 优先治理；≤2 次/分钟通常可接受。' },
    bigjank: { t: 'BigJank 严重卡顿帧', u: '次/s',
      d: '耗时特别长的卡顿帧，用户几乎必感知。',
      h: 'PerfDog 口径：当前帧耗时 > 前三帧平均耗时 2 倍，且 > 3 个电影帧（125ms）判定为 1 次 BigJank。',
      g: '优先级最高：通常对应 GC、磁盘 IO、资源加载或布局重排。' },
    smalljank: { t: 'SmallJank 轻卡顿帧', u: '次/s',
      d: 'Jank 家族中较轻的一级，用于在整体已流畅时定位轻微抖动。',
      h: '同 Jank 的相对判定逻辑，但阈值更宽松（帧耗时超过基线而尚未达到 Jank 门槛）。',
      g: '数值不大时无需处理；集中出现时说明有周期性的小开销。' },
    tinyjank: { t: 'TinyJank 微卡顿帧', u: '次/s',
      d: '最轻一级的卡顿，粒度最细。',
      h: '同 Jank 的相对判定逻辑，阈值最低。',
      g: '用于对标极致流畅度的专项优化。' },
    jank10: { t: 'Jank/10min', u: '次',
      d: '按每 10 分钟折算的 Jank 次数。',
      h: '整段 Jank 累计次数 ÷ 测试分钟数 × 10。',
      g: '抹平时长差异，便于不同长度的测试横向对比。' },
    bigjank10: { t: 'BigJank/10min', u: '次',
      d: '按每 10 分钟折算的严重卡顿次数。',
      h: '整段 BigJank 累计次数 ÷ 测试分钟数 × 10。',
      g: '跨版本、跨机型对比最有价值的卡顿指标。' },
    smalljank10: { t: 'SmallJank/10min', u: '次',
      d: '按每 10 分钟折算的轻卡顿次数。',
      h: '整段 SmallJank 累计次数 ÷ 测试分钟数 × 10。',
      g: '同上，用于横向对比。' },
    tinyjank10: { t: 'TinyJank/10min', u: '次',
      d: '按每 10 分钟折算的微卡顿次数。',
      h: '整段 TinyJank 累计次数 ÷ 测试分钟数 × 10。',
      g: '同上，用于横向对比。' },

    syscpu: { t: '系统 CPU', u: '%',
      d: '整机 CPU 占用率，反映设备整体繁忙程度（含系统与其他应用）。',
      h: 'Android 取 /proc/stat 的时间片差值，iOS 由内核 CPU 负载折算，PC 取系统 CPU 计数器。',
      g: '持续高于 80% 说明整机负载饱和，会放大掉帧与发热；低但进程 CPU 高则说明瓶颈在自身。' },
    cpuchart: { t: 'CPU 使用率', u: '%',
      d: '同时展示整机（系统 CPU）与被测进程（进程 CPU）的占用率，用于区分瓶颈在系统侧还是应用侧。',
      h: '两条曲线同源：整机取系统 CPU 计数，进程取被测进程 CPU 时间差值 ÷ 采样间隔。',
      g: '进程 CPU 高而系统 CPU 低 = 自身代码开销大；两者都高 = 整机负载饱和。' },
    proccpu: { t: '进程 CPU', u: '%',
      d: '被测应用进程占用的 CPU 比例。',
      h: '读取进程 CPU 时间（utime + stime）在采样间隔内的差值 ÷ 间隔时长。',
      g: '长期高于 60% 需排查热点函数；注意不同平台对多核的归一口径不同，跨平台对比需留意。' },
    cpulimit: { t: 'CPU 限频', u: '%',
      d: 'CPU 实际运行频率相对最高频率的比例。',
      h: '取各核心当前频率 ÷ 硬件最高频率。',
      g: '长时间偏低说明已发生温控降频或调度限制，重负载场景会算力不足。' },
    cpucores: { t: '各核心 CPU 使用率', u: '%',
      d: '每个 CPU 核心各自的占用率。',
      h: '读取 /proc/stat（或等价接口）中各核心的时间片差值。',
      g: '大核打满而小核空闲，通常是线程亲和性或主线程瓶颈的信号。' },
    cpufreq: { t: '各核心 CPU 频率', u: 'MHz',
      d: '每个 CPU 核心当前的运行频率。',
      h: '读取 cpufreq 节点的 cur_freq / cpuinfo_cur_freq。',
      g: '持续低于最高频且伴随掉帧，说明触发了温控降频。' },

    mem: { t: '内存', u: 'MB',
      d: 'Android 为内存 PSS（按共享页比例分摊后的实际物理内存，官方推荐口径）；iOS 为物理内存足迹 phys_footprint；PC 为进程常驻内存。',
      h: 'Android 汇总 /proc/<pid>/smaps 或 dumpsys meminfo 的 PSS；iOS 取 task_vm_info 的 phys_footprint。',
      g: '重点看峰值与增长趋势：长时间运行持续增长通常意味着内存压力或泄漏。' },
    memdetail: { t: '内存详情', u: 'MB',
      d: '内存的组成部分。Android / PC：NativeHeap、JavaHeap、Code、Stack、Graphics、PrivateOther、System；iOS：私有常驻、共享常驻、匿名、压缩、可清除。',
      h: '由 meminfo / task_vm_info 的各分项原始值换算为 MB。',
      g: 'JavaHeap 持续增长多为对象未释放，Graphics 增长多为纹理 / RenderTarget 未回收。' },

    net: { t: '网络 ↓/↑', u: 'KB/s',
      d: '下行（接收）与上行（发送）速率。',
      h: '取网卡流量计数（Android /proc/net/dev 或系统流量接口，iOS / PC 用系统计数器）在采样间隔内的差值。',
      g: '下行尖刺通常对应资源下载；做弱网测试时应配合真实带宽限制一起看。' },

    gpu: { t: 'GPU 使用率', u: '%',
      d: 'GPU 计算单元的占用比例。',
      h: '高通读取 /sys/class/kgsl 节点，Mali 读取 GPU 设备节点；部分 MTK 非 root 机型读不到，此时报告会自动改用 GPU 温度展示。',
      g: '长期高于 90% 说明 GPU 已成瓶颈，应从分辨率、后处理、Overdraw 入手。' },
    gputemp: { t: 'GPU 温度', u: '°C',
      d: 'GPU 芯片温度，用于在读不到利用率时侧面反映 GPU 负载。',
      h: '读取 GPU 温度传感器节点。',
      g: '与温度同为降频前兆；持续升高说明渲染负载偏高。' },
    temp: { t: '温度', u: '°C',
      d: '机身 / 电池温度，反映设备热状态。',
      h: '优先读取 thermal 温控节点，读不到时回退为电池温度。',
      g: '超过 45°C 通常会开始降频，超过 50°C 会明显影响帧率与手感。' },

    battery: { t: '电池', u: '%',
      d: '设备剩余电量百分比。',
      h: '读取系统电池电量接口。',
      g: '用于确认测试期间的电量条件是否一致。' },
    current: { t: '电流', u: 'mA',
      d: '电池瞬时充放电电流。',
      h: '读取电池电流寄存器值；负值通常代表充电状态。',
      g: '与功耗一起评估续航影响，建议在同一电量区间对比。' },
    power: { t: '功耗', u: 'mW',
      d: '整机瞬时功率。',
      h: '由电流 × 电压估算得到。',
      g: '长时间高功耗会加速升温并触发限频。' },

    disk: { t: '磁盘 I/O', u: 'KB/s',
      d: '磁盘读 / 写速率。',
      h: '取进程 IO 计数（read_bytes / write_bytes）在采样间隔内的差值。',
      g: '加载期的读尖刺属正常；持续的高频写入会造成卡顿与发热。' },
    cswitch: { t: '上下文切换', u: '次/s',
      d: '进程每秒发生的线程上下文切换次数。',
      h: '取进程自愿 / 非自愿上下文切换计数在采样间隔内的差值。',
      g: '数值过高说明线程过多或锁竞争严重，会带来额外调度开销。' },
    events: { t: '系统事件', u: '次/s',
      d: 'iOS 的系统事件计数：上下文切换、中断唤醒、缺页中断。',
      h: '由 iOS 系统计数器在采样间隔内的差值计算。',
      g: '中断唤醒偏高说明 wakeup 频繁，通常与定时器或 IPC 有关。' },
    threads: { t: '线程数', u: '个',
      d: '被测进程当前的线程数量。',
      h: '读取进程线程计数（iOS numThreads / Android threads）。',
      g: '线程过多会增加调度开销与内存占用，且容易放大上下文切换。' },

    gpu_occ: { t: 'GPU 占用率', u: '%',
      d: 'Vertex / Fragment / Compute 三类管线的占用率，反映各 GPU 单元的繁忙程度。',
      h: '来自 Apple GPU Counters（Instruments 的 AGX 计数器）采样。',
      g: '某类接近 100% 说明该管线被打满，优化方向随之明确。' },
    gpu_alu: { t: 'ALU 利用率', u: '%',
      d: '算术逻辑单元利用率，即着色器指令执行单元的繁忙程度。',
      h: '来自 Apple GPU Counters 的 ALU Utilization。',
      g: '持续接近 100% 需简化 shader 计算量。' },
    gpu_aluperf: { t: 'ALU 性能', u: '%',
      d: 'ALU / F32 / F16 的利用率，以及 ALU 成为瓶颈的时间占比（Limiter）。',
      h: '来自 Apple GPU Counters 的 Utilization 与 Limiter 系列计数。',
      g: 'Utilization 高且 Limiter 也高 = 此处是真瓶颈；只有 Utilization 高则是负载大但还没堵死。' },
    gpu_tex: { t: '纹理性能', u: '%',
      d: '纹理采样器利用率，以及 Filtering / Sample / Cache 各环节成为瓶颈的比例。',
      h: '来自 Apple GPU Counters 的 Texture 系列 Utilization 与 Limiter。',
      g: 'Cache Limiter 偏高优先考虑纹理尺寸与压缩格式。' },
    gpu_texlimiter: { t: '纹理采样限制', u: '%',
      d: '纹理采样环节成为 GPU 性能瓶颈的时间占比。',
      h: '来自 Apple GPU Counters 的 Texture Sample Limiter。',
      g: '偏高时应减少采样次数、使用 mipmap 与压缩纹理。' },
    gpu_vertex: { t: 'Vertex 占用', u: '%',
      d: '顶点着色阶段的管线占用率。',
      h: '来自 Apple GPU Counters 的 Vertex Occupancy。',
      g: '偏高时应减少顶点数量、启用 LOD 与实例化。' },
    gpu_frag: { t: 'Fragment 占用', u: '%',
      d: '片元着色阶段的管线占用率。',
      h: '来自 Apple GPU Counters 的 Fragment Occupancy。',
      g: '偏高多数是 Overdraw 或复杂片元着色器导致。' },
    gpu_bw: { t: 'GPU 内存带宽', u: 'GB/s',
      d: 'GPU 与外部内存之间的读 / 写带宽。',
      h: '来自 Apple GPU Counters 的 GPU Read / Write Bandwidth。',
      g: '带宽打满时应降低纹理尺寸、启用压缩格式或减少 RenderTarget。' },
    gpu_readbw: { t: 'GPU 读带宽', u: 'GB/s',
      d: 'GPU 从显存读取数据占用的带宽。',
      h: '来自 Apple GPU Counters 的 GPU Read Bandwidth。',
      g: '读带宽高通常是纹理采样过多或分辨率过高。' },
    gpu_writebw: { t: 'GPU 写带宽', u: 'GB/s',
      d: 'GPU 写入显存占用的带宽。',
      h: '来自 Apple GPU Counters 的 GPU Write Bandwidth。',
      g: '写带宽高通常与多 RenderTarget、后处理链过长有关。' },
    gpu_cache: { t: '缓存 & MMU', u: '%',
      d: '末级缓存（LLC）与 MMU 的利用率及其成为瓶颈的比例。',
      h: '来自 Apple GPU Counters 的 Last Level Cache / MMU Utilization 与 Limiter。',
      g: 'Cache Limiter 偏高说明数据局部性差，应改善资源布局与访问顺序。' },
    gpu_shader: { t: '着色器 & 插值', u: '%',
      d: '片元插值开销，以及 Threadgroup / Imageblock 的 Load、Store 利用率。',
      h: '来自 Apple GPU Counters 的 Interpolation 与 Threadgroup / Imageblock 系列计数。',
      g: '插值开销高通常是 varying 传参过多或过度使用高精度浮点。' },
  };

  /** 报告里出现各种指标名 → 说明 key */
  var ALIAS = {
    '系统CPU': 'syscpu', '系统 CPU': 'syscpu', 'CPU': 'proccpu', '进程CPU': 'proccpu', '进程 CPU': 'proccpu',
    '进程 CPU 平均': 'proccpu', 'CPU 使用率': 'syscpu', 'CPU 限频': 'cpulimit',
    '各核心CPU': 'cpucores', '各核心频率': 'cpufreq',
    '内存': 'mem', '内存 PSS': 'mem', '内存 PSS 平均': 'mem', '物理内存': 'mem', 'PSS': 'mem', 'RSS': 'mem',
    '内存详情': 'memdetail', '内存明细': 'memdetail',
    'FPS': 'fps', 'fps': 'fps', 'FPS 平均': 'fps', 'FPS 最低': 'fpsMin', '目标': 'fpsTarget', '目标帧率': 'fpsTarget',
    '达帧率': 'reach', '均帧': 'frametime', '低帧': 'lowpct', '低帧占比': 'lowpct',
    '帧率标准差': 'fpsstd', '帧耗时标准差': 'ftimestd', '帧耗时方差': 'ftimevar',
    '1%Low': 'onelow', 'Drop': 'drop', 'FPS≥目标': 'getarget', '≥目标': 'getarget',
    '稳帧': 'medrange', '稳帧范围': 'medrange', '卡顿时长占比': 'stutter', 'Stutter': 'stutter',
    'Jank': 'jank', '大 Jank': 'bigjank', 'BigJank': 'bigjank', 'Jank 平均': 'jank', 'BigJank 平均': 'bigjank',
    'SmallJank': 'smalljank', 'SmallJank 平均': 'smalljank', 'TinyJank': 'tinyjank', 'TinyJank 平均': 'tinyjank',
    'Jank/10min': 'jank10', 'BigJank/10min': 'bigjank10', 'SmallJank/10min': 'smalljank10', 'TinyJank/10min': 'tinyjank10',
    '网络 ↓/↑': 'net', '网络流量': 'net', '下行': 'net', '上行': 'net',
    'GPU': 'gpu', 'GPU 平均': 'gpu', 'GPU 使用率': 'gpu', 'GPU 温度': 'gputemp',
    '温度': 'temp', '温度 平均': 'temp', '电池': 'battery', '电流': 'current', '功耗': 'power',
    '磁盘 I/O': 'disk', '磁盘读': 'disk', '磁盘读写': 'disk', '读 KB/s': 'disk', '写 KB/s': 'disk',
    '上下文切换': 'cswitch', '系统事件': 'events', '线程数': 'threads',
    // library.html 内部使用的英文指标键（对比表 / 曲线 / 归档 KPI）
    'fpsMin': 'fpsMin', 'fpsReach': 'reach', 'fpsFrameTime': 'frametime', 'fpsLowPct': 'lowpct',
    'fps1Low': 'onelow', 'fpsGeTarget': 'getarget', 'fpsMedRange': 'medrange',
    'fpsStd': 'fpsstd', 'fpsStutter': 'stutter', 'fpsDrop': 'drop',
    'bigJank': 'bigjank', 'smallJank': 'smalljank', 'tinyJank': 'tinyjank',
    'jank10': 'jank10', 'bigJank10': 'bigjank10', 'smallJank10': 'smalljank10', 'tinyJank10': 'tinyjank10',
    'cpuLimit': 'cpulimit', 'gpuTemp': 'gputemp', 'fpsTarget': 'fpsTarget',
    'cpu': 'proccpu', 'syscpu': 'syscpu', 'disk': 'disk', 'bandwidth': 'gpu_bw',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function keyOf(name) {
    if (!name) return '';
    var k = ALIAS[String(name).trim()];
    if (k) return k;
    if (INFO[String(name).trim()]) return String(name).trim();
    return '';
  }

  /** 给带 data-info 的容器补上「!」标记（幂等，可重复调用） */
  function decorate(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var host = (scope === document || !scope.querySelectorAll) ? scope : scope;
    var list = host.querySelectorAll('[data-info]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.getAttribute('data-info') === '') continue;
      if (el.querySelector('.info-dot')) continue;
      if (el.tagName === 'TBODY' || el.tagName === 'TABLE') continue;
      var key = keyOf(el.getAttribute('data-info'));
      if (!key || !INFO[key]) continue;
      var dot = document.createElement('span');
      dot.className = 'info-dot';
      dot.setAttribute('data-info', key);
      dot.setAttribute('role', 'button');
      dot.setAttribute('tabindex', '0');
      dot.title = '查看参数说明';
      dot.textContent = '!';
      el.appendChild(dot);
    }
  }

  /** 把某个指标名改成「!」标记的属性串，供 innerHTML 拼接使用 */
  function attr(name) {
    var k = keyOf(name);
    return k ? ' data-info="' + esc(k) + '"' : '';
  }

  var mask = null;
  function ensureModal() {
    if (mask) return mask;
    mask = document.createElement('div');
    mask.className = 'mi-mask';
    mask.hidden = true;
    mask.innerHTML =
      '<div class="mi-modal" role="dialog" aria-modal="true">' +
        '<div class="mi-head"><span class="mi-title"></span>' +
        '<button type="button" class="mi-close" aria-label="关闭">✕</button></div>' +
        '<div class="mi-body"></div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || (e.target.closest && e.target.closest('.mi-close'))) hide();
    });
    return mask;
  }

  function row(label, text) {
    return text ? '<div class="mi-row"><i>' + esc(label) + '</i><p>' + esc(text) + '</p></div>' : '';
  }

  function show(key) {
    var info = INFO[key];
    if (!info) return;
    var box = ensureModal();
    box.querySelector('.mi-title').innerHTML = esc(info.t) + (info.u ? '<span class="mi-unit">' + esc(info.u) + '</span>' : '');
    box.querySelector('.mi-body').innerHTML =
      row('是什么', info.d) + row('来源与算法', info.h) + row('怎么看', info.g);
    box.hidden = false;
  }

  function hide() { if (mask) mask.hidden = true; }

  window.MetricInfo = {
    version: '__METRIC_INFO_V1__',
    has: function (k) { return !!INFO[k]; },
    keyOf: keyOf,
    attr: attr,
    decorate: decorate,
    open: show,
    close: hide,
  };

  // 点击「!」弹说明：捕获阶段处理，避免触发报告卡片本身的点击（如勾选、展开）
  document.addEventListener('click', function (e) {
    var dot = e.target && e.target.closest ? e.target.closest('.info-dot') : null;
    if (!dot) return;
    e.preventDefault();
    e.stopPropagation();
    show(dot.getAttribute('data-info'));
  }, true);
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && mask && !mask.hidden) hide();
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('info-dot')) {
      e.preventDefault(); e.stopPropagation();
      show(e.target.getAttribute('data-info'));
    }
  }, true);
})();
</script>
"""

# ══════════════════════════════════════════════════════════════════════════
# perf.html
# ══════════════════════════════════════════════════════════════════════════
CARD_LABEL_MAP = {
    '系统 CPU': 'syscpu', '进程 CPU': 'proccpu', '内存 PSS': 'mem', '物理内存': 'mem',
    'FPS': 'fps', 'Jank': 'jank', 'BigJank': 'bigjank', '大 Jank': 'bigjank', 'Stutter': 'stutter',
    '网络 ↓/↑': 'net', 'GPU': 'gpu', '电池': 'battery', '温度': 'temp',
    '线程数': 'threads', '磁盘读': 'disk',
    'ALU 利用率': 'gpu_alu', 'Fragment 占用': 'gpu_frag', 'Vertex 占用': 'gpu_vertex',
    '纹理采样限制': 'gpu_texlimiter', 'GPU 读带宽': 'gpu_readbw', 'GPU 写带宽': 'gpu_writebw',
}

CHART_ID_MAP = {
    'chart-cpu': 'cpu', 'chart-mem': 'mem', 'chart-memdetail': 'memdetail', 'chart-fps': 'fps',
    'chart-net': 'net', 'chart-gpu': 'gpu', 'chart-temp': 'temp', 'chart-current': 'current',
    'chart-power': 'power', 'chart-cpu-cores': 'cpucores', 'chart-cpu-freq': 'cpufreq',
    'chart-cswitch': 'cswitch', 'chart-disk': 'disk', 'chart-events': 'events',
    'chart-occupancy': 'gpu_occ', 'chart-alu-perf': 'gpu_aluperf', 'chart-texture': 'gpu_tex',
    'chart-bandwidth': 'gpu_bw', 'chart-cache': 'gpu_cache', 'chart-shader': 'gpu_shader',
}
# chart-mem / chart-cpu 等 id 复用且语义随模板变化，这里统一收敛到「指标组」说明
CHART_ID_FIX = {'chart-cpu': 'cpuchart', 'chart-mem': 'mem'}


class Log(object):
    def __init__(self):
        self.items = []

    def add(self, name, count, expect=None):
        flag = 'OK ' if (expect is None or count == expect) else '!! '
        self.items.append('  %s%-42s %s 次' % (flag, name, count))
        return count


def sub_once(content, old, new, log_, name, expect=1):
    n = content.count(old)
    log_.add(name, n, expect)
    if n == 0:
        return content
    return content.replace(old, new, 1 if expect == 1 else -1)


def inject_perf(path, dry=False):
    log_ = Log()
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    content = src
    if MARK in content:
        print('[perf] 已注入，跳过：%s' % path)
        return None
    log_.add('源文件行数', content.count('\n'))

    # 1. CSS
    content = sub_once(content, '</style>', CSS.replace('__METRIC_INFO_V1__', MARK) + '</style>',
                       log_, 'CSS 片段', 1)

    # 2. JS
    content = sub_once(content, '<div id="root"></div>',
                       '<div id="root"></div>\n\n' + JS_HEAD + JS_BODY.replace('__METRIC_INFO_V1__', MARK),
                       log_, 'MetricInfo 脚本', 1)

    # 3. 指标卡：<div class="card-label">X</div> → 带 data-info
    def card_sub(m):
        label = m.group(1)
        key = CARD_LABEL_MAP.get(label)
        if not key:
            return m.group(0)
        return '<div class="card-label" data-info="%s">%s</div>' % (key, label)

    content, n = re.subn(r'<div class="card-label">([^<]+)</div>', card_sub, content)
    log_.add('card-label 加 data-info', n, 25)

    # 4. 图表标题：按 chart id 映射
    def title_sub(m):
        cid = m.group(2)
        key = CHART_ID_FIX.get(cid) or CHART_ID_MAP.get(cid)
        if not key:
            return m.group(0)
        return '<div class="chart-title" data-info="%s">%s</div><div id="%s" class="chart"></div>' % (
            key, m.group(1), cid)

    content, n = re.subn(r'<div class="chart-title">([^<]*)</div><div id="(chart-[a-z-]+)" class="chart"></div>',
                         title_sub, content)
    log_.add('chart-title 加 data-info', n, 25)

    # 5. decorateChartTitles：缓存原标题时先摘掉「!」，并在末尾统一补回
    old = "        if (!title.dataset.base) title.dataset.base = title.textContent.trim();"
    new = (
        "        if (!title.dataset.base) {\n"
        "          const _dot = title.querySelector('.info-dot');\n"
        "          if (_dot) _dot.remove();\n"
        "          title.dataset.base = title.textContent.trim();\n"
        "        }"
    )
    content = sub_once(content, old, new, log_, 'decorateChartTitles 标题基准', 1)

    i = content.index('    function decorateChartTitles() {')
    j = content.index('\n    }\n', i)
    tail = (
        "\n        // 标题被改写后，参数说明「!」标记需要重新补回（__METRIC_INFO_V1__）\n"
        "        if (window.MetricInfo) {\n"
        "          for (const [n2, c2] of Object.entries(CHART_CONFIGS)) {\n"
        "            const _e = document.getElementById(c2.el);\n"
        "            const _w = _e && _e.closest('.chart-wrap');\n"
        "            if (_w) MetricInfo.decorate(_w);\n"
        "          }\n"
        "        }\n"
    )
    content = content[:j] + tail + content[j:]
    log_.add('decorateChartTitles 尾补标记', 1, 1)

    # 6. annotateMetricCards：改写 GPU / BigJank 标签后补回标记
    old_gpu = """          const gpuLabel = document.querySelector('#card-gpu .card-label');
          if (gpuLabel) gpuLabel.textContent = 'GPU \\u6e29\\u5ea6';"""
    new_gpu = """          const gpuLabel = document.querySelector('#card-gpu .card-label');
          if (gpuLabel) {
            gpuLabel.textContent = 'GPU \\u6e29\\u5ea6';
            gpuLabel.setAttribute('data-info', 'gputemp');
            if (window.MetricInfo) MetricInfo.decorate(gpuLabel);
          }"""
    content = sub_once(content, old_gpu, new_gpu, log_, 'annotate: GPU 卡片改标题', 1)

    old_gt = """          if (title) title.textContent = 'GPU \\u6e29\\u5ea6\\uff08\\u5229\\u7528\\u7387\\u9700 root\\uff09';"""
    new_gt = """          if (title) {
            title.textContent = 'GPU \\u6e29\\u5ea6\\uff08\\u5229\\u7528\\u7387\\u9700 root\\uff09';
            title.setAttribute('data-info', 'gputemp');
            if (window.MetricInfo) MetricInfo.decorate(title);
          }"""
    content = sub_once(content, old_gt, new_gt, log_, 'annotate: GPU 图标题改标题', 1)

    old_bj = """        const lab = document.querySelector('#card-bigjank .card-label');
        if (lab) lab.textContent = 'BigJank · 无>125ms帧';"""
    new_bj = """        const lab = document.querySelector('#card-bigjank .card-label');
        if (lab) {
          lab.textContent = 'BigJank · 无>125ms帧';
          if (window.MetricInfo) MetricInfo.decorate(lab);
        }"""
    content = sub_once(content, old_bj, new_bj, log_, 'annotate: BigJank 卡片', 1)

    # 7. 动态帧率卡片
    old_defs = """      const defs = [
        { id: 'card-reach', val: 'val-reach', label: '达帧率', unit: '% · 目标 ' + fm.target },
        { id: 'card-ft',    val: 'val-ft',    label: '均帧',   unit: 'ms' },
        { id: 'card-low',   val: 'val-low',   label: '低帧占比', unit: '% · <' + Math.round(fm.target * 0.8) + ' 帧' },
        { id: 'card-1low',  val: 'val-1low',  label: '1%Low',  unit: '帧/s' },
      ];"""
    new_defs = """      const defs = [
        { id: 'card-reach', val: 'val-reach', label: '达帧率', info: 'reach', unit: '% · 目标 ' + fm.target },
        { id: 'card-ft',    val: 'val-ft',    label: '均帧',   info: 'frametime', unit: 'ms' },
        { id: 'card-low',   val: 'val-low',   label: '低帧占比', info: 'lowpct', unit: '% · <' + Math.round(fm.target * 0.8) + ' 帧' },
        { id: 'card-1low',  val: 'val-1low',  label: '1%Low',  info: 'onelow', unit: '帧/s' },
      ];"""
    content = sub_once(content, old_defs, new_defs, log_, '动态帧率卡片 defs', 1)

    old_set = """        card.querySelector('.card-label').textContent = d.label;
        card.querySelector('.card-unit').textContent = d.unit;"""
    new_set = """        const _lb = card.querySelector('.card-label');
        _lb.textContent = d.label;
        if (d.info && window.MetricInfo) { _lb.setAttribute('data-info', d.info); MetricInfo.decorate(_lb); }
        card.querySelector('.card-unit').textContent = d.unit;"""
    content = sub_once(content, old_set, new_set, log_, '动态帧率卡片补标记', 1)

    # 8. 统计表（整体 / 选中区域）
    old_cell = """      const cell = (r) =>
        `<tr><td>${r.metric}${r.unit ? `<span class="metric-unit">${r.unit}</span>` : ''}</td>` +"""
    new_cell = """      const _miAttr = (r) => (window.MetricInfo ? MetricInfo.attr(r.raw || r.metric) : '');
      const cell = (r) =>
        `<tr><td${_miAttr(r)}>${r.metric}${r.unit ? `<span class="metric-unit">${r.unit}</span>` : ''}</td>` +"""
    content = sub_once(content, old_cell, new_cell, log_, '统计表 cell 指标名', 1)

    old_end = """      tb.innerHTML = html;
    }

    // 明细折叠：事件委托，一次绑定"""
    new_end = """      tb.innerHTML = html;
      if (window.MetricInfo) MetricInfo.decorate(tb);
    }

    // 明细折叠：事件委托，一次绑定"""
    content = sub_once(content, old_end, new_end, log_, '统计表补标记', 1)

    # 9. 子场景统计表
    old_tag = """        tr.innerHTML = `<td>${r.seg}</td><td>${r.metric}</td><td>${fmtStat(r.mean)}</td><td>${fmtStat(r.max)}</td>`;"""
    new_tag = """        const _ta = (window.MetricInfo ? MetricInfo.attr(r.metric) : '');
        tr.innerHTML = `<td>${r.seg}</td><td${_ta}>${r.metric}</td><td>${fmtStat(r.mean)}</td><td>${fmtStat(r.max)}</td>`;"""
    content = sub_once(content, old_tag, new_tag, log_, '子场景表 指标名', 1)

    old_tag_end = """        tb.appendChild(tr);
      });
    }

    // selection state (by x-axis index)"""
    new_tag_end = """        tb.appendChild(tr);
      });
      if (window.MetricInfo) MetricInfo.decorate(tb);
    }

    // selection state (by x-axis index)"""
    content = sub_once(content, old_tag_end, new_tag_end, log_, '子场景表补标记', 1)

    # 10. 兜底：模板渲染后统一补一遍
    old_render = """  render();
  </script>"""
    new_render = """  render();
  if (window.MetricInfo) MetricInfo.decorate(document);
  </script>"""
    content = sub_once(content, old_render, new_render, log_, 'render 后兜底 decorate', 1)

    print('[perf] %s' % os.path.basename(path))
    for line in log_.items:
        print(line)
    if dry:
        return None
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    return content


# ══════════════════════════════════════════════════════════════════════════
# library.html
# ══════════════════════════════════════════════════════════════════════════
def inject_library(path, dry=False):
    log_ = Log()
    with io.open(path, encoding='utf-8') as f:
        content = f.read()
    if MARK in content:
        print('[lib] 已注入，跳过：%s' % path)
        return None
    log_.add('源文件行数', content.count('\n'))

    # 1. CSS
    content = sub_once(content, '</style>', CSS.replace('__METRIC_INFO_V1__', MARK) + '</style>',
                       log_, 'CSS 片段', 1)

    # 2. JS（放在索引脚本之前）
    anchor = '<!-- 报告索引：由主进程在每次归档时写入（history/index.js） -->'
    content = sub_once(content, anchor, JS_HEAD + JS_BODY.replace('__METRIC_INFO_V1__', MARK) + '\n' + anchor,
                       log_, 'MetricInfo 脚本', 1)

    # 3. 对比表指标名
    old = """    html += '<tr><td class="metric-name"><b>' + label + '</b> ' +
            '<span style="color:var(--text2)">(' + unit + ')</span></td>';"""
    new = """    html += '<tr><td class="metric-name"' + (window.MetricInfo ? MetricInfo.attr(key) : '') + '><b>' + label + '</b> ' +
            '<span style="color:var(--text2)">(' + unit + ')</span></td>';"""
    content = sub_once(content, old, new, log_, '对比表 指标名', 1)

    old = """  body.innerHTML = html;
}"""
    new = """  body.innerHTML = html;
  if (window.MetricInfo) MetricInfo.decorate(body);
}"""
    content = sub_once(content, old, new, log_, '对比表补标记', 1)

    # 4. 对比图标题
    old = """    wrap.innerHTML = '<h3>' + title + ' <span style="color:var(--text2)">(' + unit + ')</span></h3>' +
                     '<div class="chart"></div>';"""
    new = """    const _hAttr = (window.MetricInfo ? MetricInfo.attr(cfg.key) : '');
    wrap.innerHTML = '<h3' + _hAttr + '>' + title + ' <span style="color:var(--text2)">(' + unit + ')</span></h3>' +
                     '<div class="chart"></div>';
    if (window.MetricInfo) MetricInfo.decorate(wrap);"""
    content = sub_once(content, old, new, log_, '对比图标题', 1)

    # 5. 卡片 KPI
    old = """      kpiCell('FPS', kpi.fps, '帧/s'),
      kpiCell('CPU', kpi.cpu, '%'),
      kpiCell('温度', kpi.temp, '°C'),
      kpiCell('内存', kpi.mem, 'MB'),
      kpiCell('Jank', kpi.jank, '次/s'),
      kpi.gpu != null ? kpiCell('GPU', kpi.gpu, '%') : kpiCell('GPU 温度', kpi.gpuTemp, '°C'),"""
    new = """      kpiCell('FPS', kpi.fps, '帧/s', 'fps'),
      kpiCell('CPU', kpi.cpu, '%', 'proccpu'),
      kpiCell('温度', kpi.temp, '°C', 'temp'),
      kpiCell('内存', kpi.mem, 'MB', 'mem'),
      kpiCell('Jank', kpi.jank, '次/s', 'jank'),
      kpi.gpu != null ? kpiCell('GPU', kpi.gpu, '%', 'gpu') : kpiCell('GPU 温度', kpi.gpuTemp, '°C', 'gputemp'),"""
    content = sub_once(content, old, new, log_, '卡片 KPI 传参', 1)

    old = """    grid.appendChild(card);
  }
}"""
    new = """    grid.appendChild(card);
  }
  if (window.MetricInfo) MetricInfo.decorate(grid);
}"""
    content = sub_once(content, old, new, log_, '卡片补标记', 1)

    old = """function kpiCell(label, value, unit) {
  const na = value == null;
  return '<div class="kpi">' +
    '<div class="kpi-label">' + label + '</div>' +"""
    new = """function kpiCell(label, value, unit, infoKey) {
  const na = value == null;
  const ib = (infoKey && window.MetricInfo) ? ' data-info="' + infoKey + '"' : '';
  return '<div class="kpi">' +
    '<div class="kpi-label"' + ib + '>' + label + '</div>' +"""
    content = sub_once(content, old, new, log_, 'kpiCell 支持说明', 1)

    # 6. 卡片帧率小字行
    old = """  const cell = (label, v, unit, cls) =>
    '<span class="kpx"><i>' + label + '</i><b class="' + cls + '">' + (v == null ? '—' : fmt(v)) + unit + '</b></span>';"""
    new = """  const cell = (label, v, unit, cls, infoKey) =>
    '<span class="kpx"><i' + ((infoKey && window.MetricInfo) ? ' data-info="' + infoKey + '"' : '') + '>' + label +
    '</i><b class="' + cls + '">' + (v == null ? '—' : fmt(v)) + unit + '</b></span>';"""
    content = sub_once(content, old, new, log_, 'kpx cell 支持说明', 1)

    old = """  let extra = '<div class="kpis-extra">' +
    '<span class="kpx"><i>目标</i><b>' + tgt + ' 帧</b></span>' +
    cell('达帧率', kpi.fpsReach, '%', tone(kpi.fpsReach, 90, 70)) +
    cell('均帧', kpi.fpsFrameTime, 'ms', tone(ftScore, 95, 85)) +
    cell('低帧', kpi.fpsLowPct, '%', tone(kpi.fpsLowPct == null ? null : 100 - kpi.fpsLowPct, 90, 80));
  if (kpi.fps1Low != null)
    extra += cell('1%Low', kpi.fps1Low, ' 帧/s', tone(kpi.fps1Low, tgtNum && tgtNum * 0.95, tgtNum && tgtNum * 0.85));
  if (kpi.fpsGeTarget != null)
    extra += cell('≥目标', kpi.fpsGeTarget, '%', tone(kpi.fpsGeTarget, 90, 70));
  if (kpi.fpsMedRange != null)
    extra += cell('稳帧', kpi.fpsMedRange, '%', tone(kpi.fpsMedRange, 80, 60));"""
    new = """  let extra = '<div class="kpis-extra">' +
    '<span class="kpx"><i data-info="fpsTarget">目标</i><b>' + tgt + ' 帧</b></span>' +
    cell('达帧率', kpi.fpsReach, '%', tone(kpi.fpsReach, 90, 70), 'reach') +
    cell('均帧', kpi.fpsFrameTime, 'ms', tone(ftScore, 95, 85), 'frametime') +
    cell('低帧', kpi.fpsLowPct, '%', tone(kpi.fpsLowPct == null ? null : 100 - kpi.fpsLowPct, 90, 80), 'lowpct');
  if (kpi.fps1Low != null)
    extra += cell('1%Low', kpi.fps1Low, ' 帧/s', tone(kpi.fps1Low, tgtNum && tgtNum * 0.95, tgtNum && tgtNum * 0.85), 'onelow');
  if (kpi.fpsGeTarget != null)
    extra += cell('≥目标', kpi.fpsGeTarget, '%', tone(kpi.fpsGeTarget, 90, 70), 'getarget');
  if (kpi.fpsMedRange != null)
    extra += cell('稳帧', kpi.fpsMedRange, '%', tone(kpi.fpsMedRange, 80, 60), 'medrange');"""
    content = sub_once(content, old, new, log_, 'kpis-extra 传参', 1)

    print('[lib] %s' % os.path.basename(path))
    for line in log_.items:
        print(line)
    if dry:
        return None
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    return content


def main():
    argv = [a for a in sys.argv[1:]]
    dry = '--dry' in argv
    force = '--force' in argv
    targets = [a for a in argv if not a.startswith('--')]
    # --force：先还原备份的原件，保证可反复重跑
    bak = os.path.join(ROOT, '_backup_metricinfo')
    if force and os.path.isdir(bak):
        import shutil
        for name in ('perf.html', 'library.html'):
            s = os.path.join(bak, name)
            if os.path.isfile(s):
                shutil.copyfile(s, os.path.join(REPORTS, name))
                print('[restore] %s ← 备份' % name)
    else:
        os.makedirs(bak, exist_ok=True)
        import shutil
        for name in ('perf.html', 'library.html'):
            s = os.path.join(REPORTS, name)
            d = os.path.join(bak, name)
            if os.path.isfile(s) and not os.path.isfile(d) and MARK not in io.open(s, encoding='utf-8').read():
                shutil.copyfile(s, d)
    files = []
    if not targets or 'perf' in targets:
        files.append(os.path.join(REPORTS, 'perf.html'))
    if not targets or 'lib' in targets:
        files.append(os.path.join(REPORTS, 'library.html'))
    for path in files:
        if not os.path.isfile(path):
            print('文件不存在：%s' % path)
            continue
        if path.endswith('perf.html'):
            inject_perf(path, dry)
        else:
            inject_library(path, dry)
    # 同步便携包副本
    if not dry and os.path.isdir(PORTABLE):
        import shutil
        for name in ('perf.html', 'library.html'):
            s = os.path.join(REPORTS, name)
            d = os.path.join(PORTABLE, name)
            if os.path.isfile(s) and os.path.isfile(d):
                shutil.copyfile(s, d)
                print('[sync] %s → Perfara-Portable' % name)


if __name__ == '__main__':
    main()
