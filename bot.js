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

// meta doc reference
const META_DOC = db.collection("meta").doc("counters");

// ensure meta doc exists with defaults
async function ensureMetaDoc() {
  const snap = await META_DOC.get();
  if (!snap.exists) {
    await META_DOC.set({
      total_share_balance: 0,
      total_touches: 0,
      total_players: 0,
      daily_users: 0,
      // optional tracking fields
      total_referrals: 0,
      updatedAt: Date.now()
    });
    console.log("Meta counters created");
  }
}

// run ensure on startup
ensureMetaDoc().catch(err => console.warn("ensureMetaDoc err", err));

// helper: increment meta counters (safe to call outside tx)
async function incMeta(fields) {
  return META_DOC.update({
    ...Object.keys(fields).reduce((acc, k) => {
      acc[k] = admin.firestore.FieldValue.increment(fields[k]);
      return acc;
    }, {}),
    updatedAt: Date.now()
  }).catch(async (err) => {
    // if meta missing, create and retry
    const s = await META_DOC.get();
    if (!s.exists) {
      await META_DOC.set({
        total_share_balance: 0,
        total_touches: 0,
        total_players: 0,
        daily_users: 0,
        total_referrals: 0,
        updatedAt: Date.now()
      });
    }
    return META_DOC.update({
      ...Object.keys(fields).reduce((acc, k) => {
        acc[k] = admin.firestore.FieldValue.increment(fields[k]);
        return acc;
      }, {}),
      updatedAt: Date.now()
    });
  });
}

// helper: reset daily boost counts if day changed
async function resetBoostCountsIfNeeded(user, ref, now) {
  const lastReset = user.boost_counts_reset || 0;
  const lastResetDate = new Date(lastReset).toDateString();
  const todayDate = new Date(now).toDateString();
  if (lastReset === 0 || lastResetDate !== todayDate) {
    await ref.update({
      taping_used: 0,
      fulltank_used: 0,
      boost_counts_reset: now
    }).catch(()=>{});
    user.taping_used = 0;
    user.fulltank_used = 0;
    user.boost_counts_reset = now;
  }
}

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
      referral_awarded: false,
      referral_bonus_total: 0,
      touches: 0,
      lastActive: now,
      lastDailyActive: 0,
      // booster counters & effects
      taping_used: 0,
      fulltank_used: 0,
      boost_counts_reset: now,
      active_effects: [] // array of { type: "taping"|"x2", expires_at: ms }
    });
    // increment global players count
    await incMeta({ total_players: 1 });
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

            // award referrer bonus and increment referrals count and referral_bonus_total
            t.update(referrerRef, {
              points: admin.firestore.FieldValue.increment(REFERRER_BONUS),
              referrals: admin.firestore.FieldValue.increment(1),
              referral_bonus_total: admin.firestore.FieldValue.increment(REFERRER_BONUS)
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

            // update meta counters inside transaction if possible
            const metaRef = META_DOC;
            const metaSnap = await t.get(metaRef);
            if (metaSnap.exists) {
              t.update(metaRef, {
                total_share_balance: admin.firestore.FieldValue.increment(FIRST_TIME_GIFT + REFERRER_BONUS),
                total_referrals: admin.firestore.FieldValue.increment(1),
                updatedAt: now
              });
            } else {
              // if meta missing, do nothing here (incMeta will handle)
            }
          });

          // If meta doc wasn't updated in tx above (rare), ensure increments
          await incMeta({ total_share_balance: FIRST_TIME_GIFT + REFERRER_BONUS, total_referrals: 1 });

          // notify both parties (safe best-effort)
          try {
            // notify new user
            await bot.sendMessage(
              msg.chat.id,
              `🎉 Welcome! You registered via a referral link and received ${FIRST_TIME_GIFT} bonus points.`
            );
          } catch (e) { /* ignore notification errors */ }

          try {
            // notify referrer (best-effort, only if bot can message them)
            await bot.sendMessage(
              Number(referrerId),
              `✅ You have a new referral! ${REFERRER_BONUS} points have been added to your account.`
            );
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
                referrals: admin.firestore.FieldValue.increment(1),
                referral_bonus_total: admin.firestore.FieldValue.increment(REFERRER_BONUS)
              });
              t.update(ref, {
                points: admin.firestore.FieldValue.increment(FIRST_TIME_GIFT),
                referral_awarded: true,
                referrer: referrerId
              });
              const recRef = referrerRef.collection("referrals").doc(userId);
              t.set(recRef, { uid: userId, at: now });

              const metaRef = META_DOC;
              const metaSnap = await t.get(metaRef);
              if (metaSnap.exists) {
                t.update(metaRef, {
                  total_share_balance: admin.firestore.FieldValue.increment(FIRST_TIME_GIFT + REFERRER_BONUS),
                  total_referrals: admin.firestore.FieldValue.increment(1),
                  updatedAt: now
                });
              }
            });

            await incMeta({ total_share_balance: FIRST_TIME_GIFT + REFERRER_BONUS, total_referrals: 1 });

            try { await bot.sendMessage(msg.chat.id, `🎉 Welcome! You registered via a referral link and received ${FIRST_TIME_GIFT} bonus points.`); } catch(e){}
            try { await bot.sendMessage(Number(referrerId), `✅ You have a new referral! ${REFERRER_BONUS} points have been added to your account.`); } catch(e){}
          } catch (err) { console.error("Referral transaction failed (existing user):", err); }
        }
      }
    }
  }

  // Always show the main START message and web app button (unchanged behavior)
  bot.sendMessage(msg.chat.id, "Start playing 👇", {
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
  try {
    const ref = db.collection("users").doc(req.params.userId);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false });

    const user = snap.data();
    const now = Date.now();

    // prune expired effects
    const activeEffects = (user.active_effects || []).filter(e => e.expires_at > now);
    if ((user.active_effects || []).length !== activeEffects.length) {
      // update stored active_effects to remove expired ones
      ref.update({ active_effects: activeEffects }).catch(()=>{});
    }

    const elapsed = Math.floor((now - (user.lastEnergyUpdate || now)) / 1000);

    const energy = Math.min(
      user.maxEnergy,
      Math.floor((user.energy || 0) + elapsed * (user.regenRate || REGEN_RATE))
    );

    res.json({
      success: true,
      energy,
      maxEnergy: user.maxEnergy,
      points: user.points,
      referral_bonus_total: user.referral_bonus_total || 0,
      active_effects: activeEffects // return active effects so client can show UI (expires_at in ms)
    });
  } catch (err) {
    console.error("state error", err);
    res.json({ success: false });
  }
});

