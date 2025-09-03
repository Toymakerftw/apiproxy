-- Supabase Automated Daily Reset Schema
-- This file contains all tables, functions, and triggers for automatic daily reset handling

-- Drop existing objects if they exist (for clean setup)
DROP TRIGGER IF EXISTS auto_reset_demo_usage ON public.demo_usage;
DROP TRIGGER IF EXISTS auto_reset_key_usage ON public.key_usage;
DROP TRIGGER IF EXISTS auto_reset_rotation_state ON public.rotation_state;

DROP FUNCTION IF EXISTS public.check_and_reset_daily_usage();
DROP FUNCTION IF EXISTS public.check_and_reset_key_usage();
DROP FUNCTION IF EXISTS public.check_and_reset_rotation_state();
DROP FUNCTION IF EXISTS public.daily_cleanup();
DROP FUNCTION IF EXISTS public.update_updated_at_column();

DROP VIEW IF EXISTS public.current_usage;

DROP TABLE IF EXISTS public.rotation_state;
DROP TABLE IF EXISTS public.key_usage;
DROP TABLE IF EXISTS public.demo_usage;
DROP TABLE IF EXISTS public.api_keys;

-- Create api_keys table to store API keys
CREATE TABLE public.api_keys (
    id SERIAL PRIMARY KEY,
    key_value TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create demo_usage table to track device usage
CREATE TABLE public.demo_usage (
    device_id TEXT NOT NULL PRIMARY KEY,
    uses INTEGER NOT NULL DEFAULT 0,
    last_reset DATE NOT NULL DEFAULT CURRENT_DATE,
    lifetime_uses INTEGER NOT NULL DEFAULT 0,
    device_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create key_usage table to track API key usage
CREATE TABLE public.key_usage (
    key TEXT NOT NULL PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 0,
    last_reset DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create rotation_state table to track key rotation
CREATE TABLE public.rotation_state (
    id INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    last_used_index INTEGER NOT NULL DEFAULT -1,
    last_reset DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to automatically reset demo usage if date changed
CREATE OR REPLACE FUNCTION public.check_and_reset_daily_usage()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if we're in a new day
    IF NEW.last_reset < CURRENT_DATE THEN
        NEW.uses := 0;
        NEW.last_reset := CURRENT_DATE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to automatically reset key usage if date changed
CREATE OR REPLACE FUNCTION public.check_and_reset_key_usage()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.last_reset < CURRENT_DATE THEN
        NEW.hits := 0;
        NEW.last_reset := CURRENT_DATE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to automatically reset rotation state if date changed
CREATE OR REPLACE FUNCTION public.check_and_reset_rotation_state()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.last_reset < CURRENT_DATE THEN
        NEW.last_used_index := -1;
        NEW.last_reset := CURRENT_DATE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Optional: Daily cleanup function for orphaned records
CREATE OR REPLACE FUNCTION public.daily_cleanup()
RETURNS void AS $$
BEGIN
    -- Clean up key_usage entries for inactive API keys
    DELETE FROM public.key_usage 
    WHERE key NOT IN (SELECT key_value FROM public.api_keys WHERE is_active = true);
    
    -- Insert key_usage entries for new active API keys
    INSERT INTO public.key_usage (key, hits, last_reset)
    SELECT key_value, 0, CURRENT_DATE
    FROM public.api_keys 
    WHERE is_active = true 
    AND key_value NOT IN (SELECT key FROM public.key_usage)
    ON CONFLICT (key) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to automatically update updated_at
CREATE TRIGGER update_api_keys_updated_at
    BEFORE UPDATE ON public.api_keys
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_demo_usage_updated_at
    BEFORE UPDATE ON public.demo_usage
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_key_usage_updated_at
    BEFORE UPDATE ON public.key_usage
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_rotation_state_updated_at
    BEFORE UPDATE ON public.rotation_state
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Create triggers for automatic daily reset
CREATE TRIGGER auto_reset_demo_usage
    BEFORE INSERT OR UPDATE ON public.demo_usage
    FOR EACH ROW
    EXECUTE FUNCTION public.check_and_reset_daily_usage();

CREATE TRIGGER auto_reset_key_usage
    BEFORE INSERT OR UPDATE ON public.key_usage
    FOR EACH ROW
    EXECUTE FUNCTION public.check_and_reset_key_usage();

CREATE TRIGGER auto_reset_rotation_state
    BEFORE INSERT OR UPDATE ON public.rotation_state
    FOR EACH ROW
    EXECUTE FUNCTION public.check_and_reset_rotation_state();

-- Create indexes for better performance
CREATE INDEX idx_demo_usage_last_reset ON public.demo_usage(last_reset);
CREATE INDEX idx_demo_usage_device_id ON public.demo_usage(device_id);
CREATE INDEX idx_key_usage_last_reset ON public.key_usage(last_reset);
CREATE INDEX idx_api_keys_is_active ON public.api_keys(is_active);
CREATE INDEX idx_api_keys_key_value ON public.api_keys(key_value);
CREATE INDEX idx_rotation_state_last_reset ON public.rotation_state(last_reset);

-- Create view to show current daily usage
CREATE OR REPLACE VIEW public.current_usage AS
SELECT 
    d.device_id,
    CASE 
        WHEN d.last_reset = CURRENT_DATE THEN d.uses 
        ELSE 0 
    END as daily_uses,
    d.lifetime_uses,
    k.key,
    CASE 
        WHEN k.last_reset = CURRENT_DATE THEN k.hits 
        ELSE 0 
    END as daily_hits,
    r.last_used_index,
    r.last_reset as rotation_last_reset
FROM public.demo_usage d
CROSS JOIN public.key_usage k
CROSS JOIN public.rotation_state r;

-- Insert initial rotation state
INSERT INTO public.rotation_state (id, last_used_index, last_reset)
VALUES (1, -1, CURRENT_DATE)
ON CONFLICT (id) DO UPDATE SET
    last_used_index = EXCLUDED.last_used_index,
    last_reset = EXCLUDED.last_reset;

-- Insert sample API keys (replace with your actual keys)
INSERT INTO public.api_keys (key_value, description, is_active) VALUES
('sk-1234567890abcdef1234567890abcdef1234567890abcdef', 'Primary API Key', true),
('sk-abcdef1234567890abcdef1234567890abcdef1234567890', 'Secondary API Key', true),
('sk-7890abcdef1234567890abcdef1234567890abcdef123456', 'Backup API Key', true)
ON CONFLICT (key_value) DO UPDATE SET
    is_active = EXCLUDED.is_active,
    description = EXCLUDED.description,
    updated_at = NOW();

-- Initialize key_usage records for active API keys
INSERT INTO public.key_usage (key, hits, last_reset)
SELECT key_value, 0, CURRENT_DATE
FROM public.api_keys 
WHERE is_active = true
ON CONFLICT (key) DO UPDATE SET
    last_reset = EXCLUDED.last_reset,
    updated_at = NOW();

-- Insert sample demo device for testing
INSERT INTO public.demo_usage (device_id, uses, last_reset, lifetime_uses, device_info)
VALUES ('test_device_123', 0, CURRENT_DATE, 0, '{"os": "test", "version": "1.0"}'::jsonb)
ON CONFLICT (device_id) DO UPDATE SET
    last_reset = EXCLUDED.last_reset,
    updated_at = NOW();

-- Grant necessary permissions (adjust based on your Supabase RLS settings)
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.key_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rotation_state ENABLE ROW LEVEL SECURITY;

-- Create basic RLS policies (customize based on your needs)
CREATE POLICY "Allow full access to api_keys" ON public.api_keys FOR ALL USING (true);
CREATE POLICY "Allow full access to demo_usage" ON public.demo_usage FOR ALL USING (true);
CREATE POLICY "Allow full access to key_usage" ON public.key_usage FOR ALL USING (true);
CREATE POLICY "Allow full access to rotation_state" ON public.rotation_state FOR ALL USING (true);

-- Comments for documentation
COMMENT ON TABLE public.api_keys IS 'Stores API keys with activation status and metadata';
COMMENT ON TABLE public.demo_usage IS 'Tracks device usage for demo limits with automatic daily reset';
COMMENT ON TABLE public.key_usage IS 'Tracks API key usage with automatic daily reset';
COMMENT ON TABLE public.rotation_state IS 'Maintains key rotation state with automatic daily reset';
COMMENT ON VIEW public.current_usage IS 'Shows current daily usage across all tables';

-- Display confirmation message
DO $$ 
BEGIN
    RAISE NOTICE 'Database schema setup completed successfully!';
    RAISE NOTICE 'Tables created: api_keys, demo_usage, key_usage, rotation_state';
    RAISE NOTICE 'Triggers enabled: Automatic daily reset and updated_at timestamps';
    RAISE NOTICE 'Sample data inserted for testing';
END $$;