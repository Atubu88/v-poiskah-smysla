import assert from "node:assert/strict";
import test from "node:test";

import { stages, totalTasks } from "../lib/journey.ts";

test("journey has eight ordered stages and forty-eight steps", () => {
  assert.equal(stages.length, 8);
  assert.equal(totalTasks, 48);
  assert.deepEqual(stages.map(stage => stage.number), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("public journey copy speaks directly without source commentary", () => {
  const copy = JSON.stringify(stages).toLowerCase();
  assert.doesNotMatch(copy, /автор|брошюр|согласно книге|в этой книге|страниц/);
});

test("stage and task identifiers are unique", () => {
  const stageIds = stages.map(stage => stage.id);
  const taskIds = stages.flatMap(stage => stage.tasks.map(task => task.id));
  assert.equal(new Set(stageIds).size, stageIds.length);
  assert.equal(new Set(taskIds).size, taskIds.length);
});

test("objective answers reference valid options", () => {
  for (const stage of stages) {
    assert.ok(stage.tasks.length > 0, `${stage.id} has no tasks`);
    for (const task of stage.tasks) {
      assert.ok(task.options.length > 1, `${task.id} needs options`);
      if (task.kind === "reflection") {
        assert.equal(task.correct, undefined);
        continue;
      }
      assert.ok(task.correct?.length, `${task.id} needs a correct answer`);
      for (const index of task.correct) {
        assert.ok(index >= 0 && index < task.options.length, `${task.id} has an invalid answer index`);
      }
      if (task.kind === "sequence" || task.kind === "reveal") {
        assert.equal(task.correct.length, task.options.length, `${task.id} must use every option`);
      }
    }
  }
});
