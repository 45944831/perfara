# -*- coding: utf-8 -*-
import sqlite3
import os

DB = os.path.join(os.path.dirname(__file__), "webperf.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()

c.execute(
    "SELECT DISTINCT label FROM test_runs WHERE label IS NOT NULL AND trim(label) != '' ORDER BY label LIMIT 100"
)
print("sample labels:", [r[0] for r in c.fetchall()])

c.execute(
    "SELECT DISTINCT package_name FROM projects WHERE package_name IS NOT NULL AND trim(package_name) != '' ORDER BY package_name LIMIT 100"
)
print("sample packages:", [r[0] for r in c.fetchall()])

c.execute("SELECT COUNT(*) FROM test_runs")
print("total test_runs:", c.fetchone()[0])
conn.close()
