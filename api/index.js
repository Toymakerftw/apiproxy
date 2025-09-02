
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// --- Environment Variables ---
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  PSK,
  API_KEYS,
  CRON_SECRET
} = process.env;

// --- Constants ---
const DAILY_API_KEY_LIMIT = 90;
const DAILY_DEMO_LIMIT = 5;
const LIFETIME_DEMO_LIMIT = 50; // Optional: set to a high number to disable
const ALGORITHM = 'aes-256-cbc';

// --- Initialization ---
const app = express();
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Helper Functions ---

/**
 * Returns the current date in 'YYYY-MM-DD' format in UTC.
 */
const getUTCDate = () => {
  const now = new Date();
  return now.toISOString().split('T')[0];
};

/**
 * Encrypts a string using AES-256-CBC.
 * @param {string} text - The text to encrypt.
 * @returns {string} The encrypted text in 'iv:encryptedData' hex format.
 */
const encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(PSK, 'utf8'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

/**
 * Validates an HMAC-SHA256 signature.
 * @param {string} deviceId - The device ID used in the HMAC.
 * @param {string} hmac_base64 - The base64 encoded HMAC from the client.
 * @returns {boolean} True if the HMAC is valid, false otherwise.
 */
const validateHmac = (deviceId, hmac_base64) => {
  try {
    const generated_hmac = crypto.createHmac('sha256', PSK).update(deviceId).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(generated_hmac), Buffer.from(hmac_base64));
  } catch (error) {
    console.error('HMAC validation error:', error);
    return false;
  }
};


// --- Middleware ---

// Basic rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Middleware to validate HMAC signature
const hmacAuth = (req, res, next) => {
  const { deviceId, hmac } = req.body;

  if (!deviceId || !hmac) {
    return res.status(400).json({ error: 'Missing deviceId or hmac' });
  }

  if (!validateHmac(deviceId, hmac)) {
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  next();
};


// --- API Routes ---

/**
 * POST /api/get-api-key
 * The main endpoint for clients to request an encrypted API key.
 */
app.post('/api/get-api-key', hmacAuth, async (req, res) => {
  const { deviceId } = req.body;
  const today = getUTCDate();

  try {
    // 1. --- Demo Usage Check ---
    let { data: demoUser, error: demoError } = await supabase
      .from('demo_usage')
      .select('*')
      .eq('device_id', deviceId)
      .single();

    if (demoError && demoError.code !== 'PGRST116') { // PGRST116 = 'not found'
      throw new Error(`Supabase demo_usage select error: ${demoError.message}`);
    }

    if (demoUser) {
      // Optional: Check for lifetime demo uses
      // if (demoUser.lifetime_uses >= LIFETIME_DEMO_LIMIT) {
      //   return res.status(403).json({ error: 'Lifetime demo limit reached.' });
      // }
      
      if (demoUser.last_reset === today && demoUser.uses >= DAILY_DEMO_LIMIT) {
        return res.status(403).json({ error: 'Daily demo limit reached. Try again tomorrow.' });
      }
    }

    // 2. --- API Key Selection ---
    const availableKeys = JSON.parse(API_KEYS);
    let { data: keyUsage, error: keyUsageError } = await supabase
      .from('key_usage')
      .select('*');

    if (keyUsageError) {
      throw new Error(`Supabase key_usage select error: ${keyUsageError.message}`);
    }

    let selectedKey = null;
    let hitsRemaining = 0;

    for (const key of availableKeys) {
      const usage = keyUsage.find(k => k.key === key);
      const currentHits = (usage && usage.last_reset === today) ? usage.hits : 0;

      if (currentHits < DAILY_API_KEY_LIMIT) {
        selectedKey = key;
        hitsRemaining = DAILY_API_KEY_LIMIT - (currentHits + 1);
        break;
      }
    }

    if (!selectedKey) {
      return res.status(429).json({ error: 'All API keys have reached their daily limit. Please try again later.' });
    }

    // 3. --- Update Metrics in Supabase ---
    const keyPromise = supabase.from('key_usage').upsert({
      key: selectedKey,
      hits: (keyUsage.find(k => k.key === selectedKey && k.last_reset === today)?.hits || 0) + 1,
      last_reset: today,
    });

    const remainingDemoUses = demoUser?.last_reset === today ? DAILY_DEMO_LIMIT - (demoUser.uses + 1) : DAILY_DEMO_LIMIT - 1;
    const demoPromise = supabase.from('demo_usage').upsert({
        device_id: deviceId,
        uses: (demoUser?.last_reset === today ? demoUser.uses : 0) + 1,
        last_reset: today,
        lifetime_uses: (demoUser?.lifetime_uses || 0) + 1,
    });

    const [keyResult, demoResult] = await Promise.all([keyPromise, demoPromise]);

    if (keyResult.error) throw new Error(`Supabase key_usage upsert error: ${keyResult.error.message}`);
    if (demoResult.error) throw new Error(`Supabase demo_usage upsert error: ${demoResult.error.message}`);

    // 4. --- Encrypt and Respond ---
    const encryptedKey = encrypt(selectedKey);

    return res.status(200).json({
      encryptedKey,
      demoMode: true,
      remainingDemoUses,
      hitsRemaining,
    });

  } catch (error) {
    console.error('Error in /api/get-api-key:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /api/reset-metrics
 * A Vercel cron job triggers this endpoint to reset daily counters.
 */
app.get('/api/reset-metrics', async (req, res) => {
  // Protect the endpoint with a secret
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = getUTCDate();
  console.log(`Running daily reset for ${today}...`);

  try {
    // Reset hits for all keys
    const { error: keyResetError } = await supabase
      .from('key_usage')
      .update({ hits: 0, last_reset: today });

    if (keyResetError) {
      throw new Error(`Supabase key_usage reset error: ${keyResetError.message}`);
    }

    // Delete old demo usage records
    const { error: demoResetError } = await supabase
      .from('demo_usage')
      .delete()
      .neq('last_reset', today);

    if (demoResetError) {
      throw new Error(`Supabase demo_usage cleanup error: ${demoResetError.message}`);
    }
    
    console.log('Daily metrics reset successfully.');
    return res.status(200).json({ message: 'Daily metrics reset successfully.' });

  } catch (error) {
    console.error('Error in /api/reset-metrics:', error.message);
    return res.status(500).json({ error: 'Internal Server Error during reset.' });
  }
});

// Export the app for Vercel
module.exports = app;
