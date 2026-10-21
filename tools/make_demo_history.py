"""构造 3 份归档样本，用于验证报告库对比界面（验证完请删除 history 目录）。"""
import json, os, random, datetime, copy, sys

REPORTS = sys.argv[1] if len(sys.argv) > 1 else '.'
random.seed(7)
base = json.load(open(os.path.join(REPORTS, 'data.json'), encoding='utf-8'))
hist = os.path.join(REPORTS, 'history')
os.makedirs(hist, exist_ok=True)


def r1(v):
    return None if v is None else round(v, 1)


def avg(a):
    a = [x for x in a if isinstance(x, (int, float))]
    return sum(a) / len(a) if a else None


variants = [
    ((52, 58), (18, 26), None, (0, 0), (0, 1)),
    ((58, 60), (14, 20), (28, 42), (37, 40), (0, 0)),
    ((38, 45), (32, 44), (62, 85), (43, 47), (1, 3)),
]
stamps = [datetime.datetime(2026, 10, 19, 15, 50, 10),
          datetime.datetime(2026, 10, 19, 16, 5, 10),
          datetime.datetime(2026, 10, 19, 16, 20, 10)]

index = []
for vi, ((fpsr, cpur, gpur, tempr, jankr), now) in enumerate(zip(variants, stamps)):
    p = copy.deepcopy(base)
    t0 = 1792396249326 + vi * 3600 * 1000
    for i, row in enumerate(p['perf']):
        row['timestamp'] = t0 + i * 1000
        row['time'] = (now + datetime.timedelta(seconds=i)).strftime('%H:%M:%S')
        row['fps'] = round(random.uniform(*fpsr), 1)
        row['cpu']['procCpu'] = round(random.uniform(*cpur), 1)
        row['cpu']['sysCpu'] = round(random.uniform(cpur[0], cpur[1] + 8), 1)
        row['jank'] = random.randint(*jankr)
        row['bigJank'] = 0
        row['jankRate'] = round(row['jank'] / 60, 2)
        row['mem']['totalPss'] = random.randint(600, 720)
        row['gpu'] = round(random.uniform(*gpur), 1) if gpur else 0
        row['gpuTemp'] = round(random.uniform(39, 47), 1)
        row['temperature'] = round(random.uniform(*tempr), 1) if tempr[1] > 0 else 0

    rid = f"{now.strftime('%Y%m%d-%H%M%S')}-DEMO_DEVICE"
    js = 'var data = ' + json.dumps(p, ensure_ascii=False, indent=2) + ';\n'
    open(os.path.join(hist, rid + '.js'), 'w', encoding='utf-8').write(js)
    open(os.path.join(hist, rid + '.json'), 'w', encoding='utf-8').write(
        json.dumps(p, ensure_ascii=False, indent=2))

    perf = p['perf']

    def ser(g):
        return [g(r) for r in perf]

    s = {'fps': ser(lambda r: r.get('fps')),
         'cpu': ser(lambda r: r.get('cpu', {}).get('procCpu')),
         'mem': ser(lambda r: r.get('mem', {}).get('totalPss')),
         'temp': ser(lambda r: r.get('temperature')),
         'gpu': ser(lambda r: r.get('gpu')),
         'gpuTemp': ser(lambda r: r.get('gpuTemp')),
         'jank': ser(lambda r: r.get('jank')),
         'bigJank': ser(lambda r: r.get('bigJank'))}
    kpi = {}
    for k, a in s.items():
        nums = [x for x in a if isinstance(x, (int, float))]
        kpi[k] = {'avg': r1(avg(a)),
                  'min': r1(min(nums)) if nums else None,
                  'max': r1(max(nums)) if nums else None}
    ts = [r['timestamp'] for r in perf]
    index.append({'id': rid, 'file': f'history/{rid}.js',
                  'createdAt': now.isoformat(),
                  'createdAtLocal': now.strftime('%Y-%m-%d %H:%M:%S'),
                  'platform': 'android', 'deviceName': '演示设备',
                  'deviceId': 'demo-device-001',
                  'app': 'com.example.game',
                  'samples': len(perf),
                  'durationSec': round((max(ts) - min(ts)) / 1000, 1), 'kpi': kpi})

index.sort(key=lambda x: x['createdAt'], reverse=True)
open(os.path.join(hist, 'index.json'), 'w', encoding='utf-8').write(
    json.dumps(index, ensure_ascii=False, indent=2))
open(os.path.join(hist, 'index.js'), 'w', encoding='utf-8').write(
    'var reportIndex = ' + json.dumps(index, ensure_ascii=False, indent=2) + ';\n')
print('generated', len(index))
