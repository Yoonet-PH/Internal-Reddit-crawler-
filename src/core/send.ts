import { context, reddit, settings } from '@devvit/web/server';
import type { WatchResult } from './match';
import { DIGEST_MAX, digest, slackText } from './match';
import { loadConfig, rememberSent, runWatch } from './watch';

async function slackSettings() {
  return {
    token: await settings.get<string>('slackBotToken'),
    channel: await settings.get<string>('slackChannel'),
  };
}

/** Slack first. Throws with the reason if the token or channel is missing, or if
 * Slack refuses the post. Slack answers 200 with ok:false on errors such as
 * not_in_channel, so the body is checked, not just the status. */
async function sendSlack(result: WatchResult): Promise<void> {
  const { token, channel } = await slackSettings();
  if (!token || !channel) throw new Error('Slack not configured (slackBotToken or slackChannel unset)');
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      text: slackText(result),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(`Slack ${res.status}: ${body.error ?? 'unknown error'}`);
}

async function sendModmail(result: WatchResult): Promise<void> {
  const { subject, body } = digest(result);
  await reddit.modMail.createModNotification({
    subject,
    bodyMarkdown: body,
    subredditId: context.subredditId,
  });
}

/** The real run: search, post to Slack (modmail if Slack fails), then remember
 * what was sent. Returns how many posts went out and by which route. */
export async function scanAndSend(): Promise<{ sent: number; via: string }> {
  const config = await loadConfig();
  const result = await runWatch(config);
  console.log(
    `watch: ${result.hits.length} new, ${result.droppedLoose} loose dropped, ${result.alreadySeen} already sent`
  );
  if (!result.hits.length) return { sent: 0, via: 'none' };

  let via = 'Slack';
  try {
    await sendSlack(result);
  } catch (err) {
    console.error(`Slack failed, using modmail: ${String(err)}`);
    await sendModmail(result);
    via = 'modmail';
  }
  const shown = result.hits.slice(0, DIGEST_MAX);
  await rememberSent(shown);
  console.log(`sent ${shown.length} by ${via}`);
  return { sent: shown.length, via };
}

/** Log only, nothing sent or remembered. Runs on install and upgrade so a
 * playtest shows what the next real run would find. */
export async function dryRun(): Promise<void> {
  const config = await loadConfig();
  const result = await runWatch(config);
  const { token, channel } = await slackSettings();
  console.log(
    `dry run: terms ${JSON.stringify(config.terms)}, ${result.searched} searched, ${result.hits.length} would send, ${result.droppedLoose} loose dropped`
  );
  console.log(`Slack: token ${token ? 'set' : 'MISSING'}, channel ${channel ?? 'MISSING'}`);
  for (const h of result.hits) {
    console.log(
      `  ${h.createdAt.toISOString().slice(0, 10)} r/${h.subreddit} [${h.matched.join(', ')}] ${h.title} ${h.url}`
    );
  }
}
