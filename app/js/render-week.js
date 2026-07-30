/* render-week.js — week grid, nutri cards, week summary, swap, regenerate, routines */
/* ---------------- week screen rendering ---------------- */
// weekPlan.weekStartDate is always a Monday (planner.js:mondayOfWeek), so the day index
// maps straight onto Mon..Sun.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Two-week horizon (owner feedback: "I need to see both this and next week's menu to shop
// on the weekend"): which week the Week screen's "This week | Next week" segmented control
// (index.html #weekSeg, reusing the existing .seg style) currently shows. Default is
// CURRENT week on every fresh render of the screen (app.js:go() doesn't reset it on
// re-visit, matching how every other screen's local view state — e.g. quickAdd — persists
// across tab switches within a session).
let weekScreenShowsNext = false;
let weekQualityExpanded = false;

function setWeekScreenMode(mode, el){
  weekScreenShowsNext = (mode === 'next');
  if(el){
    el.parentNode.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
    el.classList.add('on');
  }
  renderWeek();
}

function toggleWeekQualityDrawer(){
  weekQualityExpanded = !weekQualityExpanded;
  renderWeek();
}

// "Mon 20" — weekday abbreviation + day-of-month, used for next week's day rows (task:
// "show weekday names with dates") since "Today"-relative labels like the current week's
// don't make sense a week out. parseISODate (planner.js) is in the same shared global
// scope (classic <script> tags, no modules).
function dayDateLabel(dateISO){
  const d = parseISODate(dateISO);
  return DAY_NAMES[(d.getDay() + 6) % 7] + ' ' + d.getDate();
}

// Paints the 7-day list for the CURRENT person, for whichever week the segmented control
// currently selects (task C2 origin; two-week horizon adds the week parameter): every
// kcal shown is that person's portion-scaled computed value, day totals are real sums
// over the four slots. "Today" only ever highlights on the CURRENT week's row — next
// week has no "today". Each meal row gets an inline 🔁 swap icon (weekStartDate-aware —
// see openWeekSwap below) so a swap works on whichever week is displayed, not just today.
// B4: per-day, per-slot displayed views + macro totals for `person` across a plan's 7
// days, built from displayedSlotViewForDate() — the SAME per-slot view renderWeek()'s rows
// paint from. Computed ONCE here so nutrition is never derived twice for a single render:
// renderWeek() consumes dayViews[i].views[slot] for the row markup and dayViews[i].totals
// for the day's macro line, and passes the whole array into renderWeekNutriCard for the
// week-level averages. Pure/DOM-free (safe to call from tools/check.js). A slot with no
// matching recipe (view.recipe falsy — same guard the row loop already used) contributes
// nothing to that day's totals.
// B4×B5 fix: a slot the person SKIPPED (slotLogStatus === 'skipped', current-week past
// rows only — B5's catch-up log) still returns its planned/frozen macros from
// displayedSlotViewForDate (view.kcal keeps showing that informational number on the row,
// same convention as the Today card), but must NOT count toward the day/week "logged
// overlay" totals — a skipped meal wasn't eaten, matching how recomputeConsumed/Insights
// already zero it via the raw logHistory entries. Without this guard the day macro line
// and week nutrient card silently disagreed with the row's own ∅ state.
// C3 fix: standalone log entries (quick-added foods/beverages, plus a recipe logged with
// "No meal") are NEVER slot views — displayedSlotViewForDate only ever resolves a slot's
// kind:'plan' entry or the planned recipe — so computeInsights/recomputeConsumed (which
// iterate the whole day log, kind-agnostic) already counted them while this function
// didn't. Folded in here, once,
// so both renderWeek's day-header kcal and its macro line (which both read THIS totals
// object — see renderWeek below) can never disagree. Only for days that already have a
// real log, i.e. day.date <= todayISO(): a next-week plan's days (and any future date
// within the current week) always sort after today, so this single date check is enough
// to skip them — no separate "is this the current week's plan" flag needed, and no
// logHistory entries exist for future dates regardless.
function weekDayNutriViews(plan, person){
  return plan.days.map(function(day){
    const views = {};
    const totals = {kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugars: 0, freeSugars: 0};
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      const entry = m[person];
      const view = displayedSlotViewForDate(day.date, person, slot, planEntryView(entry, m.shared));
      views[slot] = view;
      if(!view.recipe) return;
      if(slotLogStatus(day.date, person, slot) === 'skipped') return;
      totals.kcal += view.kcal; totals.protein += view.protein; totals.carbs += view.carbs;
      totals.fat += view.fat; totals.fiber += view.fiber; totals.sugars += view.sugars; totals.freeSugars += view.freeSugars;
    });
    const standaloneEntries = [];
    if(day.date <= todayISO()){
      const dayLog = getDayLog(day.date);
      const entries = (dayLog && dayLog[person]) || [];
      entries.forEach(function(e){
        // Food entries are always unassigned. Recipe entries are unassigned only when
        // their slot is empty (the Log picker's "No meal" route); slot-bound plan entries
        // already have a meal row above and must not be counted twice.
        if(!e || (e.kind !== 'food' && !(e.kind === 'plan' && !e.slot))) return;
        const nut = logEntryNutrition(e);
        totals.kcal += nut.kcal; totals.protein += nut.protein; totals.carbs += nut.carbs;
        totals.fat += nut.fat; totals.fiber += nut.fiber; totals.sugars += nut.sugars; totals.freeSugars += nut.freeSugars;
        const title = e.kind === 'food'
          ? ((FOODS[e.ref] && FOODS[e.ref].name) || 'Ingredient')
          : recipeDisplayTitle(e.ref, e.opts);
        standaloneEntries.push({title: title, kcal: nut.kcal, freeSugars: nut.freeSugars});
      });
    }
    return {views: views, totals: totals, quickAddCount: standaloneEntries.length, standaloneEntries: standaloneEntries};
  });
}

