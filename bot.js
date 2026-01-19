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
      // multitap numeric value: default 1 (1 tap per click). Upgrades will increase it.
      multitap: 1,
      // levels map for storing upgrade levels (multitap level starts at 0)
      levels: { multitap: 0, energylimit: 0, recharge: 0, tapbot: 0 },
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
      // boost tracking (daily)
      taping_used_today: 0,
      fulltank_used_today: 0,
      lastBoostDate: new Date(now).toDateString(),
      active_effects: []
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
    // reset energy calculation
    const elapsed = Math.floor((now - (user.lastEnergyUpdate || now)) / 1000);

    const energy = Math.min(
      user.maxEnergy,
      Math.floor((user.energy || 0) + elapsed * (user.regenRate || REGEN_RATE))
    );

    // filter active effects to only non-expired (do not persist removal here to keep GET read-only)
    const active_effects = Array.isArray(user.active_effects) ? user.active_effects.filter(e => (e.expires_at || 0) > now) : [];

    res.json({
      success: true,
      energy,
      maxEnergy: user.maxEnergy,
      points: user.points,
      referral_bonus_total: user.referral_bonus_total || 0,
      active_effects
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

// ================= DAILY-INFO (for the modal) =================
app.get("/daily-info/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const ref = db.collection("users").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: false, message: "user not found" });

    const user = snap.data();
    const now = Date.now();
    const today = new Date(now).toDateString();
    let taping_used = user.taping_used_today || 0;
    let fulltank_used = user.fulltank_used_today || 0;

    // if lastBoostDate is old, counts are effectively zero (do not mutate server here)
    if ((user.lastBoostDate || '') !== today) {
      taping_used = 0;
      fulltank_used = 0;
    }

    return res.json({ success: true, taping_used, fulltank_used });
  } catch (err) {
    console.error("daily-info error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// helper: internal function to reset daily boost counters (returns object of current used counts)
function normalizeBoostsForToday(userData, now) {
  const today = new Date(now).toDateString();
  if (!userData) return { taping_used_today: 0, fulltank_used_today: 0, lastBoostDate: today };
  if ((userData.lastBoostDate || '') !== today) {
    return { taping_used_today: 0, fulltank_used_today: 0, lastBoostDate: today };
  }
  return {
    taping_used_today: userData.taping_used_today || 0,
    fulltank_used_today: userData.fulltank_used_today || 0,
    lastBoostDate: userData.lastBoostDate || today
  };
}

// ================= BOOST: TAPING (10s ×2) =================
app.post("/boost/taping", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, message: "missing user_id" });
    const ref = db.collection("users").doc(String(user_id));
    const now = Date.now();
    const expires_at = now + 10 * 1000; // 10 seconds

    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { success: false, message: "user not found" };
      const data = snap.data();
      const normalized = normalizeBoostsForToday(data, now);
      let taping_used = normalized.taping_used_today;

      if (taping_used >= 3) {
        return { success: false, message: "No taping uses left today" };
      }

      // increment used count and add active effect
      const new_taping_used = taping_used + 1;
      const effect = { type: "taping", expires_at };

      // Build updates (explicit numbers to avoid FieldValue.increment complexities across resets)
      const updates = {
        taping_used_today: new_taping_used,
        fulltank_used_today: normalized.fulltank_used_today,
        lastBoostDate: normalized.lastBoostDate,
        // keep lastActive updated
        lastActive: now
      };

      // push effect into array
      t.update(ref, updates);
      t.update(ref, { active_effects: admin.firestore.FieldValue.arrayUnion(effect) });

      return { success: true, active_effects: (data.active_effects || []).concat([effect]), taping_used: new_taping_used };
    });

    if (!result) return res.json({ success: false });
    if (!result.success) return res.json(result);

    // increment global meta if you want tracking (optional)
    await incMeta({ total_share_balance: 0 });

    return res.json({ success: true, active_effects: result.active_effects, taping_used: result.taping_used });
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
    const ref = db.collection("users").doc(String(user_id));
    const now = Date.now();

    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { success: false, message: "user not found" };
      const data = snap.data();
      const normalized = normalizeBoostsForToday(data, now);
      let fulltank_used = normalized.fulltank_used_today;

      if (fulltank_used >= 3) {
        return { success: false, message: "No Full Tank uses left today" };
      }

      // increment used count and refill energy
      const new_fulltank_used = fulltank_used + 1;
      const updates = {
        fulltank_used_today: new_fulltank_used,
        taping_used_today: normalized.taping_used_today,
        lastBoostDate: normalized.lastBoostDate,
        energy: data.maxEnergy || MAX_ENERGY,
        lastEnergyUpdate: now,
        lastActive: now
      };

      t.update(ref, updates);

      return { success: true, energy: updates.energy, fulltank_used: new_fulltank_used };
    });

    if (!result) return res.json({ success: false });
    if (!result.success) return res.json(result);

    return res.json({ success: true, energy: result.energy, fulltank_used: result.fulltank_used });
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

