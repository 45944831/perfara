# -*- coding: utf-8 -*-
"""
One-off: remove DB rows tied to 示例应用 and com.example.app.
Run: python data/_purge_once.py
"""
import os
import sqlite3

DB = os.path.join(os.path.dirname(__file__), "webperf.db")


def main():
    conn = sqlite3.connect(DB)
    c = conn.cursor()

    c.execute(
        """
        SELECT id FROM projects WHERE
          (package_name IS NOT NULL AND (
            package_name LIKE '%com.example.app%'
            OR package_name LIKE '%示例应用%'
          ))
          OR trim(COALESCE(app_name,'')) IN ('com.example.app', '示例应用')
        """
    )
    project_ids = [r[0] for r in c.fetchall()]
    print("matching project ids:", project_ids)

    c.execute("SELECT id FROM test_runs WHERE label = ?", ("示例应用",))
    label_ids = [r[0] for r in c.fetchall()]
    print("test_runs with label 示例应用:", label_ids)

    tr_from_proj = []
    if project_ids:
        pph = ",".join("?" * len(project_ids))
        c.execute(
            "SELECT id FROM test_runs WHERE project_id IN (%s)" % pph,
            project_ids,
        )
        tr_from_proj = [r[0] for r in c.fetchall()]
    print("test_run ids from matching projects:", tr_from_proj)

    all_tr = sorted(set(tr_from_proj + label_ids))
    print("all test_run ids to delete:", all_tr)

    if not all_tr and not project_ids:
        print("Nothing to delete.")
        conn.close()
        return

    conn.execute("BEGIN")
    try:
        if all_tr:
            ph = ",".join("?" * len(all_tr))
            c.execute("DELETE FROM metric_blobs WHERE test_run_id IN (%s)" % ph, all_tr)
            print("metric_blobs deleted:", c.rowcount)
            c.execute(
                "DELETE FROM perfara_demo_snapshot WHERE test_run_id IN (%s)" % ph,
                all_tr,
            )
            print("perfara_demo_snapshot deleted:", c.rowcount)
            c.execute(
                "DELETE FROM parsed_info WHERE test_run_id IN (%s)" % ph, all_tr
            )
            print("parsed_info (by test_run) deleted:", c.rowcount)
            c.execute("DELETE FROM test_runs WHERE id IN (%s)" % ph, all_tr)
            print("test_runs deleted:", c.rowcount)

        if project_ids:
            pph = ",".join("?" * len(project_ids))
            c.execute(
                "DELETE FROM parsed_info WHERE project_id IN (%s)" % pph, project_ids
            )
            print("parsed_info (by project) deleted:", c.rowcount)
            c.execute("DELETE FROM projects WHERE id IN (%s)" % pph, project_ids)
            print("projects deleted:", c.rowcount)

        c.execute(
            """
            DELETE FROM project_aliases WHERE
              (package_name IS NOT NULL AND (
                package_name LIKE '%com.example.app%'
                OR package_name LIKE '%示例应用%'
              ))
              OR trim(COALESCE(app_name,'')) IN ('com.example.app', '示例应用')
            """
        )
        print("project_aliases deleted:", c.rowcount)

        conn.commit()
        print("Committed OK.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
