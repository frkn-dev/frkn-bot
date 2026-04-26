import "dotenv/config";
import { Bot, InlineKeyboard, Context, session } from "grammy";
import { PrismaClient } from "@prisma/client";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import axios from "axios";
type MyContext = Context & ConversationFlavor;

const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);
const prisma = new PrismaClient();

const API_SECRET = process.env.API_SECRET || "supetsecrettoken";
const headers = {
  Authorization: `Bearer ${API_SECRET}`,
};

const BASE =
  process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://frkn.org";

const AUTH_BASE =
  process.env.NODE_ENV === "development"
    ? "http://localhost:3005"
    : "https://api.frkn.org";

const API_BASE =
  process.env.NODE_ENV === "development"
    ? "http://localhost:5005"
    : "https://api.frkn.org";

// ---------- GLOBAL ERROR HANDLING ----------

process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED REJECTION:", err);
});

bot.catch((err) => {
  console.error("🤖 GRAMMY ERROR:", err.error);
});

// ---------- UTILS ----------

function safeDate(date?: string) {
  if (!date) return "—";
  const d = new Date(date);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("ru-RU");
}

function extractTelegramUser(ctx: MyContext)
{ if (!ctx.from) return null;
    return {
        id: BigInt(ctx.from.id),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        languageCode: ctx.from.language_code,
        isPremium: ctx.from.is_premium ?? false, }; }

// ---------- CONVERSATIONS ----------

async function feedbackConversation(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  if (!ctx.from) return;

  await ctx.reply("💬 Напиши свой вопрос или фидбек:");

  const { message } = await conversation.wait();

  if (!message?.text) {
    return ctx.reply("❌ Отправь текстовое сообщение.");
  }

  const text = message.text.trim();

  if (text.length < 3) {
    return ctx.reply("❌ Слишком короткое сообщение.");
  }

  const user = ctx.from;

  const payload = `
📩 NEW FEEDBACK

👤 User: ${user.first_name ?? ""} ${user.last_name ?? ""}
🆔 Telegram ID: ${user.id}
🔗 Username: @${user.username ?? "none"}

💬 Message:
${text}
`;

  await ctx.api.sendMessage(
    process.env.ADMIN_CHAT_ID!,
    payload,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💬 Ответить пользователю",
              url: `https://t.me/${user.username ?? ""}`,
            },
          ],
        ],
      },
    }
  );

  await ctx.reply("✅ Спасибо! Сообщение отправлено.");
}

async function activateKeyConversation(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  await ctx.reply("🎟 Введи ключ активации:");

  const { message } = await conversation.wait();

  if (!message?.text) {
    return ctx.reply("❌ Отправь текстовое сообщение.");
  }

  const code = message.text.trim();
  const user = await conversation.external(() =>
    prisma.telegramUser.findUnique({
      where: { id: BigInt(userId) },
    })
  );

  if (code.length < 10) {
    return ctx.reply("❌ Неверный формат ключа.");
  }

  const waitMsg = await ctx.reply("⏳ Активирую...");

  if (!user?.subscriptionId) {
    const waitMsg = await ctx.reply("😶 Подписка не найдена...");
    return;
  }

  const subscriptionId = user?.subscriptionId;

  try {
    const res = await conversation.external(() =>
      axios.post(`${AUTH_BASE}/activate`, { code: code, subscription_id: subscriptionId, }, { headers, timeout: 5000 })
    );

    if (res.status === 200) {
      const sub = res.data?.response?.instance?.Subscription;
      const subId = sub?.id;

      if (!subId) throw new Error("No subscription ID in response");

      await conversation.external(() =>
        prisma.telegramUser.upsert({
          where: { id: BigInt(userId) },
          update: { subscriptionId: subId },
          create: {
            id: BigInt(userId),
            subscriptionId: subId,
            username: ctx.from?.username,
          },
        })
      );

      const keyboard = await getMainMenu(userId);

      await ctx.api.editMessageText(
        ctx.chat!.id,
        waitMsg.message_id,
        `✅ Ключ активирован\n\nID: <code>${subId}</code>\nАктивна до: ${safeDate(
          sub.expires_at
        )}`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } else {
      await ctx.reply("❌ Ошибка активации.");
    }
  } catch (err: any) {
    const apiError = err?.response?.data;

    console.error("Activation error:", apiError || err.message);

    const message = apiError?.message;

    if (message?.includes("already activated")) {
      await ctx.reply("⚠️ Этот ключ уже был активирован ранее.");
      return;
    }

    await ctx.reply("❌ Ошибка при активации. Попробуй позже.");
  }
}

async function enterSubscriptionIdConversation(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  await ctx.reply("📝 Введи ID подписки:");

  const { message } = await conversation.wait();

  if (!message?.text) {
    return ctx.reply("❌ Отправь текст.");
  }

  const subscriptionId = message.text.trim();

  if (subscriptionId.length < 5) {
    return ctx.reply("❌ Неверный формат ID.");
  }

  await ctx.reply("🔍 Проверяю...");

  try {
    const res = await conversation.external(() =>
      axios.get(`${API_BASE}/subscription/${subscriptionId}`, {
        headers,
        timeout: 5000,
      })
    );

    if (res.status === 200 && res.data?.id) {
      await conversation.external(() =>
        prisma.telegramUser.upsert({
          where: { id: BigInt(userId) },
          update: { subscriptionId },
          create: {
            id: BigInt(userId),
            subscriptionId,
            username: ctx.from?.username,
          },
        })
      );

      const keyboard = await getMainMenu(userId);

      await ctx.reply(
        `✅ Подписка привязана\n\nID: <code>${subscriptionId}</code>\nАктивна до: ${safeDate(
          res.data.expires
        )}`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } else {
      await ctx.reply("❌ Подписка не найдена.");
    }
  } catch (err: any) {
    console.error("Check error:", err?.response?.data || err.message);

    if (err.response?.status === 404) {
      await ctx.reply("❌ Подписка не существует.");
    } else {
      await ctx.reply("❌ Ошибка сервера.");
    }
  }
}

// ---------- MENU ----------

async function getMainMenu(userId: number) {
  const user = await prisma.telegramUser.findUnique({
    where: { id: BigInt(userId) },
  });

  const subId = user?.subscriptionId || "";

  const keyboard = new InlineKeyboard()
    .webApp("🚀 Моя подписка(miniapp)", `https://frkn.org/app/?id=${subId}`)
    .row()
    .url("💎 Купить Ключ Активации", "https://frkn.org/pay")
    .row().text("🔑 У меня есть Ключ Активации", "start_activation")
    .row().text("📦 Поддерживаемые Приложения", "clients_menu")
    .row().text("💬 Фидбек / Вопрос", "feedback_start");

  if (!subId) {
    keyboard.row().text("🎁 Получить триал", "get_trial")
    .row().text("🔑 У меня есть ID", "enter_subscription_id");
  }

  return keyboard;
}


bot.command("clients", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text("📱 iOS", "clients_ios")
    .text("🤖 Android", "clients_android")
    .row()
    .text("🪟 Windows", "clients_windows")
    .text("🍎 macOS", "clients_macos")
    .row()
    .text("🐧 Linux", "clients_linux");

  await ctx.reply("📦 Рекомендуемые клиенты:", {
    reply_markup: keyboard,
  });
});

bot.callbackQuery("clients_ios", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
`📱 iOS клиенты:

• Shadowrocket (рекомендуем ⭐)
• Stash
• Quantumult X
• Streisand

💡 Лучший выбор: Shadowrocket`
  );
});