function weekStandaloneLogLine(entries, dateISO){
  if(!entries || !entries.length) return '';
  const shown = entries.slice(0, 3).map(function(entry){ return escapeHtml(entry.title); });
  if(entries.length > shown.length) shown.push('+' + (entries.length - shown.length) + ' more');
  const kcal = entries.reduce(function(sum, entry){ return sum + (entry.kcal || 0); }, 0);
  const freeSugars = entries.reduce(function(sum, entry){ return sum + (entry.freeSugars || 0); }, 0);
  return '<div class="sub week-standalone-log" style="margin:6px 0 0">Additional: ' + shown.join(' · ')
    + ' · +' + Math.round(kcal) + ' kcal'
    + (freeSugars > 0 ? ' · ' + Math.round(freeSugars) + 'g free sugars' : '')
    + ' <button class="week-standalone-link" data-act="standalone-log" data-date="' + htmlAttr(dateISO || '') + '">View / edit</button></div>';
}

// B4: pure week-level summary consumed by renderWeekNutriCard — per-day averages (kcal/P/
// C/F), fiber and free-sugars averages against their existing single-sourced targets, and
// the coverageGaps() object for the two headline household chips (omega-3, sat fat),
// evaluated against the DISPLAYED week's plan (current or next). dayViews defaults to a
// fresh weekDayNutriViews() call but renderWeek passes in the one it already built so nutri
// totals are computed once per paint. Pure/DOM-free (safe to call from tools/check.js).
function weekNutriSummary(plan, person, dayViews){
  dayViews = dayViews || weekDayNutriViews(plan, person);
  const days = dayViews.length || 7;
  const sum = function(key){ return dayViews.reduce(function(s, d){ return s + d.totals[key]; }, 0); };
  const avgKcal = sum('kcal') / days;
  const avgProtein = sum('protein') / days;
  const avgCarbs = sum('carbs') / days;
  const avgFat = sum('fat') / days;
  const avgFiber = sum('fiber') / days;
  const avgFreeSugars = sum('freeSugars') / days;

  const fiberTarget = WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay; // single-sourced, never re-typed 25
  const cov = computeWeeklyCoverage(plan);
  const gaps = coverageGaps(cov);
  const sugarTargetPct = gaps.freeSugars.target; // single-sourced, never re-typed 6
  const calGoal = (PROF[person] && PROF[person].calGoalNum) || 0;
  // Same grams conversion coverageTargetText already applies for this person's calorie goal
  // — kept in sync by construction since both read gaps.freeSugars.target, never a literal.
  const sugarTargetG = calGoal > 0 ? Math.round((sugarTargetPct / 100) * calGoal / 4) : 0;

  return {
    avgKcal: avgKcal, avgProtein: avgProtein, avgCarbs: avgCarbs, avgFat: avgFat,
    avgFiber: avgFiber, avgFreeSugars: avgFreeSugars,
    fiberTarget: fiberTarget, sugarTargetG: sugarTargetG, gaps: gaps
  };
}

