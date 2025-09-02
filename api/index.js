require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const helmet = require("helmet");

// Initialize Express
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(helmet());

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Helper: Get current UTC date (YYYY-MM-DD)
const getUTCDate = () => new Date().toISOString().split("T")[0];

// Helper: Generate HMAC
const generateHmac = (deviceId, secret) => {
  return crypto
    .createHmac("sha256", secret)
    .update(deviceId)
    .digest("base64");
};

// Helper: Validate HMAC
const validateHmac = (deviceId, hmac) => {
  const generatedHmac = generateHmac(deviceId, process.env.PSK);
  return crypto.timingSafeEqual(
    Buffer.from(generatedHmac),
    Buffer.from(hmac)
  );
};

// Helper: Encrypt API key
const encryptKey = (key) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    crypto.createHash("sha256").update(process.env.PSK).digest(),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(key, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
};

// Middleware: HMAC Authentication
const hmacAuth = (req, res, next) => {
  const { deviceId, hmac } = req.body;
  if (!deviceId || !hmac) {
    return res.status(400).json({ error: "Missing deviceId or hmac." });
  }
  if (!validateHmac(deviceId, hmac)) {
    return res.status(401).json({ error: "Invalid HMAC." });
  }
  next();
};

// Endpoint: Register device
app.post("/api/register-device", async (req, res) => {
  const { appSecret, deviceInfo } = req.body;
  if (appSecret !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Invalid app secret." });
  }
  const deviceId = `device_${crypto.randomBytes(16).toString("hex")}`;
  try {
    const { error } = await supabase.from("demo_usage").upsert({
      device_id: deviceId,
      uses: 0,
      last_reset: getUTCDate(),
      lifetime_uses: 0,
      device_info: deviceInfo,
    });
    if (error) throw error;
    return res.status(200).json({ deviceId });
  } catch (err) {
    console.error("Registration error:", err);
    return res.status(500).json({ error: "Registration failed." });
  }
});

// Endpoint: Get API key
app.post("/api/get-api-key", hmacAuth, async (req, res) => {
  const { deviceId } = req.body;
  const today = getUTCDate();
  try {
    // Check demo limits
    const { data: demoUser, error: demoError } = await supabase
      .from("demo_usage")
      .select("*")
      .eq("device_id", deviceId)
      .single();
    if (demoError && demoError.code !== "PGRST116") throw demoError;
    if (demoUser) {
      if (demoUser.last_reset === today && demoUser.uses >= 5) {
        return res.status(403).json({ error: "Daily demo limit reached." });
      }
      if (demoUser.lifetime_uses >= 50) {
        return res.status(403).json({ error: "Lifetime demo limit reached." });
      }
    }
    // Select API key (round-robin)
    const apiKeys = JSON.parse(process.env.API_KEYS);
    const { data: keyUsage, error: keyUsageError } = await supabase
      .from("key_usage")
      .select("*");
    if (keyUsageError) throw keyUsageError;
    const { data: rotationState, error: rotationError } = await supabase
      .from("rotation_state")
      .select("*")
      .eq("id", 1)
      .single();
    if (rotationError) throw rotationError;
    let index = (rotationState?.last_used_index || -1) + 1;
    let selectedKey = null;
    let attempts = 0;
    while (attempts < apiKeys.length) {
      const keyIndex = index % apiKeys.length;
      const key = apiKeys[keyIndex];
      const usage = keyUsage?.find((k) => k.key === key);
      const hits = usage?.last_reset === today ? usage.hits : 0;
      if (hits < 90) {
        selectedKey = key;
        break;
      }
      index++;
      attempts++;
    }
    if (!selectedKey) {
      return res.status(429).json({ error: "All API keys exhausted." });
    }
    // Update rotation state
    const newIndex = (index % apiKeys.length);
    const { error: updateError } = await supabase
      .from("rotation_state")
      .upsert({ id: 1, last_used_index: newIndex, last_reset: today });
    if (updateError) throw updateError;
    // Update usage metrics
    const { error: usageError } = await supabase.from("key_usage").upsert({
      key: selectedKey,
      hits: (keyUsage?.find((k) => k.key === selectedKey)?.hits || 0) + 1,
      last_reset: today,
    });
    if (usageError) throw usageError;
    const { error: demoUpdateError } = await supabase.from("demo_usage").upsert({
      device_id: deviceId,
      uses: (demoUser?.uses || 0) + 1,
      last_reset: today,
      lifetime_uses: (demoUser?.lifetime_uses || 0) + 1,
    });
    if (demoUpdateError) throw demoUpdateError;
    // Encrypt and return the key
    return res.status(200).json({
      encryptedKey: encryptKey(selectedKey),
      demoMode: true,
      remainingDemoUses: 5 - ((demoUser?.uses || 0) + 1),
      hitsRemaining: 90 - ((keyUsage?.find((k) => k.key === selectedKey)?.hits || 0) + 1),
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// Endpoint: Reset daily metrics (cron job)
app.get("/api/reset-metrics", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  const today = getUTCDate();
  try {
    const { error: keyUsageError } = await supabase
      .from("key_usage")
      .update({ hits: 0, last_reset: today })
      .gte("id", 0);
    if (keyUsageError) throw keyUsageError;
    const { error: demoUsageError } = await supabase
      .from("demo_usage")
      .delete()
      .neq("last_reset", today);
    if (demoUsageError) throw demoUsageError;
    const { error: rotationError } = await supabase
      .from("rotation_state")
      .upsert({ id: 1, last_used_index: -1, last_reset: today });
    if (rotationError) throw rotationError;
    return res.status(200).json({ message: "Metrics reset successfully." });
  } catch (err) {
    console.error("Reset error:", err);
    return res.status(500).json({ error: "Reset failed." });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});