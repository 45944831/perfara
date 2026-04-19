# -*- coding: utf-8 -*-
import sqlite3
import os

DB = os.path.join(os.path.dirname(__file__), "webperf.db")
conn = sqlite3.connect(DB)
c = conn.cursor()

c.execute("SELECT id, project_id, label FROM test_runs WHERE project_id IN (1,2) OR project_id IS NULL")
print("test_runs for proj 1,2:", c.fetchall())

c.execute("SELECT * FROM project_aliases")
print("all aliases:", c.fetchall())

conn.close()
