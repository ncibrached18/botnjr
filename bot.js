/**
 * bot.js (Supabase + Telegram)
 * Updated to call Postgres RPC functions for atomic operations:
 *  - fn_boost_upgrade(p_user_id text, p_item text)
 *  - fn_tap(p_user_id text)
 *
 * Requirements:
 *  - npm i node-telegram-bot-api express body-parser @supabase/supabase-js dotenv
 *  - Environment variables:
 *      SUPABASE_URL
 *      SUPABASE_KEY         (use service_role key on server)
 *      BOT_TOKEN
 *      WEB_APP_URL (optional)
 *
 * Notes:
 *  - This file keeps the same HTTP API as before (/state, /boost/levels, /boost/upgrade, /tap, etc.)
 *  - The RPC functions must exist in your Supabase DB (see the provided SQL).
 */
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// ----------------- Supabase -----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_KEY must be set in environment");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ----------------- Telegram -----------------
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ----------------- Express -----------------
const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

// ----------------- Constants -----------------
const MAX_ENERGY = 500;
const REGEN_RATE = 1.2;
const FIRST_TIME_GIFT = 2500;
const REFERRER_BONUS = 500;

// ----------------- Payments -----------------
const BOOST_PACKAGES = {
  boost_x2_1h: {
    multiplier: 2,
    duration_ms: 1 * 60 * 60 * 1000,
    price_ton: 0.4
  },
  boost_x2_2h: {
    multiplier: 2,
    duration_ms: 4 * 60 * 60 * 1000,
    price_ton: 0.9
  },
  boost_x2_7h: {
    multiplier: 2,
    duration_ms: 8 * 60 * 60 * 1000,
    price_ton: 3
  }
};


// ----------------- Helpers -----------------
async function ensureMetaRow() {
  const { data, error } = await supabase
    .from("meta")
    .select("*")
    .eq("id", "counters")
    .limit(1);
  if (error) {
    console.warn("ensureMetaRow select error", error);
    return;
  }
  if (!data || data.length === 0) {
    const insert = {
      id: "counters",
      total_share_balance: 0,
      total_touches: 0,
      total_players: 0,
      daily_users: 0,
      total_referrals: 0,
      updated_at: Date.now()
    };
    const { error: ie } = await supabase.from("meta").insert(insert);
    if (ie) console.warn("ensureMetaRow insert error", ie);
    else console.log("Meta counters created (supabase)");
  }
}

async function getUser(userId) {
  const { data, error } = await supabase.from("users").select("*").eq("id", String(userId)).limit(1);
  if (error) {
    console.error("getUser error", error);
    return null;
  }
  return (data && data[0]) || null;
}

async function createDefaultUser(userId, now) {
  const doc = {
    id: String(userId),
    points: 0,
    energy: MAX_ENERGY,
    max_energy: MAX_ENERGY,
    regen_rate: REGEN_RATE,
    boost: 1,
    multitap: 1,
    levels: { multitap: 0, energylimit: 0, recharge: 0, tapbot: 0 },
    last_energy_update: now,
    created_at: now,
    referrer: null,
    referrals: 0,
    referral_awarded: false,
    referral_bonus_total: 0,
    touches: 0,
    last_active: now,
    last_daily_active: 0,
    taping_used_today: 0,
    fulltank_used_today: 0,
    last_boost_date: new Date(now).toDateString(),
    active_effects: []
  };
  const { error } = await supabase.from("users").insert(doc);
  if (error) {
    console.error("createDefaultUser error", error);
  } else {
    // increment meta players
    const { error: incMetaErr } = await supabase.rpc('inc_meta', { field: 'total_players', delta: 1 });
    if (incMetaErr) console.warn('inc_meta err', incMetaErr);
  }
  return;
}

async function addReferralRecord(referrerId, referredId, at) {
  const rec = { referrer_id: String(referrerId), referred_id: String(referredId), at };
  const { error } = await supabase.from("referrals").insert(rec);
  if (error) console.warn("addReferralRecord error", error);
}

