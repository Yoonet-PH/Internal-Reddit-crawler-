import { context, reddit } from '@devvit/web/server';
import { digest, loadConfig, runWatch } from './watch';

/** The real run: search, send new posts to this subreddit's modmail, remember them. */
export async function scanAndSend(): Promise<number> {
  const config = await loadConfig();
  const result = await runWatch(config, { markSeen: true });
  console.log(
    `watch: ${result.hits.length} new, ${result.droppedLoose} loose dropped, ${result.alreadySeen} already sent`
  );
  if (!result.hits.length) return 0;
  const { subject, body } = digest(result);
  await reddit.modMail.createModNotification({
    subject,
    bodyMarkdown: body,
    subredditId: context.subredditId,
  });
  return result.hits.length;
}

/** Log only, nothing sent or remembered. Runs on install and upgrade so a
 * playtest shows what the next real run would find. */
export async function dryRun(): Promise<void> {
  const config = await loadConfig();
  const result = await runWatch(config, { markSeen: false });
  console.log(
    `dry run: terms ${JSON.stringify(config.terms)}, ${result.searched} searched, ${result.hits.length} would send, ${result.droppedLoose} loose dropped`
  );
  for (const h of result.hits) {
    console.log(
      `  ${h.createdAt.toISOString().slice(0, 10)} r/${h.subreddit} [${h.matched.join(', ')}] ${h.title} ${h.url}`
    );
  }
}
