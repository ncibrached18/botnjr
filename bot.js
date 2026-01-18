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
const WEBAPP_URL = "https://botnjr.onrender.com";

// ================= TEXTS =================
const TEXTS = {
  en: {
    welcome: (name) => `
🚀 *Welcome ${name}!*

Welcome to *NJR – Nova Joint Reserve* 💎

⚡ Tap to earn points  
🔥 Upgrade your power  
🚀 Grow your balance  

👇 Press the button below to start now
`,
    button: "🚀 START TAPPING"
  },

  ar: {
    welcome: (name) => `
🚀 *مرحبًا ${name}!*

مرحبًا بك في *NJR – Nova Joint Reserve* 💎

⚡ اضغط لتربح النقاط  
🔥 طوّر قوتك  
🚀 نمّي رصيدك  

👇 اضغط الزر بالأسفل وابدأ الآن
`,
    button: "🚀 ابدأ اللعب"
  }
};

// ================= /start =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const name = msg.from.first_name || "Player";
  const lang = msg.from.language_code?.startsWith("ar") ? "ar" : "en";

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

  await bot.sendMessage(
    chatId,
    TEXTS[lang].welcome(name),
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[
          {
            text: TEXTS[lang].button,
            web_app: { url: WEBAPP_URL }
          }
        ]],
        resize_keyboard: true
      }
    }
  );
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
  console.log("🚀 Server running on", PORT);
});