// ----------------- Bot /start handler -----------------
bot.onText(/\/start(?:\s(.+))?/, async (msg, match) => {
  const userId = String(msg.from.id);
  const payload = match && match[1] ? match[1] : null;
  const now = Math.floor(Date.now() / 1000);

  try {
    const existing = await getUser(userId);
    if (!existing) {
      await createDefaultUser(userId, now);

      if (payload && payload.startsWith("r_")) {
        const referrerId = payload.slice(2);
        if (referrerId && referrerId !== userId) {
          const referrer = await getUser(referrerId);
          if (referrer) {
            // award referrer and new user
            await supabase.from("users").update({
              points: (Number(referrer.points || 0) + REFERRER_BONUS),
              referrals: (Number(referrer.referrals || 0) + 1),
              referral_bonus_total: (Number(referrer.referral_bonus_total || 0) + REFERRER_BONUS)
            }).eq("id", String(referrerId)).catch(e=>console.error('referrer update err', e));

            await supabase.from("users").update({
              points: (Number(0) + FIRST_TIME_GIFT), // new user had 0
              referral_awarded: true,
              referrer: String(referrerId)
            }).eq("id", String(userId)).catch(e=>console.error('new user award err', e));

            await addReferralRecord(referrerId, userId, Date.now());
            // inc meta counters via RPC
            const { error: incShareErr } = await supabase.rpc('inc_meta', { field: 'total_share_balance', delta: FIRST_TIME_GIFT + REFERRER_BONUS });
            if (incShareErr) console.warn('inc_meta err', incShareErr);
            const { error: incRefErr } = await supabase.rpc('inc_meta', { field: 'total_referrals', delta: 1 });
            if (incRefErr) console.warn('inc_meta err', incRefErr);

            try { await bot.sendMessage(msg.chat.id, `🎉 Welcome! You registered via a referral link and received ${FIRST_TIME_GIFT} bonus points.`); } catch(e){}
            try { await bot.sendMessage(Number(referrerId), `✅ You have a new referral! ${REFERRER_BONUS} points have been added to your account.`); } catch(e){}
          }
        }
      }
    } else {
      // existing user: optionally handle payload if no referrer
      if (payload && payload.startsWith("r_")) {
        const referrerId = payload.slice(2);
        if (referrerId && referrerId !== userId && !existing.referral_awarded && !existing.referrer) {
          const referrer = await getUser(referrerId);
          if (referrer) {
            await supabase.from("users").update({
              points: (Number(referrer.points || 0) + REFERRER_BONUS),
              referrals: (Number(referrer.referrals || 0) + 1),
              referral_bonus_total: (Number(referrer.referral_bonus_total || 0) + REFERRER_BONUS)
            }).eq("id", String(referrerId)).catch(e=>console.error('referrer update err', e));

            await supabase.from("users").update({
              points: (Number(existing.points || 0) + FIRST_TIME_GIFT),
              referral_awarded: true,
              referrer: String(referrerId)
            }).eq("id", String(userId)).catch(e=>console.error('user update err', e));

            await addReferralRecord(referrerId, userId, Date.now());
            const { error: incShareErr2 } = await supabase.rpc('inc_meta', { field: 'total_share_balance', delta: FIRST_TIME_GIFT + REFERRER_BONUS });
            if (incShareErr2) console.warn('inc_meta err', incShareErr2);
            const { error: incRefErr2 } = await supabase.rpc('inc_meta', { field: 'total_referrals', delta: 1 });
            if (incRefErr2) console.warn('inc_meta err', incRefErr2);

            try { await bot.sendMessage(msg.chat.id, `🎉 Welcome! You registered via a referral link and received ${FIRST_TIME_GIFT} bonus points.`); } catch(e){}
            try { await bot.sendMessage(Number(referrerId), `✅ You have a new referral! ${REFERRER_BONUS} points have been added to your account.`); } catch(e){}
          }
        }
      }
    }
  } catch (err) {
    console.error("/start handler error", err);
  }

  bot.sendMessage(msg.chat.id, "Start playing 👇", {
    reply_markup: {
      inline_keyboard: [[
        {
          text: "▶️ START TAPPING",
          web_app: {
            url: process.env.WEB_APP_URL || "https://botnjr.onrender.com"
          }
        }
      ]]
    }
  });
});

// ----------------- نضيف زر في البوت داخل كود البوت (مثلاً بعد /start أو أمر /buy): -----------------

