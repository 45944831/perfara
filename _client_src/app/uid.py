#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本机唯一 UID（64 位十六进制 SHA256），与 src/machine-uid.js 一致。"""

from __future__ import annotations

import getpass
import hashlib
import platform
import sys


def get_machine_uid() -> str:
    parts = [
        platform.node(),
        sys.platform,
        platform.machine(),
        getpass.getuser(),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


if __name__ == "__main__":
    print(get_machine_uid())