bot.callbackQuery("clients_android", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
`🤖 Android клиенты:

• v2rayNG (рекомендуем ⭐)
• NekoBox
• Clash for Android
• Hiddify Next

💡 Лучший выбор: v2rayNG`
  );
});

bot.callbackQuery("clients_windows", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
`🪟 Windows клиенты:

• Clash Verge Rev (рекомендуем ⭐)
• V2rayN
• Nekoray
• Hiddify Next

💡 Лучший выбор: Clash Verge Rev`
  );
});

bot.callbackQuery("clients_macos", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
`🍎 macOS клиенты:

• ClashX Pro (рекомендуем ⭐)
• V2rayU
• Stash (если доступен)
• Hiddify Next

💡 Лучший выбор: ClashX Pro`
  );
});

bot.callbackQuery("clients_linux", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
`🐧 Linux клиенты:

• Clash Verge
• Hiddify CLI
• v2rayA
• Nekoray

💡 Лучший выбор: Clash Verge`
  );
});

bot.callbackQuery("clients_menu", async (ctx) => {
  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard()

    .text("🪟 Windows", "clients_windows")
    .text("🍎 macOS", "clients_macos")
    .row()
    .text("🤖 Android", "clients_android")
    .row()
    .text("📱 iOS", "clients_ios");

  await ctx.reply("📦 Выбери платформу:", {
    reply_markup: keyboard,
  });
});

// ---------- BOT ----------

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(activateKeyConversation));
bot.use(createConversation(enterSubscriptionIdConversation));
bot.use(createConversation(feedbackConversation));

bot.command("start", async (ctx) => {
  if (!ctx.from) return;

  const tgUser = extractTelegramUser(ctx);

    if (tgUser) {
      await prisma.telegramUser.upsert({
        where: { id: tgUser.id },
        update: {
          username: tgUser.username,
          firstName: tgUser.firstName,
          lastName: tgUser.lastName,
          languageCode: tgUser.languageCode,
          isPremium: tgUser.isPremium,
        },
        create: {
          id: tgUser.id,
          username: tgUser.username,
          firstName: tgUser.firstName,
          lastName: tgUser.lastName,
          languageCode: tgUser.languageCode,
          isPremium: tgUser.isPremium,
        },
      });
    }

  const keyboard = await getMainMenu(ctx.from.id);

  await ctx.reply(
    `Привет, ${ctx.from.first_name || "зай"} 🚀`,
    { reply_markup: keyboard }
  );
});

bot.callbackQuery("get_trial", async (ctx) => {
  if (!ctx.from) return;

  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;

  try {
    const res = await axios.post(
      `${AUTH_BASE}/tg-trial`,
      {referred_by: "TG",
          telegram_id: userId.toString() },
      { headers, timeout: 5000 }
    );

    if (res.status === 200) {
      const subId = res.data.response.id;

      await prisma.telegramUser.upsert({
        where: { id: BigInt(userId) },
        update: { subscriptionId: subId },
        create: {
          id: BigInt(userId),
          subscriptionId: subId,
          username: ctx.from.username,
        },
      });

      const keyboard = await getMainMenu(userId);

      await ctx.editMessageText(
        `✅ Триал выдан\nID: <code>${subId}</code>`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } else {
      await ctx.reply("❌ Не удалось выдать триал.");
    }
  } catch (err: any) {
    console.error("Trial error:", err?.response?.data || err.message);
    await ctx.reply("❌ Ошибка сервера.");
  }
});

bot.callbackQuery("enter_subscription_id", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("enterSubscriptionIdConversation");
});

bot.callbackQuery("start_activation", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("activateKeyConversation");
});

bot.callbackQuery("feedback_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("feedbackConversation");
});

bot.start();
console.log("🤖 Бот запущен");