// snippet: inside bot.onText(/\/buy/, ... )
bot.onText(/\/buy/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  // نرسل زر يفتح صفحة الويب (داخل Telegram WebApp) لصفحة الدفع
  const webAppUrl = (process.env.WEB_APP_URL || "https://botnjr.onrender.com") + `/pay.html?item=boost_x2_1h&user=${encodeURIComponent(userId)}`;

  bot.sendMessage(chatId, "💎 اختر طريقة الدفع:", {
    reply_markup: {
      inline_keyboard: [[
        {
          text: "💳 Buy Boost ×2 (Open WebApp)",
          web_app: {
            url: webAppUrl
          }
        }
      ]]
    }
  });
});


// ----------------- Create payment -----------------
app.post("/pay/create", async (req, res) => {
  try {
    const { user_id, item } = req.body;
    if (!user_id || !item) {
      return res.json({ success: false, message: "missing params" });
    }

    const pack = BOOST_PACKAGES[item];
    if (!pack) {
      return res.json({ success: false, message: "invalid item" });
    }

    const comment = `BOOST_${user_id}_${Date.now()}`;

    const { error } = await supabase.from("payments").insert({
      user_id: String(user_id),
      item,
      amount_ton: pack.price_ton,
      comment,
      status: "pending",
      created_at: Date.now()
    });

    if (error) {
      console.error("payment create error", error);
      return res.json({ success: false });
    }

    return res.json({
      success: true,
      address: process.env.TON_WALLET_ADDRESS,
      amount: pack.price_ton,
      comment
    });
  } catch (e) {
    console.error("/pay/create error", e);
    return res.json({ success: false });
  }
});

// ----------------- Confirm payment -----------------
app.post("/pay/confirm", async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.json({ success: false });

  const payment = await supabase
    .from("payments")
    .select("*")
    .eq("comment", comment)
    .single();

  if (!payment.data) return res.json({ success: false });

  const txs = await axios.get(
  `https://tonapi.io/v2/blockchain/accounts/${process.env.TON_WALLET_ADDRESS}/transactions`,
  {
    headers: {
      Authorization: `Bearer ${process.env.TONAPI_KEY}`
    }
  }
);


  const found = txs.data.transactions.find(
    tx => tx.in_msg?.message === comment
  );

  if (!found) return res.json({ success: false });

  await supabase
    .from("payments")
    .update({
      status: "paid",
      paid_at: Date.now()
    })
    .eq("comment", comment);

  // تفعيل الـ Boost
  await supabase.rpc("activate_boost", {
    uid: payment.data.user_id
  });

  res.json({ success: true });
});


// ----------------- /state -----------------
app.get("/state/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const { data, error } = await supabase.from("users").select("*").eq("id", userId).limit(1);
    if (error) { console.error("state select error", error); return res.json({ success: false }); }
    if (!data || data.length === 0) return res.json({ success: false });

    const user = data[0];
    const now = Math.floor(Date.now() / 1000);
    const elapsed = Math.floor((now - (user.last_energy_update || now)));
    const energy = Math.min(user.max_energy, Math.floor((user.energy || 0) + elapsed * (user.regen_rate || REGEN_RATE)));

    const active_effects = Array.isArray(user.active_effects) ? (user.active_effects.filter(e => (e.expires_at || 0) > Date.now())) : [];

    res.json({
     success: true,
     energy,
     maxEnergy: user.max_energy,
     points: user.points,
     referral_bonus_total: user.referral_bonus_total || 0,
     active_effects,
     multitap: user.multitap || 1,
     boost: user.boost || user.multitap || 1, // ⭐ السطر المهم
     levels: user.levels || {}
    });

  } catch (err) {
    console.error("state error", err);
    res.json({ success: false });
  }
});