// ================= BOOSTERS CONFIG (Multitap updated to requested costs/behavior) =================
const boostersData = {
  // Multitap costs updated per your list: level1 => +2 taps cost 600, level2 => +3 taps cost 1500, ...
  multitap: {
    name: 'Multitap',
    // costs array: index 0 -> cost to go from level 0 -> level1 (which yields multitap value 2)
    costs: [600,1500,4000,10000,25000,60000,150000,350000,800000],
    maxLevel: 9
  },
  energylimit: {
    name: 'Energy limit',
    costs: [200,500,1200,3000,8000,20000,50000,120000,300000,700000],
    maxLevel: 10
  },
  recharge: {
    name: 'Recharging speed',
    costs: [2000,5000,12000,30000,70000,150000,350000,800000,1800000,4000000],
    maxLevel: 10
  },
  tapbot: {
    name: 'Tap Bot',
    levels: [
      { clicks_per_sec:1, duration_hrs:2, cost:200000 },
      { clicks_per_sec:2, duration_hrs:4, cost:500000 },
      { clicks_per_sec:4, duration_hrs:6, cost:1500000 },
      { clicks_per_sec:7, duration_hrs:9, cost:4000000 },
      { clicks_per_sec:12, duration_hrs:12, cost:10000000 }
    ],
    maxLevel: 5
  }
};

function getNextCostFromDef(levelsObj, itemKey) {
  const def = boostersData[itemKey];
  if (!def) return null;
  const cur = Number((levelsObj && levelsObj[itemKey]) || 0);
  if (itemKey === 'tapbot') {
    if (cur >= def.maxLevel) return null;
    return def.levels[cur].cost; // cur is current level, next level index = cur
  } else {
    if (cur >= def.costs.length) return null;
    return def.costs[cur];
  }
}

