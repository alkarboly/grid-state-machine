-- Hourly cabinet temperature. The mean of every sample in that clock hour.
alter table usage_hours add column if not exists temp_c double precision;
