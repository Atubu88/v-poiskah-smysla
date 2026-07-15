import assert from "node:assert/strict";
import test from "node:test";

import { stages } from "../lib/journey.ts";
import {
  journeyProgressStages,
  totalProgressStages,
  totalProgressTasks,
  validateProgressIds,
} from "../lib/progress.ts";

test("server progress metadata matches the journey", () => {
  const journeyMetadata = stages.map(stage => ({
    id: stage.id,
    title: stage.title,
    taskIds: stage.tasks.map(task => task.id),
  }));
  assert.deepEqual(journeyProgressStages, journeyMetadata);
  assert.equal(totalProgressStages, stages.length);
  assert.equal(totalProgressTasks, stages.reduce((sum, stage) => sum + stage.tasks.length, 0));
});

test("progress validation accepts only known unique ids", () => {
  assert.deepEqual(validateProgressIds(["never-enough", "never-enough"], ["enough-after-goal"]), {
    completedStages: ["never-enough"],
    completedTasks: ["enough-after-goal"],
  });
  assert.equal(validateProgressIds(["unknown-stage"], []), null);
  assert.equal(validateProgressIds([], ["unknown-task"]), null);
  assert.equal(validateProgressIds("never-enough", []), null);
});
