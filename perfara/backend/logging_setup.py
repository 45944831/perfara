import logging
import os
from logging.handlers import RotatingFileHandler


def setup_logging(base_dir: str) -> str:
    """
    Initialize rotating file logging under logs/app.log.
    Returns the log file path.
    """
    logs_dir = os.path.abspath(os.path.join(base_dir, "logs"))
    os.makedirs(logs_dir, exist_ok=True)
    log_path = os.path.join(logs_dir, "app.log")

    level = logging.INFO
    fmt = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"

    root = logging.getLogger()
    root.setLevel(level)

    # Avoid duplicate handlers on reload
    for h in list(root.handlers):
        root.removeHandler(h)

    file_handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    file_handler.setLevel(level)
    file_handler.setFormatter(logging.Formatter(fmt))

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(logging.Formatter(fmt))

    root.addHandler(file_handler)
    root.addHandler(console_handler)

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)
    return log_path

