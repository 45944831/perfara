# -*- coding: utf-8 -*-
import sqlite3
import os

DB = os.path.join(os.path.dirname(__file__), "webperf.db")
conn = sqlite3.connect(DB)
c = conn.cursor()

c.execute("SELECT id, package_name, app_name FROM projects")
for row in c.fetchall():
    pid, pkg, app = row
    print("id=%s pkg=%r app=%r" % (pid, pkg, app))

c.execute("SELECT id, label, project_id FROM test_runs")
for row in c.fetchall():
    print("tr id=%s label=%r project_id=%s" % row)

c.execute("SELECT id, package_name, app_name, display_name FROM project_aliases")
for row in c.fetchall():
    print("alias", row)

conn.close()
