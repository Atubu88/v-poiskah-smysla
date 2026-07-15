export const journeyProgressStages = [
  { id: "never-enough", title: "Почему нам всегда мало?", taskIds: ["enough-what-is-missing", "enough-after-goal", "enough-cycle", "enough-bigger-question", "enough-core-questions", "enough-personal-question"] },
  { id: "hidden-worship", title: "Ты точно никому не поклоняешься?", taskIds: ["worship-only-ritual", "worship-many-objects", "worship-political-cult", "worship-money", "worship-personal-center", "worship-why-search"] },
  { id: "control-disappears", title: "Когда исчезает контроль", taskIds: ["control-instinct-awakens", "control-dog-example", "control-guarantees", "control-sinking-ship", "control-ocean-people", "control-need-not-proof"] },
  { id: "world-speaks", title: "Что говорит этот мир?", taskIds: ["world-faith-and-facts", "world-fact-foundation", "world-limits", "world-dependence", "world-design", "world-purpose"] },
  { id: "true-god", title: "Кто действительно достоин поклонения?", taskIds: ["god-dependency-chain", "god-dependent-object", "god-necessary-qualities", "god-created-creator", "god-setting-star", "god-final-conclusion"] },
  { id: "messenger-proof", title: "Почему мы должны поверить Посланнику?", taskIds: ["messenger-first-reaction", "messenger-valid-proof", "messenger-miracle-definition", "messenger-false-signs", "messenger-contemporary-proof", "messenger-later-generations"] },
  { id: "lasting-challenge", title: "Вызов, который остаётся", taskIds: ["challenge-lasting-proof", "challenge-what-miracle", "challenge-conditions", "challenge-argument-chain", "challenge-translation", "challenge-personal-next"] },
  { id: "trust-god", title: "Что значит довериться Богу?", taskIds: ["trust-first-image", "trust-meaning-islam", "trust-testimony", "trust-beliefs", "trust-guidance", "trust-final-meaning"] },
] as const;

export const totalProgressStages = journeyProgressStages.length;
export const totalProgressTasks = journeyProgressStages.reduce((sum, stage) => sum + stage.taskIds.length, 0);

const allowedStageIds = new Set<string>(journeyProgressStages.map(stage => stage.id));
const allowedTaskIds = new Set<string>(journeyProgressStages.flatMap(stage => [...stage.taskIds]));

export type ValidProgressIds = { completedStages: string[]; completedTasks: string[] };

function validateIds(value: unknown, allowed: Set<string>, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  if (value.some(item => typeof item !== "string" || !allowed.has(item))) return null;
  return Array.from(new Set(value));
}

export function validateProgressIds(completedStages: unknown, completedTasks: unknown): ValidProgressIds | null {
  const validStages = validateIds(completedStages, allowedStageIds, totalProgressStages);
  const validTasks = validateIds(completedTasks, allowedTaskIds, totalProgressTasks);
  if (!validStages || !validTasks) return null;
  return { completedStages: validStages, completedTasks: validTasks };
}
