import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web"
DB_PATH = DATA / "gridsim.db"

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


def official_api_configured() -> bool:
    return bool(ERCOT_USERNAME and ERCOT_PASSWORD and ERCOT_SUBSCRIPTION_KEY)


def supabase_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)
