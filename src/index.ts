import "dotenv/config";
import {
	type Conversation,
	type ConversationFlavor,
	conversations,
	createConversation,
} from "@grammyjs/conversations";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { Bot, type Context, InlineKeyboard, session } from "grammy";
import { startApiServer } from "./api.js";

type MyContext = Context & ConversationFlavor;

type ProxyItem = {
	name: string;
	url: string;
};

const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);
const prisma = new PrismaClient();

const API_SECRET = process.env.API_SECRET || "supetsecrettoken";
const headers = {
	Authorization: `Bearer ${API_SECRET}`,
};

const BASE =
	process.env.NODE_ENV === "development"
		? "http://localhost:8080"
		: "https://frkn.org";

const API_BASE =
	process.env.NODE_ENV === "development"
		? "http://localhost:3000"
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

function parseProxies(): ProxyItem[] {
	const raw = process.env.FREE_TELEGRAM_PROXIES;
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter(
			(item): item is ProxyItem =>
				item && typeof item.name === "string" && typeof item.url === "string",
		);
	} catch {
		console.error("❌ Невалидный JSON в FREE_TELEGRAM_PROXIES");
		return [];
	}
}

function getProxyKeyboard() {
	const proxies = parseProxies();
	const keyboard = new InlineKeyboard();

	for (const proxy of proxies) {
		keyboard.url(proxy.name, proxy.url).row();
	}

	keyboard.text("🔙 Назад", "main_menu");

	return keyboard;
}

function extractTelegramUser(ctx: MyContext) {
	if (!ctx.from) return null;
	return {
		id: BigInt(ctx.from.id),
		username: ctx.from.username,
		firstName: ctx.from.first_name,
		lastName: ctx.from.last_name,
		languageCode: ctx.from.language_code,
		isPremium: ctx.from.is_premium ?? false,
	};
}

// ---------- CONVERSATIONS ----------

async function feedbackConversation(
	conversation: Conversation<MyContext>,
	ctx: MyContext,
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

	await ctx.api.sendMessage(process.env.ADMIN_CHAT_ID!, payload, {
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
	});

	await ctx.reply("✅ Спасибо! Сообщение отправлено.");
}

