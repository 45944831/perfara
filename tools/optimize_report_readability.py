# -*- coding: utf-8 -*-
"""
报告页可读性优化（perf.html / library.html）

做法：在 </style> 前追加一段「覆盖层 CSS」（带区间标记），而不是改动原有 CSS 行。
好处：幂等可反复重跑；出问题整体撤销即可；不影响既有 DOM 与 JS 行为。

优化内容：
  1) 次要文字提亮：--text2 由 #8a90a0 → #9ba3b4（对比度 ~4.6:1 → ~5.9:1）
  2) 指标卡：flex→grid 等宽对齐，字号层次拉开（标签 12 / 数值 24 / 单位 11），悬停反馈
  3) 图块：标题提为主色文字 12.5px，图区加高到 250px，留白增大
  4) 统计表：表头吸顶、斑马纹、行悬停高亮、行高与字号放大
  5) 解读总结：风险项加左侧色条+底色，行距放大，便于扫读
  6) 分区标题：加主色竖条，层级更清晰
  7) 标题区：设备名放大、副信息允许换行（不再被单行截断）

用法：
  python tools/optimize_report_readability.py          # 应用（重复执行=刷新）
  python tools/optimize_report_readability.py --revert # 撤销（还原到未优化状态）
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = os.path.join(ROOT, 'perfara', 'collector', 'resources', 'reports')
PORTABLE = os.path.join(ROOT, 'Perfara-Portable', 'collector', 'resources', 'reports')

BEGIN = '/* ═══ 可读性优化 __READABILITY_V1__ begin ══════════════════════════════ */'
END = '/* ═══ 可读性优化 __READABILITY_V1__ end ════════════════════════════════ */'

PERF_CSS = """
%s
:root {
  /* 次要文字整体提亮：标签 / 单位 / 说明文字更容易看清（对比度约 5.9:1） */
  --text2: #9ba3b4;
}

/* ── 分区标题：主色竖条 + 更大字号，层级更清楚 ────────────────────────── */
.section-label { font-size: 12.5px; padding: 10px 16px 5px; }
.section-label::before {
  content: ''; display: inline-block; flex: none;
  width: 3px; height: 13px; border-radius: 2px; background: var(--accent);
}

/* ── 顶部概要条 ────────────────────────────────────────────────────────── */
.rm-device { font-size: 15px; }
.rm-app { font-size: 12.5px; }
.rm-chip { font-size: 11.5px; line-height: 19px; }
.rm-sub { white-space: normal; line-height: 1.55; }

