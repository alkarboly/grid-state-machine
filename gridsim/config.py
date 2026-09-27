import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web"
DB_PATH = DATA / "gridsim.db"


def _load_env_file() -> None:
    """Read `.env` into the process. A variable already set in the shell wins."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file()

CHICAGO = "America/Chicago"

# Published Base Core energy. Continuous kW is an assumption; see docs/gaps.md.
BASE_CAPACITY_KWH = float(os.environ.get("BASE_CAPACITY_KWH", "39.2"))
BASE_POWER_KW = float(os.environ.get("BASE_POWER_KW", "11.5"))
SOC_RESERVE = float(os.environ.get("SOC_RESERVE", "0.20"))
SOC_CEILING = 0.95
ETA = 0.96
SIM_TIME_SCALE = float(os.environ.get("SIM_TIME_SCALE", "1"))

# Total simulated batteries, apportioned across the metros in data/anchors.json.
FLEET_SIZE = int(os.environ.get("FLEET_SIZE", "3000"))
# Batteries whose full component contract is written every tick. See docs/database.md.
PERSIST_SAMPLE = int(os.environ.get("PERSIST_SAMPLE", "60"))

ERCOT_USERNAME = os.environ.get("ERCOT_USERNAME", "").strip()
ERCOT_PASSWORD = os.environ.get("ERCOT_PASSWORD", "").strip()
ERCOT_SUBSCRIPTION_KEY = os.environ.get("ERCOT_SUBSCRIPTION_KEY", "").strip()

TOKEN_URL = (
    "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/"
    "B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token"
)
TOKEN_CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70"
PUBLIC_API = "https://api.ercot.com/api/public-reports"
FUEL_MIX_URL = "https://www.ercot.com/api/1/services/read/dashboards/fuel-mix.json"
SUPPLY_DEMAND_URL = "https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json"

TICK_SECONDS = 10

# Optional. When both are set, each tick is written to Supabase and the latest
# dispatch_orders row is read back. The service-role key stays in this process.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

# Optional remote model. Empty means that call is skipped. The maintenance
# manager still resolves chart alarms, and the fleet manager still writes
# set_signal on a unit set to dispatch.
LLM_URL = os.environ.get("LLM_URL", "").strip()
LLM_EVERY_S = float(os.environ.get("LLM_EVERY_S", "600"))

# Optional. When the key is set, an escalated maintenance ticket asks this model
# for the decision from the site pull. gpt-4o-mini is the cheap default.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"

# Comma-separated browser origins allowed to call the bot. Empty keeps same-origin only.
WEB_ORIGIN = os.environ.get("WEB_ORIGIN", "").strip()
# Default serves web/ from this process. Set to 0 only when another origin hosts the map.
SERVE_STATIC = os.environ.get("SERVE_STATIC", "1").strip() != "0"


def official_api_configured() -> bool:
    return bool(ERCOT_USERNAME and ERCOT_PASSWORD and ERCOT_SUBSCRIPTION_KEY)


def supabase_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)
