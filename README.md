# 花间 · multiplayer on Render

Everything still renders on your phones. This server only hands out the page and relays tiny messages
(positions ~10×/s, time of day, her flower stats). The free tier is plenty for two people.

## Deploy (~5 min)
1. Make a new GitHub repo and upload EVERYTHING in this folder (server.js, package.json, public/index.html, README.md).
2. render.com → New → Web Service → connect that repo.
   - Runtime: Node · Build command: `npm install` · Start command: `npm start` · Instance: Free
3. Environment → add `PEEK_KEY` = any secret word (e.g. `ranunculus123`). This protects the stats page.
4. Deploy. You get a link like `https://huajian-xxxx.onrender.com`.

## Use
- You both open the link. The start screen shows **I'm 公惠 / I'm Demir**; each of you taps your own.
- You see each other as glowing figures with name tags. Time of day is shared, and tapping the clock changes it for both.
- **Your secret dashboard:** open `https://YOUR-LINK.onrender.com/?key=YOUR_PEEK_KEY#peek` (or long-press the herbarium button),
  then tap **📡 load 公惠's live stats**. Her close-up time per flower updates live; no share button needed.
- Raw JSON: `/stats?key=YOUR_PEEK_KEY`

## Good to know
- Free Render sleeps after 15 min with nobody connected. The first visit after that takes ~1 min to wake (the page shows the loader).
- Stats are saved to a file on the server, but free Render wipes files on redeploy/restart. Her phone keeps its own copy, and it re-uploads every few seconds while she plays.
- Check that onrender.com opens from China before relying on it. The same index.html still works single-player on GitHub Pages.
- Private room: add `?room=anything` to both links.

## Keep everything between restarts (free, ~3 min)
Render's free disk is wiped on every restart/redeploy. To keep her stats, lanterns, chat, clock and picnic:
1. upstash.com → sign up (free) → Create Database → Redis, any name, region close to Render (e.g. Frankfurt), Free plan.
2. On the database page, scroll to **REST API** → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Render → your service → Environment → add both with exactly those names → Save (it redeploys).
4. Render Logs should say `(saving to Upstash)`. Done.
