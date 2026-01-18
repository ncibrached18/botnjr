const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

// ================= TELEGRAM =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ================= EXPRESS =================
const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

// ================= CONSTANTS =================
const MAX_ENERGY = 500;
const REGEN_RATE = 1.2;

// ================= /start =================
bot.onText(/\/start/, async (msg) => {
  const userId = String(msg.from.id);
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      points: 0,
      energy: MAX_ENERGY,
      maxEnergy: MAX_ENERGY,
      regenRate: REGEN_RATE,
      boost: 1,
      multitap: 1,
      level: 1,
      lastEnergyUpdate: Date.now(),
      createdAt: Date.now(),
    });
  }

  bot.sendMessage(msg.chat.id, "ابدأ اللعب 👇", {
    reply_markup: {
      inline_keyboard: [[
        {
          text: "▶️ START TAPPING",
          web_app: {
            url: "https://botnjr.onrender.com"
          }
        }
      ]]
    }
  });
});

// ================= GET STATE =================
app.get("/state/:userId", async (req, res) => {
  const ref = db.collection("users").doc(req.params.userId);
  const snap = await ref.get();
  if (!snap.exists) return res.json({ success: false });

  const user = snap.data();
  const now = Date.now();
  const elapsed = Math.floor((now - user.lastEnergyUpdate) / 1000);

  const energy = Math.min(
    user.maxEnergy,
    Math.floor(user.energy + elapsed * user.regenRate)
  );

  res.json({
    success: true,
    energy,
    maxEnergy: user.maxEnergy,
    points: user.points
  });
});

// ================= TAP =================
app.post("/tap", async (req, res) => {
  const { user_id } = req.body;
  const ref = db.collection("users").doc(String(user_id));
  const snap = await ref.get();

  if (!snap.exists) return res.json({ success: false });

  const user = snap.data();
  const now = Date.now();

  const elapsed = Math.floor((now - user.lastEnergyUpdate) / 1000);
  let energy = Math.min(
    user.maxEnergy,
    Math.floor(user.energy + elapsed * user.regenRate)
  );

  if (energy <= 0) {
    return res.json({ success: false, energy });
  }

  energy -= 1;
  const gain = user.boost * user.multitap;

  await ref.update({
    energy,
    points: admin.firestore.FieldValue.increment(gain),
    lastEnergyUpdate: now
  });

  res.json({
    success: true,
    energy,
    gain
  });
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});

