# State machine protocols

These are the rules the sim uses. They are a prototype policy, not an ERCOT market award. The same page is the **Protocols** tab (`/#protocols`). The code is `gridsim/fleet/policy.py` and the SOC queue in [simulation.md](simulation.md).

## Words

- **push** — discharge to the grid.
- **pull** — charge from the grid.
- **hold** — neither.

The call is what the fleet was asked to do. Colour on the map is what the cabinet did.

## Who chooses

1. A posted `POST /api/dispatch` order is one call for every home. The ladder is off.
2. Else the ladder below runs. First match wins.
3. A `set_signal` on one home outranks that call for that home.
4. An open maintenance ticket keeps the fleet manager off that home.

## Ladder

1. Official load-zone LMP, only when the ERCOT subscription key is set. Push if the price is at least the greater of 40 $/MWh and 1.1× the interval mean. Pull if it is at most the lesser of 25 $/MWh and 0.9× that mean. Until the key is set, this step is skipped and the price is simulated.
2. Push when today's demand is at or above the 75th percentile.
3. Pull when today's demand is at or below the 35th percentile.
4. Push when ERCOT Power Storage is discharging at least 200 MW. The Base fleet discharges with it.
5. Pull when ERCOT Power Storage is charging (storage generation ≤ −200 MW). The Base fleet charges with it.
6. Hold.

**Reverse demand** skips prices and takes the opposite of that live call: a discharge becomes a charging window.

## Who answers

Hold has intensity 0. A live call is at least 0.35 (about a third of each service area) and rises toward 1 as the peak or trough deepens.

Inside a service area, charge takes the emptiest cabinets first. Discharge takes the fullest first. Discharge stops at the customer's reserve. Charge stops at 95% full. Offline and grid-off homes stay out of the queue.
