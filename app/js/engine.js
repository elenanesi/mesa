/* ===================================================================
   engine.js — deterministic target engine
   Pure(ish) calculation functions: BMR/maintenance/recommended calories
   (Mifflin-St Jeor), the daily calorie band, macro-split guardrails,
   and recomputeProf() which derives a profile's display-ready numbers
   from its stored body stats + split. No DOM access in this file.
   =================================================================== */

/* ---------------- deterministic target engine ---------------- */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ACTIVITY_LEVELS = [
  {f:1.2,   t:'Sedentary',         d:'Mostly sitting · ×1.2'},
  {f:1.375, t:'Lightly active',    d:'Walks or 1–2 workouts a week · ×1.375'},
  {f:1.55,  t:'Moderately active', d:'Training 3–5 days a week · ×1.55'},
  {f:1.725, t:'Very active',       d:'Hard training most days · ×1.725'}
];
function fmtKcal(n){ return n.toLocaleString('en-US'); }
function round10(n){ return Math.round(n / 10) * 10; }
function ageOf(p){
  const now = new Date();
  let a = now.getFullYear() - p.dobY;
  if((now.getMonth() + 1) < p.dobM) a--;
  return a;
}
// Mifflin-St Jeor: male 10w + 6.25h − 5a + 5 · female 10w + 6.25h − 5a − 161
function bmrOf(p){
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * ageOf(p);
  return p.sex === 'male' ? base + 5 : base - 161;
}
function maintenanceOf(p){ return bmrOf(p) * p.activity; }
function recommendedCal(p){ return round10(maintenanceOf(p) + p.goalAdj); }
// Sane band for manual targets: never below ~110% of BMR, never above maintenance + 600.
function calBand(p){ return [round10(bmrOf(p) * 1.1), round10(maintenanceOf(p) + 600)]; }

// Recomputes macro gram targets + fat good/sat split from the profile's split % and
// daily calories. Consumed grams are fixed (already eaten today); only the target
// denominators — and therefore the bar widths — move when the split changes.
function recomputeProf(key){
  const p = PROF[key];
  // Daily target: the Mifflin-St Jeor recommendation unless a manual override is set.
  p.recCal = recommendedCal(p);
  if(p.calCustom !== null && p.calCustom === p.recCal) p.calCustom = null; // drifted back onto the recommendation
  p.calGoalNum = (p.calCustom !== null) ? p.calCustom : p.recCal;
  p.calGoal = fmtKcal(p.calGoalNum);
  p.cals = fmtKcal(p.calGoalNum) + ' kcal';
  p.calLeft = fmtKcal(Math.max(0, p.calGoalNum - p.consumedKcal));
  p.off = Math.round(351.8 * Math.min(1, p.consumedKcal / p.calGoalNum)); // ring arc = fraction of kcal still left
  const kcal = p.calGoalNum;
  const targetP = Math.round(kcal * p.kP / 100 / 4);
  const targetC = Math.round(kcal * p.kC / 100 / 4);
  const targetF = Math.round(kcal * p.kF / 100 / 9);
  p.targetP = targetP; p.targetC = targetC; p.targetF = targetF;
  p.mp = p.consumed.p + ' / ' + targetP + ' g';
  p.mc = p.consumed.c + ' / ' + targetC + ' g';
  p.mf = p.consumed.f + ' / ' + targetF + ' g';
  p.bp = Math.min(100, Math.round(p.consumed.p / targetP * 100)) + '%';
  p.bc = Math.min(100, Math.round(p.consumed.c / targetC * 100)) + '%';
  p.bff = Math.min(100, Math.round(p.consumed.f / targetF * 100)) + '%';
  // Good/sat fat line scales with the fat *target* (not the fixed consumed grams) so it
  // visibly moves with the split, holding roughly a 75/25 good/sat ratio.
  p.fatGood = Math.round(targetF * 0.75);
  p.fatSat = targetF - p.fatGood;
}

const SPLIT_BOUNDS = {P:[10,40], C:[20,60], F:[20,45]};
const SPLIT_PROP = {P:'kP', C:'kC', F:'kF'};
const SPLIT_LABEL = {P:'Protein', C:'Carbs', F:'Fat'};

function splitGuardNote(macro, dir){
  const msgs = {
    P:{min:'Protein stays ≥10% — your body needs a baseline to protect muscle.', max:'Protein stays ≤40% — more than this adds little extra benefit.'},
    C:{min:'Carbs stay ≥20% — your brain and workouts need fuel.', max:'Carbs stay ≤60% — leaves enough room for protein and fat.'},
    F:{min:'Fat stays ≥20% — needed for hormones and vitamin absorption.', max:'Fat stays ≤45% — keeps room for enough protein and carbs.'}
  };
  return msgs[macro][dir];
}