function renderWeek(){
  const mondayISO = weekScreenShowsNext ? nextMondayISO() : mondayOfWeek(todayISO());
  const plan = ensureWeekPlan(mondayISO);
  const todayIdx = weekScreenShowsNext ? -1 : todayDayIndex();
  const person = currentProf;
  const el = document.getElementById('weekList');
  // B4: every row's view, computed exactly once, reused for the day macro lines AND the
  // week card below (see weekDayNutriViews's header comment).
  const dayViews = weekDayNutriViews(plan, person);
  // B5 (catch-up logging): on the CURRENT week only, rows for dates up to and including
  // today swap the pin/routine buttons for a single log-state button (data-act="log") so
  // rows never exceed their existing button budget (decision Q3). Next week and future
  // dates of this week are untouched — pins/routines on the past are meaningless anyway
  // (re-balance already ignores them), so nothing of value is hidden.
  el.innerHTML = plan.days.map(function(day, di){
    const totals = dayViews[di].totals;
    const titles = [];
    const logEligible = !weekScreenShowsNext && day.date <= todayISO();
    const rows = SLOT_ORDER.map(function(slot){
      const m = day.meals[slot];
      const view = dayViews[di].views[slot];
      const r = view.recipe;
      if(!r){
        // Empty-pool guard (task 5): a genuinely-starved slot (view.reason ===
        // 'no-candidates', from planner.js:pickSharedMeal/pickSoloMeal finding zero legal
        // candidates) gets a visible row instead of silently vanishing — the same
        // "blank row" this branch already produces for every OTHER unresolved-recipe
        // case (a dangling/deleted reference, or a solo household's unused partner cell)
        // stays exactly as before; those aren't this batch's concern.
        if(view.reason === 'no-candidates'){
          return '<div class="day-meal-row" data-di="'+di+'" data-slot="'+htmlAttr(slot)+'" data-recipe-id="">'
            + '<div class="dm-e">⚠️</div>'
            + '<div class="dm-t">No meal fits your filters<small>'+SLOT_LABEL[slot]+' · adjust Diet in Profile</small></div>'
            + '<div class="dm-k">0</div></div>';
        }
        return '';
      }
      titles.push(escapeHtml(mealTitleWithExtras(view)));
      const together = view.shared ? ' <span class="pill together mini">👥 Together</span>' : '';
      // WEEK-EATENOUT-plan.md: a "🍴 out" pill, same chip-computed styling the daily
      // "Today so far"/"Today records" eaten-out pill uses (renderTodayEntries above),
      // when this row's slot is logged eaten-out for the viewer — the meal's absence from
      // the shopping list is otherwise invisible on this row.
      const eatenOutPill = slotLoggedEatenOut(day.date, person, slot) ? ' <span class="chip-computed">🍴 out</span>' : '';
      // Recipe ids can be user-authored ('cr-<slug>'), so every per-row argument rides in
      // data-* attributes (htmlAttr-escaped once, never re-parsed as JS) and clicks are
      // resolved by the delegated #weekList handler below instead of inline onclick JS.
      // The buttons' old event.stopPropagation() is replaced by handler ordering: the
      // delegated handler checks buttons before the row, and the row before the day.
      const swapBtn = '<button class="dm-swap" data-act="swap" aria-label="Swap this meal">🔁</button>';
      // B3: sides/extras button on EVERY row (This week and Next week alike) — opens
      // openAddMealSheetForContext via the delegated handler below, same sheet the Today
      // card ✎/＋ and recipe-screen "Manage" strip already use. Icon/label follow the same
      // hasExtras convention as that entry point (renderTodayCardActions's add/edit glyph).
      const hasExtras = !!(view.extras && view.extras.length);
      const extrasAria = (hasExtras ? 'Edit ' : 'Add to ') + (SLOT_LABEL[slot] || slot);
      const extrasBtn = '<button class="dm-extras" data-act="extras" aria-label="'+extrasAria+'">'+(hasExtras ? '✎' : '＋')+'</button>';
      let actionBtns;
      if(logEligible){
        const status = slotLogStatus(day.date, person, slot);
        const icon = status === 'confirmed' ? '✓' : (status === 'skipped' ? '∅' : '◯');
        const label = SLOT_LABEL[slot] || slot;
        const aria = (status === 'confirmed' ? 'Logged ' : (status === 'skipped' ? 'Skipped ' : 'Log ')) + label.toLowerCase();
        const logBtn = '<button class="dm-log'+(status ? ' on' : '')+'" data-act="log" aria-label="'+aria+'">'+icon+'</button>';
        actionBtns = logBtn + extrasBtn + swapBtn;
      } else {
        const pinPerson = mealPinPersonForMeal(m, person);
        const pinned = isMealPinned(plan.weekStartDate, di, slot, pinPerson);
        const pinBtn = '<button class="dm-pin'+(pinned ? ' on' : '')+'" data-act="pin" data-pin-person="'+htmlAttr(pinPerson)+'" aria-label="'+(pinned ? 'Unpin this meal' : 'Pin this meal')+'">'+(pinned ? '📌' : '📍')+'</button>';
        const routineBtn = '<button class="dm-rule" data-act="routine" aria-label="Set meal routine">↻</button>';
        actionBtns = pinBtn + routineBtn + extrasBtn + swapBtn;
      }
      return '<div class="day-meal-row" data-di="'+di+'" data-slot="'+htmlAttr(slot)+'" data-recipe-id="'+htmlAttr(view.recipeId)+'">'
        + '<div class="dm-e">'+r.emoji+'</div>'
        + '<div class="dm-t">'+escapeHtml(mealTitleWithExtras(view))+'<small>'+SLOT_LABEL[slot]+together+eatenOutPill+'</small></div>'
        + '<div class="dm-k">'+Math.round(view.kcal)+'</div>'
        + actionBtns + '</div>';
    }).join('');
    // B4 day-level macro line: current-profile totals for the day (dayViews[di].totals —
    // already computed above, not re-derived), matching Insights' sugar-tracking convention
    // (FREE sugars is the headline metric there — planner.js coverageGaps' 'freeSugars'
    // entry, label "Free sugars" — so it's labeled the same way here rather than showing
    // total sugars, which would be a second, disagreeing figure).
    // Standalone entries need one compact line: their nutrition is included above but
    // otherwise has no corresponding meal row to explain a calorie/sugar increase.
    const standaloneLine = weekStandaloneLogLine(dayViews[di].standaloneEntries, day.date);
    const dayMacroLine = '<div class="sub day-macros" style="margin:0">P '+Math.round(totals.protein)+'g · C '+Math.round(totals.carbs)
      +'g · F '+Math.round(totals.fat)+'g · fiber '+Math.round(totals.fiber)+'g · free sugars '+Math.round(totals.freeSugars)+'g</div>';
    const label = weekScreenShowsNext ? dayDateLabel(day.date) : (DAY_NAMES[di] + (di === todayIdx ? ' · Today' : ''));
    return '<div class="day'+(di === todayIdx ? ' today' : '')+'" id="wd'+di+'" data-di="'+di+'">'
      + '<div class="dh"><span class="dn">'+label+'</span><span class="dk">~'+fmtKcal(Math.round(totals.kcal))+' kcal <span class="chev">⌄</span></span></div>'
      + '<div class="dmeals">'+titles.join(' · ')+'</div>'
      + '<div class="day-meals">'+dayMacroLine+standaloneLine+rows+'</div></div>';
  }).join('');
  // Delegated click handler for the whole week list (see the data-* note above): most
  // specific target first — action button, then meal row (open recipe), then day header
  // (expand/collapse) — which reproduces the old inline stopPropagation() behavior.
  // Reassigned (not addEventListener) on every renderWeek so the closure always captures
  // the currently displayed week's weekStartDate and person.
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(btn && el.contains(btn)){
      const act = btn.getAttribute('data-act');
      if(act === 'standalone-log'){
        openWeekStandaloneLogSheet(btn.getAttribute('data-date'), person);
        return;
      }
      const mrow = btn.closest('.day-meal-row');
      if(!mrow) return;
      const di2 = +mrow.getAttribute('data-di');
      const slot2 = mrow.getAttribute('data-slot');
      if(act === 'pin') toggleMealPin(plan.weekStartDate, di2, slot2, btn.getAttribute('data-pin-person'));
      else if(act === 'routine') openMealRoutineSheet(plan.weekStartDate, di2, slot2, person, mrow.getAttribute('data-recipe-id'));
      else if(act === 'swap') openWeekSwap(plan.weekStartDate, di2, slot2, person);
      else if(act === 'log') openWeekLogSheet(plan.weekStartDate, di2, slot2, person);
      else if(act === 'extras') openWeekAddMealSheet(plan.weekStartDate, di2, slot2, person);
      return;
    }
    const mealRow = e.target.closest('.day-meal-row');
    if(mealRow && el.contains(mealRow)){
      openRecipe(mealRow.getAttribute('data-recipe-id'), 'week', {weekStartDate: plan.weekStartDate, dayIndex: +mealRow.getAttribute('data-di'), slot: mealRow.getAttribute('data-slot'), person: person});
      // No return: the old inline markup let a meal-row click bubble to the day's
      // toggleDay too (only the action buttons stopped propagation) — keep that.
    }
    const day = e.target.closest('.day[data-di]');
    if(day && el.contains(day)) toggleDay(+day.getAttribute('data-di'));
  };
  renderWeekQuality(plan, person, dayViews);
  renderWeekNutriCard(plan, person, dayViews);

  // Nutrient coverage chips always reflect the CURRENT week regardless of which week is
  // toggled on-screen (renderNutrientChips reads the `weekPlan` compat getter, which only
  // ever mirrors the current week — planner.js:ensureWeekPlan) — no change needed there.
  renderNutrientChips();
  updateWeekActionsForMode();
}

