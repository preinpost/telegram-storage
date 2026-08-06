/**
 * Helper for finding the storage chat id.
 *
 *   npm run chatid -- @mychannel      # resolve a public @username (bot must be admin)
 *   npm run chatid                    # scan recent getUpdates (post a message in the
 *                                     #   channel/group first; works for fully private chats)
 *
 * Requires TELEGRAM_BOT_TOKEN (from @BotFather) in .env / env.
 */
import { Bot } from 'grammy';

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set (see .env.example / README).');
    process.exitCode = 1;
    return;
  }
  const bot = new Bot(token);
  const target = process.argv[2];

  if (target) {
    try {
      const chat = await bot.api.getChat(target);
      const title =
        'title' in chat ? (chat.title ?? '') : 'first_name' in chat ? (chat.first_name ?? '') : '';
      console.log(`chat id: ${chat.id}  (type: ${chat.type}, title: ${title})`);
      console.log(`→ put this number in .env as STORAGE_CHAT_ID=${chat.id}`);
    } catch (err) {
      console.error(`getChat failed: ${err instanceof Error ? err.message : err}`);
      console.error('hint: the bot must be an admin of the channel/group and the username must be public.');
      process.exitCode = 1;
    }
    return;
  }

  try {
    const updates = await bot.api.getUpdates();
    const chats = new Map<string, { id: number; type: string; title: string }>();
    for (const u of updates) {
      const chat = u.channel_post?.chat ?? u.message?.chat ?? u.edited_message?.chat;
      if (chat) {
        const title = 'title' in chat ? (chat.title ?? '') : 'first_name' in chat ? (chat.first_name ?? '') : '';
        chats.set(String(chat.id), { id: chat.id, type: chat.type, title });
      }
    }
    if (chats.size === 0) {
      console.log('No chats found via getUpdates.');
      console.log('Post a message in the channel/group first and re-run, or pass a public @username:');
      console.log('  npm run chatid -- @channelusername');
    } else {
      for (const c of chats.values()) {
        console.log(`chat id: ${c.id}  (type: ${c.type}, title: ${c.title})`);
      }
      console.log('→ put the storage channel id in .env as STORAGE_CHAT_ID=<id>');
    }
  } catch (err) {
    console.error(`getUpdates failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

await main();