// ----------------- /boost/levels -----------------
app.get("/boost/levels/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const { data, error } = await supabase.from("users").select("levels").eq("id", userId).limit(1);
    if (error) { console.error("/boost/levels select error", error); return res.json({ success: false }); }
    if (!data || data.length === 0) return res.json({ success: false, message: "user not found" });
    const levels = data[0].levels || {};
    Object.keys(levels).forEach(k => levels[k] = Number(levels[k] || 0));
    return res.json({ success: true, levels });
  } catch (err) {
    console.error("/boost/levels error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ----------------- /boost/upgrade (uses RPC fn_boost_upgrade) -----------------
app.post('/boost/upgrade', async (req, res) => {
  try {
    const { user_id, item } = req.body || {};
    if (!user_id || !item) return res.json({ success: false, message: 'missing parameters' });

    // Call RPC function
    const { data, error } = await supabase.rpc('fn_boost_upgrade', { p_user_id: String(user_id), p_item: String(item) });

    if (error) {
      console.error('/boost/upgrade rpc error', error);
      return res.json({ success: false, message: 'internal error' });
    }

    // RPC returns a jsonb object; depending on supabase client it may arrive wrapped
    const result = Array.isArray(data) ? data[0] : data;
    // result is expected to be an object like { success: true, new_level: ..., points: ..., levels: ..., multitap: ... }

    if (!result || result.success === false) {
      return res.json(result || { success: false, message: 'upgrade failed' });
    }

    // Optionally, update meta counters (not required if db function handles it)
    // await supabase.rpc('inc_meta', { field: 'total_share_balance', delta: 0 }).catch(()=>{});

    return res.json({
      success: true,
      new_level: result.new_level,
      points: result.points,
      levels: result.levels,
      multitap: result.multitap,
      message: result.message || 'upgraded'
    });
  } catch (err) {
    console.error('/boost/upgrade error', err);
    return res.status(500).json({ success: false, message: 'internal error' });
  }
});

// ----------------- /tap (uses RPC fn_tap) -----------------
app.post("/tap", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false });

    const { data, error } = await supabase.rpc('fn_tap', { p_user_id: String(user_id) });
    if (error) {
      console.error('/tap rpc error', error);
      return res.json({ success: false });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result || result.success === false) {
      return res.json(result || { success: false });
    }

    return res.json({ success: true, energy: result.energy, gain: result.gain });
  } catch (err) {
    console.error("tap error", err);
    res.json({ success: false });
  }
});