// POST /boost/upgrade
// body: { user_id, item }  item ∈ ['multitap','energylimit','recharge','tapbot']
app.post('/boost/upgrade', async (req, res) => {
  try {
    const { user_id, item } = req.body || {};
    console.log('[boost/upgrade] request', { user_id, item });
    if (!user_id || !item) return res.json({ success: false, message: 'missing parameters' });
    if (!boostersData[item]) return res.json({ success: false, message: 'invalid item' });

    const userRef = db.collection('users').doc(String(user_id));

    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (!snap.exists) return { success: false, message: 'user not found' };
      const user = snap.data();

      // ensure levels map exists
      const levels = user.levels || {};
      const curLevel = Number(levels[item] || 0);
      const cost = getNextCostFromDef(levels, item);
      if (cost === null) return { success: false, message: 'max level' };

      const currentPoints = Number(user.points || 0);
      if (currentPoints < cost) {
        return { success: false, message: 'insufficient funds', points: currentPoints };
      }

      // Build updates
      const newLevel = curLevel + 1;
      const updates = {};
      // update nested levels map
      updates['levels'] = { ...(user.levels || {}), [item]: newLevel };

      // deduct points
      updates['points'] = admin.firestore.FieldValue.increment(-cost);

      // apply immediate effects per item
      if (item === 'multitap') {
        // Desired behavior:
        // - level 1 -> multitap value = 2
        // - level 2 -> multitap value = 3
        // etc.
        // We maintain numeric multitap in user.multitap and increment it by 1 per upgrade from default 1.
        updates['multitap'] = (user.multitap || 1) + 1;
      } else if (item === 'energylimit') {
        // map level -> extra energy; keep same mapping as client if desired
        const energyByLevel = [100,150,200,300,400,600,800,1000,1300,1600];
        const added = energyByLevel[Math.max(0, newLevel-1)] || 0;
        updates['maxEnergy'] = 500 + added; // example: base 500 + mapping
        // ensure current energy <= new max
        if ((user.energy || 0) > (500 + added)) updates['energy'] = 500 + added;
      } else if (item === 'recharge') {
        const speeds = [1,1.3,1.6,2,2.5,3,3.5,4,4.5,5];
        const newSpeed = speeds[Math.max(0,newLevel-1)] || (user.regenRate || REGEN_RATE);
        updates['regenRate'] = newSpeed;
      } else if (item === 'tapbot') {
        updates['tapbot_level'] = newLevel;
      }

      updates['lastActive'] = Date.now();

      // perform update
      t.update(userRef, updates);

      // return new_level and cost (points will be read after transaction)
      return { success: true, new_level: newLevel, cost };
    });

    if (!result) {
      console.error('[boost/upgrade] transaction returned falsy');
      return res.json({ success: false, message: 'transaction failed' });
    }
    if (!result.success) {
      // not enough points or other user-level limit
      console.log('[boost/upgrade] failed:', result.message);
      return res.json(result);
    }

    // read fresh points to return authoritative number
    const freshSnap = await userRef.get();
    const fresh = freshSnap.exists ? freshSnap.data() : null;
    const freshPoints = fresh ? Number(fresh.points || 0) : null;

    console.log('[boost/upgrade] success', { user_id, item, new_level: result.new_level, points: freshPoints });

    return res.json({
      success: true,
      new_level: result.new_level,
      points: freshPoints,
      message: 'upgraded'
    });
  } catch (err) {
    console.error('[boost/upgrade] error', err);
    return res.status(500).json({ success: false, message: 'internal error' });
  }
});

// ================= TAP (updated: energy cost = multitap count, gain = multitap count * boost * effect) =================
app.post("/tap", async (req, res) => {
  try {
    const { user_id } = req.body;
    const ref = db.collection("users").doc(String(user_id));
    const snap = await ref.get();

    if (!snap.exists) return res.json({ success: false });

    const user = snap.data();
    const now = Date.now();

    // recompute current energy from lastEnergyUpdate
    const elapsed = Math.floor((now - (user.lastEnergyUpdate || now)) / 1000);
    let energy = Math.min(
      user.maxEnergy,
      Math.floor((user.energy || 0) + elapsed * (user.regenRate || REGEN_RATE))
    );

    // determine how many taps per click (multitap value)
    const multitapCount = Number(user.multitap || 1); // e.g., level 1 => 2, level 3 => 4 depending on upgrades

    // require enough energy to perform multitapCount taps
    if (energy < multitapCount) {
      return res.json({ success: false, energy, message: 'insufficient energy' });
    }

    // determine multiplier from active effects (taping or x2)
    const active_effects = Array.isArray(user.active_effects) ? user.active_effects.filter(e => (e.expires_at || 0) > now) : [];
    const hasTaping = active_effects.some(e => e.type === 'taping' && e.expires_at > now);
    const hasX2 = active_effects.some(e => e.type === 'x2' && e.expires_at > now);
    const extraMultiplier = (hasTaping || hasX2) ? 2 : 1;

    // compute gain: (boost * multitapCount) * extraMultiplier
    const boostVal = Number(user.boost || 1);
    const baseGain = boostVal * multitapCount;
    const gain = Math.round(baseGain * extraMultiplier);

    // reduce energy by multitapCount
    energy = Math.max(0, energy - multitapCount);

    // update user and global meta
    await ref.update({
      energy,
      points: admin.firestore.FieldValue.increment(gain),
      lastEnergyUpdate: now,
      touches: admin.firestore.FieldValue.increment(1),
      lastActive: now
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
