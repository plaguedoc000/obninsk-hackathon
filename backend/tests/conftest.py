import os
import sys
import tempfile
from pathlib import Path

# отдельная папка данных для тестов — до импорта приложения
os.environ.setdefault("ONESCALE_DATA_DIR", tempfile.mkdtemp(prefix="onescale_test_"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
