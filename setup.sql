-- SQL for Supabase Table Setup

-- Create the table to track API key usage
CREATE TABLE key_usage (
  "key" TEXT PRIMARY KEY,
  "hits" INTEGER DEFAULT 0 NOT NULL,
  "last_reset" TEXT NOT NULL
);

-- Create an index on the key column for faster lookups
CREATE INDEX idx_key_usage_key ON key_usage("key");

-- Create the table to track demo mode usage per device
CREATE TABLE demo_usage (
  "device_id" TEXT PRIMARY KEY,
  "uses" INTEGER DEFAULT 0 NOT NULL,
  "last_reset" TEXT NOT NULL,
  "lifetime_uses" INTEGER DEFAULT 0 NOT NULL
);

-- Create an index on the device_id column for faster lookups
CREATE INDEX idx_demo_usage_device_id ON demo_usage("device_id");

-- Enable Row Level Security (RLS) for both tables as a good security practice
ALTER TABLE key_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_usage ENABLE ROW LEVEL SECURITY;

-- Create policies to allow server-side access using the service_role key
-- This assumes you are using the service_role key from your Node.js backend
CREATE POLICY "Allow full access for service role" ON key_usage
FOR ALL
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow full access for service role" ON demo_usage
FOR ALL
USING (true)
WITH CHECK (true);
