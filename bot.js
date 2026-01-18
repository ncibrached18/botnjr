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

// Referral / rewards configuration (tweak as needed)
const FIRST_TIME_GIFT = 2500;   // points awarded to the new user who used a referral link
const REFERRER_BONUS = 500;     // points awarded to the referrer when someone registers with their link

// ================= /start =================
// Accept optional start payload. payload format supported: r_<referrerId>
// Example deep-link: https://t.me/NJROfficialBot?start=r_123456789
bot.onText(/\/start(?:\s(.+))?/, async (msg, match) => {
  const userId = String(msg.from.id);
  const payload = match && match[1] ? match[1] : null;
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();

  const now = Date.now();

  // helper to create a default user doc
  async function createDefaultUserDoc() {
    await ref.set({
      points: 0,
      energy: MAX_ENERGY,
      maxEnergy: MAX_ENERGY,
      regenRate: REGEN_RATE,
      boost: 1,
      multitap: 1,
      level: 1,
      lastEnergyUpdate: now,
      createdAt: now,
      // referral related:
      referrer: null,
      referrals: 0,
      referral_awarded: false
    });
  }

  // If user does not exist create it
  if (!snap.exists) {
    await createDefaultUserDoc();

    // If there's a payload like r_12345 treat as referral
    if (payload && payload.startsWith("r_")) {
      const referrerId = payload.slice(2);
      // avoid self-referral
      if (referrerId && referrerId !== userId) {
        const referrerRef = db.collection("users").doc(String(referrerId));
        try {
          // Transaction: credit referrer and new user atomically and record the referral entry
          await db.runTransaction(async (t) => {
            const rSnap = await t.get(referrerRef);
            const uSnap = await t.get(ref);
            if (!rSnap.exists) {
              // referrer not found - just set referrer id on new user doc without awarding
              t.update(ref, { referrer: referrerId });
              return;
            }
            // If new user already has referral_awarded true then don't double-award
            const alreadyAwarded = uSnap.exists ? uSnap.data().referral_awarded : false;
            if (alreadyAwarded) {
              // still store referrer id if missing
              t.update(ref, { referrer: referrerId });
              return;
            }

            // award referrer bonus and increment referrals count
            t.update(referrerRef, {
              points: admin.firestore.FieldValue.increment(REFERRER_BONUS),
              referrals: admin.firestore.FieldValue.increment(1)
            });

            // award first-time gift to new user and mark awarded
            t.update(ref, {
              points: admin.firestore.FieldValue.increment(FIRST_TIME_GIFT),
              referral_awarded: true,
              referrer: referrerId
            });

            // add a referral record under referrer's subcollection
            const recRef = referrerRef.collection("referrals").doc(userId);
            t.set(recRef, { uid: userId, at: now });
          });

          // notify both parties (safe best-effort)
          try {
            // notify new user
            await bot.sendMessage(msg.chat.id, `🎉 مرحبًا! لقد سجّلت عبر رابط إحالة، تلقّيت ${FIRST_TIME_GIFT} نقاط كمكافأة بداية.`);
          } catch (e) { /* ignore notification errors */ }

          try {
            // notify referrer (best-effort, only if bot can message them)
            await bot.sendMessage(Number(referrerId), `✅ لديك إحالة جديدة! تم إضافة ${REFERRER_BONUS} نقاط لحسابك.`);
          } catch (e) {
            // it's normal if bot can't message the referrer (e.g. never started), ignore
          }
        } catch (err) {
          console.error("Referral transaction failed:", err);
        }
      } else {
        // payload was self-referral or invalid — still set referrer field to null
        await ref.update({ referrer: null }).catch(()=>{});
      }
    }

  } else {
    // user exists: optional handling if payload is present and user had no referrer previously
    // We'll allow setting referrer only if user hasn't been awarded previously and has no referrer
    if (payload && payload.startsWith("r_")) {
      const referrerId = payload.slice(2);
      if (referrerId && referrerId !== userId) {
        const userData = snap.data();
        if (!userData.referral_awarded && !userData.referrer) {
          const referrerRef = db.collection("users").doc(String(referrerId));
          try {
            await db.runTransaction(async (t) => {
              const rSnap = await t.get(referrerRef);
              const uSnap = await t.get(ref);
              if (!rSnap.exists) {
                t.update(ref, { referrer: referrerId });
                return;
              }
              const alreadyAwarded = uSnap.exists ? uSnap.data().referral_awarded : false;
              if (alreadyAwarded) {
                t.update(ref, { referrer: referrerId });
                return;
              }
              t.update(referrerRef, {
                points: admin.firestore.FieldValue.increment(REFERRER_BONUS),
                referrals: admin.firestore.FieldValue.increment(1)
              });
              t.update(ref, {
                points: admin.firestore.FieldValue.increment(FIRST_TIME_GIFT),
                referral_awarded: true,
                referrer: referrerId
              });
              const recRef = referrerRef.collection("referrals").doc(userId);
              t.set(recRef, { uid: userId, at: now });
            });
            try { await bot.sendMessage(msg.chat.id, `🎉 مرحبًا! لقد سجّلت عبر رابط إحالة، تلقّيت ${FIRST_TIME_GIFT} نقاط كمكافأة بداية.`); } catch(e){}
            try { await bot.sendMessage(Number(referrerId), `✅ لديك إحالة جديدة! تم إضافة ${REFERRER_BONUS} نقاط لحسابك.`); } catch(e){}
          } catch (err) { console.error("Referral transaction failed (existing user):", err); }
        }
      }
    }
  }

  // Always show the main START message and web app button (unchanged behavior)
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
