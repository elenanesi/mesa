# Mesa — Test it & put it on your iPhone

There are two stages. **Stage 1** is now: open the mockup and try it on your phone (no code, no accounts, 5 minutes). **Stage 2** is later, when you build the real app — it's here so you know what's coming.

---

## Stage 1 — Try the mockup (today)

### A. On your computer first (fastest look)
Just double-click `mesa-prototype.html`. It opens in your browser inside an iPhone frame. Click the bottom tabs, the Elena/Andrea switch at the top, and any meal card to see the recipe screen. This is the quickest way to react to the layout.

### B. On your actual iPhone — the simple way (AirDrop)
1. On your Mac, find `mesa-prototype.html` in the Workspace folder.
2. Right-click it → **Share → AirDrop** → pick your iPhone.
3. On the iPhone, tap the file when it arrives. It opens full-screen in Safari and behaves like a real app (the desktop "phone frame" disappears — it just fills your screen).

### C. On your iPhone — add it to your Home Screen (feels like an installed app)
Do this so it gets its own icon and opens without Safari's address bar:
1. With the mockup open in Safari, tap the **Share** button (the square with an up-arrow, bottom centre).
2. Scroll down and tap **Add to Home Screen**.
3. Name it "Mesa" and tap **Add**.
4. You now have a Mesa icon on your home screen. Open it — it runs full-screen, no browser chrome.

> This works because the file already includes the web-app settings (`apple-mobile-web-app-capable`, full-screen viewport). Andrea can do the exact same on his iPhone — AirDrop it to him.

### D. Get the file onto the phone without AirDrop (alternatives)
- **iCloud / Files:** drop `mesa-prototype.html` into iCloud Drive, open the **Files** app on your iPhone, tap it.
- **Email/Message it to yourself**, then open the attachment in Safari.
- **Local web server (most "real" preview)** — see the box below; lets you refresh changes instantly.

```
# On your Mac, in the folder with the file:
cd ~/Desktop/Workspace/health_app
python3 -m http.server 8000
# Find your Mac's IP: System Settings → Wi-Fi → Details → IP address (e.g. 192.168.1.20)
# On your iPhone (same Wi-Fi), open Safari and go to:
#   http://192.168.1.20:8000/mesa-prototype.html
```
With the server running, when I update the design you just **reload** the page on your phone — no re-sending the file.

### What to test (give feedback on these)
- **First open:** you'll see a 3-screen intro (pick Elena or Andrea on screen 2). It only shows once — replay it from Profile → "Replay intro".
- Does **Today** tell you what you need in one glance? Is the calorie ring the right anchor?
- Switch **Elena ⇄ Andrea** (top right). Your breakfasts differ (solo meals), dinner is shared — does that split feel right? Note the fat line ("💚 good fats · sat.") and the **Calories by macro** bar under the ring.
- In **Profile → "Meals we share"**, toggle Lunch to shared and watch the "👥 Together" pill appear on the lunch card. Is dinner-only the right default for you two?
- On the salmon (shared) recipe, try the per-person steppers; on a breakfast (solo) recipe you get a single servings stepper instead. Does the difference read clearly?
- On **Week**, tap **✨ Re-balance my week** — the sheet tells you exactly what it keeps fixed and what it changes, previews the swaps, and applying it actually lifts the Vitamin D chip. Is that the level of transparency you'd want?
- In **Profile → "Macro split"**, tap **Higher protein** (or step the percentages yourself) — then look at Today, the + tab, and Week: the whole menu rebuilds around your new split, gram targets recompute, and the coach explains what changed. Try pushing Fat below 20% to see the guardrail. Each of you has your own split — switch to Andrea and check his is untouched.
- Tap a meal → recipe. Is the **"why this fits you"** box the kind of explanation you'd trust? Try the **servings steppers** ("Elena 1× · Andrea 1.5×") — ingredient quantities rescale live.
- On **Week**, tap a day — it expands to that day's meals. Try **Generate shopping list** (checkable, categorised) and find the "Last week in one minute" card.
- The **shopping list is now one list for the household, with real totals**: quantities are summed from the whole week for both of you (shared dinners counted once at your combined portions, solo meals per person, same ingredient merged across recipes — "Eggs · 32"). Do the amounts look like what you'd actually buy? Is the "Pantry staples" section at the bottom useful or noise?
- In **Profile → Basics**, everything is now editable: change your **weight or activity level** and watch the daily target, macro grams and Today's ring rebuild instantly (the formula line under the calorie row shows the math). Note your **date of birth** replaces age — age is computed, so it updates itself on birthdays.
- Still in Profile, step the **Calories** target away from the recommendation — the chip flips to "custom" and a **"↺ Restore recommended"** button appears. Then change your weight while the custom value is active: Mesa keeps your number and just tells you what it now recommends. Does that feel respectful rather than pushy?
- On **Log** (the + tab), try the plan-first flow: **✓ Confirm / 🔁 Swap / ✕ Skip** on a planned meal. Swap opens a sheet with alternatives showing kcal/protein differences — pick one and see the card update.
- On **Insights**, look at the **weekly band** (7 dots) — does "5 of 7 days in your band" feel kinder and more honest than a streak?
- Is anything too small to tap, or any screen too busy / too empty?
- What's missing from the six screens that you'd reach for daily?

---

## Stage 2 — When you build the real app (later)

The mockup is HTML so it's easy to look at. The real app will be **React Native via Expo**, which is the shortest path from here to an app running on your iPhone. Two install routes, easiest first:

### Route 1 — Expo Go (testing, free, no Apple account)
This is how you'll run the real app during development.
1. On your Mac (one-time): install Node, then `npm install -g expo`.
2. In the project folder: `npx expo start` — a QR code appears.
3. On your iPhone, install **Expo Go** from the App Store.
4. Open the **Camera** app, point at the QR code, tap the banner. The app launches inside Expo Go.
5. Andrea scans the same QR on his phone. Both of you are testing instantly.

Expo Go is perfect for the whole design-and-build phase. Limitation: the app only runs while Expo Go is open and it can't use *every* native capability — which is fine until you want Apple Health and a standalone icon.

### Route 2 — TestFlight (a real installed app, needs Apple Developer account)
When you want Mesa to run on its own, untethered, with Apple Health and notifications:
1. Enrol in the **Apple Developer Program** ($99/year).
2. Build with `eas build --platform ios` (Expo's build service).
3. Upload to **App Store Connect**, add yourself and Andrea as TestFlight testers.
4. You both install the **TestFlight** app and get Mesa like a normal download — it stays on the phone, full native access.

You don't need Route 2 to make real progress. Build everything in Expo Go first; only pay for the developer account when you specifically want Apple Health sync or a standalone install.

### Rough order of building (once layout is locked)
1. Scaffold the Expo app, recreate the six screens from the mockup.
2. Wire the deterministic engine — Mifflin-St Jeor targets + nutrition = sum of foods.
3. Seed a small, hand-checked food & recipe database (the meals you two actually eat).
4. Add Apple Health (needs Route 2 / a dev build).
5. Add the AI suggestion endpoint last, behind your own backend so the API key stays secret.

---

## Quick reference

| I want to… | Do this |
|---|---|
| See the design fast | Double-click `mesa-prototype.html` on the Mac |
| Try it on my iPhone | AirDrop the file → open in Safari |
| Make it feel installed | Safari → Share → **Add to Home Screen** |
| Live-preview my edits on phone | Run `python3 -m http.server 8000`, open the Mac's IP on iPhone |
| Run the real app while building | Expo Go + scan QR (free) |
| Install the real app for keeps | TestFlight (Apple Developer, $99/yr) |