// B4: paints weekNutriSummary(plan, person, dayViews) into #weekNutriCard inside the
// collapsible Week quality drawer. It uses the same computed averages and coverage chips
// as before, but no longer sits as a large card before the plan.
function renderWeekNutriCard(plan, person, dayViews){
  const wrap = document.getElementById('weekNutriCard');
  if(!wrap) return;
  const s = weekNutriSummary(plan, person, dayViews);

  const macroLine = 'Avg/day — ' + fmtKcal(Math.round(s.avgKcal)) + ' kcal · P ' + Math.round(s.avgProtein) + 'g · C ' + Math.round(s.avgCarbs)
    + 'g · F ' + Math.round(s.avgFat) + 'g';

  // Fiber: single-sourced against WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay (never re-typed
  // 25 here) — reuses coverageChipHtml's exact chip markup via a coverageGaps-shaped
  // object built from OUR OWN per-day average (not the household worst-of-two Insights
  // tracks), since fiber here is a per-profile, logged-overlay-aware figure.
  const fiberGap = {
    key: 'fiber', label: 'Fiber', value: Math.round(s.avgFiber), target: s.fiberTarget, unit: 'g/day',
    gap: Math.max(0, (s.fiberTarget - s.avgFiber) / s.fiberTarget),
    pct: Math.min(100, Math.round(s.avgFiber / s.fiberTarget * 100))
  };

  // Free sugars: same headline metric/label Insights already uses (planner.js coverageGaps
  // 'freeSugars' — never total sugars), against the SAME 6%-of-kcal target (gaps.freeSugars
  // .target, never re-typed as a literal 6, via weekNutriSummary's sugarTargetG) — the
  // cap-note reuses coverageTargetText(gaps.freeSugars) verbatim so the target text never
  // disagrees with Insights' own.
  const sugarOver = s.sugarTargetG > 0 && s.avgFreeSugars > s.sugarTargetG;
  const sugarPct = s.sugarTargetG > 0 ? Math.min(100, Math.round(s.avgFreeSugars / s.sugarTargetG * 100)) : 0;
  const sugarChip = '<div class="n'+(sugarOver ? ' low' : '')+'"><div class="nt"><span>Free sugars</span><b>'+Math.round(s.avgFreeSugars)+' g/day</b></div>'
    + '<div class="nbar"><i style="width:'+sugarPct+'%"></i></div>'
    + '<div class="cap-note">Target ' + coverageTargetText(s.gaps.freeSugars) + ' — staying below is good</div></div>';

  // Two headline household coverage chips, evaluated against the DISPLAYED week's plan
  // (This or Next) via the exact same computeWeeklyCoverage/coverageGaps/coverageChipHtml
  // Insights uses — never re-derived.
  const covChips = ['satFat'].map(function(k){ return coverageChipHtml(s.gaps[k]); }).join('');

  wrap.innerHTML = '<div class="sub" style="margin:0 0 10px">' + macroLine + '</div>'
    + '<div class="nutri">' + coverageChipHtml(fiberGap) + sugarChip + covChips + '</div>';
}

// Paints a plain-language balance check into the Planner drawer. The visible signals make
// clear that this is about the proposed week's variety and nutrition targets — not a grade
// for how someone has eaten. The expanded metrics live below it in #weekNutriCard.
function renderWeekQuality(plan, person, dayViews){
  const row = document.getElementById('weekQuality');
  const toggle = document.getElementById('weekQualityToggle');
  const panel = document.getElementById('weekQualityPanel');
  const summaryEl = document.getElementById('weekSummaryLine');
  const signalsEl = document.getElementById('weekQualitySignals');
  const s = summarizeWeekPlan(plan, person);
  const proteinOnTarget = s.targetProtein > 0 && s.avgProteinPerDay >= s.targetProtein;
  if(summaryEl) summaryEl.textContent = s.uniqueRecipeCount + ' dishes planned · ' + s.metricText;
  if(signalsEl){
    signalsEl.innerHTML = '<span class="week-quality-signal signal-variety"><b>Variety</b><em>' + s.uniqueRecipeCount + ' dishes</em></span>'
      + '<span class="week-quality-signal signal-protein"><b>Protein</b><em>' + (proteinOnTarget ? 'On target' : Math.round(s.avgProteinPerDay) + 'g/day') + '</em></span>'
      + '<span class="week-quality-signal signal-fiber"><b>Fiber</b><em>' + Math.round(s.avgFiberPerDay) + 'g/day</em></span>';
  }
  if(row) row.classList.toggle('open', weekQualityExpanded);
  if(toggle) toggle.setAttribute('aria-expanded', weekQualityExpanded ? 'true' : 'false');
  if(panel) panel.hidden = !weekQualityExpanded;
}