/* ── 指标卡：等宽网格 + 字号层次 + 悬停反馈 ───────────────────────────── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(106px, 1fr));
  gap: 8px;
  padding: 8px 16px 10px;
}
.card { padding: 12px 10px; gap: 4px; }
.card:hover { border-color: #3b4354; }
.card-label { font-size: 12px; font-weight: 500; }
.card-value { font-size: 24px; letter-spacing: -.2px; }
.card-unit  { font-size: 11px; }

/* ── 图表：标题更醒目、图区更舒展 ─────────────────────────────────────── */
.charts-grid { gap: 12px; padding: 0 16px 12px; }
.chart-wrap { height: 250px; }
.chart-wrap:hover { border-color: #333a4a; }
.chart-wrap.stats { height: auto; }          /* 统计表保持自适应高度 */
.chart-title { padding: 9px 12px 0; font-size: 12.5px; color: var(--text); letter-spacing: .2px; }

/* ── 统计表：表头吸顶 + 斑马纹 + 行悬停 ───────────────────────────────── */
.stats-head { padding-top: 10px; }
/* 让统计表跟随主滚动条滚动（stats-body 不再自成滚动容器），表头才能相对图表区吸顶 */
.chart-wrap.stats .stats-body { padding: 6px 12px 12px; overflow: visible; }
.stats-table { font-size: 12.5px; }
.stats-table thead th {
  position: sticky; top: 0; z-index: 2;
  background: var(--bg2); font-size: 12px;
  box-shadow: inset 0 -1px 0 var(--border);
}
.stats-table th, .stats-table td { padding: 7px 8px; }
.stats-table tbody tr:nth-child(even) td { background: rgba(255,255,255,.022); }
.stats-table tbody tr:hover td { background: rgba(79,142,247,.10); }
.stats-detail-row td { background: rgba(255,255,255,.022); }
.metric-unit { font-size: 11px; }
.stats-toggle button { font-size: 11.5px; padding: 5px 9px; }

/* ── 解读总结：风险项色条化，便于纵向扫读 ─────────────────────────────── */
.insight { padding: 14px 16px; margin: 4px 16px 12px; }
.insight-head { margin-bottom: 10px; }
.insight-title { font-size: 13.5px; }
.insight-lead { font-size: 13px; line-height: 1.8; margin-bottom: 11px; }
.insight-list { gap: 4px 26px; }
.insight-list li { font-size: 12.5px; line-height: 1.85; }
.insight-risks { margin-top: 12px; padding-top: 11px; gap: 6px; }
.insight-risk {
  line-height: 1.75; padding: 4px 10px;
  border-left: 2px solid currentColor; border-radius: 0 4px 4px 0;
  background: rgba(255,255,255,.032);
}
%s
""" % (BEGIN, END)

LIB_CSS = """
%s
:root {
  --text2: #9ba3b4;
}

/* ── 报告卡片：字号层次 + 网格呼吸感 ──────────────────────────────────── */
.grid { gap: 14px; }
.card-time { font-size: 13.5px; }
.card-sub { font-size: 12px; }
.card-off { font-size: 11px; }
.kpi-label { font-size: 11px; }
.kpi-value { font-size: 15px; }
.kpi-value .unit { font-size: 11px; }
.kpis-extra { font-size: 11px; gap: 5px 12px; margin-top: 8px; }
.card-foot { font-size: 11.5px; }

/* ── 对比表：字号放大、行高拉开、最佳/最差加方向标记 ──────────────────── */
table { font-size: 12.5px; }
th, td { padding: 8px 12px; }
thead th { background: var(--bg3); font-size: 12px; }
tbody tr:nth-child(even) td { background: rgba(255,255,255,.022); }
tbody tr:hover td { background: rgba(79,142,247,.09) !important; }
.metric-name b { font-size: 12.5px; font-weight: 600; }
td.best  { color: var(--green); }
td.best::after  { content: ' ▲'; font-size: 9px; opacity: .8; }
td.worst::after { content: ' ▼'; font-size: 9px; opacity: .8; }

/* ── 对比曲线：标题更醒目、图区加高 ───────────────────────────────────── */
.chart-box h3 { font-size: 13px; color: var(--text); font-weight: 600; margin-bottom: 8px; }
.chart-box { padding: 12px 12px 6px; }
.chart { height: 230px; }

/* ── 解读 / 图例 ───────────────────────────────────────────────────────── */
.cmp-insight { font-size: 12.5px; line-height: 1.8; }
.cmp-insight-list li { font-size: 12.5px; line-height: 1.85; }
.legend { font-size: 11.5px; }
%s
""" % (BEGIN, END)


def strip_block(content):
    if BEGIN not in content:
        return content, False
    start = content.index(BEGIN)
    stop = content.index(END, start) + len(END)
    # 连同块尾的换行一并去掉，保持文件干净
    after = content[stop:]
    return (content[:start].rstrip('\n') + '\n' + after.lstrip('\n'), True)


def apply(path, css, revert=False):
    name = os.path.basename(path)
    with io.open(path, encoding='utf-8') as f:
        content = f.read()
    content, had = strip_block(content)
    if revert:
        with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        print('[%s] 已撤销优化块（原存在：%s）' % (name, had))
        return
    if '</style>' not in content:
        print('[%s] 未找到 </style>，跳过' % name)
        return
    # 追加块放在 </style> 之前 → 同权重规则排在后面，优先级最高
    content = content.replace('</style>', css.strip('\n') + '\n</style>', 1)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    print('[%s] 已写入可读性优化块（ refreshed：%s）' % (name, had))


def main():
    argv = [a for a in sys.argv[1:]]
    revert = '--revert' in argv
    for name, css in (('perf.html', PERF_CSS), ('library.html', LIB_CSS)):
        p = os.path.join(REPORTS, name)
        if os.path.isfile(p):
            apply(p, css, revert)
    # 同步便携包副本
    import shutil
    if os.path.isdir(PORTABLE):
        for name in ('perf.html', 'library.html'):
            s = os.path.join(REPORTS, name)
            d = os.path.join(PORTABLE, name)
            if os.path.isfile(s) and os.path.isfile(d):
                shutil.copyfile(s, d)
                print('[sync] %s → Perfara-Portable' % name)


if __name__ == '__main__':
    main()
