require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const helmet = require("helmet");

// Initialize Express
const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(helmet());

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Helper: Generate HMAC
const generateHmac = (deviceId, secret) => {
  return crypto.createHmac("sha256", secret).update(deviceId).digest("base64");
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

// Helper: Fetch API keys from database
const fetchApiKeys = async () => {
  const { data, error } = await supabase
    .from("api_keys")
    .select("key_value")
    .eq("is_active", true);

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("No active API keys found in database");
  }

  return data.map((item) => item.key_value);
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
  try {
    // Fetch API keys
    const apiKeys = await fetchApiKeys();

    // Fetch device usage
    const { data: demoData, error: demoError } = await supabase
      .from("demo_usage")
      .select("*")
      .eq("device_id", deviceId)
      .single();

    if (demoError && demoError.code !== "PGRST116") throw demoError;

    const demoUser = demoData || null;
    if (demoUser) {
      if (demoUser.uses >= 5) {
        return res.status(403).json({ error: "Daily demo limit reached." });
      }
      if (demoUser.lifetime_uses >= 50) {
        return res.status(403).json({ error: "Lifetime demo limit reached." });
      }
    }

    // Fetch key usage + rotation state
    const { data: keyUsage, error: keyUsageError } = await supabase
      .from("key_usage")
      .select("*");
    if (keyUsageError) throw keyUsageError;

    const { data: rotationData, error: rotationError } = await supabase
      .from("rotation_state")
      .select("*")
      .eq("id", 1)
      .single();
    if (rotationError && rotationError.code !== "PGRST116") throw rotationError;

    let index = (rotationData?.last_used_index || -1) + 1;
    let selectedKey = null;
    let attempts = 0;

    while (attempts < apiKeys.length) {
      const keyIndex = index % apiKeys.length;
      const key = apiKeys[keyIndex];
      const usage = keyUsage?.find((k) => k.key === key);
      const hits = usage?.hits || 0;
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
    const newIndex = index % apiKeys.length;
    await supabase.from("rotation_state").upsert({
      id: 1,
      last_used_index: newIndex,
    });

    // Increment key usage
    const currentKeyUsage = keyUsage?.find((k) => k.key === selectedKey);
    const currentHits = currentKeyUsage?.hits || 0;
    await supabase.from("key_usage").upsert({
      key: selectedKey,
      hits: currentHits + 1,
    });

    // Increment demo usage
    const currentUses = demoUser?.uses || 0;
    const currentLifetimeUses = demoUser?.lifetime_uses || 0;
    await supabase.from("demo_usage").upsert({
      device_id: deviceId,
      uses: currentUses + 1,
      lifetime_uses: currentLifetimeUses + 1,
      device_info: demoUser?.device_info || null,
    });

    // Return encrypted key
    return res.status(200).json({
      encryptedKey: encryptKey(selectedKey),
      demoMode: true,
      remainingDemoUses: 5 - (currentUses + 1),
      hitsRemaining: 90 - (currentHits + 1),
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