function updateWeekActionsForMode(){
  const btn = document.getElementById('rebalanceBtn');
  const regenBtn = document.getElementById('regenerateBtn');
  const note = document.getElementById('rebalanceCapNote');
  if(btn){
    btn.textContent = 'Re-balance';
    btn.setAttribute('aria-label', weekScreenShowsNext ? 'Re-balance next week' : 'Re-balance this week');
  }
  if(regenBtn) regenBtn.setAttribute('aria-label', weekScreenShowsNext ? 'Regenerate next week, keeping pinned and logged meals' : 'Regenerate this week, keeping pinned and logged meals');
  if(note) note.style.display = 'none';
}

// Opens the swap sheet for one meal on a SPECIFIC week (current or next) — the Week
// screen's inline 🔁 per meal row. Unlike openSwap() (Today/Log/recipe-screen entry
// points, which always target today's plan via resolveSwapContext), this carries an
// explicit weekStartDate through swapCtx so chooseSwap (planner.js) applies the swap to
// the right week's plan, and — for next week — skips the "correct today's log entry" step
// entirely (there's nothing logged for a future date).
/* ---------------- Regenerate week (keep pinned + logged) ----------------
   A one-tap rebuild of the shown week from the CURRENT catalog/rules, so a catalog change
   (new slot rules, the lunch/dinner nudge, a removed recipe) can be pulled into an existing
   plan — which normally only regenerates on a profile/target change. Pinned meals and
   anything already logged/skipped are kept; every other slot is rebuilt. Confirmed first,
   since it replaces any un-pinned manual swaps on the shown week. */
