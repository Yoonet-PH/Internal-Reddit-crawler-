# bataaneyes: privacy policy

Last updated 24/09/2026.

bataaneyes is a private Reddit app operated by UBE (ube.ph) for its own use.

**What it reads.** Public Reddit posts returned by Reddit's search for a short list of terms, and new posts in any community named in its settings.

**What it keeps.** Only the ids of posts it has already sent, in the app's Redis store on Reddit's servers, each deleted automatically after 30 days. It keeps no post text, no usernames and no other personal information.

**What it shares, and with whom.** Once a day it posts one message, through Slack's API, to one private channel in UBE's own Slack workspace. The message contains the title, link, subreddit, author username, date, comment count and a short excerpt of each matching public post. Nothing is sold, shared outside UBE, used for advertising, or used to train any AI model.

**Deletion.** Stored post ids expire after 30 days. Slack messages already posted are deleted on request.

**Contact.** Message u/lostintool on Reddit.