async function activateKeyConversation(
	conversation: Conversation<MyContext>,
	ctx: MyContext,
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
		}),
	);

	if (code.length < 10) {
		return ctx.reply("❌ Неверный формат ключа.");
	}

	const waitMsg = await ctx.reply("⏳ Активирую...");

	if (!user?.subscriptionId) {
		const waitMsg = await ctx.reply(
			"😶 Подписка не найдена... Возьми 1 ГБ за 67₽ — кнопка в главном меню",
		);
		return;
	}

	const subscriptionId = user?.subscriptionId;

	try {
		const res = await conversation.external(() =>
			axios.post(
				`${API_BASE}/key/activate`,
				{ code: code, subscription_id: subscriptionId },
				{ headers, timeout: 5000 },
			),
		);

		if (res.status === 200) {
			const key = res.data?.response?.instance?.Key;
			const keyId = key?.id;

			const keyboard = await getMainMenu(userId);

			await ctx.api.editMessageText(
				ctx.chat!.id,
				waitMsg.message_id,
				`✅ Спасибо Ключ активирован\n\n`,
				{ parse_mode: "HTML", reply_markup: keyboard },
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
	ctx: MyContext,
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
			}),
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
				}),
			);

			const keyboard = await getMainMenu(userId);

			await ctx.reply(
				`✅ Подписка привязана\n\nID: <code>${subscriptionId}</code>\nАктивна до: ${safeDate(
					res.data.expires,
				)}`,
				{ parse_mode: "HTML", reply_markup: keyboard },
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
		.row()
		.text("🔑 У меня есть Ключ Активации", "start_activation")
		.row()
		.text("📦 Поддерживаемые Приложения", "clients_menu")
		.row()
		.url("📱 Скачать FRKN Dopamine", "https://frkn.org/dopamine")
		.row()
		.text("🌐 Бесплатные телеграм прокси", "free_proxies")
		.row()
		.text("💬 Фидбек / Вопрос", "feedback_start");

	if (!subId) {
		keyboard.row().text("🔑 У меня есть ID", "enter_subscription_id");
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

bot.command("proxy", async (ctx) => {
	const proxies = parseProxies();

	if (proxies.length === 0) {
		return ctx.reply("😕 Прокси пока не настроены.");
	}

	await ctx.reply("🌐 Выбери бесплатный прокси для подключения:", {
		reply_markup: getProxyKeyboard(),
	});
});

bot.callbackQuery("free_proxies", async (ctx) => {
	await ctx.answerCallbackQuery();

	const proxies = parseProxies();

	if (proxies.length === 0) {
		return ctx.reply("😕 Прокси пока не настроены.");
	}

	await ctx.reply("🌐 Выбери бесплатный прокси для подключения:", {
		reply_markup: getProxyKeyboard(),
	});
});

bot.callbackQuery("main_menu", async (ctx) => {
	await ctx.answerCallbackQuery();

	if (!ctx.from) return;

	const keyboard = await getMainMenu(ctx.from.id);

	await ctx.reply("Главное меню 🚀", {
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

💡 Лучший выбор: Shadowrocket`,
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

💡 Лучший выбор: v2rayNG`,
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

💡 Лучший выбор: Clash Verge Rev`,
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

💡 Лучший выбор: ClashX Pro`,
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

💡 Лучший выбор: Clash Verge`,
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

	await ctx.reply(`Привет, ${ctx.from.first_name || "зай"} 🚀`, {
		reply_markup: keyboard,
	});
});

bot.callbackQuery("buy_gb", async (ctx) => {
	await ctx.answerCallbackQuery();

	const keyboard = new InlineKeyboard()
		.text("1 ГБ — 67₽", "gb_1")
		.text("5 ГБ — 167₽", "gb_5")
		.row()
		.text("10 ГБ — 267₽", "gb_10")
		.text("50 ГБ — 367₽", "gb_50")
		.row()
		.text("🔙 Назад", "main_menu");

	await ctx.reply(
		`🎁 Вечный доступ: трафик не сгорает.\n\n` +
			`Выбери пакет — после оплаты получишь ключ активации.`,
		{ reply_markup: keyboard },
	);
});

bot.callbackQuery(/^gb_(\d+)$/, async (ctx) => {
	await ctx.answerCallbackQuery();
	const gb = ctx.match[1];

	const keyboard = new InlineKeyboard()
		.text("💳 Оплата СБП", `gbgw_planta_${gb}`)
		.row()
		.text("💎 Карта МИР / Крипта", `gbgw_platega_${gb}`)
		.row()
		.text("🔙 Назад", "buy_gb");

	await ctx.reply(`Пакет: ${gb} ГБ. Как платим?`, { reply_markup: keyboard });
});

bot.callbackQuery(/^gbgw_(planta|platega)_(\d+)$/, async (ctx) => {
	await ctx.answerCallbackQuery();
	const gateway = ctx.match[1];
	const gb = Number(ctx.match[2]);

	const waitMsg = await ctx.reply("⏳ Создаю счёт на оплату...");

	try {
		const res = await axios.post(
			`${API_BASE}/payment/${gateway}/key/create`,
			{ duration: 0, kind: "lite", traffic_gib: gb },
			{ timeout: 10000 },
		);

		const url = res.data?.url || res.data?.paymentUrl;

		if (res.status === 200 && url) {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				waitMsg.message_id,
				`💳 Счёт на ${gb} ГБ готов!\n\n` +
					`Оплати по кнопке ниже — ключ придёт на странице после оплаты ` +
					`(сохрани его, он и есть твой доступ).`,
				{
					reply_markup: new InlineKeyboard()
						.url("💳 Оплатить", url)
						.row()
						.text("🔙 В меню", "main_menu"),
				},
			);
		} else {
			throw new Error("no payment url");
		}
	} catch (err: any) {
		console.error("GB purchase error:", err?.response?.data || err.message);
		await ctx.api.editMessageText(
			ctx.chat!.id,
			waitMsg.message_id,
			"❌ Не удалось создать платёж. Попробуй позже или купи на сайте frkn.org/pay",
			{
				reply_markup: new InlineKeyboard().text("🔙 В меню", "main_menu"),
			},
		);
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

startApiServer(bot, prisma);

console.log("🤖 Bot is running");
console.log("version 0.2.0");