// ----------------- Other endpoints: /boost/taping, /boost/full, /heartbeat, /ref, /daily-info, /global-stats -----------------
// For brevity reusing read-update logic from earlier implementation (these do not require RPC in minimal setup)
// boost/taping
app.post("/boost/taping", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, message: "missing user_id" });
    const now = Date.now();
    const expires_at = now + 10 * 1000;

    const { data, error } = await supabase.from("users").select("*").eq("id", String(user_id)).limit(1);
    if (error || !data || data.length === 0) return res.json({ success: false, message: "user not found" });
    const user = data[0];

    const today = new Date(now).toDateString();
    let taping_used = user.taping_used_today || 0;
    let fulltank_used = user.fulltank_used_today || 0;
    if ((user.last_boost_date || '') !== today) {
      taping_used = 0;
      fulltank_used = 0;
    }

    if (taping_used >= 3) return res.json({ success: false, message: "No taping uses left today" });

    const new_taping_used = taping_used + 1;
    const active_effects = Array.isArray(user.active_effects) ? user.active_effects.slice() : [];
    active_effects.push({ type: "taping", expires_at });

    const updates = {
      taping_used_today: new_taping_used,
      fulltank_used_today: fulltank_used,
      last_boost_date: today,
      last_active: now,
      active_effects
    };

    const { error: ue } = await supabase.from("users").update(updates).eq("id", String(user_id));
    if (ue) { console.error("boost/taping update error", ue); return res.json({ success: false }); }

    const { error: incShareErr3 } = await supabase.rpc('inc_meta', { field: 'total_share_balance', delta: 0 });
    if (incShareErr3) console.warn('inc_meta err', incShareErr3);

    return res.json({ success: true, active_effects, taping_used: new_taping_used });
  } catch (err) {
    console.error("boost/taping error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// boost/full
app.post("/boost/full", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ success: false, message: "missing user_id" });
    const now = Date.now();
    const { data, error } = await supabase.from("users").select("*").eq("id", String(user_id)).limit(1);
    if (error || !data || data.length === 0) return res.json({ success: false, message: "user not found" });
    const user = data[0];

    const today = new Date(now).toDateString();
    let taping_used = user.taping_used_today || 0;
    let fulltank_used = user.fulltank_used_today || 0;
    if ((user.last_boost_date || '') !== today) {
      taping_used = 0;
      fulltank_used = 0;
    }

    if (fulltank_used >= 3) return res.json({ success: false, message: "No Full Tank uses left today" });

    const new_fulltank_used = fulltank_used + 1;
    const updates = {
      fulltank_used_today: new_fulltank_used,
      taping_used_today: taping_used,
      last_boost_date: today,
      energy: user.max_energy || MAX_ENERGY,
      last_energy_update: Math.floor(Date.now() / 1000),
      last_active: Math.floor(Date.now() / 1000)
    };

    const { error: ue } = await supabase.from("users").update(updates).eq("id", String(user_id));
    if (ue) { console.error("boost/full update error", ue); return res.json({ success: false }); }

    return res.json({ success: true, energy: updates.energy, fulltank_used: new_fulltank_used });
  } catch (err) {
    console.error("boost/full error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// heartbeat
app.post("/heartbeat/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const { data, error } = await supabase.from("users").select("*").eq("id", userId).limit(1);
    if (error || !data || data.length === 0) return res.json({ success: false, message: "user not found" });
    const user = data[0];
    const now = Math.floor(Date.now() / 1000);
    const lastDaily = user.last_daily_active || 0;
    const lastDailyDate = new Date(lastDaily * 1000).toDateString();
    const todayDate = new Date(now * 1000).toDateString();

    const updates = { last_active: now };
    if (lastDailyDate !== todayDate) {
      updates.last_daily_active = now;
      const { error: incDailyErr } = await supabase.rpc('inc_meta', { field: 'daily_users', delta: 1 });
      if (incDailyErr) console.warn('inc_meta err', incDailyErr);
    }

    await supabase.from("users").update(updates).eq("id", userId);
    return res.json({ success: true });
  } catch (err) {
    console.error("heartbeat error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// ref endpoint
app.get("/ref/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    if (!userId) return res.json({ success: false, message: "missing userId" });
    const { data, error } = await supabase.from("users").select("*").eq("id", userId).limit(1);
    if (error || !data || data.length === 0) return res.json({ success: false, message: "user not found" });
    const user = data[0];

    const { data: rows, error: rerr } = await supabase
      .from("referrals")
      .select("referred_id, at")
      .eq("referrer_id", userId)
      .order("at", { ascending: false })
      .limit(100);
    if (rerr) console.warn("referrals list error", rerr);
    const referrals = (rows || []).map(r => ({ uid: r.referred_id, at: r.at }));

    return res.json({
      success: true,
      referrals_count: user.referrals || 0,
      ref_bonus_total: user.referral_bonus_total || 0,
      referrals
    });
  } catch (err) {
    console.error("ref endpoint error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// daily-info
app.get("/daily-info/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const { data, error } = await supabase.from("users").select("taping_used_today, fulltank_used_today, last_boost_date").eq("id", userId).limit(1);
    if (error || !data || data.length === 0) return res.json({ success: false, message: "user not found" });
    const user = data[0];
    const now = Date.now();
    const today = new Date(now).toDateString();
    let taping_used = user.taping_used_today || 0;
    let fulltank_used = user.fulltank_used_today || 0;
    if ((user.last_boost_date || '') !== today) {
      taping_used = 0;
      fulltank_used = 0;
    }
    return res.json({ success: true, taping_used, fulltank_used });
  } catch (err) {
    console.error("daily-info error", err);
    return res.json({ success: false, message: "internal error" });
  }
});

// global-stats
app.get("/global-stats", async (req, res) => {
  try {
    const { data: metaRows } = await supabase.from("meta").select("*").eq("id", "counters").limit(1);
    const meta = (metaRows && metaRows[0]) || { total_share_balance:0, total_touches:0, total_players:0, daily_users:0, total_referrals:0 };

    const onlineWindowMs = 60 * 1000;
    const cutoff = Math.floor(Date.now() / 1000) - (onlineWindowMs / 1000);
    const { data: users } = await supabase.from("users").select("id").gt("last_active", cutoff);
    const onlinePlayers = (users && users.length) || 0;

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

// ----------------- Server start -----------------
const PORT = process.env.PORT || 3000;
ensureMetaRow().catch(err => console.warn("ensureMetaRow failed", err));
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});