function openRegenerateSheet(){
  document.getElementById('sheetBody').innerHTML = buildRegenerateSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function buildRegenerateSheet(){
  const label = weekScreenShowsNext ? 'next week' : 'this week';
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Regenerate ' + label + '?</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub" style="margin-top:10px">Rebuilds ' + label + '’s plan ' + (isSoloHousehold() ? 'for you' : 'for both of you') + ' using the latest recipes and rules. '
    + '<b>Pinned meals and anything you’ve already logged or skipped stay exactly as they are</b> — only the other meals are replaced. Any un-pinned manual swaps on ' + label + ' will be redone.</p>'
    + '<button class="cta" onclick="confirmRegenerateWeek()">↻ Regenerate ' + label + '</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

function confirmRegenerateWeek(){
  const showingNext = weekScreenShowsNext;
  const monday = showingNext ? nextMondayISO() : mondayOfWeek(todayISO());
  regenerateWeekPreservingLocks(monday);
  if(monday === mondayOfWeek(todayISO())) weekPlan = weekPlans[monday];
  // Regenerating the current week invalidates a stored next week (its cross-week variety
  // input just changed), so rebuild it too, same pairing ensureWeekPlan uses.
  if(!showingNext){
    const nm = nextMondayISO();
    if(weekPlans[nm]) regenerateWeekPreservingLocks(nm);
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogScreen();
  renderWeek();
  persist();
  closeSheet();
  toast('↻ Regenerated ' + (showingNext ? 'next week' : 'this week') + ' — pinned & logged meals kept');
}

// 'tall' (not 'remove'): the sheet now has a "Best matches" + "All <slot> options" section
// (FEATURE: swap anything) which can be long — same tall/scrollable treatment as the
// shopping list and library sheets.
function openSwapSheetForContext(ctx, targetElId){
  swapCtx = {dayIndex: ctx.dayIndex, slot: ctx.slot, person: ctx.person, weekStartDate: ctx.weekStartDate, targetElId: targetElId || null};
  document.getElementById('sheetBody').innerHTML = buildSwapSheet(ctx);
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  if(typeof attachSwapSearchHandler === 'function') attachSwapSearchHandler();
}

function openWeekSwap(weekStartDate, dayIndex, slot, person){
  openSwapSheetForContext({dayIndex: dayIndex, slot: slot, person: person, weekStartDate: weekStartDate}, null);
}

function toggleMealPin(weekStartDate, dayIndex, slot, person){
  const key = mealPinKey(weekStartDate, dayIndex, slot, person);
  if(mealPins[key]){
    const rule = routineRuleForPinnedOccurrence(weekStartDate, dayIndex, slot, person);
    if(rule){ openRoutineUnpinSheet(weekStartDate, dayIndex, slot, person, rule); return; }
    delete mealPins[key]; toast('Meal unpinned');
  }
  else { mealPins[key] = true; toast('Pinned — re-balance will leave it alone'); }
  renderWeek();
  persist();
}

let routineUnpinCtx = null;

function routineRuleForPinnedOccurrence(weekStartDate, dayIndex, slot, person){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days && plan.days[dayIndex];
  const meal = day && day.meals && day.meals[slot];
  if(!day || !meal) return null;
  const rulePerson = mealPinPersonForMeal(meal, person);
  const recipeId = meal.shared ? meal.recipeId : (meal[rulePerson] && meal[rulePerson].recipeId);
  for(let i = mealRules.length - 1; i >= 0; i--){
    const rule = mealRules[i];
    if(!rule || !rule.pinFromDate || day.date < rule.pinFromDate) continue;
    if(rule.recipeId !== recipeId) continue;
    if(mealRuleApplies(rule, day.date, dayIndex, slot, rulePerson)) return rule;
  }
  return null;
}

function openRoutineUnpinSheet(weekStartDate, dayIndex, slot, person, rule){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days[dayIndex];
  routineUnpinCtx = {weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: person, rule: rule, dateISO: day.date};
  const meal = day.meals[slot];
  const entry = meal.shared ? meal.elena : meal[person];
  const view = planEntryView(entry, meal.shared);
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Unpin routine meal?</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub"><b>' + escapeHtml(mealTitleWithExtras(view)) + '</b> is part of a pinned routine. Choose whether to unlock only this meal or the following meals in this routine too.</p>'
    + '<button class="cta" onclick="unpinOnlyThisMeal()">Unpin only this meal</button>'
    + '<button class="cta ghostbtn" onclick="unpinThisAndFollowingRoutineMeals()">Unpin this and following routine meals</button>';
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function unpinOnlyThisMeal(){
  if(!routineUnpinCtx) return;
  const ctx = routineUnpinCtx;
  delete mealPins[mealPinKey(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person)];
  routineUnpinCtx = null;
  closeSheet();
  renderWeek();
  persist();
  toast('Meal unpinned');
}

function unpinThisAndFollowingRoutineMeals(){
  if(!routineUnpinCtx) return;
  const ctx = routineUnpinCtx;
  if(typeof unpinRoutineOccurrencesFrom === 'function') unpinRoutineOccurrencesFrom(ctx.rule, ctx.dateISO);
  else delete mealPins[mealPinKey(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person)];
  routineUnpinCtx = null;
  closeSheet();
  renderWeek();
  persist();
  toast('Routine meals unpinned');
}

function routineLabel(rule){
  if(!rule) return 'No routine';
  if(rule.cadence === 'daily') return 'Every day';
  if(rule.cadence === 'alternate') return 'Every other day';
  if(rule.cadence === 'weekly') return 'Every ' + DAY_NAMES[rule.dayIndex];
  return 'Routine';
}

function findMealRule(slot, person){
  for(let i = mealRules.length - 1; i >= 0; i--){
    const r = mealRules[i];
    if(r.slot === slot && r.person === person) return r;
  }
  return null;
}

let routineCtx = null;

function openMealRoutineSheet(weekStartDate, dayIndex, slot, person, recipeId){
  const plan = ensureWeekPlan(weekStartDate);
  const meal = plan.days[dayIndex].meals[slot];
  const rulePerson = meal.shared ? 'shared' : person;
  routineCtx = {weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: rulePerson, recipeId: recipeId};
  const r = RECIPES_DB[recipeId];
  const existing = findMealRule(slot, rulePerson);
  const weeklyLabel = 'Every ' + DAY_NAMES[dayIndex];
  const pinChecked = existing && existing.pinFromDate ? ' checked' : '';
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Meal routine</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Use <b>' + (r ? escapeHtml(r.title) : 'this meal') + '</b> as a default for ' + SLOT_LABEL[slot].toLowerCase() + '. A routine is a preference; pinned routine meals are locked against re-balance.</p>'
    + '<div class="card" style="padding:14px;margin-top:12px"><div class="row between"><b>Current</b><span class="pill ghost">' + routineLabel(existing) + '</span></div></div>'
    + '<label class="card" style="padding:14px;margin-top:12px;display:flex;gap:12px;align-items:flex-start;cursor:pointer"><input id="routinePinRepeats" type="checkbox"' + pinChecked + ' style="margin-top:3px;min-width:18px;min-height:18px"><span><b>Pin repeated meals too</b><small style="display:block;color:var(--muted);margin-top:4px">Matching routine meals from this date onward stay unchanged unless you unpin them.</small></span></label>'
    + '<button class="cta ghostbtn" onclick="setMealRoutine(\'daily\')">Every day</button>'
    + '<button class="cta ghostbtn" onclick="setMealRoutine(\'alternate\')">Every other day</button>'
    + '<button class="cta ghostbtn" onclick="setMealRoutine(\'weekly\')">' + weeklyLabel + '</button>'
    + '<button class="cta ghostbtn" onclick="clearMealRoutine()">Clear this routine</button>';
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function replaceMealRule(rule){
  mealRules = mealRules.filter(function(r){ return !(r.slot === rule.slot && r.person === rule.person); });
  mealRules.push(rule);
}

function refreshAfterMealRules(){
  applyMealRulesToStoredPlans();
  refreshAfterMealRuleStateChange();
}

function refreshAfterMealRuleStateChange(){
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogScreen();
  renderWeek();
  persist();
}

function setMealRoutine(cadence){
  if(!routineCtx) return;
  const pinRepeats = !!(document.getElementById('routinePinRepeats') && document.getElementById('routinePinRepeats').checked);
  const rule = {
    recipeId: routineCtx.recipeId,
    slot: routineCtx.slot,
    cadence: cadence,
    person: routineCtx.person,
    anchorDate: addDaysISO(routineCtx.weekStartDate, routineCtx.dayIndex),
    dayIndex: routineCtx.dayIndex
  };
  if(pinRepeats) rule.pinFromDate = rule.anchorDate;
  replaceMealRule(rule);
  applyMealRulesToStoredPlans();
  if(pinRepeats && typeof pinRoutineOccurrencesFrom === 'function') pinRoutineOccurrencesFrom(rule, rule.pinFromDate);
  closeSheet();
  refreshAfterMealRuleStateChange();
  toast(pinRepeats ? 'Routine saved and pinned' : 'Routine saved');
}

function clearMealRoutine(){
  if(!routineCtx) return;
  mealRules = mealRules.filter(function(r){ return !(r.slot === routineCtx.slot && r.person === routineCtx.person); });
  closeSheet();
  refreshAfterMealRules();
  toast('Routine cleared');
}

/* ---------------- B5: catch-up logging from the Week view (current week only) ----------------
   The ◯/✓/∅ button (see renderWeek's logEligible branch) opens this mini sheet for one
   (dateISO, slot, currentProf) — same log-history funnel as Log/Today (logPlanEntry,
   markSlotSkipped, removeLoggedSlot), just reachable for any past day of the CURRENT week
   instead of only Today/Yesterday. Confirm/Skip both remain offered regardless of the
   current status (so a skip can be corrected to a confirm and vice versa — upsertLogEntry/
   markSlotSkipped already clear the other state's tombstone, see log.js); Undo only when
   something is actually logged. Static onclicks with constant (zero-arg) calls are fine
   here, same as openMealRoutineSheet's setMealRoutine('daily') pattern — weekLogCtx carries
   the real arguments, and the only user string on the sheet (the meal title) is escaped. */
let weekLogCtx = null;
let weekStandaloneLogCtx = null;

function weekStandaloneEntriesForDate(dateISO, person){
  const day = getDayLog(dateISO);
  return ((day && day[person]) || []).map(function(entry, index){ return {entry: entry, index: index}; }).filter(function(row){
    const entry = row.entry;
    return entry && (entry.kind === 'food' || (entry.kind === 'plan' && !entry.slot));
  });
}

function openWeekStandaloneLogSheet(dateISO, person){
  weekStandaloneLogCtx = {dateISO: dateISO, person: person};
  renderWeekStandaloneLogSheet();
}

function renderWeekStandaloneLogSheet(){
  const ctx = weekStandaloneLogCtx;
  if(!ctx) return;
  const rows = weekStandaloneEntriesForDate(ctx.dateISO, ctx.person);
  const html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Additional items</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">' + escapeHtml(dayDateLabel(ctx.dateISO)) + ' · these are logged outside a planned meal.</p>'
    + (rows.length ? rows.map(function(row){
      const entry = row.entry;
      const nut = logEntryNutrition(entry);
      const isFood = entry.kind === 'food';
      const food = isFood && FOODS[entry.ref];
      const recipe = !isFood && RECIPES_DB[entry.ref];
      const title = isFood ? (food ? food.name : 'Ingredient') : logEntryTitleWithComponents(entry);
      const amount = isFood ? foodAmountLabel(food, entry.grams) : ((entry.portion || 1) + ' serving');
      const icon = isFood ? '🥄' : (recipe ? recipe.emoji : '🍽️');
      const edit = isFood ? '<button class="li-x" aria-label="Edit ' + htmlAttr(title) + '" onclick="openEditWeekStandaloneFood(' + row.index + ')">✎</button>' : '';
      return '<div class="logitem"><div class="li-i">' + icon + '</div><div class="li-t">' + escapeHtml(title)
        + '<small>' + escapeHtml(amount) + ' · ' + escapeHtml(macroSummaryFromTotals(nut)) + '</small></div><div class="li-k">' + Math.round(nut.kcal) + '</div>'
        + edit + '<button class="li-x" aria-label="Remove ' + htmlAttr(title) + '" onclick="removeWeekStandaloneEntry(' + row.index + ')">✕</button></div>';
    }).join('') : '<p class="sub">No additional items are logged for this day.</p>');
  document.getElementById('sheetBody').innerHTML = html;
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function openEditWeekStandaloneFood(index){
  const ctx = weekStandaloneLogCtx;
  const entry = ctx && getDayLog(ctx.dateISO)[ctx.person][index];
  if(!entry || entry.kind !== 'food') return;
  editTodayFoodCtx = {indices: [index], ref: entry.ref, grams: Math.max(1, Math.round(entry.grams || 0)), eatenOut: !!entry.eatenOut, dateISO: ctx.dateISO, person: ctx.person};
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
}

function removeWeekStandaloneEntry(index){
  const ctx = weekStandaloneLogCtx;
  if(!ctx || !removeLogEntryAt(ctx.dateISO, ctx.person, index)) return;
  refreshAfterLogChange();
  renderWeekStandaloneLogSheet();
  toast('✕ Removed item');
}

function weekLogStatusLabel(status){
  if(status === 'confirmed') return '✓ Logged';
  if(status === 'skipped') return '∅ Skipped';
  return '◯ Not logged yet';
}

function openWeekLogSheet(weekStartDate, dayIndex, slot, person){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days[dayIndex];
  const dateISO = day.date;
  const meal = day.meals[slot];
  const entry = meal[person];
  weekLogCtx = {weekStartDate: plan.weekStartDate, dayIndex: dayIndex, slot: slot, person: person, dateISO: dateISO};
  const view = displayedSlotViewForDate(dateISO, person, slot, planEntryView(entry, meal.shared));
  const status = slotLogStatus(dateISO, person, slot);
  const titleText = (view.recipe ? mealTitleWithExtras(view) : (SLOT_LABEL[slot] || slot)) + ' · ' + dayDateLabel(dateISO);
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + escapeHtml(titleText) + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Log what actually happened for ' + SLOT_LABEL[slot].toLowerCase() + ' on this day.</p>'
    + '<div class="card" style="padding:14px;margin-top:12px"><div class="row between"><b>Current</b><span class="pill ghost">' + weekLogStatusLabel(status) + '</span></div></div>'
    + '<button class="cta" onclick="weekLogConfirm(this)">✓ Eaten as planned</button>'
    + '<button class="cta ghostbtn" onclick="weekLogSkip(this)">∅ Skipped</button>'
    + (status ? '<button class="cta ghostbtn" onclick="weekLogUndo()">↺ Undo</button>' : '');
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function weekLogConfirm(anchorEl){
  if(!weekLogCtx) return;
  const ctx = weekLogCtx;
  const anchorRect = typeof captureRewardAnchor === 'function' ? captureRewardAnchor(anchorEl) : null;
  const accountedBefore = ctx.dateISO === todayISO() && typeof accountedSlotCount === 'function'
    ? accountedSlotCount(ctx.dateISO, ctx.person) : null;
  const plan = ensureWeekPlan(ctx.weekStartDate);
  const entry = plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot][ctx.person];
  if(!entry || !entry.recipeId){ closeSheet(); return; }
  // Confirm logs the meal AS PLANNED, extras included (planEntryComponents mirrors
  // logConfirm's own v.components derivation) — only ctx.person's log is written, exactly
  // like logConfirm's shared-meal semantics (the other person logs their own row separately).
  const components = planEntryComponents(entry);
  // Backdated days carry `t: null` (unknown eating time — the migrateV1TodayLog precedent);
  // logging TODAY through this same sheet keeps the normal HH:MM stamp.
  const opts = ctx.dateISO === todayISO() ? undefined : {tNull: true};
  logPlanEntry(ctx.dateISO, ctx.person, ctx.slot, entry.recipeId, entry.portion, components, opts);
  closeSheet();
  refreshAfterLogChange(); // task C1: now renders Week itself — see that function's doc comment
  const logged = loggedPlanEntryForSlot(ctx.dateISO, ctx.person, ctx.slot);
  triggerMealLogReward({
    anchorEl: anchorEl,
    anchorRect: anchorRect,
    title: logEntryTitleWithComponents(logged) || SLOT_LABEL[ctx.slot] || 'Meal',
    kcal: Math.round(logEntryNutrition(logged).kcal || 0),
    dateISO: ctx.dateISO,
    person: ctx.person,
    type: 'meal'
  }, accountedBefore);
}

function weekLogSkip(anchorEl){
  if(!weekLogCtx) return;
  const ctx = weekLogCtx;
  const anchorRect = typeof captureRewardAnchor === 'function' ? captureRewardAnchor(anchorEl) : null;
  const accountedBefore = ctx.dateISO === todayISO() && typeof accountedSlotCount === 'function'
    ? accountedSlotCount(ctx.dateISO, ctx.person) : null;
  markSlotSkipped(ctx.dateISO, ctx.person, ctx.slot);
  closeSheet();
  refreshAfterLogChange(); // task C1: now renders Week itself — see that function's doc comment
  triggerMealLogReward({
    anchorEl: anchorEl,
    anchorRect: anchorRect,
    title: SLOT_LABEL[ctx.slot] || 'Meal',
    kcal: 0,
    dateISO: ctx.dateISO,
    person: ctx.person,
    type: 'meal'
  }, accountedBefore, true);
}

function weekLogUndo(){
  if(!weekLogCtx) return;
  const ctx = weekLogCtx;
  const status = slotLogStatus(ctx.dateISO, ctx.person, ctx.slot);
  if(!status){ closeSheet(); return; }
  removeLoggedSlot(ctx.dateISO, ctx.person, ctx.slot);
  closeSheet();
  refreshAfterLogChange(); // task C1: now renders Week itself — see that function's doc comment
  toast('↺ Un-logged ' + dayDateLabel(ctx.dateISO).toLowerCase());
}

// The "Weekly nutrition guidance" card uses the computed fibre, free-sugar and
// saturated-fat measures that Mesa can compare with public-health guidance.
function coverageValueText(g){
  if(g.key === 'fiber') return g.value + ' g/day';
  if(g.key === 'satFat') return g.value + '% of energy';
  if(g.key === 'freeSugars'){
    const kcal = (PROF && PROF[currentProf] && PROF[currentProf].calGoalNum) || 0;
    const grams = kcal > 0 ? Math.round((g.value / 100) * kcal / 4) : 0;
    return grams + ' g/day (' + g.value + '% of kcal)';
  }
  return g.value + '/wk';
}
function coverageTargetText(g){
  if(g.key === 'fiber') return g.target + ' g/day';
  if(g.key === 'satFat') return '<' + g.target + '% of energy';
  if(g.key === 'freeSugars'){
    const kcal = (PROF && PROF[currentProf] && PROF[currentProf].calGoalNum) || 0;
    const grams = kcal > 0 ? Math.round((g.target / 100) * kcal / 4) : 0;
    return '<' + grams + ' g/day (' + g.target + '% of energy)';
  }
  return '≥' + g.target + '/wk';
}
// Single chip's markup (.n/.nt/.nbar/.cap-note) for a coverageGaps() entry — factored out
// of renderNutrientChips (Insights) so B4's week-level card (renderWeekNutriCard) can
// paint the SAME two headline chips (omega-3, sat fat) with identical styling instead of
// re-deriving the markup, per the B4 design note "reuse renderNutrientChips' chip styling".
function coverageChipHtml(g){
  const low = g.gap > 1e-9;
  const capNote = g.cap ? '<div class="cap-note">WHO guidance: keep under ' + g.target + '% of energy</div>' : '';
  return '<div class="n'+(low ? ' low' : '')+'"><div class="nt"><span>'+g.label+'</span><b>'+coverageValueText(g)+'</b></div>'
    + '<div class="nbar"><i style="width:'+g.pct+'%"></i></div>'+capNote+'</div>';
}
function renderNutrientChips(){
  const wrap = document.getElementById('nutriChips');
  if(!wrap) return;
  const gaps = coverageGaps(computeWeeklyCoverage(weekPlan));
  const order = ['fiber', 'satFat', 'freeSugars'];
  wrap.innerHTML = order.map(function(k){ return coverageChipHtml(gaps[k]); }).join('');
  const worstKey = order.reduce(function(a, b){ return gaps[b].gap > gaps[a].gap ? b : a; });
  const worst = gaps[worstKey];
  const pill = document.getElementById('coveragePill');
  if(pill) pill.textContent = worst.gap > 1e-9 ? 'Needs a nudge' : 'On track';
  const note = document.getElementById('coverageNote');
  if(note){
    note.innerHTML = worst.gap > 1e-9
      ? '📌 <b>' + worst.label + ' is the biggest gap</b> — at ' + coverageValueText(worst) + ' vs ' + coverageTargetText(worst) + '. Re-balance proposes the fewest swaps Mesa found.'
      : '✅ <b>These computed measures are within the displayed WHO guidance.</b> <button class="why-link" onclick="openHowMesaPlans(\'guidance\')">Why?</button>';
  }
}

function toggleDay(i){
  document.getElementById('wd'+i).classList.toggle('expanded');
}

/* ---------------- bottom sheet: generic open/close ---------------- */
// mealKey may be a slot name (from Today/Log cards) or a recipe id (from the recipe
// screen) — planner.js:resolveSwapContext maps either to (dayIndex, slot, person) on
// TODAY's plan for the current person. buildSwapSheet stores the computed alternatives
// on swapCtx so chooseSwap (planner.js) applies exactly what was shown.
// 'tall': see openWeekSwap's doc above — the sheet can now be long (FEATURE: swap anything).
