"""重新编译 PC 采集脚本：_client_src 源 → collector/resources 的 .pyc

为什么需要这一步：
  pc-collector.js 优先加载 `Scripts/collect_pc_perf.pyc`（发布包里只有 pyc，没有 .py），
  所以改完源码必须重编，否则运行期还是旧逻辑。
用内置 python 编译，保证 magic number 与运行期解释器一致（当前 3.13）。
"""
import os
import py_compile
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '_client_src', 'app', 'ios脚本', '进程管理', 'collect_pc_perf.py')
DST = os.path.join(ROOT, 'perfara', 'collector', 'resources', 'ios-tools',
                   'python', 'python', 'Scripts', 'collect_pc_perf.pyc')


def main():
    for p in (SRC,):
        if not os.path.isfile(p):
            print('MISS', p)
            return 1
    print('src:', SRC, os.path.getsize(SRC), 'B')
    old = os.path.getsize(DST) if os.path.isfile(DST) else -1
    py_compile.compile(SRC, cfile=DST, dfile='collect_pc_perf.py', doraise=True)
    print('dst:', DST, old, '->', os.path.getsize(DST), 'B')
    print('magic ok:', open(DST, 'rb').read(4).hex())
    return 0


if __name__ == '__main__':
    sys.exit(main())