// ================= REFERRAL INFO ENDPOINT =================
// Returns referral count, total referral bonus (stored) and recent referrals list
app.get("/ref/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) return res.json({ success: false, message: "missing userId" });
    const ref = db.collection("users").doc(String(userId));
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false, message: "user not found" });
    const data = snap.data();
    const referralsCount = data.referrals || 0;
    const refBonusTotal = data.referral_bonus_total || 0;

    // fetch recent referrals list (up to 100)
    const listSnap = await ref.collection("referrals").orderBy("at", "desc").limit(100).get();
    const referrals = listSnap.docs.map(d => {
      const doc = d.data();
      return {
        uid: d.id,
        at: doc.at || null
      };
    });

    return res.json({
      success: true,
      referrals_count: referralsCount,
      ref_bonus_total: refBonusTotal,
      referrals
    });
  } catch (err) {
    console.error("ref endpoint error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ================= DAILY INFO =================
// returns how many boosts used today for showing in modal
app.get("/daily-info/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const ref = db.collection("users").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false, message: "user not found" });
    const user = snap.data();
    const now = Date.now();
    await resetBoostCountsIfNeeded(user, ref, now);
    const updatedSnap = await ref.get();
    const updated = updatedSnap.data();
    return res.json({
      success: true,
      taping_used: updated.taping_used || 0,
      fulltank_used: updated.fulltank_used || 0
    });
  } catch (err) {
    console.error("daily-info error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ================= BOOST: TAPING (×2 for 10s) =================
app.post("/boost/taping", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, message: "missing user_id" });
    const uid = String(user_id);
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false, message: "user not found" });

    const user = snap.data();
    const now = Date.now();

    // daily reset if needed
    await resetBoostCountsIfNeeded(user, ref, now);

    const tapingUsed = user.taping_used || 0;
    if (tapingUsed >= 3) {
      return res.json({ success: false, message: "Taping Guru daily limit reached (3/day)" });
    }

    const expires_at = now + 10 * 1000; // 10 seconds
    const newEffect = { type: "taping", expires_at };

    // push effect and increment counter
    const updatedEffects = (user.active_effects || []).filter(e => e.expires_at > now).concat(newEffect);

    await ref.update({
      active_effects: updatedEffects,
      taping_used: admin.firestore.FieldValue.increment(1)
    });

    // return active effects to client
    return res.json({ success: true, active_effects: updatedEffects });
  } catch (err) {
    console.error("boost/taping error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ================= BOOST: FULL TANK =================
app.post("/boost/full", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, message: "missing user_id" });
    const uid = String(user_id);
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false, message: "user not found" });

    const user = snap.data();
    const now = Date.now();

    // daily reset if needed
    await resetBoostCountsIfNeeded(user, ref, now);

    const fullUsed = user.fulltank_used || 0;
    if (fullUsed >= 3) {
      return res.json({ success: false, message: "Full Tank daily limit reached (3/day)" });
    }

    // set energy to max and update lastEnergyUpdate to now
    await ref.update({
      energy: user.maxEnergy || MAX_ENERGY,
      lastEnergyUpdate: now,
      fulltank_used: admin.firestore.FieldValue.increment(1)
    });

    // fetch updated user
    const updatedSnap = await ref.get();
    const updated = updatedSnap.data();

    return res.json({ success: true, energy: updated.energy, points: updated.points || 0 });
  } catch (err) {
    console.error("boost/full error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ================= HEARTBEAT =================
// Mark user active for daily/online counters
app.post("/heartbeat/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const ref = db.collection("users").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false, message: "user not found" });

    const user = snap.data();
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;

    const updates = { lastActive: now };
    // if lastDailyActive is older than today, increment daily_users and update lastDailyActive
    const lastDaily = user.lastDailyActive || 0;
    const lastDailyDate = new Date(lastDaily).toDateString();
    const todayDate = new Date(now).toDateString();
    if (lastDailyDate !== todayDate) {
      updates.lastDailyActive = now;
      // increment meta.daily_users
      await incMeta({ daily_users: 1 });
    }

    await ref.update(updates);
    return res.json({ success: true });
  } catch (err) {
    console.error("heartbeat error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ================= GLOBAL STATS =================
// Returns meta counters and computed online players (users active in last N seconds)
app.get("/global-stats", async (req, res) => {
  try {
    const metaSnap = await META_DOC.get();
    const meta = metaSnap.exists ? metaSnap.data() : {
      total_share_balance: 0,
      total_touches: 0,
      total_players: 0,
      daily_users: 0,
      total_referrals: 0
    };

    // compute online players: users with lastActive within last 60 seconds (configurable)
    const onlineWindowMs = 60 * 1000; // 60s
    const cutoff = Date.now() - onlineWindowMs;
    const usersRef = db.collection("users").where("lastActive", ">", cutoff);
    const usersSnap = await usersRef.get();
    const onlinePlayers = usersSnap.size || 0;

    return res.json({
      success: true,
      total_share_balance: meta.total_share_balance || 0,
      total_touches: meta.total_touches || 0,
      total_players: meta.total_players || 0,
      daily_users: meta.daily_users || 0,
      online_players: onlinePlayers,
      total_referrals: meta.total_referrals || 0
    });
  } catch (err) {
    console.error("global-stats error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ================= TAP =================
app.post("/tap", async (req, res) => {
  try {
    const { user_id } = req.body;
    const ref = db.collection("users").doc(String(user_id));
    const snap = await ref.get();

    if (!snap.exists) return res.json({ success: false });

    const user = snap.data();
    const now = Date.now();

    // prune expired effects locally
    const activeEffects = (user.active_effects || []).filter(e => e.expires_at > now);

    const elapsed = Math.floor((now - (user.lastEnergyUpdate || now)) / 1000);
    let energy = Math.min(
      user.maxEnergy,
      Math.floor((user.energy || 0) + elapsed * (user.regenRate || REGEN_RATE))
    );

    if (energy <= 0) {
      // also update stored active_effects if expired were pruned
      if ((user.active_effects || []).length !== activeEffects.length) {
        await ref.update({ active_effects: activeEffects }).catch(()=>{});
      }
      return res.json({ success: false, energy });
    }

    energy -= 1;

    // compute multiplier from active effects
    const hasTaping = activeEffects.some(e => e.type === 'taping' && e.expires_at > now);
    const hasX2 = activeEffects.some(e => e.type === 'x2' && e.expires_at > now);
    const multiplier = (hasTaping || hasX2) ? 2 : 1;

    const gain = Math.round((user.boost || 1) * (user.multitap || 1) * multiplier);

    // update user and global meta
    await ref.update({
      energy,
      points: admin.firestore.FieldValue.increment(gain),
      lastEnergyUpdate: now,
      touches: admin.firestore.FieldValue.increment(1),
      lastActive: now,
      active_effects: activeEffects // prune expired effects persistently
    });

    // increment meta counters
    await incMeta({ total_touches: 1, total_share_balance: gain });

    res.json({
      success: true,
      energy,
      gain
    });
  } catch (err) {
    console.error("tap error", err);
    res.json({ success: false });
  }
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
